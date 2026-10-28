import { randomUUID } from "node:crypto";
import {
  GameError, applyAction, advanceExpiredPhases, createRoom, makeSnapshot, roomCodeForRequest
} from "./game-engine.mjs";

const MAX_CONFLICT_RETRIES = 10;
const ROOM_KEY_PREFIX = "room:";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 6);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readRoom(store, code) {
  return store.getWithMetadata(ROOM_KEY_PREFIX + code, { consistency: "strong", type: "json" });
}

async function writeConditional(store, key, room, etag) {
  if (etag === null) return store.setJSON(key, room, { onlyIfNew: true });
  return store.setJSON(key, room, { onlyIfMatch: etag });
}

async function createRoomRequest(store, input, now, uuid) {
  const requestId = String(input.requestId || uuid()).trim().slice(0, 100);
  if (requestId.length < 8) throw new GameError("Room request could not be identified. Please try again.", 400, "invalid_request");
  const code = roomCodeForRequest(requestId);
  const key = ROOM_KEY_PREFIX + code;
  const existing = await readRoom(store, code);
  if (existing) {
    if (existing.data.expiresAt > now && existing.data.creatorRequestId === requestId) {
      return { state: makeSnapshot(existing.data, existing.data.hostId, now) };
    }
    if (existing.data.expiresAt > now) {
      throw new GameError("That room code is already in use. Please create again.", 409, "room_code_collision");
    }
  }
  const room = createRoom({ code, name: input.name, requestId, now, id: uuid() });
  const result = existing
    ? await writeConditional(store, key, room, existing.etag)
    : await store.setJSON(key, room, { onlyIfNew: true });
  if (result.modified) return { state: makeSnapshot(room, room.hostId, now) };
  const winner = await readRoom(store, code);
  if (winner?.data.creatorRequestId === requestId && winner.data.expiresAt > now) {
    return { state: makeSnapshot(winner.data, winner.data.hostId, now) };
  }
  throw new GameError("That room code is already in use. Please create again.", 409, "room_code_collision");
}

async function transactRoom(store, code, playerId, action, now, uuid) {
  const key = ROOM_KEY_PREFIX + code;
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const entry = await readRoom(store, code);
    if (!entry) throw new GameError("Room not found. Check the code and try again.", 404, "room_not_found");
    if (entry.data.expiresAt <= now) {
      throw new GameError("This room has expired. Create a new room.", 410, "room_expired");
    }
    if (entry.data.phase === "closed") throw new GameError("This room has expired. Create a new room.", 410, "room_expired");

    const room = structuredClone(entry.data);
    const before = JSON.stringify(room);
    let actionError = null;
    let left = false;
    try {
      if (action.type === "join") {
        applyAction(room, action, now, { playerId });
      } else if (action.type === "poll") {
        advanceExpiredPhases(room, now);
        const player = room.players.find(candidate => candidate.id === playerId);
        if (!player) throw new GameError("Your room session has expired. Create or join a room again.", 404, "session_expired");
      } else {
        applyAction(room, { ...action, playerId }, now, { playerId, uuid });
        left = action.type === "leave";
      }
    } catch (error) {
      actionError = error;
    }

    // applyAction handles gameplay actions. A poll is a presence heartbeat.
    if (action.type === "poll" && !actionError) {
      const player = room.players.find(candidate => candidate.id === playerId);
      if (player && now - player.lastSeenAt >= 10_000) {
        player.lastSeenAt = now;
        room.lastActivityAt = now;
        room.expiresAt = now + 12 * 60 * 60 * 1000;
        const host = room.players.find(candidate => candidate.id === room.hostId);
        if (host && now - host.lastSeenAt > 30_000) {
          const active = room.players.filter(candidate => now - candidate.lastSeenAt <= 30_000);
          if (active.length) room.hostId = active[0].id;
        }
      }
    }
    const changed = JSON.stringify(room) !== before;
    if (!changed) {
      if (actionError) throw actionError;
      const viewerId = action.type === "join" && action.requestId ? room.joinRequests[action.requestId] || playerId : playerId;
      return left ? { left: true } : { state: makeSnapshot(room, viewerId, now) };
    }
    const write = await writeConditional(store, key, room, entry.etag);
    if (!write.modified) {
      await sleep(Math.min(8 * (attempt + 1), 40));
      continue;
    }
    if (actionError) throw actionError;
    const viewerId = action.type === "join" && action.requestId ? room.joinRequests[action.requestId] || playerId : playerId;
      return left ? { left: true } : { state: makeSnapshot(room, viewerId, now) };
  }
  throw new GameError("The room is busy with another player action. Please try again.", 409, "room_conflict");
}

export function createGameHandler({ store, now = () => Date.now(), uuid = randomUUID } = {}) {
  if (!store) throw new Error("A Netlify Blobs-compatible store is required.");
  return async function handleGameRequest(request) {
    try {
      const currentTime = now();
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (request.method === "GET") {
        const url = new URL(request.url);
        const code = normalizeCode(url.searchParams.get("code"));
        const playerId = String(url.searchParams.get("playerId") || "");
        if (code.length !== 6 || !playerId) throw new GameError("Room code and player session are required.");
        return jsonResponse(await transactRoom(store, code, playerId, { type: "poll" }, currentTime, uuid));
      }
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);
      let input;
      try { input = await request.json(); } catch { throw new GameError("Request body must be valid JSON."); }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new GameError("Request body must be an object.");

      if (input.type === "create") return jsonResponse(await createRoomRequest(store, input, currentTime, uuid));
      const code = normalizeCode(input.code);
      if (code.length !== 6) throw new GameError("Enter the room code from your host.");
      if (input.type === "join") {
        const playerId = uuid();
        return jsonResponse(await transactRoom(store, code, playerId, { ...input, type: "join" }, currentTime, uuid));
      }
      const playerId = String(input.playerId || "");
      if (!playerId) throw new GameError("Your room session has expired. Rejoin from the lobby.", 401, "missing_player");
      return jsonResponse(await transactRoom(store, code, playerId, input, currentTime, uuid));
    } catch (error) {
      const status = error instanceof GameError ? error.status : 500;
      const message = error instanceof GameError ? error.message : "The game server hit an unexpected error.";
      const code = error instanceof GameError ? error.code : "server_error";
      if (status >= 500) console.error("Bluff Battle function error:", error);
      return jsonResponse({ error: message, code }, status);
    }
  };
}

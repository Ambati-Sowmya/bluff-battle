import { createHash, randomUUID } from "node:crypto";

export const ROUND_COUNT = 5;
export const SUBMISSION_SECONDS = 60;
export const VOTING_SECONDS = 35;
export const REVEAL_SECONDS = 9;
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
export const HEARTBEAT_MS = 10 * 1000;
export const CONNECTED_MS = 30 * 1000;

export const WORDS = [
  { word: "Petrichor", definition: "The earthy scent after rain falls on dry ground." },
  { word: "Apricity", definition: "The warmth of the sun in winter." },
  { word: "Defenestration", definition: "The act of throwing someone or something out of a window." },
  { word: "Ultracrepidarian", definition: "A person who gives opinions beyond their knowledge." },
  { word: "Sonder", definition: "The realization that strangers have lives as vivid as your own." },
  { word: "Susurrus", definition: "A soft whispering or rustling sound." },
  { word: "Mellifluous", definition: "A sound that is sweet and smooth to hear." },
  { word: "Nudiustertian", definition: "Relating to the day before yesterday." },
  { word: "Quincunx", definition: "An arrangement of five objects with four at the corners and one in the middle." },
  { word: "Limerence", definition: "An intense, involuntary longing for another person." },
  { word: "Crapulence", definition: "Feeling unwell after eating or drinking too much." },
  { word: "Borborygmus", definition: "A rumbling noise made by the stomach." }
];

export class GameError extends Error {
  constructor(message, status = 400, code = "game_error") {
    super(message);
    this.name = "GameError";
    this.status = status;
    this.code = code;
  }
}

export function cleanName(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 18);
}

export function roomCodeForRequest(requestId) {
  return createHash("sha256").update(String(requestId)).digest("hex").slice(0, 6).toUpperCase();
}

export function createRoom({ code, name, requestId, now = Date.now(), id = randomUUID() }) {
  const clean = cleanName(name);
  if (!clean) throw new GameError("Enter your name first.");
  return {
    code,
    phase: "lobby",
    round: 0,
    totalRounds: ROUND_COUNT,
    hostId: id,
    creatorRequestId: requestId,
    players: [{ id, name: clean, score: 0, joinedAt: now, lastSeenAt: now }],
    submissions: {},
    entries: [],
    votes: {},
    voteCounts: {},
    votersByEntry: {},
    result: [],
    winner: [],
    deadlineAt: null,
    lastActivityAt: now,
    expiresAt: now + ROOM_TTL_MS,
    joinRequests: {},
    receipts: {}
  };
}

function startRound(room, startAt) {
  room.round += 1;
  room.phase = "submit";
  room.word = WORDS[(room.round - 1) % WORDS.length];
  room.submissions = {};
  room.entries = [];
  room.votes = {};
  room.voteCounts = {};
  room.votersByEntry = {};
  room.result = [];
  room.deadlineAt = startAt + SUBMISSION_SECONDS * 1000;
}

function openVoting(room, startAt) {
  if (room.phase !== "submit") return;
  room.entries = Object.entries(room.submissions).map(([ownerId, text]) => ({
    id: randomUUID(), ownerId, text, real: false
  }));
  room.entries.push({ id: randomUUID(), ownerId: null, text: room.word.definition, real: true });
  room.entries.sort(() => Math.random() - 0.5);
  room.phase = "vote";
  room.votes = {};
  room.deadlineAt = startAt + VOTING_SECONDS * 1000;
}

function finishVoting(room, endAt) {
  if (room.phase !== "vote") return;
  room.voteCounts = {};
  room.votersByEntry = {};
  for (const [voter, picked] of Object.entries(room.votes)) {
    room.voteCounts[picked] = (room.voteCounts[picked] || 0) + 1;
    (room.votersByEntry[picked] ||= []).push(voter);
  }
  const roundPoints = new Map();
  for (const entry of room.entries) {
    const count = room.voteCounts[entry.id] || 0;
    if (entry.real) {
      for (const [voter, picked] of Object.entries(room.votes)) {
        if (picked === entry.id) roundPoints.set(voter, (roundPoints.get(voter) || 0) + 1);
      }
    } else if (entry.ownerId) {
      roundPoints.set(entry.ownerId, (roundPoints.get(entry.ownerId) || 0) + count * 2);
    }
  }
  for (const player of room.players) player.score += roundPoints.get(player.id) || 0;
  room.result = room.players.map(player => ({ id: player.id, name: player.name, points: roundPoints.get(player.id) || 0 }));
  room.deadlineAt = null;
  if (room.round >= ROUND_COUNT) {
    room.phase = "finished";
    const high = Math.max(...room.players.map(player => player.score));
    room.winner = room.players.filter(player => player.score === high).map(player => player.name);
  } else {
    room.phase = "reveal";
    room.deadlineAt = endAt + REVEAL_SECONDS * 1000;
  }
}

/**
 * Advance deadline-driven phases from their scheduled timestamps, not from the
 * time of the first later request. Multiple missed deadlines are caught up in
 * one transaction, so polling delays cannot extend a round.
 */
export function advanceExpiredPhases(room, now = Date.now()) {
  let changed = false;
  while (room.deadlineAt !== null && now >= room.deadlineAt) {
    const deadline = room.deadlineAt;
    if (room.phase === "submit") openVoting(room, deadline);
    else if (room.phase === "vote") finishVoting(room, deadline);
    else if (room.phase === "reveal" && room.round < ROUND_COUNT) startRound(room, deadline);
    else {
      room.deadlineAt = null;
    }
    changed = true;
  }
  return changed;
}

function getPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function touch(room, playerId, now) {
  const player = getPlayer(room, playerId);
  if (player && now - player.lastSeenAt >= HEARTBEAT_MS) {
    player.lastSeenAt = now;
    room.lastActivityAt = now;
    room.expiresAt = now + ROOM_TTL_MS;
  }
  const host = getPlayer(room, room.hostId);
  if (host && now - host.lastSeenAt > CONNECTED_MS) {
    const active = room.players.filter(candidate => now - candidate.lastSeenAt <= CONNECTED_MS);
    if (active.length) room.hostId = active[0].id;
  }
}

function addReceipt(room, requestId, playerId) {
  if (!requestId) return;
  room.receipts[requestId] = playerId;
  const keys = Object.keys(room.receipts);
  if (keys.length > 250) delete room.receipts[keys[0]];
}

export function applyAction(room, action, now = Date.now(), ids = {}) {
  const requestId = String(action.requestId || "");
  if (requestId && room.receipts[requestId]) return;
  advanceExpiredPhases(room, now);

  if (action.type === "join") {
    const existingId = requestId && room.joinRequests[requestId];
    if (existingId) {
      touch(room, existingId, now);
      return;
    }
    if (room.phase !== "lobby") throw new GameError("This game has already started.");
    if (room.players.length >= 8) throw new GameError("This room is full (8 players maximum).");
    const name = cleanName(action.name);
    if (!name) throw new GameError("Enter your name first.");
    const player = { id: ids.playerId || randomUUID(), name, score: 0, joinedAt: now, lastSeenAt: now };
    room.players.push(player);
    if (requestId) room.joinRequests[requestId] = player.id;
    room.lastActivityAt = now;
    room.expiresAt = now + ROOM_TTL_MS;
    addReceipt(room, requestId, player.id);
    return;
  }

  const player = getPlayer(room, action.playerId);
  if (!player) throw new GameError("Your room session has expired. Create or join a room again.", 404, "session_expired");
  touch(room, player.id, now);

  if (action.type === "leave") {
    room.players = room.players.filter(candidate => candidate.id !== player.id);
    delete room.submissions[player.id];
    delete room.votes[player.id];
    if (!room.players.length) {
      room.phase = "closed";
      room.deadlineAt = null;
      room.expiresAt = now;
    } else if (room.hostId === player.id) {
      room.hostId = room.players.find(candidate => now - candidate.lastSeenAt <= CONNECTED_MS)?.id || room.players[0].id;
    }
    if (room.phase === "submit" && Object.keys(room.submissions).length >= room.players.length) openVoting(room, now);
    else if (room.phase === "vote" && Object.keys(room.votes).length >= room.players.length) finishVoting(room, now);
  } else if (action.type === "start") {
    if (player.id !== room.hostId) throw new GameError("Only the host can start the game.");
    if (room.players.length < 2) throw new GameError("Invite at least one more player to start.");
    if (room.phase === "lobby") startRound(room, now);
  } else if (action.type === "submit") {
    if (room.submissions[player.id]) return;
    if (room.phase !== "submit") throw new GameError("Submissions are closed for this round.");
    const text = String(action.text || "").trim().slice(0, 150);
    if (text.length < 4) throw new GameError("Write at least 4 characters for your fake definition.");
    room.submissions[player.id] = text;
    if (Object.keys(room.submissions).length === room.players.length) openVoting(room, now);
  } else if (action.type === "vote") {
    if (room.votes[player.id]) return;
    if (room.phase !== "vote") throw new GameError("Voting is closed for this round.");
    const entry = room.entries.find(candidate => candidate.id === action.entryId);
    if (!entry) throw new GameError("That answer is no longer available.");
    if (entry.ownerId === player.id) throw new GameError("You cannot vote for your own definition.");
    room.votes[player.id] = entry.id;
    if (Object.keys(room.votes).length === room.players.length) finishVoting(room, now);
  } else if (action.type === "next") {
    if (player.id !== room.hostId) throw new GameError("Only the host can advance the round.");
    if (room.phase === "reveal" && room.round < ROUND_COUNT) startRound(room, now);
  } else if (action.type === "playAgain") {
    if (player.id !== room.hostId) throw new GameError("Only the host can start a rematch.");
    if (room.phase === "finished") {
      for (const candidate of room.players) candidate.score = 0;
      room.round = 0;
      room.phase = "lobby";
      room.deadlineAt = null;
      room.word = undefined;
      room.submissions = {};
      room.entries = [];
      room.votes = {};
      room.voteCounts = {};
      room.votersByEntry = {};
      room.result = [];
      room.winner = [];
    }
  } else {
    throw new GameError("That game action is not supported.");
  }

  room.lastActivityAt = now;
  room.expiresAt = now + ROOM_TTL_MS;
  addReceipt(room, requestId, player.id);
}

export function makeSnapshot(room, playerId, now = Date.now()) {
  const players = room.players.map(player => ({
    id: player.id,
    name: player.name,
    score: player.score,
    isHost: player.id === room.hostId,
    connected: now - player.lastSeenAt <= CONNECTED_MS
  }));
  const base = {
    code: room.code,
    phase: room.phase,
    players,
    round: room.round,
    totalRounds: ROUND_COUNT,
    secondsLeft: room.deadlineAt === null ? 0 : Math.max(0, Math.ceil((room.deadlineAt - now) / 1000)),
    hostId: room.hostId,
    you: playerId
  };
  if (room.phase === "lobby") return base;
  const submitted = Boolean(room.submissions[playerId]);
  if (room.phase === "submit") {
    return { ...base, word: room.word.word, submitted, submissionCount: Object.keys(room.submissions).length };
  }
  if (room.phase === "vote") {
    return {
      ...base,
      word: room.word.word,
      submitted,
      entries: room.entries.map(entry => ({ id: entry.id, text: entry.text, own: entry.ownerId === playerId })),
      voted: Boolean(room.votes[playerId]),
      voteCount: Object.keys(room.votes).length
    };
  }
  if (room.phase === "reveal" || room.phase === "finished") {
    return {
      ...base,
      word: room.word?.word,
      definition: room.word?.definition,
      entries: room.entries.map(entry => ({
        text: entry.text,
        author: room.players.find(player => player.id === entry.ownerId)?.name || "Player",
        isReal: entry.real,
        votes: room.voteCounts[entry.id] || 0,
        voters: (room.votersByEntry[entry.id] || []).map(id => room.players.find(player => player.id === id)?.name || "Player")
      })),
      result: room.result,
      ...(room.winner.length ? { winner: room.winner } : {})
    };
  }
  return base;
}

export function publicRoomSummary(room) {
  return { code: room.code, phase: room.phase, round: room.round, playerCount: room.players.length };
}
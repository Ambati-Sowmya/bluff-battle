import assert from "node:assert/strict";
import test from "node:test";
import { createGameHandler } from "./src/game-api.mjs";

class MemoryBlobs {
  constructor() { this.values = new Map(); this.version = 0; }
  async getWithMetadata(key) {
    await Promise.resolve();
    const item = this.values.get(key);
    return item ? { data: structuredClone(item.data), etag: item.etag, metadata: {} } : null;
  }
  async setJSON(key, data, options = {}) {
    await Promise.resolve();
    const current = this.values.get(key);
    if (options.onlyIfNew && current) return { modified: false };
    if (options.onlyIfMatch && (!current || current.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = '"test-' + (++this.version) + '"';
    this.values.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  }
  async delete(key) { this.values.delete(key); }
  raw(code) { return structuredClone(this.values.get("room:" + code)?.data); }
}

function fixture(start = 1_800_000_000_000) {
  let time = start, id = 0;
  const store = new MemoryBlobs();
  const handler = createGameHandler({ store, now: () => time, uuid: () => "player-id-" + (++id).toString().padStart(4, "0") });
  const get = async (code, playerId) => {
    const response = await handler(new Request("https://example.test/.netlify/functions/game?code=" + code + "&playerId=" + playerId));
    return { status: response.status, body: await response.json() };
  };
  const post = async body => {
    const response = await handler(new Request("https://example.test/.netlify/functions/game", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));
    return { status: response.status, body: await response.json() };
  };
  return { store, get, post, now: () => time, setTime: value => { time = value; } };
}

async function createPlayers(f) {
  const create = { type: "create", name: "Alice", requestId: "create-request-0001" };
  const [first, duplicate] = await Promise.all([f.post(create), f.post(create)]);
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(first.body.state.code, duplicate.body.state.code);
  assert.equal(first.body.state.you, duplicate.body.state.you);
  assert.equal(first.body.state.players.length, 1, "repeated create request does not create duplicate rooms or players");
  const code = first.body.state.code;
  const join = { type: "join", name: "Bob", code, requestId: "join-request-0001" };
  const [joined, duplicateJoin] = await Promise.all([f.post(join), f.post(join)]);
  assert.equal(joined.status, 200);
  assert.equal(duplicateJoin.status, 200);
  assert.equal(joined.body.state.you, duplicateJoin.body.state.you);
  assert.equal(joined.body.state.players.length, 2, "repeated join request adds only one player");
  const host = await f.get(code, first.body.state.you);
  const guest = await f.get(code, joined.body.state.you);
  assert.deepEqual(host.body.state.players.map(player => player.id), guest.body.state.players.map(player => player.id));
  assert.equal(host.body.state.players.length, 2);
  return { code, hostId: first.body.state.you, guestId: joined.body.state.you };
}

test("room creation, idempotent retries, join-by-code, and synchronized snapshots", async () => {
  const f = fixture();
  const { code, hostId, guestId } = await createPlayers(f);
  assert.match(code, /^[A-F0-9]{6}$/);
  assert.equal(f.store.raw(code).hostId, hostId);
  assert.equal((await f.get(code, guestId)).body.state.players.find(player => player.id === hostId).isHost, true);
});

test("concurrent submissions and votes are serialized without losing state; voting remains anonymous", async () => {
  const f = fixture();
  const { code, hostId, guestId } = await createPlayers(f);
  assert.equal((await f.post({ type: "start", code, playerId: hostId, requestId: "start-round-one" })).status, 200);
  const [hostSubmit, guestSubmit] = await Promise.all([
    f.post({ type: "submit", code, playerId: hostId, text: "A convincing fake from Alice", requestId: "submit-alice-round-1" }),
    f.post({ type: "submit", code, playerId: guestId, text: "A convincing fake from Bob", requestId: "submit-bob-round-1" })
  ]);
  assert.equal(hostSubmit.status, 200);
  assert.equal(guestSubmit.status, 200);
  const voteState = (await f.get(code, hostId)).body.state;
  assert.equal(voteState.phase, "vote");
  assert.equal(voteState.entries.length, 3);
  assert.equal(voteState.entries.filter(entry => entry.own).length, 1);
  assert.ok(voteState.entries.every(entry => !("ownerId" in entry) && !("author" in entry) && !("real" in entry)));
  assert.ok(!("votes" in voteState) && !("votersByEntry" in voteState), "individual ballots are absent before reveal");
  assert.equal(voteState.voteCount, 0);

  const raw = f.store.raw(code);
  const bobFake = raw.entries.find(entry => entry.ownerId === guestId);
  const real = raw.entries.find(entry => entry.real);
  const [aliceVote, bobVote, duplicateAliceVote] = await Promise.all([
    f.post({ type: "vote", code, playerId: hostId, entryId: bobFake.id, requestId: "vote-alice-round-1" }),
    f.post({ type: "vote", code, playerId: guestId, entryId: real.id, requestId: "vote-bob-round-1" }),
    f.post({ type: "vote", code, playerId: hostId, entryId: bobFake.id, requestId: "vote-alice-round-1-retry" })
  ]);
  assert.equal(aliceVote.status, 200);
  assert.equal(bobVote.status, 200);
  assert.equal(duplicateAliceVote.status, 200, "a simultaneous retry with a fresh transport ID is safely deduplicated by player and phase");
  const reveal = (await f.get(code, hostId)).body.state;
  assert.equal(reveal.phase, "reveal");
  assert.equal(reveal.players.find(player => player.id === guestId).score, 3);
  assert.equal(reveal.players.find(player => player.id === hostId).score, 0);
  assert.equal(reveal.entries.reduce((sum, entry) => sum + entry.votes, 0), 2, "one player cannot cast two ballots in a round");
  assert.equal(reveal.entries.find(entry => entry.isReal).voters.length, 1, "voter names are revealed only after voting closes");

  const repeatedVote = await f.post({ type: "vote", code, playerId: guestId, entryId: real.id, requestId: "vote-bob-round-1" });
  assert.equal(repeatedVote.status, 200);
  assert.equal((await f.get(code, guestId)).body.state.players.find(player => player.id === guestId).score, 3);
});

test("poll-driven deadlines catch up submission, voting, reveals, and all five rounds", async () => {
  const f = fixture();
  const { code, hostId, guestId } = await createPlayers(f);
  await f.post({ type: "start", code, playerId: hostId, requestId: "timer-start" });
  assert.equal((await f.get(code, hostId)).body.state.secondsLeft, 60);
  f.setTime(f.now() + 60_000);
  let state = (await f.get(code, guestId)).body.state;
  assert.equal(state.phase, "vote");
  assert.equal(state.secondsLeft, 35);
  f.setTime(f.now() + 35_000);
  state = (await f.get(code, hostId)).body.state;
  assert.equal(state.phase, "reveal");
  assert.equal(state.secondsLeft, 9);
  f.setTime(f.now() + 9_000);
  state = (await f.get(code, guestId)).body.state;
  assert.equal(state.phase, "submit");
  assert.equal(state.round, 2);
  assert.equal(state.secondsLeft, 60);

  f.setTime(f.now() + 60_000 + 35_000 + 9_000 + 3 * (60_000 + 35_000 + 9_000));
  state = (await f.get(code, hostId)).body.state;
  assert.equal(state.phase, "finished");
  assert.equal(state.round, 5);
  assert.equal(state.winner.length, 2, "zero-score tie is represented by both winners");
});

test("all five rounds preserve scoring, choose the winner, and rematch resets scores", async () => {
  const f = fixture();
  const { code, hostId, guestId } = await createPlayers(f);
  await f.post({ type: "start", code, playerId: hostId, requestId: "full-game-start" });
  for (let round = 1; round <= 5; round += 1) {
    const [a, b] = await Promise.all([
      f.post({ type: "submit", code, playerId: hostId, text: "Alice fake meaning for round " + round, requestId: "a-submit-" + round }),
      f.post({ type: "submit", code, playerId: guestId, text: "Bob fake meaning for round " + round, requestId: "b-submit-" + round })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const bothSeeVote = await Promise.all([f.get(code, hostId), f.get(code, guestId)]);
    assert.equal(bothSeeVote[0].body.state.phase, "vote");
    assert.equal(bothSeeVote[1].body.state.word, bothSeeVote[0].body.state.word);
    const room = f.store.raw(code);
    const bobFake = room.entries.find(entry => entry.ownerId === guestId);
    const trueAnswer = room.entries.find(entry => entry.real);
    const [voteA, voteB] = await Promise.all([
      f.post({ type: "vote", code, playerId: hostId, entryId: bobFake.id, requestId: "a-vote-" + round }),
      f.post({ type: "vote", code, playerId: guestId, entryId: trueAnswer.id, requestId: "b-vote-" + round })
    ]);
    assert.equal(voteA.status, 200);
    assert.equal(voteB.status, 200);
    const result = (await f.get(code, hostId)).body.state;
    assert.equal(result.phase, round === 5 ? "finished" : "reveal");
    assert.equal(result.players.find(player => player.id === guestId).score, 3 * round);
    assert.equal(result.players.find(player => player.id === hostId).score, 0);
    if (round < 5) await f.post({ type: "next", code, playerId: hostId, requestId: "next-" + round });
  }
  let final = (await f.get(code, guestId)).body.state;
  assert.deepEqual(final.winner, ["Bob"]);
  assert.equal(final.totalRounds, 5);
  await f.post({ type: "playAgain", code, playerId: hostId, requestId: "play-again" });
  final = (await f.get(code, hostId)).body.state;
  assert.equal(final.phase, "lobby");
  assert.equal(final.round, 0);
  assert.ok(final.players.every(player => player.score === 0));
});

test("host controls reject guests; room-expiry errors are returned safely", async () => {
  const f = fixture();
  const { code, hostId, guestId } = await createPlayers(f);
  const denied = await f.post({ type: "start", code, playerId: guestId, requestId: "guest-start" });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /Only the host/);
  f.setTime(f.now() + 13 * 60 * 60 * 1000);
  const expired = await f.get(code, hostId);
  assert.equal(expired.status, 410);
  const restarted = await f.post({ type: "create", name: "Alice Again", requestId: "create-request-0001" });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.state.code, code);
  assert.equal(restarted.body.state.phase, "lobby", "an expired code is safely replaced with an ETag-conditional write");
});

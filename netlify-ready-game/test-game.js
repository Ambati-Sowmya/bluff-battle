const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handle, rooms, server } = require('./server');

class FakeSocket {
  // Match a Node net.Socket: readyState is a string, not WebSocket.OPEN (1).
  constructor() { this.readyState = 'open'; this.wsOpen = true; this.writable = true; this.destroyed = false; this.frames = []; }
  write(buffer) { this.frames.push(buffer); }
  send(type, data = {}) { handle(this, JSON.stringify({ type, ...data })); }
  state() {
    const frame = this.frames.at(-1);
    assert.ok(frame, 'expected a server state frame');
    let offset = 2, length = frame[1] & 0x7f;
    if (length === 126) { length = frame.readUInt16BE(2); offset = 4; }
    else if (length === 127) { length = Number(frame.readBigUInt64BE(2)); offset = 10; }
    return JSON.parse(frame.subarray(offset, offset + length).toString('utf8'));
  }
}

class FakeTransport extends EventEmitter {
  constructor() { super(); this.writable = true; this.destroyed = false; this.writes = []; }
  get readyState() { return 'open'; }
  write(data) { this.writes.push(data); return true; }
  end() { this.writable = false; this.destroyed = true; this.emit('close'); }
}

function clientFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  assert.ok(payload.length < 126);
  const mask = Buffer.from([17, 31, 47, 63]);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, out]);
}

function decodeServerFrame(frame) {
  let offset = 2, length = frame[1] & 0x7f;
  if (length === 126) { length = frame.readUInt16BE(2); offset = 4; }
  else if (length === 127) { length = Number(frame.readBigUInt64BE(2)); offset = 10; }
  return JSON.parse(frame.subarray(offset, offset + length).toString('utf8'));
}

function testWebSocketCreate() {
  const host = new FakeTransport();
  server.emit('upgrade', { url: '/ws', headers: { 'sec-websocket-key': 'c2VydmVyLXRlc3Qta2V5' } }, host);
  assert.match(host.writes[0], /^HTTP\/1\.1 101 Switching Protocols/);
  host.emit('data', clientFrame({ type: 'create', name: 'SocketHost' }));
  const frame = host.writes.findLast(value => Buffer.isBuffer(value));
  assert.ok(frame, 'server sends a room state after WebSocket create');
  const message = decodeServerFrame(frame);
  assert.equal(message.type, 'state');
  assert.equal(message.state.phase, 'lobby');
  assert.equal(message.state.players[0].name, 'SocketHost');
  assert.match(message.state.code, /^[A-F0-9]{6}$/);
  const guest = new FakeTransport();
  server.emit('upgrade', { url: '/ws', headers: { 'sec-websocket-key': 'Z3Vlc3QtdGVzdC1rZXk=' } }, guest);
  guest.emit('data', clientFrame({ type: 'join', name: 'SocketGuest', code: message.state.code }));
  const hostUpdate = decodeServerFrame(host.writes.findLast(value => Buffer.isBuffer(value)));
  const guestUpdate = decodeServerFrame(guest.writes.findLast(value => Buffer.isBuffer(value)));
  assert.deepEqual(hostUpdate.state.players.map(player => player.name), ['SocketHost', 'SocketGuest']);
  assert.deepEqual(guestUpdate.state.players.map(player => player.name), ['SocketHost', 'SocketGuest']);
  assert.equal(guestUpdate.state.you, guestUpdate.state.players.find(player => player.name === 'SocketGuest').id);
  rooms.delete(message.state.code);
  host.emit('close'); guest.emit('close');
  console.log('PASS: WebSocket create returns host lobby/code; join by code adds guest and syncs both lobby states with Node-style readyState="open".');
}

function testLeaveRoom() {
  const host = new FakeSocket(), guest = new FakeSocket();
  host.send('create', { name: 'Host' });
  const code = host.state().state.code;
  guest.send('join', { name: 'Guest', code });
  const hostId = host.state().state.you;
  host.send('leave');
  const acknowledgement = host.state();
  assert.equal(acknowledgement.type, 'left');
  const remaining = guest.state().state;
  assert.equal(remaining.players.length, 1);
  assert.equal(remaining.players[0].name, 'Guest');
  assert.equal(remaining.players[0].isHost, true, 'host role transfers to the remaining player');
  assert.notEqual(remaining.hostId, hostId);
  guest.send('leave');
  assert.equal(rooms.has(code), false, 'empty room is removed');
  console.log('PASS: explicit leave removes player, transfers host, and removes empty room.');
}

function test() {
  const alice = new FakeSocket(), bob = new FakeSocket();
  alice.send('create', { name: 'Alice' });
  const lobby = alice.state().state;
  assert.equal(lobby.phase, 'lobby');
  assert.match(lobby.code, /^[A-F0-9]{6}$/);
  assert.equal(lobby.players.length, 1);
  assert.equal(lobby.players[0].name, 'Alice');
  assert.equal(lobby.players[0].isHost, true);
  assert.equal(lobby.you, lobby.players[0].id);
  const code = lobby.code;
  bob.send('join', { name: 'Bob', code });
  assert.equal(alice.state().state.players.length, 2);
  assert.deepEqual(alice.state().state.players.map(p => p.name), ['Alice', 'Bob']);
  assert.deepEqual(bob.state().state.players.map(p => p.name), ['Alice', 'Bob']);
  assert.equal(bob.state().state.code, code);
  assert.equal(bob.state().state.you, bob.state().state.players.find(p => p.name === 'Bob').id);
  alice.send('start');

  for (let round = 1; round <= 5; round++) {
    let a = alice.state().state, b = bob.state().state;
    assert.equal(a.phase, 'submit'); assert.equal(a.round, round); assert.equal(a.secondsLeft, 60);
    assert.equal(b.word, a.word, 'both players receive the same round word');
    alice.send('submit', { text: `Alice's convincing fake number ${round}` });
    assert.equal(alice.state().state.submitted, true);
    bob.send('submit', { text: `Bob's convincing fake number ${round}` });
    a = alice.state().state; b = bob.state().state;
    assert.equal(a.phase, 'vote'); assert.equal(a.entries.length, 3);
    assert.equal(a.entries.filter(e => e.own).length, 1);
    assert.equal(a.entries.some(e => e.own && e.id === b.entries.find(x => x.own).id), false);
    assert.equal(b.entries.filter(e => e.own).length, 1);
    const aChoice = a.entries.find(e => !e.own), bChoice = b.entries.find(e => !e.own);
    alice.send('vote', { entryId: aChoice.id });
    assert.equal(alice.state().state.voted, true);
    bob.send('vote', { entryId: bChoice.id });
    a = alice.state().state; b = bob.state().state;
    assert.equal(a.phase, round === 5 ? 'finished' : 'reveal');
    assert.equal(b.phase, a.phase);
    assert.ok(a.entries.some(e => e.isReal && e.text === a.definition), 'real definition is revealed');
    for (const state of [a, b]) {
      const points = new Map(state.players.map(p => [p.id, 0]));
      for (const entry of state.entries) {
        if (entry.isReal) for (const voterName of entry.voters) {
          const voter = state.players.find(p => p.name === voterName);
          if (voter) points.set(voter.id, points.get(voter.id) + 1);
        }
        else {
          const author = state.players.find(p => p.name === entry.author);
          if (author) points.set(author.id, points.get(author.id) + 2 * entry.votes);
        }
      }
      assert.deepEqual(state.result.map(p => [p.id, p.points]).sort(), [...points].sort(), 'correct votes score 1 and each fake vote scores its author 2');
    }
    if (round < 5) alice.send('next');
  }
  const final = alice.state().state;
  assert.equal(final.round, 5);
  assert.ok(final.winner.length >= 1, 'final winner or tied winners are named');
  alice.send('playAgain');
  assert.equal(alice.state().state.phase, 'lobby');
  assert.equal(alice.state().state.round, 0);
  rooms.delete(code);
  console.log(`PASS: room ${code}; host create and lobby identity; join by code and synchronized player lists; all 5 submit/vote/reveal rounds; scoring; winner; rematch.`);
}

async function testHttpRoot() {
  let statusCode, headers, body;
  const response = {
    writeHead(code, value) { statusCode = code; headers = value; },
    end(value) { body = value; },
  };
  server.emit('request', { url: '/', headers: { host: 'localhost:3000' } }, response);
  for (let n = 0; n < 50 && body === undefined; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(statusCode, 200);
  assert.match(headers['content-type'], /^text\/html/);
  assert.match(String(body), /Can you spot/);
  console.log('PASS: GET / serves public/index.html with HTTP 200 and HTML content type.');
}

testWebSocketCreate();
testLeaveRoom();
testHttpRoot().then(() => test()).catch(error => { console.error(error); process.exitCode = 1; });

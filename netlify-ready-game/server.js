const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();
const words = [
  { word: 'Petrichor', definition: 'The earthy scent after rain falls on dry ground.' },
  { word: 'Apricity', definition: 'The warmth of the sun in winter.' },
  { word: 'Defenestration', definition: 'The act of throwing someone or something out of a window.' },
  { word: 'Ultracrepidarian', definition: 'A person who gives opinions beyond their knowledge.' },
  { word: 'Sonder', definition: 'The realization that strangers have lives as vivid as your own.' },
  { word: 'Susurrus', definition: 'A soft whispering or rustling sound.' },
  { word: 'Mellifluous', definition: 'A sound that is sweet and smooth to hear.' },
  { word: 'Nudiustertian', definition: 'Relating to the day before yesterday.' },
  { word: 'Quincunx', definition: 'An arrangement of five objects with four at the corners and one in the middle.' },
  { word: 'Limerence', definition: 'An intense, involuntary longing for another person.' },
  { word: 'Crapulence', definition: 'Feeling unwell after eating or drinking too much.' },
  { word: 'Borborygmus', definition: 'A rumbling noise made by the stomach.' },
];

const safeName = (value) => String(value || '').trim().replace(/[<>]/g, '').slice(0, 18);
const codeGen = () => crypto.randomBytes(3).toString('hex').toUpperCase();
function send(socket, data) {
  if (!socket || socket.wsOpen !== true || socket.destroyed || socket.writable === false) return;
  const payload = Buffer.from(JSON.stringify(data));
  let head;
  if (payload.length < 126) { head = Buffer.from([0x81, payload.length]); }
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([head, payload]));
}
function broadcast(room) {
  const packet = snapshot(room);
  for (const player of room.players.values()) send(player.socket, { type: 'state', state: packet });
}
function snapshot(room) {
  const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.id === room.hostId, connected: Boolean(p.socket) }));
  const base = { code: room.code, phase: room.phase, players, round: room.round, totalRounds: 5, secondsLeft: room.secondsLeft, hostId: room.hostId, you: room.currentViewer };
  if (room.phase === 'lobby') return { ...base };
  const own = room.players.get(room.currentViewer);
  const viewerId = room.currentViewer;
  const submitted = room.submissions.has(viewerId);
  if (room.phase === 'submit') return { ...base, word: room.word.word, submitted, submissionCount: room.submissions.size };
  if (room.phase === 'vote') {
    return { ...base, word: room.word.word, submitted: room.submissions.has(viewerId), entries: room.entries.map(e => ({ id: e.id, text: e.text, own: e.ownerId === viewerId })), voted: room.votes.has(viewerId), voteCount: room.votes.size };
  }
  if (room.phase === 'reveal' || room.phase === 'finished') {
    return { ...base, word: room.word.word, definition: room.word.definition, entries: room.entries.map(e => ({ text: e.text, author: room.players.get(e.ownerId)?.name || 'Player', isReal: e.real, votes: room.voteCounts.get(e.id) || 0, voters: (room.votersByEntry.get(e.id) || []).map(id => room.players.get(id)?.name || 'Player') })), result: room.result, ...(room.winner ? { winner: room.winner } : {}) };
  }
  return { ...base, submitted, own };
}
function personalizedBroadcast(room) {
  for (const p of room.players.values()) { room.currentViewer = p.id; send(p.socket, { type: 'state', state: snapshot(room) }); }
  delete room.currentViewer;
}
function clearTimer(room) { if (room.timer) clearInterval(room.timer); room.timer = null; }
function startTimer(room, seconds, callback) {
  clearTimer(room); room.secondsLeft = seconds;
  room.timer = setInterval(() => {
    room.secondsLeft -= 1;
    if (room.secondsLeft <= 0) { clearTimer(room); callback(); }
    else personalizedBroadcast(room);
  }, 1000);
}
function startRound(room) {
  room.round += 1;
  room.phase = 'submit';
  room.word = words[(room.round - 1) % words.length];
  room.submissions = new Map(); room.entries = []; room.votes = new Map(); room.voteCounts = new Map(); room.votersByEntry = new Map();
  startTimer(room, 60, () => openVoting(room));
  personalizedBroadcast(room);
}
function openVoting(room) {
  if (room.phase !== 'submit') return;
  room.entries = [...room.submissions].map(([ownerId, text]) => ({ id: crypto.randomUUID(), ownerId, text, real: false }));
  room.entries.push({ id: crypto.randomUUID(), ownerId: null, text: room.word.definition, real: true });
  room.entries.sort(() => Math.random() - 0.5);
  room.phase = 'vote'; room.votes = new Map();
  startTimer(room, 35, () => finishVoting(room));
  personalizedBroadcast(room);
}
function finishVoting(room) {
  if (room.phase !== 'vote') return;
  clearTimer(room);
  room.voteCounts = new Map(); room.votersByEntry = new Map();
  for (const [voter, entryId] of room.votes) {
    room.voteCounts.set(entryId, (room.voteCounts.get(entryId) || 0) + 1);
    if (!room.votersByEntry.has(entryId)) room.votersByEntry.set(entryId, []);
    room.votersByEntry.get(entryId).push(voter);
  }
  const roundPoints = new Map();
  for (const entry of room.entries) {
    const count = room.voteCounts.get(entry.id) || 0;
    if (entry.real) {
      for (const [voter, picked] of room.votes) if (picked === entry.id) roundPoints.set(voter, (roundPoints.get(voter) || 0) + 1);
    } else if (entry.ownerId) {
      roundPoints.set(entry.ownerId, (roundPoints.get(entry.ownerId) || 0) + count * 2);
    }
  }
  for (const [id, points] of roundPoints) { const p = room.players.get(id); if (p) p.score += points; }
  room.result = [...room.players.values()].map(p => ({ id: p.id, name: p.name, points: roundPoints.get(p.id) || 0 }));
  if (room.round >= 5) {
    room.phase = 'finished';
    const high = Math.max(...[...room.players.values()].map(p => p.score));
    room.winner = [...room.players.values()].filter(p => p.score === high).map(p => p.name);
  } else room.phase = 'reveal';
  room.secondsLeft = 9; personalizedBroadcast(room);
  if (room.phase === 'reveal') startTimer(room, 9, () => startRound(room));
}
function leaveRoom(socket) {
  const room = rooms.get(socket.roomCode), player = room?.players.get(socket.playerId);
  if (!room || !player || player.socket !== socket) return;
  send(socket, { type: 'left' });
  room.players.delete(player.id);
  room.submissions?.delete(player.id);
  room.votes?.delete(player.id);
  socket.playerId = null; socket.roomCode = null;
  if (!room.players.size) { clearTimer(room); rooms.delete(room.code); return; }
  if (room.hostId === player.id) room.hostId = [...room.players.values()].find(candidate => candidate.socket)?.id || [...room.players.keys()][0];
  if (room.phase === 'finished') {
    const high = Math.max(...[...room.players.values()].map(candidate => candidate.score));
    room.winner = [...room.players.values()].filter(candidate => candidate.score === high).map(candidate => candidate.name);
  }
  if (room.phase === 'submit' && room.submissions.size >= room.players.size) openVoting(room);
  else if (room.phase === 'vote' && room.votes.size >= room.players.size) finishVoting(room);
  else personalizedBroadcast(room);
}
function handle(socket, message) {
  let data; try { data = JSON.parse(message); } catch { return send(socket, { type: 'error', message: 'That message could not be read.' }); }
  if (data.type === 'resume') {
    const room = rooms.get(String(data.code || '').toUpperCase());
    const player = room?.players.get(String(data.id || ''));
    if (!player) return send(socket, { type: 'error', message: 'This room session has expired. Rejoin from the lobby.' });
    if (player.socket && player.socket !== socket) player.socket.end();
    player.socket = socket; socket.playerId = player.id; socket.roomCode = room.code; personalizedBroadcast(room);
  } else if (data.type === 'create') {
    const name = safeName(data.name); if (!name) return send(socket, { type: 'error', message: 'Enter your name first.' });
    let code; do { code = codeGen(); } while (rooms.has(code));
    const id = crypto.randomUUID(); const room = { code, phase: 'lobby', round: 0, secondsLeft: 0, hostId: id, players: new Map(), timer: null };
    room.players.set(id, { id, name, score: 0, socket }); socket.playerId = id; socket.roomCode = code; rooms.set(code, room); personalizedBroadcast(room);
  } else if (data.type === 'join') {
    const code = String(data.code || '').toUpperCase().trim(), name = safeName(data.name), room = rooms.get(code);
    if (!name) return send(socket, { type: 'error', message: 'Enter your name first.' });
    if (!room) return send(socket, { type: 'error', message: 'Room not found. Check the code and try again.' });
    if (room.phase !== 'lobby') return send(socket, { type: 'error', message: 'This game has already started.' });
    if (room.players.size >= 8) return send(socket, { type: 'error', message: 'This room is full (8 players maximum).' });
    const id = crypto.randomUUID(); room.players.set(id, { id, name, score: 0, socket }); socket.playerId = id; socket.roomCode = code; personalizedBroadcast(room);
  } else if (data.type === 'leave') {
    leaveRoom(socket);
  } else {
    const room = rooms.get(socket.roomCode), player = room?.players.get(socket.playerId);
    if (!room || !player) return;
    if (data.type === 'start') {
      if (player.id !== room.hostId) return send(socket, { type: 'error', message: 'Only the host can start the game.' });
      if (room.players.size < 2) return send(socket, { type: 'error', message: 'Invite at least one more player to start.' });
      if (room.phase === 'lobby') startRound(room);
    } else if (data.type === 'submit' && room.phase === 'submit' && !room.submissions.has(player.id)) {
      const text = String(data.text || '').trim().slice(0, 150);
      if (text.length < 4) return send(socket, { type: 'error', message: 'Write at least 4 characters for your fake definition.' });
      room.submissions.set(player.id, text);
      if (room.submissions.size === room.players.size) openVoting(room); else personalizedBroadcast(room);
    } else if (data.type === 'vote' && room.phase === 'vote' && !room.votes.has(player.id)) {
      const entry = room.entries.find(e => e.id === data.entryId);
      if (!entry) return send(socket, { type: 'error', message: 'That answer is no longer available.' });
      if (entry.ownerId === player.id) return send(socket, { type: 'error', message: 'You cannot vote for your own definition.' });
      room.votes.set(player.id, entry.id);
      if (room.votes.size === room.players.size) finishVoting(room); else personalizedBroadcast(room);
    } else if (data.type === 'next' && player.id === room.hostId && room.phase === 'reveal') {
      clearTimer(room); startRound(room);
    } else if (data.type === 'playAgain' && player.id === room.hostId && room.phase === 'finished') {
      clearTimer(room); room.players.forEach(p => p.score = 0); room.round = 0; room.phase = 'lobby'; personalizedBroadcast(room);
    }
  }
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const file = pathname === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, path.normalize(pathname).replace(/^[/\\]+/, ''));
  const relative = path.relative(PUBLIC, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, contents) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(contents);
  });
});
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // net.Socket.readyState is a read-only string ("open", "readOnly", ...),
  // not the numeric WebSocket.OPEN constant. Track the upgraded connection separately.
  socket.wsOpen = true; let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f, masked = buffer[1] & 0x80; let len = buffer[1] & 0x7f, offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset; if (masked) offset += 4;
      if (buffer.length < offset + len) return;
      let payload = buffer.subarray(offset, offset + len);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + i % 4]; }
      buffer = buffer.subarray(offset + len);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) { socket.write(Buffer.from([0x8a, 0])); continue; }
      if (opcode === 1) handle(socket, payload.toString('utf8'));
    }
  });
  socket.on('close', () => {
    socket.wsOpen = false;
    const room = rooms.get(socket.roomCode), p = room?.players.get(socket.playerId);
    if (p && p.socket === socket) {
      p.socket = null;
      if (room.hostId === p.id) room.hostId = [...room.players.values()].find(candidate => candidate.socket)?.id || room.hostId;
      personalizedBroadcast(room);
    }
  });
  socket.on('error', () => {});
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Bluff Battle is running on http://localhost:${PORT}`));
module.exports = { server, handle, rooms };

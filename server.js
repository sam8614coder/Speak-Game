'use strict';
/* ==========================================================================
   SPEAK ONLINE - game server
   One Node process that
     * serves the web client from ./public
     * runs rooms over WebSocket (/ws): lobby, talk, plan, reveal, results
     * is the single source of truth for the rules (same engine.js as the client)
     * keeps every player's orders SECRET until the reveal
     * relays WebRTC signalling so players can talk to each other by voice
   Voice itself is peer-to-peer; this server never touches audio.
   Run:  npm install && npm start      (PORT env var, default 3000)
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
/* The web client normally lives in ./public. If someone uploaded the files flat (no public folder), fall back to the root. */
const PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'engine.js')) ? path.join(__dirname, 'public')
  : fs.existsSync(path.join(__dirname, 'engine.js')) ? __dirname : null;
if (!PUBLIC) {
  console.error('\nSPEAK: cannot find engine.js. The "public" folder is missing from this deployment.\n' +
    'Upload the WHOLE project including the public/ folder (with engine.js, map-data.js, board.js, audio.js, voice.js, online.js, index.html, fonts/ ...).');
  process.exit(1);
}
const { makeRules } = require(path.join(PUBLIC, 'engine.js'));
const MAP = require(path.join(PUBLIC, 'map-data.js'));

const rules = makeRules(MAP);
const PORT = Number(process.env.PORT || 3000);
const REVEAL_MS = 35000;          // how long the results screen waits for everyone to press Continue
const MAX_PLAYERS = 6;
const LOBBY_GRACE_MS = 45000;
const DROP_GRACE_MS = Number(process.env.DROP_GRACE_MS || 20000); // a dropped player keeps the table waiting this long
const ROOM_IDLE_MS = 15 * 60000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

/* ICE servers for voice. STUN is free; add a TURN server (see README) for strict networks. */
function iceServers() {
  if (process.env.ICE_SERVERS) { try { return JSON.parse(process.env.ICE_SERVERS); } catch (e) { console.error('ICE_SERVERS is not valid JSON'); } }
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  return list;
}

/* ------------------------------------------------------------------ http */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ iceServers: iceServers(), rooms: rooms.size }));
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.woff2' || ext === '.png' ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
});

/* ----------------------------------------------------------------- rooms */
const rooms = new Map();      // code -> room
const byCid = new Map();      // client id -> room code

const now = () => Date.now();
const rid = () => crypto.randomBytes(4).toString('hex');
function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = ''; for (let k = 0; k < 4; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free room codes');
}
function cleanName(s, fallback) {
  const n = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || fallback;
}
function uniqueName(room, name, selfId) {
  const taken = new Set(room.players.filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
  let n = name, c = 2;
  while (taken.has(n.toLowerCase())) n = `${name} ${c++}`.slice(0, 18);
  return n;
}
const connected = (room) => room.players.filter((p) => p.connected);
const playerById = (room, id) => room.players.find((p) => p.id === id);

function makeRoom(host) {
  const code = newCode();
  const room = {
    code, hostId: host.id, players: [host],
    settings: { rounds: 12, talk: 120, plan: 90 },
    phase: 'lobby', gameNo: 0, state: null, report: null, deadline: 0,
    votes: new Set(), submitted: new Map(), timer: null, rings: new Map(), nextLine: 1,
    touched: now(), created: now(),
  };
  rooms.set(code, room);
  return room;
}

function publicState(state) {
  if (!state) return null;
  const s = JSON.parse(JSON.stringify(state));
  delete s.orders;     // never leak planned orders
  delete s.history;
  return s;
}

function snapshot(room, viewer) {
  const planning = room.phase === 'plan';
  const showReport = room.phase === 'reveal' || room.phase === 'over';
  return {
    t: 'snap', code: room.code, you: viewer.id, host: room.hostId, phase: room.phase, gameNo: room.gameNo,
    now: now(), deadline: room.deadline, settings: room.settings, revealMs: REVEAL_MS,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, seat: p.seat == null ? i : p.seat, connected: p.connected, voice: p.voice, line: p.line,
      voted: room.votes.has(p.id), locked: planning ? room.submitted.has(p.id) : false,
    })),
    state: publicState(room.state), report: showReport ? room.report : null,
  };
}
function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closed */ } } }
function broadcast(room) {
  room.touched = now();
  room.players.forEach((p) => { if (p.connected) send(p.ws, snapshot(room, p)); });
}
function toast(p, msg) { if (p && p.connected) send(p.ws, { t: 'notice', msg }); }

/* ------------------------------------------------------------- phase flow */
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function setPhase(room, phase, ms, onTimeout) {
  if (process.env.SPEAK_DEBUG) console.log('[phase]', room.code, room.phase, '->', phase, new Error().stack.split('\n').slice(2,6).map(x=>x.trim().split(' ')[1]).join('<'));
  clearTimer(room);
  room.phase = phase; room.votes = new Set();
  room.deadline = ms > 0 ? now() + ms : 0;
  if (ms > 0 && onTimeout) room.timer = setTimeout(() => { room.timer = null; onTimeout(); }, ms);
}
const seatOf = (room, p) => (p.seat == null ? -1 : p.seat);
const needsOrders = (room, p) => p.seat != null && rules.needsOrders(room.state, p.seat);

function startGame(room) {
  const ps = room.players.filter((p) => p.connected);
  room.players = ps;
  if (!ps.some((p) => p.id === room.hostId)) room.hostId = ps[0].id;
  const used = new Set();
  ps.forEach((p) => { let n = p.name, c = 2; while (used.has(n.toLowerCase())) n = `${p.name} ${c++}`.slice(0, 18); used.add(n.toLowerCase()); p.name = n; });
  ps.forEach((p, i) => { p.seat = i; });
  room.state = rules.newGame({ players: ps.map((p) => ({ name: p.name })), maxRounds: room.settings.rounds });
  room.report = null; room.gameNo++;
  enterTalk(room);
}
function enterTalk(room) {
  setPhase(room, 'talk', room.settings.talk * 1000, () => enterPlan(room));
  broadcast(room);
}
function enterPlan(room) {
  if (room.phase !== 'talk') return;
  room.submitted = new Map();
  setPhase(room, 'plan', room.settings.plan * 1000, () => resolve(room));
  room.players.forEach((p) => { if (!needsOrders(room, p)) room.submitted.set(p.id, {}); }); // nothing to wait for
  broadcast(room);
  checkAllSubmitted(room);
}
function checkAllSubmitted(room) {
  if (room.phase !== 'plan') return;
  if (room.players.every((p) => room.submitted.has(p.id) || !needsOrders(room, p) || (!p.connected && now() - p.dropAt >= DROP_GRACE_MS))) resolve(room);
}
function resolve(room) {
  if (room.phase !== 'plan') return;
  let state = room.state;
  room.players.forEach((p) => {
    if (p.seat == null || !rules.needsOrders(state, p.seat)) return;
    state = rules.submitOrders(state, p.seat, room.submitted.get(p.id) || {});  // missing orders become holds
  });
  const res = rules.resolveRound(state);
  room.state = res.state; room.report = res.report; room.submitted = new Map();
  setPhase(room, 'reveal', REVEAL_MS, () => afterReveal(room));
  broadcast(room);
}
function afterReveal(room) {
  if (room.phase !== 'reveal') return;
  if (room.state.over) { setPhase(room, 'over', 0); broadcast(room); } else enterTalk(room);
}
function checkVotes(room) {
  if (room.phase !== 'talk' && room.phase !== 'reveal') return;
  const live = connected(room);
  if (live.length && live.every((p) => room.votes.has(p.id))) {
    if (room.phase === 'talk') enterPlan(room); else afterReveal(room);
  }
}

/* ---------------------------------------------------------------- players */
function leaveLine(room, p) {
  const old = p.line; p.line = 'all';
  if (old !== 'all') {
    const rest = room.players.filter((q) => q.line === old);
    if (rest.length < 2) rest.forEach((q) => { q.line = 'all'; });
  }
}
function releaseIfAlone(room, p) {
  if (p.line === 'all') return;
  const pending = Array.from(room.rings.keys()).some((k) => k.endsWith(':' + p.id));
  if (pending) return;
  if (room.players.filter((q) => q.line === p.line).length < 2) p.line = 'all';
}
function removePlayer(room, p, why) {
  leaveLine(room, p);
  room.players = room.players.filter((q) => q.id !== p.id);
  byCid.delete(p.cid);
  room.votes.delete(p.id);
  if (!room.players.length) { destroyRoom(room); return; }
  if (room.hostId === p.id) room.hostId = (connected(room)[0] || room.players[0]).id;
  broadcast(room);
}
function destroyRoom(room) {
  clearTimer(room);
  room.players.forEach((p) => byCid.delete(p.cid));
  rooms.delete(room.code);
}
function dropConnection(p) {
  const room = p.room; if (!room || !rooms.has(room.code)) return;
  p.connected = false; p.ws = null; p.voice = false; p.dropAt = now();
  leaveLine(room, p);
  if (room.hostId === p.id) { const nh = connected(room)[0]; if (nh) room.hostId = nh.id; }
  if (room.phase === 'lobby') {
    p.graceTimer = setTimeout(() => { if (!p.connected && rooms.has(room.code) && room.phase === 'lobby') removePlayer(room, p, 'timeout'); }, LOBBY_GRACE_MS);
  } else if (room.phase === 'plan') setTimeout(() => checkAllSubmitted(room), DROP_GRACE_MS + 50);
  else checkVotes(room);
  if (!connected(room).length) { room.emptySince = now(); }
  broadcast(room);
}
function attach(room, p, ws) {
  if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; }
  if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
  p.ws = ws; p.connected = true; p.room = room; ws.player = p; room.emptySince = 0;
  byCid.set(p.cid, room.code);
}

/* --------------------------------------------------------------- messages */
function handle(ws, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  const t = msg.t;
  if (t === 'ping') { send(ws, { t: 'pong' }); return; }

  if (t === 'hello') {
    const cid = String(msg.cid || '').slice(0, 64);
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(cid)) { send(ws, { t: 'error', msg: 'Bad client id.' }); return; }
    ws.cid = cid;
    const code = byCid.get(cid);
    const room = code && rooms.get(code);
    const p = room && room.players.find((q) => q.cid === cid);
    if (p) { attach(room, p, ws); if (msg.name) { p.name = room.phase === 'lobby' ? uniqueName(room, cleanName(msg.name, p.name), p.id) : p.name; } send(ws, { t: 'hello-ok', rejoined: true }); broadcast(room); }
    else send(ws, { t: 'hello-ok', rejoined: false });
    return;
  }
  if (!ws.cid) { send(ws, { t: 'error', msg: 'Say hello first.' }); return; }

  if (t === 'create') {
    if (ws.player) return;
    if (rooms.size > 500) { send(ws, { t: 'error', msg: 'The server is full right now. Try again soon.' }); return; }
    const p = { id: rid(), cid: ws.cid, name: cleanName(msg.name, 'Player 1'), ws: null, connected: false, voice: false, line: 'all', seat: null, room: null };
    const room = makeRoom(p); attach(room, p, ws); broadcast(room);
    return;
  }
  if (t === 'join') {
    if (ws.player) return;
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const room = rooms.get(code);
    if (!room) { send(ws, { t: 'error', msg: `No room called ${code || '????'}. Check the code.`, code: 'no-room' }); return; }
    if (room.phase !== 'lobby') { send(ws, { t: 'error', msg: 'That game already started.', code: 'started' }); return; }
    if (room.players.length >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'That room is full (6 players).', code: 'full' }); return; }
    const p = { id: rid(), cid: ws.cid, name: '', ws: null, connected: false, voice: false, line: 'all', seat: null, room };
    p.name = uniqueName(room, cleanName(msg.name, `Player ${room.players.length + 1}`), p.id);
    room.players.push(p); attach(room, p, ws); broadcast(room);
    return;
  }

  const p = ws.player; const room = p && p.room;
  if (!room || !rooms.has(room.code)) { send(ws, { t: 'error', msg: 'You are not in a room.', code: 'no-room' }); return; }
  const isHost = room.hostId === p.id;

  switch (t) {
    case 'leave': removePlayer(room, p, 'left'); ws.player = null; send(ws, { t: 'left' }); break;
    case 'name':
      if (room.phase === 'lobby') { p.name = uniqueName(room, cleanName(msg.name, p.name), p.id); broadcast(room); }
      break;
    case 'settings': {
      if (!isHost || room.phase !== 'lobby') break;
      const pick = (v, allowed, d) => (allowed.includes(Number(v)) ? Number(v) : d);
      room.settings = {
        rounds: pick(msg.rounds, [8, 12, 16, 0], room.settings.rounds),
        talk: pick(msg.talk, [0, 60, 120, 180, 300], room.settings.talk),
        plan: pick(msg.plan, [0, 45, 90, 120, 180], room.settings.plan),
      };
      broadcast(room); break;
    }
    case 'start':
      if (!isHost || room.phase !== 'lobby') break;
      if (connected(room).length < 2) { toast(p, 'You need at least 2 players.'); break; }
      startGame(room); break;
    case 'planvote':
      if (room.phase === 'talk') { room.votes.add(p.id); broadcast(room); checkVotes(room); } break;
    case 'ready':
      if (room.phase === 'reveal') { room.votes.add(p.id); broadcast(room); checkVotes(room); } break;
    case 'skip':   // host: end the talking now / stop waiting for stragglers
      if (!isHost) break;
      if (room.phase === 'talk') enterPlan(room);
      else if (room.phase === 'plan') resolve(room);
      else if (room.phase === 'reveal') afterReveal(room);
      break;
    case 'orders': {
      if (room.phase !== 'plan' || !needsOrders(room, p) || typeof msg.orders !== 'object' || !msg.orders) break;
      const mine = new Set(rules.unitsOf(room.state, p.seat).map((u) => String(u.id)));
      const clean = {};
      Object.keys(msg.orders).forEach((k) => { if (mine.has(k)) clean[k] = msg.orders[k]; });
      room.submitted.set(p.id, clean);
      broadcast(room); checkAllSubmitted(room); break;
    }
    case 'unlock':
      if (room.phase === 'plan' && room.submitted.has(p.id) && needsOrders(room, p)) { room.submitted.delete(p.id); broadcast(room); }
      break;
    case 'rematch':
      if (!isHost || room.phase !== 'over') break;
      clearTimer(room); room.phase = 'lobby'; room.state = null; room.report = null; room.deadline = 0; room.votes = new Set();
      room.players = connected(room); room.players.forEach((q) => { q.seat = null; });
      broadcast(room); break;

    /* ---- voice ---- */
    case 'voice':
      p.voice = !!msg.on; if (!p.voice) leaveLine(room, p);
      broadcast(room); break;
    case 'rtc': {
      const to = playerById(room, String(msg.to || ''));
      if (to && to.connected && msg.data && typeof msg.data === 'object') send(to.ws, { t: 'rtc', from: p.id, data: msg.data });
      break;
    }
    case 'call': {
      const to = playerById(room, String(msg.to || ''));
      if (!to || to.id === p.id || !to.connected) { toast(p, `${to ? to.name : 'They'} isn't here right now.`); break; }
      if (p.line !== 'all' && p.line === to.line) break;
      if (p.line === 'all') p.line = `L${room.nextLine++}`;   // the caller waits on their own line while it rings
      const key = `${to.id}:${p.id}`;
      const old = room.rings.get(key); if (old) clearTimeout(old.timer);
      const entry = { timer: null };
      entry.timer = setTimeout(() => {
        if (room.rings.get(key) !== entry) return;
        room.rings.delete(key);
        toast(p, `${to.name} didn't pick up.`);
        send(to.ws, { t: 'ring-cancel', from: p.id });
        releaseIfAlone(room, p); broadcast(room);
      }, 30000);
      room.rings.set(key, entry);
      send(to.ws, { t: 'ring', from: p.id, name: p.name });
      broadcast(room); break;
    }
    case 'cancel': {
      const to = playerById(room, String(msg.to || ''));
      const key = `${String(msg.to)}:${p.id}`; const r = room.rings.get(key);
      if (r) { clearTimeout(r.timer); room.rings.delete(key); }
      if (to) send(to.ws, { t: 'ring-cancel', from: p.id });
      releaseIfAlone(room, p); broadcast(room); break;
    }
    case 'answer': {
      const caller = playerById(room, String(msg.to || ''));
      const key = `${p.id}:${String(msg.to)}`;
      const r = room.rings.get(key);
      if (!caller || !r) break;
      clearTimeout(r.timer); room.rings.delete(key);
      if (!msg.accept) { toast(caller, `${p.name} declined the call.`); releaseIfAlone(room, caller); broadcast(room); break; }
      if (!caller.connected || caller.line === 'all') { toast(p, 'They hung up.'); break; }
      if (p.line !== caller.line) { leaveLine(room, p); p.line = caller.line; }
      broadcast(room); break;
    }
    case 'hangup': leaveLine(room, p); broadcast(room); break;
    default: break;
  }
}

/* -------------------------------------------------------------- websocket */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  ws.alive = true; ws.hits = 0; ws.cid = null; ws.player = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    ws.hits++;
    if (ws.hits > 200) return;                     // crude flood guard (reset every second)
    let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error('handler error', e); send(ws, { t: 'error', msg: 'Something went wrong on the server.' }); }
  });
  ws.on('close', () => { if (ws.player && ws.player.ws === ws) dropConnection(ws.player); });
  ws.on('error', () => { /* ignore */ });
});
setInterval(() => { wss.clients.forEach((ws) => { ws.hits = 0; if (!ws.alive) { ws.terminate(); return; } ws.alive = false; try { ws.ping(); } catch (e) { /* ignore */ } }); }, 25000);
setInterval(() => {
  const t = now();
  rooms.forEach((room) => {
    if (!connected(room).length && (t - (room.emptySince || room.touched)) > ROOM_IDLE_MS) destroyRoom(room);
  });
}, 60000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`SPEAK online server listening on http://localhost:${PORT}`));
}
module.exports = { server, rooms, wss };

'use strict';
const test = require('node:test'); const assert = require('node:assert');
const WebSocket = require('ws');
process.env.PORT = '0';
const { server } = require('../server.js');
let port;
const ready = new Promise((r) => server.listen(0, () => { port = server.address().port; r(); }));

function client(cid) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`); const c = { ws, snap: null, msgs: [], waiters: [] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'snap') c.snap = m; c.waiters = c.waiters.filter((w) => !w(m)); });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (f) => new Promise((res) => { if (c.snap && f(c.snap)) return res(c.snap); c.waiters.push((m) => { if (m.t === 'snap' && f(m)) { res(m); return true; } return false; }); });
  c.hello = async (name) => { await c.open; c.send({ t: 'hello', cid, name }); await new Promise((r) => c.waiters.push((m) => m.t === 'hello-ok' && (r(m), true))); };
  return c;
}
test('full flow, secrecy, reconnect', async () => {
  await ready;
  const a = client('aaaaaaaa1'), b = client('bbbbbbbb2');
await a.hello('Ann'); await b.hello('Bob');
  a.send({ t: 'create', name: 'Ann' });
  const s1 = await a.wait((s) => s.phase === 'lobby');
  assert.equal(s1.code.length, 4);
  b.send({ t: 'join', code: s1.code.toLowerCase(), name: 'Ann' });
  const s2 = await b.wait((s) => s.players.length === 2);
  assert.notEqual(s2.players[0].name, s2.players[1].name);
  b.send({ t: 'start' }); await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.snap.phase, 'lobby'); // only host can start
  a.send({ t: 'settings', rounds: 8, talk: 60, plan: 45 });
  a.send({ t: 'start' });
  await a.wait((s) => s.phase === 'talk'); await b.wait((s) => s.phase === 'talk');
  a.send({ t: 'planvote' }); b.send({ t: 'planvote' });
  const p = await a.wait((s) => s.phase === 'plan');
  assert.ok(!('orders' in p.state));
  const u = p.state.units.find((x) => x.owner === 0);
  a.send({ t: 'orders', orders: { [u.id]: { type: 'hold' } } });
  const sb = await b.wait((s) => s.phase === 'plan' && s.players.find((q) => q.name === 'Ann').locked);
  assert.ok(!JSON.stringify(sb).includes('"hold"'), 'orders must not leak');
  // Bob drops and reconnects mid-plan
  b.ws.close(); await new Promise((r) => setTimeout(r, 80));
  const b2 = client('bbbbbbbb2'); await b2.hello('Bob');
  const rj = await b2.wait((s) => s.phase === 'plan'); assert.equal(rj.players.length, 2);
  const ub = rj.state.units.filter((x) => x.owner === 1);
  b2.send({ t: 'orders', orders: Object.fromEntries(ub.map((x) => [x.id, { type: 'hold' }])) });
  const rv = await a.wait((s) => s.phase === 'reveal');
  assert.ok(rv.report && rv.report.orders);
  a.send({ t: 'ready' }); b2.send({ t: 'ready' });
  const t2 = await a.wait((s) => s.phase === 'talk' && s.state.round === 2);
  assert.ok(t2);
});
test('rooms: bad code, voice call lines', async () => {
  await ready;
  const a = client('cccccccc3'), b = client('dddddddd4'), c = client('eeeeeeee5');
  await a.hello('A'); await b.hello('B'); await c.hello('C');
  b.send({ t: 'join', code: 'ZZZZ' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(b.msgs.some((m) => m.t === 'error' && m.code === 'no-room'));
  a.send({ t: 'create', name: 'A' }); const s = await a.wait((x) => x.phase === 'lobby');
  b.send({ t: 'join', code: s.code, name: 'B' }); c.send({ t: 'join', code: s.code, name: 'C' });
  await a.wait((x) => x.players.length === 3);
  const ids = Object.fromEntries(a.snap.players.map((p) => [p.name, p.id]));
  [a, b, c].forEach((x) => x.send({ t: 'voice', on: true }));
  await a.wait((x) => x.players.every((p) => p.voice));
  a.send({ t: 'call', to: ids.B });
  await new Promise((r) => b.waiters.push((m) => m.t === 'ring' && (r(), true)));
  b.send({ t: 'answer', to: ids.A, accept: true });
  const sn = await a.wait((x) => x.players.find((p) => p.name === 'B').line !== 'all');
  const L = sn.players.find((p) => p.name === 'A').line;
  assert.equal(sn.players.find((p) => p.name === 'B').line, L);
  assert.equal(sn.players.find((p) => p.name === 'C').line, 'all');
  b.send({ t: 'hangup' });
  const sh = await a.wait((x) => x.players.every((p) => p.line === 'all'));
  assert.ok(sh);
  // rtc relay only inside a room
  a.send({ t: 'rtc', to: ids.C, data: { c: {} } });
  await new Promise((r) => c.waiters.push((m) => m.t === 'rtc' && (r(), true)));
});

test('done', () => { setTimeout(() => process.exit(0), 100); });

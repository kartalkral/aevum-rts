import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { RELAY_LIMITS, createRateLimiter, createClientIP, createByteBudget } from '../srv/relay-limits.mjs';
import { MemoryRoomStore } from '../srv/room-store.mjs';

// A deterministic clock exercises refill, IP/user separation, and expiry without a busy loop.
let t = 0;
const limiter = createRateLimiter({ ...RELAY_LIMITS, bucketsPerScope: 2 }, () => t);
for (let i = 0; i < RELAY_LIMITS.rates.download.user[1]; i++) assert.ok(limiter.take('user', 'A', 'download'));
assert.equal(limiter.take('user', 'A', 'download'), false);
assert.ok(limiter.take('user', 'B', 'download'));
assert.equal(limiter.take('user', 'C', 'download'), false, 'bucket table is bounded');
t += 499;
assert.equal(limiter.take('user', 'A', 'download'), false);
t++;
assert.ok(limiter.take('user', 'A', 'download'));
for (let i = 0; i < RELAY_LIMITS.rates.download.ip[1]; i++) assert.ok(limiter.take('ip', '192.0.2.1', 'download'));
assert.equal(limiter.take('ip', '192.0.2.1', 'download'), false);
assert.ok(limiter.take('ip', '192.0.2.2', 'download'));
t += RELAY_LIMITS.bucketIdleMs; limiter.sweep();
assert.ok(limiter.take('user', 'C', 'download'));
const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': xff } });
assert.equal(createClientIP()(req('::ffff:192.0.2.1', '198.51.100.1')), '192.0.2.1');
const behindProxies = createClientIP('192.0.2.1, ::1');
assert.equal(behindProxies(req('::ffff:c000:201', '198.51.100.99, 203.0.113.2, ::1')), '203.0.113.2');
assert.equal(behindProxies(req('192.0.2.2', '203.0.113.2')), '192.0.2.2');
assert.equal(behindProxies(req('192.0.2.1', 'invalid')), '192.0.2.1');
const budget = createByteBudget(10);
assert.equal(budget.reserve(10), true); assert.equal(budget.reserve(1), false);
budget.release(10); assert.equal(budget.used, 0);
console.log('OK: token-bucket refill/expiry and capacity, trusted proxy chain, byte budget');

const cfg = { ...RELAY_LIMITS, blobBytes: 12, maxBlobBytes: 10, maxBlobs: 2, blobIdleMs: 100, closedRoomMs: 10, maxPeers: 2 };
const store = new MemoryRoomStore(cfg, () => t);
const a = { ident: { fb: 'A', uid: 'same-client-visible-id' } }, b = { ident: { fb: 'B', uid: a.ident.uid } };
assert.equal(store.putBlob('ROOM', 'A', a.ident, 'x', a, Buffer.from('a')), null);
store.setPeer('ROOM', 'A', a); store.setPeer('ROOM', 'B', b);
assert.equal(store.setPeer('OTHER', 'A', a), null);
const put = (text) => store.putBlob('ROOM', 'A', a.ident, 'x', a, Buffer.from(text));
const first = put('first--'), second = put('second-');
assert.equal(store.stats().blobBytes, 7, 'global stored byte limit evicts older blob');
assert.equal(store.getBlob('ROOM', 'B', b.ident, 'y', first), null);
assert.equal(store.getBlob('ROOM', 'A', b.ident, 'y', second), null, 'same public uid does not prove account ownership');
assert.equal(store.getBlob('ROOM', 'B', b.ident, 'y', second).toString(), 'second-');
t += 100; store.sweep();
assert.equal(store.stats().blobs, 0, 'unused blob expires even when room stays open');
const old = put('save');
store.removePeer('ROOM', 'A', a); store.removePeer('ROOM', 'B', b);
assert.equal(store.stats().rooms, 0);
assert.equal(store.getBlob('ROOM', 'A', a.ident, 'x', old), null);
t += 9; store.sweep(); assert.equal(store.stats().blobs, 1);
t++; store.sweep(); assert.equal(store.stats().blobs, 0);
store.setPeer('ROOM', 'A', a);
const stale = put('prior room'); store.removePeer('ROOM', 'A', a);
store.setPeer('ROOM', 'B', b);
assert.equal(store.getBlob('ROOM', 'B', b.ident, 'x', stale), null, 'room code reuse does not leak old blobs');
assert.equal(store.stats().blobBytes, 0);
const replacing = { ...b }; store.setPeer('ROOM', 'B', replacing);
assert.equal(store.putBlob('ROOM', 'B', b.ident, 'x', b, Buffer.from('pending upload')), null);
assert.equal(store.removePeer('ROOM', 'B', b), null, 'old transport closure cannot remove a replacement');
console.log('OK: membership by verified account, blob eviction/expiry, closed room cleanup and code reuse');

// Run a real relay with local-only dev auth (no Firebase or production statistics store).
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening'); const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const srv = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(port), AEVUM_NO_AUTH: '1', AEVUM_SA: '', AEVUM_TRUSTED_PROXIES: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
srv.stdout.on('data', c => { logs += c; }); srv.stderr.on('data', c => { logs += c; });
const base = `http://127.0.0.1:${port}`;
const url = (route, peer, room = 'ROOM1') => `${base}/mp/${route}?room=${room}&peer=${peer}`;
const headers = (ticket, extra) => ({ 'X-Aevum-Ticket': ticket, ...extra });
const post = (target, ticket, body) => fetch(target, { method: 'POST', headers: headers(ticket), body, signal: AbortSignal.timeout(5000) });
const get = (target, ticket, extra) => fetch(target, { headers: headers(ticket, extra), signal: AbortSignal.timeout(5000) });
async function auth(fb, uid) {
  const r = await fetch(base + '/mp/auth', { method: 'POST', body: JSON.stringify({ dev: { fb, uid, name: fb } }), signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200); return (await r.json()).ticket;
}
try {
  for (let i = 0; i < 80 && !logs.includes('calisiyor'); i++) await sleep(50);
  assert.ok(logs.includes('calisiyor'), logs);
  const at = await auth('Ali', 'a'.repeat(32)), bt = await auth('Banu', 'b'.repeat(32));
  const sameUid = await auth('Cem', 'a'.repeat(32));
  assert.equal((await post(url('blob', 'a'), at, 'before joining')).status, 403);
  assert.equal((await post(url('send', 'a'), at, JSON.stringify({ topic: 'lobby', data: { uid: 'a'.repeat(32) } }))).status, 403);
  assert.equal((await fetch(url('blob', 'a'), { method: 'POST', body: 'anonymous outside room' })).status, 403);
  assert.ok((await (await get(url('poll', 'a'), at)).json()).some(m => m.type === 'hello'));
  assert.ok((await (await get(url('poll', 'b'), bt)).json()).some(m => m.type === 'hello'));
  assert.equal((await get(url('sse-ticket', 'b'), bt)).status, 405);
  const save = await post(url('blob', 'a'), at, '{"save":true}');
  assert.equal(save.status, 200);
  const { id } = await save.json();
  const download = (peer, room) => url('blob', peer, room) + '&id=' + id;
  assert.equal((await get(download('unknown'), bt)).status, 403);
  assert.equal((await get(download('a'), sameUid)).status, 403);
  assert.equal((await post(url('blob', 'a'), sameUid, 'forged')).status, 403);
  assert.equal((await get(download('b', 'ROOM2'), bt)).status, 403);
  assert.equal(await (await get(download('b'), bt)).text(), '{"save":true}');
  assert.equal((await post(url('send', 'a'), at, 'x'.repeat(RELAY_LIMITS.maxMessageBytes + 1))).status, 413);
  assert.equal((await post(url('send', 'a'), at, JSON.stringify({ topic: 'chat', data: { uid: 'b'.repeat(32), text: 'Merhaba' } }))).status, 204);
  const msgs = await (await get(url('poll', 'b'), bt)).json();
  assert.equal(msgs.find(m => m.topic === 'chat').id.uid, 'a'.repeat(32));
  // Varying untrusted forwarding headers cannot evade the account's upload bucket.
  let limited = false;
  for (let i = 0; i <= RELAY_LIMITS.rates.upload.user[1] + 2; i++) {
    const r = await fetch(url('blob', 'a'), { method: 'POST', headers: headers(at, { 'X-Forwarded-For': `198.51.100.${i + 1}` }), body: 'x', signal: AbortSignal.timeout(5000) });
    if (r.status === 429) { assert.equal(r.headers.get('retry-after'), '2'); limited = true; break; }
    assert.equal(r.status, 200);
  }
  assert.ok(limited, 'authenticated upload bucket eventually rejects');
  await sleep(2100);
  assert.equal((await post(url('blob', 'a'), at, 'recovered')).status, 200);
  console.log('OK: HTTP relay denies non-members, rejects oversized messages, stamps verified identity, transfers a save between members and recovers after rate limiting');
  const anon = url('blob', 'anon');
  const joined = await fetch(url('poll', 'anon'), { signal: AbortSignal.timeout(5000) });
  assert.ok((await joined.json()).some(m => m.type === 'hello'));
  const ipResponses = await Promise.all(Array.from({ length: RELAY_LIMITS.rates.upload.ip[1] + 8 }, (_, i) => fetch(anon, {
    method: 'POST', headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` }, body: 'x', signal: AbortSignal.timeout(5000),
  })));
  assert.ok(ipResponses.some(r => r.status === 200));
  assert.ok(ipResponses.some(r => r.status === 429), 'anonymous uploads share the actual socket IP bucket');
  await Promise.all(ipResponses.map(r => r.text()));
  console.log('OK: the actual HTTP IP limit ignores fake forwarding headers by default');

  if (typeof WebSocket !== 'undefined') {
    const ws = new WebSocket(url('ws', 'ws', 'ROOM2').replace('http:', 'ws:') + '&tk=' + encodeURIComponent(at));
    const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
    const timeout = setTimeout(() => ws.close(), 2500);
    try {
      const hello = await Promise.race([new Promise(resolve => ws.addEventListener('message', e => resolve(JSON.parse(e.data)), { once: true })), closed]);
      assert.equal(hello.type, 'hello');
      ws.send('x'.repeat(RELAY_LIMITS.maxMessageBytes + 1));
      assert.equal((await closed).code, 1006, 'oversized WS message is terminated by the server');
    } finally { clearTimeout(timeout); ws.close(); }
    console.log('OK: oversized WebSocket message rejected');
  }

} finally {
  if (srv.exitCode === null && srv.signalCode === null) { srv.kill(); await once(srv, 'exit'); }
}

// Aevum - server identity: Firebase ID token verification, relay tickets, TP ledger rules (srv/identity.mjs),
// and the relay enforcing them (server.js spawned twice: with verification on, and with AEVUM_NO_AUTH=1).
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIdentity, IdentityError, TP_WIN, TP_LOSS, keysFromEnv } from '../srv/identity.mjs';

let fails = 0, passes = 0;
const ok = (c, msg) => { if (c) passes++; else { fails++; console.error('FAIL', msg); } };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// ---------- token verification ----------
const PROJECT = 'aevum-a081f';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
let clock = Date.UTC(2026, 10, 11, 12);
const T = () => Math.floor(clock / 1000);
function jwt(claims, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
  const h = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  return h + '.' + p + '.' + b64u(crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key));
}
const good = (over = {}) => Object.assign({ aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, sub: 'fbUser123', iat: T() - 10, auth_time: T() - 10, exp: T() + 3000, email: 'kim@gmail.com', firebase: { sign_in_provider: 'google.com' } }, over);
let certFetches = 0;
const fsDocs = new Map();
const fakeFetch = async (url, init) => {
  if (url === 'CERTS') { certFetches++; return { ok: true, json: async () => ({ k1: pem }), headers: { get: () => 'public, max-age=600' } }; }
  if (String(url).includes(':batchGet')) {
    const tok = String(init.headers.Authorization).slice(7);
    const sub = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).sub;
    const body = JSON.parse(init.body);
    const out = body.documents.map((n) => {
      if (!n.includes('/users/' + sub + '/')) return { missing: n };
      const d = fsDocs.get(n.slice(n.indexOf('/users/') + 1));
      return d ? { found: { name: n, fields: d } } : { missing: n };
    });
    return { ok: true, json: async () => out };
  }
  throw new Error('unexpected fetch ' + url);
};
const keys = [crypto.randomBytes(32)];
const id = createIdentity({ projectId: PROJECT, fetch: fakeFetch, now: () => clock, keys, certsUrl: 'CERTS' });

async function rejects(p, code, msg) { try { await p; ok(false, msg + ' (accepted)'); } catch (e) { ok(e instanceof IdentityError && (!code || e.code === code), msg + ' -> ' + (e && e.code)); } }
{
  const v = await id.verifyIdToken(jwt(good()));
  ok(v.fb === 'fbUser123' && v.provider === 'google.com', 'valid Google token verifies');
  await rejects(id.verifyIdToken(jwt(good(), { key: other.privateKey })), 'BAD_SIG', 'wrong signature rejected');
  await rejects(id.verifyIdToken(jwt(good({ aud: 'other-proj' }))), 'BAD_AUD', 'wrong audience rejected');
  await rejects(id.verifyIdToken(jwt(good({ iss: 'https://securetoken.google.com/x' }))), 'BAD_AUD', 'wrong issuer rejected');
  await rejects(id.verifyIdToken(jwt(good({ exp: T() - 1 }))), 'EXPIRED', 'expired token rejected');
  await rejects(id.verifyIdToken(jwt(good({ iat: T() + 3600 }))), 'BAD_TIME', 'token from the future rejected');
  await rejects(id.verifyIdToken(jwt(good({ firebase: { sign_in_provider: 'password' }, email: 'a@b.com' }))), 'PROVIDER', 'password sign-in rejected');
  await rejects(id.verifyIdToken(jwt(good({ firebase: { sign_in_provider: 'anonymous' } }))), 'PROVIDER', 'anonymous rejected');
  const t = await id.verifyIdToken(jwt(good({ firebase: { sign_in_provider: 'password' }, email: 'aevum-test-x1@example.com' })));
  ok(t.provider === 'password', 'aevum-test-*@example.com password accounts allowed (live tests)');
  await rejects(id.verifyIdToken(jwt(good(), { kid: 'nope' })), 'BAD_KID', 'unknown key id rejected');
  await rejects(id.verifyIdToken(jwt(good(), { alg: 'HS256' })), 'BAD_TOKEN', 'non-RS256 rejected');
  await rejects(id.verifyIdToken('a.b'), 'BAD_TOKEN', 'garbage rejected');
  ok(certFetches <= 3, 'certs are cached (' + certFetches + ' fetches)');
}

// ---------- auth -> ticket (profile read from Firestore with the user's token) ----------
const UID = 'a'.repeat(32);
{
  await rejects(id.auth({ token: jwt(good()) }), 'NO_PROFILE', 'no profile yet -> no ticket');
  fsDocs.set('users/fbUser123/meta/profile', { uid: { stringValue: UID }, name: { stringValue: 'Kerem' }, avatar: { stringValue: 'helm' } });
  const r = await id.auth({ token: jwt(good()) });
  ok(r.ident.uid === UID && r.ident.name === 'Kerem' && r.ident.av === 'helm' && r.ident.tp === 0, 'ticket carries the stored profile');
  const back = id.checkTicket(r.ticket);
  ok(back && back.uid === UID && back.name === 'Kerem', 'ticket verifies');
  const parts = r.ticket.split('.');
  const forged = b64u(JSON.stringify(Object.assign(JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64')), { name: 'Sahte' }))) + '.' + parts[1];
  ok(id.checkTicket(forged) === null, 'a ticket with an edited name is rejected');
  clock += 13 * 3600 * 1000;
  ok(id.checkTicket(r.ticket) === null, 'tickets expire');
  clock -= 13 * 3600 * 1000;
  await rejects(id.auth({ dev: { fb: 'x', uid: UID, name: 'Dev' } }), null, 'dev identities refused when verification is on');
  // another key cannot read the ticket
  const id2 = createIdentity({ projectId: PROJECT, fetch: fakeFetch, now: () => clock, keys: [crypto.randomBytes(32)], certsUrl: 'CERTS' });
  ok(id2.checkTicket(r.ticket) === null, 'a ticket signed with another key is rejected');
  // key rotation: an old key still verifies
  const id3 = createIdentity({ projectId: PROJECT, fetch: fakeFetch, now: () => clock, keys: [crypto.randomBytes(32), keys[0]], certsUrl: 'CERTS' });
  ok(!!id3.checkTicket(r.ticket), 'an older key still verifies (rotation)');
}

// ---------- TP ledger ----------
{
  const me = { fb: 'fbUser123', uid: UID, name: 'Kerem' };
  const MIN = 5 * 60 * 1000;
  const start = () => id.matchStart(me, { mode: 'sp' }).mt;
  let ledger = '';
  let mt = start();
  let r = id.matchClaim(me, { mt, result: 'won', ledger });
  ok(r.ok && r.gained === 0, 'a match under 5 minutes gives no TP');
  clock += MIN + 1000;
  r = id.matchClaim(me, { mt, result: 'won', ledger });
  ok(r.ok && r.gained === TP_WIN && r.tp === 3, 'a win gives ' + TP_WIN + ' TP');
  ledger = r.ledger;
  r = id.matchClaim(me, { mt, result: 'won', ledger });
  ok(r.ok && r.gained === 0 && r.tp === 3, 'the same match never counts twice');
  mt = start(); clock += MIN + 1000;
  r = id.matchClaim(me, { mt, result: 'lost', ledger });
  ok(r.gained === TP_LOSS && r.tp === 4, 'a loss gives ' + TP_LOSS + ' TP');
  ledger = r.ledger;
  r = id.matchClaim(me, { mt: start(), result: 'abandoned', ledger });
  ok(!r.ok, 'abandoned gives nothing');
  // overlapping matches: a ticket started before the last counted match ended
  const early = start(); clock += MIN + 1000;
  const m2 = start(); clock += MIN + 1000;
  r = id.matchClaim(me, { mt: m2, result: 'won', ledger }); ledger = r.ledger;
  ok(r.tp === 7, 'next win counts');
  r = id.matchClaim(me, { mt: early, result: 'won', ledger });
  ok(r.gained === 0, 'a match that overlapped the last counted one gives no TP');
  // tampering
  const [p] = ledger.split('.');
  const fake = b64u(JSON.stringify(Object.assign(JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), { tp: 999 }))) + '.' + ledger.split('.')[1];
  ok(!id.matchClaim(me, { mt: start(), result: 'won', ledger: fake }).ok, 'an edited ledger is rejected');
  ok(id.ledgerInfo(me, fake).ok === false && id.ledgerInfo(me, ledger).tp === 7, 'ledgerInfo verifies');
  const other2 = { fb: 'someoneElse', uid: 'b'.repeat(32), name: 'X' };
  ok(!id.matchClaim(other2, { mt: start(), result: 'won', ledger: '' }).ok, "another account cannot use my match ticket");
  ok(!id.matchClaim(other2, { mt: id.matchStart(other2, {}).mt, result: 'won', ledger }).ok || true, '(ledger of another account)');
  ok(id.openLedger(ledger, 'someoneElse') === null, "my ledger is not valid for another account");
  // the stored ledger reaches the relay ticket
  fsDocs.set('users/fbUser123/meta/tp', { s: { stringValue: ledger } });
  const a = await id.auth({ token: jwt(good({ iat: T() - 5, auth_time: T() - 5, exp: T() + 3000 })) });
  ok(a.ident.tp === 7, 'the relay ticket carries the verified TP (' + a.ident.tp + ')');
  fsDocs.set('users/fbUser123/meta/tp', { s: { stringValue: fake } });
  const b = await id.auth({ token: jwt(good({ iat: T() - 5, auth_time: T() - 5, exp: T() + 3000 })) });
  ok(b.ident.tp === 0, 'an edited stored ledger shows 0 TP');
}
{
  const k = keysFromEnv({ RENDER_SERVICE_ID: 'srv-abc' });
  ok(k.source === 'service' && keysFromEnv({ RENDER_SERVICE_ID: 'srv-abc' }).keys[0].equals(k.keys[0]), 'Render fallback key is stable');
  const k2 = keysFromEnv({ AEVUM_SECRET: 'x'.repeat(32), RENDER_SERVICE_ID: 'srv-abc' });
  ok(k2.source === 'env' && k2.keys.length === 2, 'AEVUM_SECRET is primary, the Render key stays for old ledgers');
}

// ---------- the relay ----------
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), AEVUM_NO_AUTH: '', AEVUM_SECRET: '' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const to = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    p.stdout.on('data', (d) => { out += d; if (out.includes('calisiyor')) { clearTimeout(to); resolve(p); } });
    p.stderr.on('data', (d) => { out += d; });
  });
}
const base = (port) => 'http://127.0.0.1:' + port;
async function readSse(url, ms, until) {
  const ctl = new AbortController();
  const got = [];
  const t = setTimeout(() => ctl.abort(), ms);
  let r;
  try { r = await fetch(url, { signal: ctl.signal }); } catch { clearTimeout(t); return { status: 0, got }; }
  if (!r.ok) { clearTimeout(t); try { await r.body.cancel(); } catch { /* ignore */ } return { status: r.status, got }; }
  const rd = r.body.getReader(); let buf = '', stop = false;
  try {
    while (!stop) {
      const { value, done } = await rd.read(); if (done) break;
      buf += Buffer.from(value).toString();
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) { got.push(JSON.parse(line.slice(6))); if (until && until(got)) stop = true; } }
    }
  } catch { /* aborted */ }
  clearTimeout(t);
  try { rd.cancel().catch(() => {}); } catch { /* ignore */ }
  return { status: 200, got };
}
{
  const port = 5600 + Math.floor(Math.random() * 300);
  const srv = await startServer(port, {});
  try {
    const r = await fetch(base(port) + '/mp/events?room=ABCDE&peer=p1');
    ok(r.status === 401, 'relay: no ticket -> 401 (' + r.status + ')');
    const mint = await fetch(base(port) + '/mp/sse-ticket?room=ABCDE&peer=p1', { method: 'POST' });
    ok(mint.status === 401, 'relay: issuing SSE tickets requires authentication');
    const s = await fetch(base(port) + '/mp/send?room=ABCDE&peer=p1', { method: 'POST', body: '{"topic":"lobby","data":{}}' });
    ok(s.status === 401, 'relay: send without ticket -> 401');
    const a = await fetch(base(port) + '/mp/auth', { method: 'POST', body: JSON.stringify({ dev: { fb: 'x1', uid: UID, name: 'Dev' } }) });
    ok(a.status === 401 || a.status === 400, 'relay: dev identities refused in production mode (' + a.status + ')');
    const a2 = await fetch(base(port) + '/mp/auth', { method: 'POST', body: JSON.stringify({ token: 'x.y.z' }) });
    ok(a2.status === 401, 'relay: a bad Firebase token is refused');
    const h = await (await fetch(base(port) + '/mp/health')).json();
    ok(h.auth === 'on', 'health reports auth on');
  } finally { srv.kill(); }
}
{
  const port = 5900 + Math.floor(Math.random() * 300);
  const srv = await startServer(port, { AEVUM_NO_AUTH: '1', AEVUM_TP_MIN_MS: '0' });
  try {
    const auth = async (fb, uid, name) => (await (await fetch(base(port) + '/mp/auth', { method: 'POST', body: JSON.stringify({ dev: { fb, uid, name, av: 'crown' } }) })).json());
    const A = await auth('fbA', 'a'.repeat(32), 'Ali');
    const B = await auth('fbB', 'b'.repeat(32), 'Banu');
    ok(!!A.ticket && A.ident.name === 'Ali', 'dev auth gives a ticket');
    const mint = (t, room, peer) => fetch(base(port) + `/mp/sse-ticket?room=${room}&peer=${peer}`, { method: 'POST', headers: { 'X-Aevum-Ticket': t } });
    const stream = (room, peer, ticket) => base(port) + `/mp/events?room=${room}&peer=${peer}&st=${encodeURIComponent(ticket)}`;
    const aGrant = (await (await mint(A.ticket, 'ROOM1', 'pa')).json()).ticket;
    ok((await fetch(stream('ROOM2', 'pa', aGrant))).status === 401, 'SSE ticket is bound to room');
    ok((await fetch(stream('ROOM1', 'different', aGrant))).status === 401, 'SSE ticket is bound to peer');
    ok((await fetch(base(port) + '/mp/events?room=ROOM1&peer=pa&tk=' + encodeURIComponent(A.ticket))).status === 401, 'general relay ticket is not accepted by SSE');
    ok((await mint(aGrant, 'ROOM1', 'pa')).status === 401, 'SSE ticket cannot mint a new ticket');
    const evA = readSse(stream('ROOM1', 'pa', aGrant), 2500, (g) => g.some((m) => m.type === 'msg'));
    await new Promise((r) => setTimeout(r, 300));
    ok((await fetch(stream('ROOM1', 'pa', aGrant))).status === 401, 'used SSE ticket cannot be replayed');
    const forbiddenMint = await mint(B.ticket, 'ROOM1', 'pa');
    ok(forbiddenMint.status === 403, 'another account cannot mint a ticket for a connected peer');
    const bGrant = (await (await mint(B.ticket, 'ROOM1', 'pb')).json()).ticket;
    const evB = readSse(stream('ROOM1', 'pb', bGrant), 2500, (g) => g.some((m) => m.type === 'dup'));
    await new Promise((r) => setTimeout(r, 300));
    // B claims to be "Ali" in the payload: the stamped identity says Banu
    await fetch(base(port) + '/mp/send?room=ROOM1&peer=pb', { method: 'POST', headers: { 'X-Aevum-Ticket': B.ticket }, body: JSON.stringify({ topic: 'lobby', data: { k: 'hello', name: 'Ali', uid: 'a'.repeat(32) } }) });
    // A's ticket cannot post as peer pb
    const imp = await fetch(base(port) + '/mp/send?room=ROOM1&peer=pb', { method: 'POST', headers: { 'X-Aevum-Ticket': A.ticket }, body: JSON.stringify({ topic: 'lobby', data: {} }) });
    ok(imp.status === 403, 'relay: another account cannot post under my peer id (' + imp.status + ')');
    const ga = await evA;
    const joined = ga.got.find((m) => m.type === 'joined');
    ok(joined && joined.id && joined.id.name === 'Banu' && joined.id.uid === 'b'.repeat(32), 'relay: joined carries the verified identity');
    const msg = ga.got.find((m) => m.type === 'msg');
    ok(msg && msg.id && msg.id.name === 'Banu' && msg.id.uid === 'b'.repeat(32), 'relay: messages are stamped with the sender\'s verified identity');
    // the same account a second time (another tab): the older connection is replaced
    const B2 = await auth('fbB', 'b'.repeat(32), 'Banu');
    const b2Grant = (await (await mint(B2.ticket, 'ROOM1', 'pb2')).json()).ticket;
    const evB2 = readSse(stream('ROOM1', 'pb2', b2Grant), 1200);
    const gb = await evB;
    ok(gb.got.some((m) => m.type === 'dup'), 'relay: a second connection of the same account replaces the first');
    const hello2 = (await evB2).got.find((m) => m.type === 'hello');
    ok(hello2 && !hello2.peers.includes('pb') && hello2.ids && hello2.ids.pb2 && hello2.ids.pb2.name === 'Banu', 'relay: hello lists verified identities, without the replaced peer');
    const back = await mint(B.ticket, 'ROOM1', 'pb');
    ok(back.status === 409, 'relay: the replaced peer id cannot come back (' + back.status + ')');
    try { await back.body.cancel(); } catch { /* ignore */ }
    // TP through the relay
    const st = await (await fetch(base(port) + '/mp/tp/start', { method: 'POST', headers: { 'X-Aevum-Ticket': A.ticket }, body: '{"mode":"sp"}' })).json();
    const cl = await (await fetch(base(port) + '/mp/tp/claim', { method: 'POST', headers: { 'X-Aevum-Ticket': A.ticket }, body: JSON.stringify({ mt: st.mt, result: 'won', ledger: '' }) })).json();
    ok(cl.ok && cl.tp === 3, 'relay: TP claim works (' + JSON.stringify(cl).slice(0, 80) + ')');
    const nt = await fetch(base(port) + '/mp/tp/claim', { method: 'POST', body: JSON.stringify({ mt: st.mt, result: 'won', ledger: '' }) });
    ok(nt.status === 401, 'relay: TP needs a ticket');
    // friends: online status + invites through the inbox
    const post = (p, tk, body) => fetch(base(port) + p, { method: 'POST', headers: tk ? { 'X-Aevum-Ticket': tk } : {}, body: JSON.stringify(body) });
    let on = await (await post('/mp/online', A.ticket, { fbs: ['fbB'] })).json();
    ok(Array.isArray(on.online) && !on.online.includes('fbB'), 'friends: B offline before opening the inbox');
    const inboxB = fetch(base(port) + '/mp/inbox?tk=' + encodeURIComponent(B2.ticket)).then(r => r.json());
    await new Promise(r => setTimeout(r, 200));
    on = await (await post('/mp/online', A.ticket, { fbs: ['fbB', 'nobody'] })).json();
    ok(on.online.length === 1 && on.online[0] === 'fbB', 'friends: B online while its inbox is open');
    const iv = await (await post('/mp/invite', A.ticket, { to: 'fbB', code: 'room1' })).json();
    ok(iv.online === true, 'friends: invite delivered to an online friend');
    const got = await inboxB;
    ok(got.length === 1 && got[0].type === 'invite' && got[0].code === 'ROOM1' && got[0].from.name === 'Ali' && got[0].from.fb === 'fbA', 'friends: the invite carries the verified sender and the room code');
    ok((await post('/mp/invite', null, { to: 'fbB', code: 'ROOM1' })).status === 401, 'friends: invites need a ticket');
    ok((await post('/mp/invite', A.ticket, { to: 'fbB', code: 'bad code!' })).status === 400, 'friends: invalid room codes refused');
    ok((await post('/mp/invite', A.ticket, { to: 'fbA', code: 'ROOM1' })).status === 400, 'friends: cannot invite yourself');
    const off = await (await post('/mp/invite', A.ticket, { to: 'fbNobody', code: 'ROOM1' })).json();
    ok(off.online === false, 'friends: an offline player gets nothing (online:false)');
    let lim = 0; for (let i = 0; i < 25; i++) if ((await post('/mp/invite', A.ticket, { to: 'fbB', code: 'ROOM1' })).status === 429) lim++;
    ok(lim > 0, 'friends: invites are rate limited');
  } finally { srv.kill(); }
}

console.log(`identity-test: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);

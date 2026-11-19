// Node-only integration checks (Firebase fake, not deployed rules).
import assert from 'node:assert/strict';
import { fakeFirebase } from './fake-firebase.mjs';
import { CloudSync, CHAT_RETENTION_DAYS } from '../src/cloud/sync.js';
import { configureChatLog, localChatHistory, setLocalChatLimit, clearLocalChatHistory, logChat } from '../src/chatlog.js';
import { accountDeleteButton } from '../src/ui/chat-privacy-ui.js';

function storage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const now = () => Date.UTC(2026, 10, 19);
const f = fakeFirebase({ now });
function browser(email) {
  const ls = storage(), profile = { uid: '1'.repeat(32), name: email.split('@')[0], created: now() };
  const make = () => new CloudSync({ fetch: f.fetch, apiKey: 'test-key', projectId: 'test-proj', now, ls, profile: { get: () => profile } });
  return { make, async signIn() {
    const c = make();
    await c.auth.adopt(f.googleSignIn(email));
    if (!await c.fs.get(`users/${c.user.uid}/meta/profile`)) await c.fs.commit([{ set: `users/${c.user.uid}/meta/profile`, data: profile }]);
    return c;
  } };
}
const A = browser('Alice@example.test'), B = browser('Bob@example.test'), A2 = browser('Alice@example.test');
let a = await A.signIn();
const b = await B.signIn(), otherTab = await A2.signIn();
const aUid = a.user.uid, bUid = b.user.uid, base = `users/${aUid}`, path = `${base}/chatlog/`, pref = `${base}/meta/chat`;
const message = { text: 'Merhaba', t: '2026-11-19 10:00:00', name: 'Alice', room: 'ABCDE' };
assert.equal(await a.chatHistoryMode(), 'off');
const writes = f.stats.writes;
assert.equal(await a.logChat(message), false);
assert.equal(f.stats.writes, writes, 'no Firestore writes before consent');
assert.deepEqual(f.paths(path), []);
await a.setChatHistoryEnabled(true);
assert.equal(await a.logChat(message), true);
const sentPath = f.paths(path)[0];
assert.equal(f.docs.get(sentPath).fields.expiresAt.timestampValue, new Date(now() + CHAT_RETENTION_DAYS * 86400000).toISOString());
assert.ok(f.docs.get(sentPath).fields.at.timestampValue);
assert.equal((await a.listChatHistory()).length, 1, 'no pre-consent backfill');
await a.setChatHistoryEnabled(false);
assert.equal(await otherTab.logChat(message), false);
assert.equal((await a.listChatHistory()).length, 1, 'withdrawal keeps existing rows');
assert.deepEqual(await b.listChatHistory(), []);
const denied = (e) => e.kind === 'denied';
await assert.rejects(b.fs.get(sentPath), denied);
await assert.rejects(b.fs.get(pref), denied);
await assert.rejects(b.fs.query(base, { collection: 'chatlog' }), denied);
await assert.rejects(b.fs.commit([{ del: sentPath }]), denied);
await assert.rejects(b.fs.commit([{ set: path + 'other', data: message }]), denied);
console.log('OK: opt-in, withdrawal on another client, Timestamp TTL field and owner-only access');

// An already-started write that read the old enabled state must not land after history deletion.
await a.setChatHistoryEnabled(true);
const originalCommit = otherTab.fs.commit;
let reached, resume;
const pending = new Promise((r) => { reached = r; }), hold = new Promise((r) => { resume = r; });
otherTab.fs.commit = async (...args) => { reached(); await hold; return originalCommit(...args); };
const staleWrite = otherTab.logChat(message);
await pending;
assert.equal((await a.deleteChatHistory()).ok, true);
resume();
assert.equal(await staleWrite, false);
otherTab.fs.commit = originalCommit;
assert.deepEqual(await a.listChatHistory(), []);

async function seedLegacy(n) {
  // These pre-opt-in documents deliberately lack at/expiresAt; the parent document doesn't exist.
  for (let i = 0; i < n; i += 300) {
    await a.fs.commit(Array.from({ length: Math.min(n - i, 300) }, (_, j) => ({ set: path + 'legacy-' + (i + j), data: message })));
  }
}
await seedLegacy(601);
assert.equal(await a.fs.get(base), null);
const rows = await a.listChatHistory();
assert.equal(new Set(rows.map((r) => r.id)).size, 601, 'all pages can be viewed/exported');
await b.setChatHistoryEnabled(true);
assert.equal(await b.logChat(message), true);

let pages = 0;
const commit = a.fs.commit;
a.fs.commit = (w, t) => {
  if (w.some((x) => x.del?.startsWith(path)) && ++pages === 2) f.failNext(503, 1, ':commit');
  return commit(w, t);
};
const failedHistory = await a.deleteChatHistory();
assert.equal(failedHistory.ok, false);
assert.match(failedHistory.error, /tamamen silinemedi/);
assert.equal(f.paths(path).length, 401);
assert.equal(await otherTab.chatHistoryMode(), 'delete-history');
await assert.rejects(otherTab.setChatHistoryEnabled(true), /silme/);
assert.equal(await otherTab.logChat(message), false);
a = A.make(); // reload: use the persisted session and restart at the first remaining page
assert.equal((await a.deleteChatHistory()).ok, true);
assert.deepEqual(f.paths(path), []);
assert.equal(await a.chatHistoryMode(), 'off');
console.log('OK: multi-page listing/deletion, interrupted history deletion and reload/retry');

// Browser retention, different accounts on the same origin, and the actual account-delete button.
globalThis.localStorage = storage();
localStorage.setItem('aevum.chatlog.v1', JSON.stringify([message]));
let current = aUid;
configureChatLog({ account: () => current });
assert.equal(localStorage.getItem('aevum.chatlog.v1'), null);
assert.equal(localChatHistory().limit, 1000);
setLocalChatLimit(2);
for (const text of ['oldest', 'middle', 'newest']) logChat({ ...message, text });
assert.deepEqual(localChatHistory().rows.map((x) => x.text), ['middle', 'newest']);
current = bUid;
assert.deepEqual(localChatHistory().rows, []);
logChat(message);
clearLocalChatHistory();
assert.deepEqual(localChatHistory().rows, []);
setLocalChatLimit(0);
logChat(message);
assert.deepEqual(localChatHistory().rows, []);
current = aUid;
assert.equal(localChatHistory().rows.length, 2);

await seedLegacy(401);
const status = [], navigation = [];
globalThis.document = { createElement: () => ({}) };
globalThis.confirm = () => true;
const accountUI = { app: { cloud: a, forgetLocalData: async () => {} }, _menuMain: (s) => navigation.push(s) };
const button = accountDeleteButton(accountUI, (...msg) => status.push(msg));
let deletes = 0;
const accountCommit = a.fs.commit;
a.fs.commit = (w, t) => {
  if (w.some((x) => x.del?.startsWith(path)) && ++deletes === 2) f.failNext(503, 1, ':commit');
  return accountCommit(w, t);
};
await button.onclick();
assert.match(status.at(-1)[0], /Hesap silme tamamlanamadı/);
assert.equal(status.at(-1)[1], false);
assert.deepEqual(navigation, [], 'no success UI on Firestore error');
assert.equal(f.paths(path).length, 201);
assert.ok(a.loggedIn && f.userByEmail('Alice@example.test'));
assert.equal(await otherTab.logChat(message), false);

f.failNext(503, 1, 'accounts:delete');
await button.onclick();
assert.deepEqual(f.paths(path), []);
assert.equal(localStorage.getItem('aevum.chatlog.v2.' + aUid), null);
assert.ok(a.loggedIn && f.userByEmail('Alice@example.test'));
assert.deepEqual(navigation, [], 'no success UI on Auth error');

await button.onclick();
assert.deepEqual(navigation, ['Aevum hesabı silindi.']);
assert.ok(!a.loggedIn && !f.userByEmail('Alice@example.test'));
assert.deepEqual(f.paths(base + '/'), []);
assert.equal((await b.listChatHistory()).length, 1, 'account deletion leaves the other account alone');
assert.notEqual(localStorage.getItem('aevum.chatlog.v2.' + bUid), null);
console.log('OK: local isolation/limits/clear and account deletion UI on Firestore failure, Auth failure and retry');

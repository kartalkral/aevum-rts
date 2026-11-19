// Persistent multiplayer history is scoped to the signed-in Firebase account on this browser.
const LEGACY_KEY = 'aevum.chatlog.v1', PREFIX = 'aevum.chatlog.v2.';
export const DEFAULT_CHAT_LIMIT = 1000, MAX_CHAT_LIMIT = 5000;
let owner = () => null, sink = null;
const memory = new Map();
export function configureChatLog({ account, upload }) {
  owner = account; sink = upload;
  // The old log mixed accounts, and cannot safely be assigned to the current user.
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* inaccessible storage */ }
}
function load(uid) {
  if (memory.has(uid)) return memory.get(uid);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(PREFIX + uid)); } catch { /* unavailable or corrupt */ }
  const limit = Number.isInteger(saved?.limit) && saved.limit >= 0 && saved.limit <= MAX_CHAT_LIMIT ? saved.limit : DEFAULT_CHAT_LIMIT;
  return { limit, rows: limit && Array.isArray(saved?.rows) ? saved.rows.slice(-limit) : [] };
}
function save(uid, data) {
  localStorage.setItem(PREFIX + uid, JSON.stringify(data));
  memory.delete(uid);
}
function currentOwner() {
  const uid = owner();
  if (!uid) throw new Error('Giriş yapılmadı.');
  return uid;
}
const pad = (n) => String(n).padStart(2, '0');
function stamp(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

export function logChat(m) {
  const uid = owner();
  if (!uid || typeof m?.text !== 'string' || !m.text.trim()) return;
  const e = { t: stamp(new Date()), room: String(m.room || ''), name: String(m.name || '?').slice(0, 40), text: m.text.slice(0, 200) };
  if (m.mine && sink) sink(e);
  const data = load(uid);
  if (!data.limit) return;
  data.rows.push(e);
  data.rows = data.rows.slice(-data.limit);
  // If the browser quota is exhausted, keep the newest lines in this tab until storage works again.
  try { save(uid, data); } catch { memory.set(uid, data); }
}
export function localChatHistory() { return load(currentOwner()); }
export function setLocalChatLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_CHAT_LIMIT) throw new Error('Geçersiz geçmiş sınırı.');
  const uid = currentOwner();
  save(uid, { limit, rows: limit ? load(uid).rows.slice(-limit) : [] });
}
export function clearLocalChatHistory() {
  const uid = currentOwner();
  save(uid, { limit: load(uid).limit, rows: [] });
}
// Account deletion also removes that account's local retention setting.
export function removeLocalChatAccount(uid) {
  localStorage.removeItem(PREFIX + uid);
  memory.delete(uid);
}
// A limit change or clear in another tab invalidates this tab's quota fallback.
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => {
  if (e.key === null) memory.clear();
  else if (e.key.startsWith(PREFIX)) memory.delete(e.key.slice(PREFIX.length));
});

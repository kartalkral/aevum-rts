// Aevum - local player profile + match history logic.
// Pure functions: storage (a localStorage-like {getItem,setItem,removeItem}), crypto and the clock are injected,
// so everything here runs in node too (test/profile-test.mjs). Nothing in this file touches the simulation:
// the uid is identity metadata for the UI, the lobby and save/history records only (never part of Game state/cfg).

export const PROFILE_KEY = 'aevum.profile';
export const MPNAME_KEY = 'aevum.mpName';     // legacy multiplayer name; kept in sync with the profile name
export const HISTORY_CAP = 500;
export const NAME_MIN = 2, NAME_MAX = 20;
export const UID_RE = /^[0-9a-f]{32}$/;
export const RESULTS = ['won', 'lost', 'abandoned'];
export const MODES = ['sp', 'mp'];
export const MAP_SIZES = [96, 128, 160, 192, 256, 320, 384, 448, 512];   // (the first four: older matches)
export const DIFFS = ['easy', 'normal', 'hard'];
// map types a record can carry (the sim's MAP_TYPES plus 'random'); anything else is rejected on import
export const MAP_TYPES = ['river', 'continent', 'highlands', 'plains', 'inlandsea', 'islands', 'random'];
export const FUTURE_MARGIN_MS = 24 * 3600 * 1000;   // imported endedAt may be at most this far in the future
export const STAT_KEYS = ['unitsTrained', 'unitsLost', 'kills', 'buildingsBuilt', 'buildingsLost', 'razed', 'techs'];
export const RES_KEYS = ['food', 'wood', 'stone', 'gold'];
export const EXPORT_FORMAT = 'aevum-profile';
const MAX_IMPORT = 5000;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export const isUid = (s) => typeof s === 'string' && UID_RE.test(s);
export const cleanUid = (s) => (isUid(s) ? s : null);

function randHex(bytes, cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('crypto.getRandomValues yok');
  const a = c.getRandomValues(new Uint8Array(bytes));
  let s = ''; for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}
// permanent 128-bit identity
export const newUid = (cryptoObj) => randHex(16, cryptoObj);
// random id of one match (single player; multiplayer matches use the match code)
export const newMatchId = (cryptoObj) => randHex(8, cryptoObj);

// ---------- names ----------
// -> {ok, name, error}; whitespace runs collapse, control characters are rejected
export function checkName(raw) {
  if (typeof raw !== 'string') return { ok: false, name: '', error: 'Ad metin olmalı.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw.replace(/[\t\n\r ]/g, ''))) return { ok: false, name, error: 'Ad geçersiz karakter içeriyor.' };
  if (name.length < NAME_MIN) return { ok: false, name, error: `Ad en az ${NAME_MIN} karakter olmalı.` };
  if (name.length > NAME_MAX) return { ok: false, name, error: `Ad en fazla ${NAME_MAX} karakter olabilir.` };
  return { ok: true, name, error: '' };
}

// ---------- profile ----------
const lsGet = (ls, k) => { try { return ls ? ls.getItem(k) : null; } catch { return null; } };
const lsSet = (ls, k, v) => { if (!ls) return false; try { ls.setItem(k, v); return true; } catch { return false; } };

export function validProfile(p) {
  return !!p && typeof p === 'object' && p.v === 1 && isUid(p.uid) && checkName(p.name).ok && Number.isFinite(p.created);
}
// avatar: an id from src/avatars.js (optional; checked there). Kept as identity metadata only.
const AV_RE = /^[a-z0-9-]{1,24}$/;
const withAvatar = (o, av) => { if (typeof av === 'string' && AV_RE.test(av)) o.avatar = av; return o; };
export function loadProfile(ls) {
  const raw = lsGet(ls, PROFILE_KEY); if (!raw) return null;
  try { const p = JSON.parse(raw); return validProfile(p) ? withAvatar({ v: 1, uid: p.uid, name: checkName(p.name).name, created: p.created }, p.avatar) : null; } catch { return null; }
}
// signed out (accounts are mandatory): no local profile stays behind
export function clearProfile(ls) { try { if (ls) ls.removeItem(PROFILE_KEY); } catch { /* ignore */ } }
// the name to suggest in the first-launch dialog: the old multiplayer name, if usable
export function defaultName(ls) {
  const r = checkName(String(lsGet(ls, MPNAME_KEY) || '').slice(0, NAME_MAX));
  return r.ok ? r.name : '';
}
export function saveProfile(ls, p) {
  const ok = lsSet(ls, PROFILE_KEY, JSON.stringify(withAvatar({ v: 1, uid: p.uid, name: p.name, created: p.created }, p.avatar)));
  lsSet(ls, MPNAME_KEY, p.name);
  return ok;
}
export function createProfile(ls, name, { cryptoObj, now } = {}) {
  const r = checkName(name); if (!r.ok) throw new Error(r.error);
  const p = { v: 1, uid: newUid(cryptoObj), name: r.name, created: now != null ? now : Date.now() };
  // the profile is returned even when storage refused it (blocked site data, quota): the caller then keeps it
  // in memory for this session and can check `saved`
  const saved = saveProfile(ls, p);
  Object.defineProperty(p, 'saved', { value: saved, enumerable: false });
  return p;
}
// -> {ok, profile, error, saved}; also updates the multiplayer name.
// current: the in-memory session profile (used instead of storage when storage could not keep it)
export function renameProfile(ls, name, current) {
  const p = (validProfile(current) ? withAvatar({ v: 1, uid: current.uid, name: current.name, created: current.created }, current.avatar) : null) || loadProfile(ls);
  if (!p) return { ok: false, profile: null, error: 'Profil yok.', saved: false };
  const r = checkName(name); if (!r.ok) return { ok: false, profile: p, error: r.error, saved: false };
  p.name = r.name;
  const saved = saveProfile(ls, p);
  return { ok: true, profile: p, error: '', saved };
}

// ---------- match records ----------
function copyStats(s) {
  s = s && typeof s === 'object' ? s : {};
  const g = s.gathered && typeof s.gathered === 'object' ? s.gathered : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = { gathered: {} };
  for (const r of RES_KEYS) out.gathered[r] = Math.floor(num(g[r]));
  for (const k of STAT_KEYS) out[k] = num(s[k]) | 0;
  return out;
}
// 'won' | 'lost' | 'abandoned' from the local player's view
export function resultOf(game, me) {
  const p = game && game.players ? game.players[me] : null;
  const ov = game && game.over;
  if (ov) {
    if (ov.winnerTeam != null && ov.winnerTeam >= 0 && p) return ov.winnerTeam === p.team ? 'won' : 'lost';
    return ov.won ? 'won' : 'lost';
  }
  if (p && p.defeated) return 'lost';
  // every opponent is out and at least one of them left the match (a friend quit): a win, not 'abandoned'
  const opp = p && game.players ? game.players.filter((q, i) => i !== me && q.team !== p.team) : [];
  if (opp.length && opp.every(q => q.left || q.defeated) && opp.some(q => q.left)) return 'won';
  return 'abandoned';
}
// ctx: {mode 'sp'|'mp', id, uids: [uid|null per player index], myUid, myName, now}
export function buildRecord(game, ctx) {
  const me = game.me | 0, cfg = game.cfg || {}, ov = game.over;
  const mp = ctx.mode === 'mp';
  // single player: the sim calls the human "Oyuncu 1" -> the profile name (multiplayer keeps the in-game name)
  const myName = !mp && checkName(ctx.myName || '').ok ? checkName(ctx.myName).name : null;
  const players = (game.players || []).map((p, i) => ({
    name: String((i === me && myName) || p.name || (p.isAI ? 'Yapay Zekâ' : 'Oyuncu ' + (i + 1))).slice(0, NAME_MAX + 4),
    uid: p.isAI ? null : cleanUid(i === me ? ctx.myUid : (ctx.uids || [])[i]),
    team: p.team | 0, ai: !!p.isAI,
    difficulty: p.isAI ? (DIFFS.includes(p.difficulty) ? p.difficulty : (DIFFS.includes(cfg.difficulty) ? cfg.difficulty : 'normal')) : null,
    won: ov && ov.winnerTeam != null && ov.winnerTeam >= 0 ? ov.winnerTeam === p.team : (ov ? (i === me ? !!ov.won : null) : null),
  }));
  const result = resultOf(game, me);
  // won because the opponents left: mark my side as the winners
  if (!ov && result === 'won') { const myTeam = game.players[me].team; for (const q of players) q.won = q.team === myTeam; }
  return {
    v: 1, id: String(ctx.id), uid: cleanUid(ctx.myUid), me,
    endedAt: ctx.now != null ? ctx.now : Date.now(),
    mode: mp ? 'mp' : 'sp',
    mapType: String(cfg.mapType || 'river'), mapSize: MAP_SIZES.includes(cfg.mapSize) ? cfg.mapSize : 128,
    difficulty: mp ? null : (DIFFS.includes(cfg.difficulty) ? cfg.difficulty : 'normal'),
    gameTime: Math.max(0, Math.round((game.time || 0) * 10) / 10),
    result,
    myAge: Math.max(0, (game.players[me] && game.players[me].age) | 0),
    stats: copyStats(game.players[me] && game.players[me].stats),
    players,
  };
}
export const spRecordId = (matchId) => 'sp-' + matchId;
export const mpRecordId = (match, uid) => 'mp-' + String(match || 'MP').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) + '-' + uid;

// ---------- aggregation ----------
const byNewest = (a, b) => (b.endedAt || 0) - (a.endedAt || 0);
export function summarize(records) {
  const t = { games: 0, wins: 0, losses: 0, abandoned: 0, winRate: 0, totalTime: 0, stats: copyStats(null), maxAge: 0, mapCounts: Object.create(null), topMap: null, sp: 0, mp: 0 };
  for (const r of records || []) {
    t.games++;
    if (r.result === 'won') t.wins++; else if (r.result === 'lost') t.losses++; else t.abandoned++;
    if (r.mode === 'mp') t.mp++; else t.sp++;
    t.totalTime += r.gameTime || 0;
    const s = copyStats(r.stats);
    for (const k of RES_KEYS) t.stats.gathered[k] += s.gathered[k];
    for (const k of STAT_KEYS) t.stats[k] += s[k];
    t.maxAge = Math.max(t.maxAge, r.myAge | 0);
    t.mapCounts[r.mapType] = (t.mapCounts[r.mapType] || 0) + 1;
  }
  const decided = t.wins + t.losses;
  t.winRate = decided ? t.wins / decided : 0;
  let best = 0;
  for (const [m, n] of Object.entries(t.mapCounts)) if (n > best) { best = n; t.topMap = m; }
  return t;
}
// per human uid that is not me: as opponent (other team) and as ally (same team); latest name by endedAt
export function headToHead(records, myUid) {
  const map = new Map();
  for (const r of (records || []).slice().sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))) {
    const ps = Array.isArray(r.players) ? r.players : [];
    const mine = ps[r.me | 0]; if (!mine) continue;
    const self = new Set([myUid, r.uid].filter(Boolean));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (i === (r.me | 0) || p.ai || !isUid(p.uid) || self.has(p.uid)) continue;
      let h = map.get(p.uid);
      if (!h) { h = { uid: p.uid, name: p.name, games: 0, vs: { games: 0, wins: 0, losses: 0, abandoned: 0 }, with: { games: 0, wins: 0, losses: 0, abandoned: 0 }, lastAt: 0 }; map.set(p.uid, h); }
      h.name = p.name; h.lastAt = r.endedAt || 0; h.games++;
      const b = p.team === mine.team ? h.with : h.vs;
      b.games++;
      if (r.result === 'won') b.wins++; else if (r.result === 'lost') b.losses++; else b.abandoned++;
    }
  }
  return [...map.values()].sort((a, b) => b.games - a.games || b.lastAt - a.lastAt);
}

// de-duplicated by id (the newer endedAt wins), newest first, capped
export function mergeHistory(existing, incoming, cap = HISTORY_CAP) {
  const m = new Map();
  for (const r of [...(existing || []), ...(incoming || [])]) {
    if (!r || typeof r.id !== 'string') continue;
    const o = m.get(r.id);
    if (!o || (r.endedAt || 0) >= (o.endedAt || 0)) m.set(r.id, r);
  }
  return [...m.values()].sort(byNewest).slice(0, cap);
}
// records beyond the cap (oldest first to go): ids to delete
export function overCap(records, cap = HISTORY_CAP) {
  return (records || []).slice().sort(byNewest).slice(cap).map(r => r.id);
}

// ---------- export / import ----------
// the imported records that belong to `uid` (or carry no owner): another player's history would count
// the same match twice from both sides in my totals. -> {keep, skipped}
export function ownRecords(records, uid) {
  const keep = (records || []).filter(r => r && (r.uid == null || r.uid === uid));
  return { keep, skipped: (records || []).length - keep.length };
}
export function exportData(profile, history, now) {
  return { format: EXPORT_FORMAT, v: 1, exportedAt: now != null ? now : Date.now(), profile: { v: 1, uid: profile.uid, name: profile.name, created: profile.created }, history: (history || []).slice().sort(byNewest) };
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo = 0, hi = 1e12) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function validStats(s) {
  if (!s || typeof s !== 'object' || !s.gathered || typeof s.gathered !== 'object') return false;
  for (const r of RES_KEYS) if (!isNum(s.gathered[r])) return false;
  for (const k of STAT_KEYS) if (!isNum(s[k], 0, 1e9)) return false;
  return true;
}
// -> null if valid, else a Turkish reason
// now: the current time (injected in tests); records dated in the future are rejected
export function recordError(r, now) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'kayıt nesne değil';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'geçersiz id';
  if (!isNum(r.endedAt, 0, (now != null ? now : Date.now()) + FUTURE_MARGIN_MS)) return 'geçersiz tarih';
  if (!MODES.includes(r.mode)) return 'geçersiz mod';
  if (!MAP_TYPES.includes(r.mapType)) return 'geçersiz harita türü';
  if (!MAP_SIZES.includes(r.mapSize)) return 'geçersiz harita boyutu';
  if (r.difficulty != null && !DIFFS.includes(r.difficulty)) return 'geçersiz zorluk';
  if (!isNum(r.gameTime, 0, 1e8)) return 'geçersiz süre';
  if (!RESULTS.includes(r.result)) return 'geçersiz sonuç';
  if (!isInt(r.myAge, 0, 10)) return 'geçersiz çağ';
  if (!validStats(r.stats)) return 'geçersiz istatistik';
  if (r.uid != null && !isUid(r.uid)) return 'geçersiz uid';
  if (r.me != null && !isInt(r.me, 0, 7)) return 'geçersiz oyuncu no';
  if (!Array.isArray(r.players) || r.players.length < 1 || r.players.length > 8) return 'geçersiz oyuncu listesi';
  for (const p of r.players) {
    if (!p || typeof p !== 'object') return 'geçersiz oyuncu';
    if (typeof p.name !== 'string' || p.name.length > NAME_MAX + 4) return 'geçersiz oyuncu adı';
    if (p.uid != null && !isUid(p.uid)) return 'geçersiz oyuncu uid';
    if (!isInt(p.team, 0, 15) || typeof p.ai !== 'boolean') return 'geçersiz oyuncu takımı';
    if (p.difficulty != null && !DIFFS.includes(p.difficulty)) return 'geçersiz oyuncu zorluğu';
    if (p.won != null && typeof p.won !== 'boolean') return 'geçersiz oyuncu sonucu';
  }
  return null;
}
// copy of only the known fields (a valid record)
function cleanRecord(r) {
  return {
    v: 1, id: r.id, uid: r.uid || null, me: r.me | 0, endedAt: r.endedAt, mode: r.mode, mapType: r.mapType, mapSize: r.mapSize,
    difficulty: r.difficulty || null, gameTime: r.gameTime, result: r.result, myAge: r.myAge, stats: copyStats(r.stats),
    players: r.players.map(p => ({ name: p.name, uid: p.uid || null, team: p.team, ai: p.ai, difficulty: p.difficulty || null, won: p.won == null ? null : p.won })),
  };
}
// strict: any invalid part rejects the whole file. -> {ok, error, profile, history}
export function validateImport(obj, now) {
  const bad = (error) => ({ ok: false, error, profile: null, history: [] });
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return bad('Dosya geçerli bir JSON değil.'); } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bad('Dosya biçimi tanınmadı.');
  if (obj.format !== EXPORT_FORMAT || obj.v !== 1) return bad('Bu geçerli bir profil dosyası değil.');
  const p = obj.profile;
  if (!validProfile(p)) return bad('Dosyadaki profil geçersiz.');
  if (!Array.isArray(obj.history)) return bad('Dosyadaki maç geçmişi geçersiz.');
  if (obj.history.length > MAX_IMPORT) return bad('Dosyada çok fazla maç var.');
  for (let i = 0; i < obj.history.length; i++) {
    const e = recordError(obj.history[i], now);
    if (e) return bad(`Maç ${i + 1}: ${e}.`);
  }
  return { ok: true, error: '', profile: { v: 1, uid: p.uid, name: checkName(p.name).name, created: p.created }, history: obj.history.map(cleanRecord) };
}

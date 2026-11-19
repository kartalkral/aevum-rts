// Aevum - optional cloud account: account <-> local profile, match history sync, cloud saves.
// Everything is injected (Firestore client, auth session, localStorage, the local history / save stores, the
// clock, timers), so test/cloud-test.mjs runs it in node against a fake Firebase.
// Nothing here touches the simulation or the Game cfg: the cloud only stores what the UI already keeps locally
// (profile, history records, serialized save records). Cloud failures never block playing: writes wait in a
// small persisted queue and are retried later.
//
// Firestore layout (rules: users/{uid}/** owner only; names/{name} create/delete by owner; profiles/{uid} public read):
//   users/{fb}/meta/profile         {uid: 32-hex profile uid (THE multiplayer identity), name, created, avatar}
//   users/{fb}/meta/tp              {s: the TP ledger, signed by the game server (srv/identity.mjs); the client only stores it}
//   users/{fb}/matches/{recordId}   {j: record JSON, e: endedAt, t: server time}   (incremental sync by t)
//   users/{fb}/saves/{key}          {name, time, mp, code, tick, me, players, hash, matchId, auto, size, chunks, sha, enc, up}
//   users/{fb}/saves/{key}/chunks/{gen}-{i} {i, sha, d: base64 part}   (gen: the save's sha prefix; old saves: chunks/{i})
//   users/{fb}/meta/chat            {mode: cloud consent / deletion state}
//   users/{fb}/chatlog/{id}          {t, room, name, text, uid, at, expiresAt}
//   names/{lowercased name}         {uid: fb}
//   profiles/{fb}                   {name, games, wins, avatar, updated}
import * as P from '../profile.js';
import { Auth, authMessage } from './auth.js';
import { googleMessage, googleCode } from './google.js';
import { firestoreApi, CloudError } from './rest.js';
import { packSave, unpackSave } from './codec.js';
import { isAvatar, defaultAvatar, avatarOf } from '../avatars.js';

export const CHAT_RETENTION_DAYS = 30;
const CHAT_PAGE = 200;
export const MAX_CLOUD_SAVES = 30;
export const AUTO_UPLOAD_MS = 5 * 60 * 1000;        // autosaves: at most one upload per game every 5 minutes
export const HIST_PAGE = 200;
export const HIST_BATCH = 100;                       // records per commit
export const CHUNKS_PER_COMMIT = 4;                  // 4 x 512 KiB base64 < the 10 MiB request limit
export const ATOMIC_CHARS = 8 * 1024 * 1024;         // a save up to this size goes up in one atomic commit (chunks + meta)
export const SAVE_LIST_TTL = 60 * 1000;
export const GUEST_KEY = 'aevum.guestProfile';       // the guest profile of this PC while an account is logged in
export const ACCOUNT_UIDS_KEY = 'aevum.accountUids'; // profile uids of accounts used on this PC (hidden from the guest)
export const STATE_PREFIX = 'aevum.cloud.';          // + firebase uid: {cursor, queue: {h, s}, up, card, name, release}
const RETRY_MIN = 15 * 1000, RETRY_MAX = 5 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const MATCH_RE = /^[0-9a-f]{16}$/;

export const TP_RULES = { won: 3, lost: 1, abandoned: 0 };   // (the server decides; shown in Profil)
// the readable part of a signed ledger (display only: the server verifies the signature) -> {tp, w, l, n} | null
export function ledgerInfo(s) {
  if (typeof s !== 'string' || !s.includes('.')) return null;
  try {
    const b = s.slice(0, s.indexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
    const txt = typeof atob === 'function' ? decodeURIComponent(escape(atob(b))) : Buffer.from(b, 'base64').toString('utf8');
    const o = JSON.parse(txt);
    return o && Number.isInteger(o.tp) ? { tp: o.tp, w: o.w | 0, l: o.l | 0, n: o.n | 0, fb: o.fb } : null;
  } catch (e) { return null; }
}
// the default user name of a new account: the e-mail's local part, made unique with a number when taken
export function nameCandidate(base, i, rnd = Math.random) {
  if (i === 0) return base;
  const suf = i < 20 ? String(i + 1) : String(1000 + Math.floor(rnd() * 9000));
  return base.slice(0, P.NAME_MAX - suf.length) + suf;
}
export const STATUS_TR = { guest: 'Giriş yapılmadı', synced: 'Senkronize', pending: 'Bekliyor', offline: 'Çevrimdışı', expired: 'Oturum süresi doldu', busy: 'Senkronize ediliyor' };

// ---------------------------------------------------------------- pure helpers (tested directly)
// names/{key}: unique case-insensitively, Turkish casing included: İ / I / ı / i (and i + combining dot) all fold
// to 'i', so 'İlker', 'ILKER', 'ılker' and 'ilker' are one name. '/' and '%' escaped (not allowed / ambiguous in doc ids)
export function nameKey(name) {
  const n = P.checkName(name).name.normalize('NFC').replace(/[İIı]/g, 'i').toLowerCase().replace(/i\u0307/g, 'i').normalize('NFC');
  const k = n.replace(/[%/]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return k === '.' || k === '..' || /^__.*__$/.test(k) ? encodeURIComponent(k).replace(/\./g, '%2E').replace(/_/g, '%5F') : k;
}
export const isAutoKey = (k) => k === 'auto' || /^auto-/.test(k) || /-auto$/.test(k);
// the cloud key of a local save: the single local single-player autosave slot becomes one cloud autosave per match
export function cloudKeyOf(localKey, rec) {
  if (localKey === 'auto' && rec && MATCH_RE.test(rec.matchId || '')) return 'auto-' + rec.matchId;
  return localKey;
}
// a better (kept) version of the same record: a finished result beats 'abandoned', then the newer one
export function betterRecord(a, b) {
  if (!b) return true;
  if (!a) return false;
  const fa = a.result !== 'abandoned', fb = b.result !== 'abandoned';
  if (fa !== fb) return fa;
  return (a.endedAt || 0) > (b.endedAt || 0);
}
// the history the Profil screen shows. Logged in: the account profile's records. Guest: everything except the
// records of accounts used on this PC (a guest who never logged in sees exactly what he saw before).
export function visibleHistory(records, { profileUid, loggedIn, accountUids }) {
  const acc = new Set(accountUids || []);
  return (records || []).filter((r) => (loggedIn ? r.uid === profileUid || r.uid == null : !(r.uid && acc.has(r.uid) && r.uid !== profileUid)));
}
// a guest record taken over by the account profile: owner uid (and the uid suffix of a multiplayer record id) changes
export function reownRecord(r, oldUid, newUid) {
  const c = JSON.parse(JSON.stringify(r));
  c.uid = newUid;
  const me = c.players && c.players[c.me | 0];
  if (me && me.uid === oldUid) me.uid = newUid;
  if (typeof c.id === 'string' && c.id.endsWith('-' + oldUid)) c.id = c.id.slice(0, -oldUid.length) + newUid;
  return c;
}
// local + cloud save lists -> one list, newest first. item.cloud: 'none' (local only) | 'synced' | 'newer' (the
// cloud copy is newer: downloaded on use) | 'only' (cloud only: downloaded on use). item.ck: the cloud key.
export function mergeSaveLists(local, cloud) {
  const byCk = new Map();
  for (const c of cloud || []) byCk.set(c.key, c);
  const out = [];
  const used = new Set();
  for (const l of local || []) {
    const ck = cloudKeyOf(l.key, l);
    const c = byCk.get(ck);
    if (!c) { out.push(Object.assign({}, l, { ck, cloud: 'none' })); continue; }
    used.add(ck);
    if ((c.time || 0) > (l.time || 0)) out.push(Object.assign({}, c, { key: l.key, ck, cloud: 'newer' }));
    else out.push(Object.assign({}, l, { ck, cloud: 'synced' }));
  }
  for (const c of cloud || []) if (!used.has(c.key)) out.push(Object.assign({}, c, { ck: c.key, cloud: 'only' }));
  return out.sort((a, b) => (b.time || 0) - (a.time || 0));
}
// which cloud saves to delete to keep at most `max`: oldest autosaves first, then the oldest others
export function pruneList(list, max = MAX_CLOUD_SAVES, keep = null) {
  const n = (list || []).length - max;
  if (n <= 0) return [];
  const cand = list.filter((s) => s.key !== keep).sort((a, b) => (isAutoKey(b.key) - isAutoKey(a.key)) || ((a.time || 0) - (b.time || 0)));
  return cand.slice(0, n).map((s) => s.key);
}
export const nameFromEmail = (email) => {
  const s = String(email || '').split('@')[0].replace(/[^A-Za-z0-9_çğıöşüÇĞİÖŞÜ]/g, '').slice(0, P.NAME_MAX);
  return P.checkName(s).ok ? s : 'Komutan';
};
// the user name suggested to a new Google account: its display name (first word when it is too long), else the e-mail
export function nameFromGoogle(displayName, email) {
  // eslint-disable-next-line no-control-regex
  const d = String(displayName || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (P.checkName(d).ok) return d;
  const w = d.split(' ')[0].slice(0, P.NAME_MAX);
  if (P.checkName(w).ok) return w;
  return nameFromEmail(email);
}
const fail = (error, extra) => Object.assign({ ok: false, error }, extra || {});
const lsGet = (ls, k) => { try { return ls ? ls.getItem(k) : null; } catch { return null; } };
const lsSet = (ls, k, v) => { try { if (ls) ls.setItem(k, v); return true; } catch { return false; } };
const lsDel = (ls, k) => { try { if (ls) ls.removeItem(k); } catch { /* ignore */ } };
const jget = (ls, k, fb) => { try { const v = JSON.parse(lsGet(ls, k) || 'null'); return v == null ? fb : v; } catch { return fb; } };

// ---------------------------------------------------------------- the cloud account
export class CloudSync {
  // opts: {fetch, apiKey, projectId, ls, now, setTimer, clearTimer,
  //        profile: {get(), set(p), create(name)}, history: {list(), get(id), put(recs), del(ids)},
  //        saves: {list(), get(key), put(key, rec), del(key)}, packOpts, google: GoogleSignIn}
  constructor(opts) {
    this.o = opts;
    this.ls = opts.ls || null;
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || ((f, ms) => setTimeout(f, ms));
    this.clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
    this.auth = opts.auth || new Auth({ fetch: opts.fetch, apiKey: opts.apiKey, ls: this.ls, now: this.now, setTimer: opts.authTimers ? this.setTimer : null, clearTimer: this.clearTimer });
    this.fs = firestoreApi({ fetch: opts.fetch, projectId: opts.projectId, token: (f) => this.auth.token(f) });
    this.auth.onChange = () => this._emit();
    this.google = opts.google || null;   // GoogleSignIn (google.js): the only way to sign in
    this.guestless = !!opts.guestless;   // accounts are mandatory: signing out leaves no local (guest) profile
    this.relayBase = opts.relayBase || '';
    this.relayFetch = opts.relayFetch || opts.fetch;
    this._tkt = null; this._tktP = null;
    this._setup = false;
    this.offline = false; this.lastError = '';
    this._busy = null; this._again = null; this._retry = null; this._backoff = 0;
    this._saveList = null; this._saveListAt = 0; this._saveListP = null;
    this._autoAt = new Map(); this._pendingAuto = new Map();
    this._listeners = new Set();
  }

  // ---------- chat history ----------
  _chatContext() {
    if (!this.loggedIn) throw new CloudError('auth', 'NO_SESSION', 'Giriş yapılmadı.');
    return { base: this._base(), sid: this._sid(), uid: this.user.uid };
  }
  async _chatSetting(ctx) {
    this._alive(ctx.sid);
    const doc = await this.fs.get(ctx.base + '/meta/chat');
    this._alive(ctx.sid);
    return doc;
  }
  _chatSettingWrite(ctx, doc, mode) {
    return { set: ctx.base + '/meta/chat', data: { mode }, mustNotExist: !doc, updateTime: doc?.updateTime };
  }
  async chatHistoryMode() {
    const doc = await this._chatSetting(this._chatContext());
    return doc?.data.mode || 'off';
  }
  async setChatHistoryEnabled(enabled) {
    const ctx = this._chatContext();
    const doc = await this._chatSetting(ctx);
    if (this._accountDeleting || ['delete-history', 'delete-account'].includes(doc?.data.mode)) {
      throw new Error('Önce devam eden silme işlemini tamamla.');
    }
    if (enabled) {
      const profile = await this.fs.get(ctx.base + '/meta/profile');
      this._alive(ctx.sid);
      if (!profile || this._accountDeleting) throw new Error('Hesap kullanılabilir durumda değil.');
    }
    await this.fs.commit([this._chatSettingWrite(ctx, doc, enabled === true ? 'on' : 'off')]);
    this._alive(ctx.sid);
  }
  // Only newly sent lines; no backfill or retry queue. The conditional update and the line are atomic:
  // if another tab changes consent or starts deleting after this read, the entire stale write fails.
  async logChat(e) {
    if (!this.loggedIn || this.auth.dead || this._accountDeleting || !e?.text) return false;
    try {
      const ctx = this._chatContext();
      const doc = await this._chatSetting(ctx);
      if (doc?.data.mode !== 'on' || this._accountDeleting) return false;
      const id = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (x) => x.toString(16).padStart(8, '0')).join('');
      const expiresAt = new Date(this.now() + CHAT_RETENTION_DAYS * 86400000).toISOString();
      const data = { t: String(e.t || ''), room: String(e.room || ''), name: String(e.name || '').slice(0, 40), text: String(e.text).slice(0, 200), uid: ctx.uid, expiresAt: { __ts: expiresAt } };
      await this.fs.commit([this._chatSettingWrite(ctx, doc, 'on'), { set: ctx.base + '/chatlog/' + id, data, mustNotExist: true, serverTime: ['at'] }]);
      return true;
    } catch { return false; }
  }
  async _chatPage(ctx, after) {
    this._alive(ctx.sid);
    const structured = { orderBy: [{ field: { fieldPath: '__name__' } }], limit: CHAT_PAGE };
    if (after) structured.startAt = { values: [{ referenceValue: after }], before: false };
    const docs = await this.fs.query(ctx.base, { collection: 'chatlog', structured });
    this._alive(ctx.sid);
    return docs;
  }
  async listChatHistory() {
    const ctx = this._chatContext(), rows = [];
    let after;
    for (;;) {
      const docs = await this._chatPage(ctx, after);
      for (const d of docs) rows.push({ ...d.data, id: d.id });
      if (docs.length < CHAT_PAGE) return rows.sort((a, b) => String(b.at || b.t || '').localeCompare(String(a.at || a.t || '')));
      after = docs[docs.length - 1].name;
    }
  }
  async _drainChatHistory(ctx, mode) {
    const doc = await this._chatSetting(ctx);
    if (doc?.data.mode === 'delete-account' && mode !== 'delete-account') throw new Error('Hesap silme işlemini yeniden dene.');
    if (doc?.data.mode !== mode) await this.fs.commit([this._chatSettingWrite(ctx, doc, mode)]);
    // Start at the first remaining page after any failure, including a lost commit response.
    // Bind each batch to the current lock so a second device finishing or escalating the deletion
    // cannot make an older batch run after consent is restored.
    for (;;) {
      const lock = await this._chatSetting(ctx);
      if (lock?.data.mode !== mode) throw new Error('Silme durumu değişti. Geçmişi yenile ve yeniden dene.');
      const docs = await this._chatPage(ctx);
      if (!docs.length) {
        if (mode === 'delete-history') await this.fs.commit([this._chatSettingWrite(ctx, lock, 'off')]);
        this._alive(ctx.sid);
        return;
      }
      const writes = docs.map((d) => ({ del: ctx.base + '/chatlog/' + d.id }));
      await this.fs.commit([this._chatSettingWrite(ctx, lock, mode), ...writes]);
    }
  }

  async deleteChatHistory() {
    if (this._accountDeleting || this._chatDeleting) return fail('Silme işlemi zaten devam ediyor.');
    this._chatDeleting = true;
    try {
      await this._drainChatHistory(this._chatContext(), 'delete-history');
      return { ok: true };
    } catch (e) { return fail('Bulut sohbet geçmişi tamamen silinemedi. Silmeyi yeniden dene. ' + authMessage(e)); }
    finally { this._chatDeleting = false; }
  }

  // ---------- state ----------
  get user() { return this.auth.user; }
  get loggedIn() { return !!this.auth.user; }
  get status() {
    if (!this.auth.user) return 'guest';
    if (this.auth.dead) return 'expired';
    if (this.offline) return 'offline';
    const q = this._st().queue;
    if (this._busy || q.h.length || q.s.length) return 'pending';
    return 'synced';
  }
  get statusText() { return STATUS_TR[this.status] || ''; }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const f of this._listeners) { try { f(this.status); } catch (e) { console.warn('[cloud]', e); } } }
  _st() {
    const u = this.auth.user;
    const d = { cursor: null, queue: { h: [], s: [] }, up: {}, card: null, name: null, release: [], tp: '', tpDirty: false };
    if (!u) return d;
    if (this._stCache && this._stCache.uid === u.uid) return this._stCache.st;
    const st = Object.assign(d, jget(this.ls, STATE_PREFIX + u.uid, {}));
    st.queue = { h: Array.isArray(st.queue && st.queue.h) ? st.queue.h : [], s: Array.isArray(st.queue && st.queue.s) ? st.queue.s : [] };
    if (!st.up || typeof st.up !== 'object') st.up = {};
    if (!Array.isArray(st.release)) st.release = [];
    this._stCache = { uid: u.uid, st };
    return st;
  }
  _save() { const u = this.auth.user; if (u) lsSet(this.ls, STATE_PREFIX + u.uid, JSON.stringify(this._st())); }
  accountUids() { const a = jget(this.ls, ACCOUNT_UIDS_KEY, []); return Array.isArray(a) ? a.filter(P.isUid) : []; }
  _markAccountUid(uid) { const a = this.accountUids(); if (!a.includes(uid)) { a.push(uid); lsSet(this.ls, ACCOUNT_UIDS_KEY, JSON.stringify(a.slice(-50))); } }
  visibleHistory(records) {
    const p = this.o.profile.get();
    return visibleHistory(records, { profileUid: p && p.uid, loggedIn: this.loggedIn, accountUids: this.accountUids() });
  }
  _base() { return 'users/' + this.auth.user.uid; }
  // the current session: account uid + sign-in generation (a sign out and in again is a new session)
  _sid() { return this.auth.user ? this.auth.user.uid + ':' + this.auth._gen : null; }
  // a sync step started for session `sid` stops as soon as the session changed (sign out / another sign in)
  _alive(sid) { if (sid != null && this._sid() !== sid) throw new CloudError('stale', 'SESSION_CHANGED', 'Oturum değişti.'); }

  // ---------- account ----------
  // ---------- sign in with Google ----------
  // opts: {askName({suggest, error, email}) -> Promise<name | null (cancel)>: the user name of a NEW account,
  //        askMerge(count) -> Promise<bool>: add this PC's guest history to an existing account?,
  //        allowRedirect: popup blocked -> signInWithRedirect (the page leaves; finishGoogleRedirect() on load)}
  // -> {ok, error, silent (show nothing), redirecting, cancelled, newAccount, ...the _attach result}
  async loginGoogle(opts = {}) {
    if (!this.google) return fail('Google ile giriş bu tarayıcıda kullanılamıyor.');
    let c;
    try { c = await this.google.signIn({ allowRedirect: opts.allowRedirect !== false }); } catch (e) { return this._googleFail(e); }
    if (c && c.redirecting) return fail('', { redirecting: true, silent: true });
    return this._googleHandoff(c, opts);
  }
  // after a signInWithRedirect: null when no redirect was pending (or nothing came back), else as loginGoogle
  async finishGoogleRedirect(opts = {}) {
    if (!this.google || !this.google.redirectPending()) return null;
    let c;
    try { c = await this.google.finishRedirect(); } catch (e) { return this._googleFail(e); }
    return c ? this._googleHandoff(c, opts) : null;
  }
  _googleFail(e) { const m = googleMessage(e); return fail(m, { silent: !m, code: googleCode(e) }); }
  // the SDK signed in with Google and was signed out again: c = {uid, email, refreshToken, displayName}.
  // Our REST session takes over (own id token); the session reaches localStorage only once the profile is set up.
  async _googleHandoff(c, opts = {}) {
    if (this.loggedIn) this.logout();
    this._setup = true;   // no background sync while the account is being set up (no profile yet)
    try {
      try { await this.auth.adopt(c, { hold: true }); } catch (e) { return fail(authMessage(e)); }
      let doc;
      try { doc = await this.fs.get(this._base() + '/meta/profile'); } catch (e) { this.auth.signOut(); return fail(authMessage(e)); }
      let attachOpts = Object.assign({}, opts, { profileDoc: doc });
      let newAccount = false;
      if (!(doc && doc.data && P.isUid(doc.data.uid))) {
        // a new account: the player chooses its unique user name first (the same claim as a rename)
        const local = this.o.profile.get();
        const guest = local && !this.accountUids().includes(local.uid) ? local : null;
        let suggest = guest ? guest.name : nameFromGoogle(c.displayName, c.email), error = '', claimed = null;
        if (!opts.askName) {
          // the default: a unique user name from the Google e-mail (changeable later in Profil)
          const base = nameFromEmail(c.email || (this.auth.user && this.auth.user.email));
          for (let i = 0; i < 40 && !claimed; i++) {
            const n = P.checkName(nameCandidate(base, i));
            if (!n.ok) continue;
            try { if (await this._claim(n.name)) claimed = n.name; } catch (e) {
              let mine = false;
              if (e.retryable) { try { const d = await this.fs.get('names/' + nameKey(n.name)); mine = !!(d && this.auth.user && d.data.uid === this.auth.user.uid); } catch (x) { mine = false; } }
              if (!mine) { this.auth.signOut(); return fail(authMessage(e)); }
              claimed = n.name;
            }
            if (!this.auth.user || this.auth.user.uid !== c.uid) return fail('Oturum değişti.');
          }
        }
        for (let tries = 0; tries < 50 && !claimed; tries++) {
          let name = suggest;
          if (opts.askName) { try { name = await opts.askName({ suggest, error, email: this.auth.user ? this.auth.user.email : '' }); } catch (e) { name = null; } }
          if (name == null) { this.auth.signOut(); return fail('', { cancelled: true, silent: true }); }
          if (!this.auth.user || this.auth.user.uid !== c.uid) return fail('Oturum değişti.');
          const n = P.checkName(String(name));
          suggest = n.name || String(name);
          if (!n.ok) error = n.error;
          else {
            try {
              if (await this._claim(n.name)) claimed = n.name; else error = 'Bu ad alınmış. Başka bir ad seç.';
            } catch (e) {
              // the claim may have been committed before the connection dropped: look once
              let mine = false;
              if (e.retryable) { try { const d = await this.fs.get('names/' + nameKey(n.name)); mine = !!(d && this.auth.user && d.data.uid === this.auth.user.uid); } catch (x) { mine = false; } }
              if (!mine) { this.auth.signOut(); return fail(authMessage(e)); }
              claimed = n.name;
            }
          }
          if (!claimed && !opts.askName) break;
        }
        if (!claimed) { this.auth.signOut(); return fail(error || 'Bu ad alınmış.', { nameTaken: true }); }
        // the account takes over this PC's guest profile (its uid stays the multiplayer identity) with the new name
        if (guest) this.o.profile.set({ v: 1, uid: guest.uid, name: claimed, created: guest.created, avatar: avatarOf(guest.avatar, guest.uid) });
        else { const np = this.o.profile.create(claimed); if (np && !isAvatar(np.avatar)) this.o.profile.set(Object.assign({}, np, { avatar: defaultAvatar(np.uid) })); }
        attachOpts = Object.assign({}, opts, { claimed: true, profileDoc: null });
        newAccount = true;
      }
      this._setup = false;
      const sid = this._sid();
      const res = await this._attach(attachOpts);
      if (res.ok && this._sid() === sid) this.auth.commit();
      if (res.ok) res.newAccount = newAccount;
      return res;
    } finally { this._setup = false; }
  }
  async _attach(opts = {}) {
    const fb = this.auth.user.uid;
    this._stCache = null; this._saveList = null;
    let cloud = opts.profileDoc;   // (already read by the caller: undefined = read it here)
    if (cloud === undefined) { try { cloud = await this.fs.get(this._base() + '/meta/profile'); } catch (e) { this.auth.signOut(); return fail(authMessage(e)); } }
    const local = this.o.profile.get();
    const res = { ok: true, error: '', switched: false, merged: 0, created: false };
    const cd = cloud && cloud.data;
    if (!cd || !P.isUid(cd.uid)) {
      // a new account (or one whose profile was never written): upload this PC's profile and history
      let p = local && !this.accountUids().includes(local.uid) ? local : null;
      if (!p) p = this.o.profile.create(local ? local.name : nameFromEmail(this.auth.user.email));
      try {
        // (normally claimed by the caller: the user name dialog of a new account)
        if (!(opts.claimed || await this._claim(p.name))) { this.auth.signOut(); return fail('Bu ad alınmış. Başka bir ad seç.', { nameTaken: true }); }
        await this.fs.commit([{ set: this._base() + '/meta/profile', data: { uid: p.uid, name: p.name, created: p.created, avatar: avatarOf(p.avatar, p.uid) } }]);
      } catch (e) { this.auth.signOut(); return fail(authMessage(e)); }
      if (!isAvatar(p.avatar)) this.o.profile.set(Object.assign({}, p, { avatar: defaultAvatar(p.uid) }));
      this._st().name = p.name; this._save();
      res.created = true;
      lsDel(this.ls, GUEST_KEY);   // the guest profile became the account's: sign out starts a fresh guest
      this._markAccountUid(p.uid);
    } else {
      const named = P.checkName(cd.name || '');
      const cp = { v: 1, uid: cd.uid, name: named.ok ? named.name : (local ? local.name : 'Komutan'), created: Number(cd.created) || this.now(), avatar: avatarOf(cd.avatar, cd.uid) };
      if (local && local.uid === cp.uid) {
        if (local.name !== cp.name || local.avatar !== cp.avatar) this.o.profile.set(cp);
      } else {
        const guest = local && !this.accountUids().includes(local.uid) ? local : null;
        if (guest) lsSet(this.ls, GUEST_KEY, JSON.stringify({ v: 1, uid: guest.uid, name: guest.name, created: guest.created }));
        this._markAccountUid(cp.uid);
        this.o.profile.set(cp);
        res.switched = true;
        if (guest) {
          const mine = (await this.o.history.list()).filter((r) => r && r.uid === guest.uid);
          let yes = false;
          if (mine.length && opts.askMerge) { try { yes = !!(await opts.askMerge(mine.length)); } catch (e) { yes = false; } }
          if (yes) {
            res.merged = await this._reown(mine, guest.uid, cp.uid);
            // up before the first pull: the pulled account history could push these out of the local history cap
            try { await this._pushHistory(this._sid()); } catch (e) { /* stays queued */ }
          }
        }
      }
      this._st().name = cp.name; this._save();
      this._markAccountUid(cp.uid);
    }
    this._emit();
    // first sync on this PC: pulls the account's history, uploads what the cloud lacks
    await this.flush({ pull: true });
    return res;
  }
  // sign out: back to this PC's guest profile (the one from before the login; a fresh one when the account was
  // created from it). The account's history and saves stay cached in IndexedDB but are hidden from the guest.
  logout() {
    const p = this.o.profile.get();
    this.auth.signOut();
    if (this.google) { try { Promise.resolve(this.google.clear()).catch(() => {}); } catch (e) { /* ignore */ } }   // no SDK state survives
    this._stCache = null; this._saveList = null; this.offline = false; this.lastError = '';
    this._autoAt.clear(); this._pendingAuto.clear();
    if (this._retry != null) { this.clearTimer(this._retry); this._retry = null; }
    this._tkt = null; this._tktP = null;
    const g = jget(this.ls, GUEST_KEY, null);
    lsDel(this.ls, GUEST_KEY);
    if (this.guestless) { if (this.o.profile.clear) this.o.profile.clear(); }
    else if (P.validProfile(g) && !this.accountUids().includes(g.uid)) this.o.profile.set(g);
    else this.o.profile.create((p && p.name) || 'Komutan');
    this._emit();
  }
  // another tab changed 'aevum.auth' (window 'storage' event): follow it. Signed out there -> forget the session here
  // too (the other tab already switched the profile in localStorage); another account -> adopt its session.
  onAuthStorage() {
    const before = this.auth.user, now = this.auth.stored();
    if (!now) { if (!before) return; this.auth.forget(); }
    else if (before && before.uid === now.uid && this.auth.s) { this.auth.s.refreshToken = now.refreshToken; return; }   // same account (a refresh there)
    else this.auth.load();
    this._stCache = null; this._saveList = null; this.offline = false; this.lastError = ''; this._tkt = null; this._tktP = null;
    this._autoAt.clear(); this._pendingAuto.clear();
    if (this._retry != null) { this.clearTimer(this._retry); this._retry = null; }
    if (!this.loggedIn && this.guestless && this.o.profile.clear) this.o.profile.clear();
    this._emit();
    if (this.loggedIn) this.kick({ pull: true });
  }
  // claim names/{key} -> true (mine now / already mine) | false (taken by another account)
  async _claim(name) {
    const key = nameKey(name), path = 'names/' + key;
    const st = this._st();
    if (st.release.includes(key)) { st.release = st.release.filter((k) => k !== key); this._save(); }   // wanted again: keep it
    try { await this.fs.commit([{ set: path, data: { uid: this.auth.user.uid }, mustNotExist: true }]); return true; } catch (e) {
      if (e.kind !== 'exists' && e.kind !== 'denied') throw e;
      const d = await this.fs.get(path);
      if (d && d.data.uid === this.auth.user.uid) return true;
      if (d) return false;
      throw e;
    }
  }
  // release names/{key} (ours). Network / server errors: queued, flush() retries; denied / gone: nothing to do.
  async _release(key) {
    const st = this._st();
    try { await this.fs.commit([{ del: 'names/' + key }]); } catch (e) {
      if (e.retryable) { if (!st.release.includes(key)) { st.release.push(key); this._save(); } return false; }
      if (e.kind === 'auth') throw e;
    }
    if (st.release.includes(key)) { st.release = st.release.filter((k) => k !== key); this._save(); }
    return true;
  }
  async _pushReleases(sid) {
    const st = this._st();
    for (const key of st.release.slice()) {
      this._alive(sid);
      const p = this.o.profile.get();
      if (p && nameKey(p.name) === key) { st.release = st.release.filter((k) => k !== key); this._save(); continue; }   // in use again
      try { await this.fs.commit([{ del: 'names/' + key }]); } catch (e) { if (e.retryable || e.kind === 'auth') throw e; }
      this._alive(sid);
      st.release = st.release.filter((k) => k !== key); this._save();
    }
  }
  // rename the account profile: claim the new name, then release the old one
  async rename(name) {
    if (!this.loggedIn) return fail('Giriş yapılmadı.');
    const n = P.checkName(name);
    if (!n.ok) return fail(n.error);
    let p = this.o.profile.get();
    if (!p) return fail('Profil yok.');
    let claimedNew = false, newKey = nameKey(n.name), oldKey = nameKey(p.name);
    try {
      // the account's current name (another PC may have renamed it): that is the name to release
      const cur = await this.fs.get(this._base() + '/meta/profile');
      if (cur && cur.data && P.isUid(cur.data.uid) && cur.data.uid === p.uid && P.checkName(cur.data.name || '').ok) oldKey = nameKey(cur.data.name);
      if (newKey !== oldKey) {
        if (!(await this._claim(n.name))) return fail('Bu ad alınmış.');
        claimedNew = true;
      }
      await this.fs.commit([{ set: this._base() + '/meta/profile', data: { uid: p.uid, name: n.name, created: p.created, avatar: avatarOf(p.avatar, p.uid) } }]);
    } catch (e) {
      // the new name was claimed but the profile still has the old one: give the new name back (best effort)
      if (claimedNew) { try { await this._release(newKey); } catch (x) { /* queued / ignore */ } }
      return fail(e.kind === 'network' ? 'Çevrimdışı: ad şu an değiştirilemiyor.' : authMessage(e));
    }
    if (newKey !== oldKey) { try { await this._release(oldKey); } catch (e) { /* session gone: nothing to do */ } }
    p = this.o.profile.get() || p;
    const np = { v: 1, uid: p.uid, name: n.name, created: p.created, avatar: avatarOf(p.avatar, p.uid) };
    this.o.profile.set(np);
    const st = this._st(); st.card = null; st.name = n.name; this._save();
    this._tkt = null;   // the relay ticket carries the name
    this.kick();   // the public card follows
    return { ok: true, error: '', profile: np };
  }
  // pick another avatar (src/avatars.js) -> {ok, error, profile}
  async setAvatar(id) {
    if (!this.loggedIn) return fail('Giriş yapılmadı.');
    if (!isAvatar(id)) return fail('Geçersiz avatar.');
    const p = this.o.profile.get();
    if (!p) return fail('Profil yok.');
    const name = this._st().name || p.name;
    try {
      await this.fs.commit([{ set: this._base() + '/meta/profile', data: { uid: p.uid, name, created: p.created, avatar: id } }]);
    } catch (e) { return fail(e.kind === 'network' ? 'Çevrimdışı: avatar şu an değiştirilemiyor.' : authMessage(e)); }
    const np = Object.assign({}, this.o.profile.get() || p, { avatar: id });
    this.o.profile.set(np);
    const st = this._st(); st.card = null; this._save();
    this._tkt = null;
    this.kick();
    return { ok: true, error: '', profile: np };
  }
  // the account profile as stored in the cloud (1 read): a rename on another PC reaches this PC
  async _pullMeta(sid) {
    const pp = this._base() + '/meta/profile', tp = this._base() + '/meta/tp';
    const got = await this.fs.batchGet([pp, tp]);
    this._alive(sid);
    this._mergeLedger(got.get(tp) && got.get(tp).data && got.get(tp).data.s);
    const d = got.get(pp);
    const cd = d && d.data;
    if (!cd || !P.isUid(cd.uid)) return;
    const named = P.checkName(cd.name || '');
    if (!named.ok) return;
    const st = this._st();
    const p = this.o.profile.get();
    const av = avatarOf(cd.avatar, cd.uid);
    if (!p || p.uid !== cd.uid || p.name !== named.name || p.avatar !== av) {
      // the account's profile (its name / avatar change): the multiplayer identity follows the account
      const np = { v: 1, uid: cd.uid, name: named.name, created: Number(cd.created) || (p && p.uid === cd.uid ? p.created : this.now()), avatar: av };
      this._markAccountUid(np.uid);
      this.o.profile.set(np);
    }
    if (st.name !== named.name) { st.name = named.name; this._save(); }
  }

  // ---------- TP (points) ----------
  // the ledger is signed by the game server; here it is only kept (local state + users/{fb}/meta/tp)
  get tp() { const i = ledgerInfo(this._st().tp); return i && (!i.fb || !this.auth.user || i.fb === this.auth.user.uid) ? i : { tp: 0, w: 0, l: 0, n: 0 }; }
  _mergeLedger(s) {
    if (typeof s !== 'string' || !s) return;
    const st = this._st(), a = ledgerInfo(s), b = ledgerInfo(st.tp);
    if (!a || (a.fb && this.auth.user && a.fb !== this.auth.user.uid)) return;
    if (!b || a.n > b.n) { st.tp = s; st.tpDirty = false; this._save(); this._emit(); }
    else if (b.n > a.n) { st.tpDirty = true; this._save(); }   // ours is newer: it goes up
  }
  async _pushTp(sid) {
    const st = this._st();
    if (!st.tpDirty || !st.tp) return;
    const s = st.tp;
    await this.fs.commit([{ set: this._base() + '/meta/tp', data: { s } }]);
    this._alive(sid);
    if (st.tp === s) { st.tpDirty = false; this._save(); }
  }
  async _relay(pathname, body, ticket) {
    const headers = { 'Content-Type': 'application/json' };
    if (ticket) headers['X-Aevum-Ticket'] = ticket;
    let r;
    try { r = await this.relayFetch(this.relayBase + pathname, { method: 'POST', headers, body: JSON.stringify(body || {}) }); } catch (e) { throw new CloudError('network', 'NETWORK', 'Oyun sunucusuna ulaşılamadı.'); }
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) throw new CloudError(r.status === 401 || r.status === 403 ? 'auth' : r.status >= 500 ? 'server' : 'bad', 'RELAY_' + r.status, (j && j.error) || ('Sunucu hatası (' + r.status + ').'), r.status);
    return j || {};
  }
  // the relay ticket of this account: the server verified our Google session and read our profile -> {ticket, ident, exp}
  async relayTicket(fresh = false) {
    if (!this.loggedIn) throw new CloudError('auth', 'NO_SESSION', 'Giriş yapılmadı.');
    if (!fresh && this._tkt && this._tkt.exp - this.now() > 10 * 60 * 1000 && this._tkt.fb === this.auth.user.uid) return this._tkt;
    if (!this._tktP) {
      const fb = this.auth.user.uid;
      this._tktP = (async () => {
        let token = await this.auth.token(false);
        let r;
        try { r = await this._relay('/mp/auth', { token }); } catch (e) {
          if (e.status !== 401) throw e;
          token = await this.auth.token(true);   // a stale id token: once more with a fresh one
          r = await this._relay('/mp/auth', { token });
        }
        if (!this.auth.user || this.auth.user.uid !== fb) throw new CloudError('stale', 'SESSION_CHANGED', 'Oturum değişti.');
        this._tkt = { ticket: r.ticket, ident: r.ident, exp: r.exp, fb, owner: r.owner === true };
        return this._tkt;
      })().finally(() => { this._tktP = null; });
    }
    return this._tktP;
  }
  // the current relay ticket when one is at hand (never fetches one): the stats beat carries it when it can
  ticketNow() { return this.loggedIn && this._tkt && this._tkt.fb === this.auth.user.uid && this._tkt.exp > this.now() ? this._tkt.ticket : null; }
  // the game's owner (AEVUM_OWNERS on the server) sees the player statistics
  async isOwner() { try { return !!(await this.relayTicket()).owner; } catch (e) { return false; } }
  // -> {online: {total, menu, sp, mp, signedIn}, today, days: [{day, visitors, players, sp, mp, peak}], persisted}
  async stats() {
    const t = await this.relayTicket();
    let r;
    try { r = await this.relayFetch(this.relayBase + '/mp/stats', { cache: 'no-store', headers: { 'X-Aevum-Ticket': t.ticket } }); } catch (e) { throw new CloudError('network', 'NETWORK', 'Oyun sunucusuna ulaşılamadı.'); }
    if (!r.ok) throw new CloudError('server', 'STATS_' + r.status, r.status === 403 ? 'Bu ekran yalnızca oyunun sahibine açık.' : 'İstatistikler alınamadı (' + r.status + ').', r.status);
    return r.json();
  }
  // a match starts -> the server's match ticket (null when it cannot be had: no TP for this match then)
  async tpStart(mode, room) {
    try { const t = await this.relayTicket(); const r = await this._relay('/mp/tp/start', { mode, room }, t.ticket); return typeof r.mt === 'string' ? r.mt : null; } catch (e) { console.warn('[tp] start', e && e.message); return null; }
  }
  // a match ended -> {ok, gained, tp, reason}
  async tpClaim(mt, result) {
    if (!mt || (result !== 'won' && result !== 'lost')) return { ok: false, gained: 0, tp: this.tp.tp, reason: '' };
    try {
      const t = await this.relayTicket();
      const r = await this._relay('/mp/tp/claim', { mt, result, ledger: this._st().tp || '' }, t.ticket);
      if (r.ok && typeof r.ledger === 'string') {
        const st = this._st();
        if (r.ledger !== st.tp) { st.tp = r.ledger; st.tpDirty = true; this._save(); }
        if (r.gained) this._tkt = null;   // the lobby shows the new TP after a fresh ticket
        this._emit(); this.kick();
      }
      return { ok: !!r.ok, gained: r.gained | 0, tp: r.tp | 0, reason: r.reason || '' };
    } catch (e) { console.warn('[tp] claim', e && e.message); return { ok: false, gained: 0, tp: this.tp.tp, reason: 'TP şu an hesaplanamadı (' + ((e && e.message) || e) + ').' }; }
  }

  // ---------- friends ----------
  // users/{fb}/friends/{friendFb} {name, avatar, added}: my list (owner only). Players are found through the public
  // cards profiles/{fb} (any signed-in user can read them). Online status and invites go through the game server.
  _cardOf(d) {
    const x = d.data || {};
    return { fb: d.id, name: P.checkName(x.name || '').ok ? P.checkName(x.name).name : 'Oyuncu', avatar: isAvatar(x.avatar) ? x.avatar : null, games: x.games | 0, wins: x.wins | 0 };
  }
  // registered players, most recently active first (my own card left out) -> [{fb, name, avatar, games, wins}]
  async players(limit = 100) {
    if (!this.loggedIn) return [];
    const docs = await this.fs.query('', { collection: 'profiles', structured: { orderBy: [{ field: { fieldPath: 'updated' }, direction: 'DESCENDING' }], limit } });
    return docs.map((d) => this._cardOf(d)).filter((c) => c.fb !== this.auth.user.uid);
  }
  // a player by exact user name (case-insensitive, Turkish-aware) -> card | null
  async findPlayer(name) {
    if (!this.loggedIn) return null;
    const n = P.checkName(name);
    if (!n.ok) return null;
    const d = await this.fs.get('names/' + nameKey(n.name));
    if (!d || !d.data || typeof d.data.uid !== 'string') return null;
    const c = await this.fs.get('profiles/' + d.data.uid);
    return c ? this._cardOf(c) : { fb: d.data.uid, name: n.name, avatar: null, games: 0, wins: 0 };
  }
  async friends() {
    if (!this.loggedIn) return [];
    const docs = await this.fs.query(this._base(), { collection: 'friends', structured: { limit: 300 } });
    return docs.map((d) => this._cardOf(d)).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }
  async addFriend(card) {
    if (!this.loggedIn || !card || typeof card.fb !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(card.fb)) return fail('Oyuncu bulunamadı.');
    if (card.fb === this.auth.user.uid) return fail('Kendini arkadaş olarak ekleyemezsin.');
    try { await this.fs.commit([{ set: this._base() + '/friends/' + card.fb, data: { name: String(card.name || 'Oyuncu').slice(0, P.NAME_MAX), avatar: isAvatar(card.avatar) ? card.avatar : null, added: this.now() } }]); } catch (e) { return fail(authMessage(e)); }
    return { ok: true, error: '' };
  }
  async removeFriend(fb) {
    if (!this.loggedIn || !/^[A-Za-z0-9]{1,128}$/.test(String(fb))) return fail('Geçersiz.');
    try { await this.fs.commit([{ del: this._base() + '/friends/' + fb }]); } catch (e) { return fail(authMessage(e)); }
    return { ok: true, error: '' };
  }
  // which of these accounts have the game open right now -> Set(fb)
  async online(fbs) {
    if (!this.loggedIn || !fbs.length) return new Set();
    const t = await this.relayTicket();
    const r = await this._relay('/mp/online', { fbs }, t.ticket);
    return new Set(Array.isArray(r.online) ? r.online : []);
  }
  // invite a friend into my room (code) -> {ok, online}
  async invite(fb, code) {
    const t = await this.relayTicket();
    const r = await this._relay('/mp/invite', { to: fb, code }, t.ticket);
    return { ok: true, online: !!r.online };
  }
  // my inbox on the game server (long-poll while signed in): it also marks me online. onMsg({type:'invite', code, from})
  startInbox(onMsg) {
    this._inboxFn = onMsg;
    if (this._inboxRun) return;
    this._inboxRun = true;
    const loop = async () => {
      let fails = 0;
      while (this._inboxRun) {
        if (!this.loggedIn || this.auth.dead) { await new Promise((r) => this.setTimer(r, 5000)); continue; }
        const fb = this.auth.user.uid;
        try {
          const t = await this.relayTicket();
          const ctl = typeof AbortController === 'function' ? new AbortController() : null;
          const to = ctl ? this.setTimer(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, 35000) : null;
          let r;
          try { r = await this.relayFetch(this.relayBase + '/mp/inbox?tk=' + encodeURIComponent(t.ticket) + '&t=' + this.now(), Object.assign({ cache: 'no-store' }, ctl ? { signal: ctl.signal } : {})); } finally { if (to != null) this.clearTimer(to); }
          if (r.status === 401) { this._tkt = null; throw new Error('ticket'); }
          if (!r.ok) throw new Error('inbox ' + r.status);
          const arr = await r.json();
          fails = 0;
          if (!this.loggedIn || this.auth.user.uid !== fb) continue;   // signed out / switched meanwhile
          for (const m of Array.isArray(arr) ? arr : []) { try { if (this._inboxFn) this._inboxFn(m); } catch (e) { console.warn('[inbox]', e); } }
        } catch (e) {
          fails++;
          await new Promise((r) => this.setTimer(r, Math.min(30000, 2000 * fails)));
        }
      }
    };
    loop();
  }
  stopInbox() { this._inboxRun = false; }

  // ---------- delete the account ----------
  // Google asks for a fresh sign in first (Firebase refuses to delete an account signed in long ago); then every
  // document of the account goes, then the Firebase account itself. localChat(fb) and local(profileUid) are cleanup hooks.
  async deleteAccount(opts = {}) {
    if (!this.loggedIn) return fail('Giriş yapılmadı.');
    if (this._accountDeleting || this._chatDeleting) return fail('Silme işlemi zaten devam ediyor.');
    this._accountDeleting = true;
    try { return await this._deleteAccount(opts); } finally { this._accountDeleting = false; }
  }
  async _deleteAccount(opts) {
    const fb = this.auth.user.uid, before = this._sid();
    if (opts.reauth !== false && this.google) {
      let c;
      try { c = await this.google.signIn({ allowRedirect: false }); } catch (e) { return this._googleFail(e); }
      if (!c || c.uid !== fb) { try { await this.google.clear(); } catch (e) { /* ignore */ } return fail('Silmek için aynı Google hesabını seçmelisin.'); }
      try { this._alive(before); await this.auth.adopt(c); } catch (e) { return fail(authMessage(e)); }
    }
    const p = this.o.profile.get();
    try {
      const ctx = this._chatContext(), { base, sid } = ctx;
      await this._busy;
      await this._drainChatHistory(ctx, 'delete-account');
      this._alive(sid);
      if (opts.localChat) await opts.localChat(fb);
      const dels = [];
      for (let page = 0; page < 20; page++) {
        const docs = await this.fs.query(base, { collection: 'matches', structured: { limit: 300 } });
        this._alive(sid);
        if (!docs.length) break;
        await this._delAll(docs.map((d) => base + '/matches/' + d.id));
        if (docs.length < 300) break;
      }
      const saves = await this.fs.query(base, { collection: 'saves', structured: { limit: 200 } });
      for (const d of saves) {
        const m = this._metaOf(d);
        dels.push(base + '/saves/' + d.id);
        for (let j = 0; j < Math.min(400, m.chunks | 0); j++) dels.push(this._chunkPath(base + '/saves/' + d.id, m, j));
      }
      for (const d of await this.fs.query(base, { collection: 'friends', structured: { limit: 300 } })) dels.push(base + '/friends/' + d.id);
      dels.push(base + '/meta/profile', base + '/meta/tp', 'profiles/' + fb);
      const names = new Set([this._st().name, p && p.name].filter(Boolean).map((n) => nameKey(n)));
      for (const k of names) { const d = await this.fs.get('names/' + k); if (d && d.data.uid === fb) dels.push('names/' + k); }
      this._alive(sid);
      await this._delAll(dels);
      this._alive(sid);
      await this._delAll([base + '/meta/chat']);
      this._alive(sid);
      await this.auth.deleteAccount();
    } catch (e) { return fail('Hesap silme tamamlanamadı. İşlem kısmen uygulanmış olabilir; silmeyi yeniden dene. ' + authMessage(e)); }
    lsDel(this.ls, STATE_PREFIX + fb);
    this._stCache = null; this._saveList = null; this._tkt = null;
    if (this.google) { try { await this.google.clear(); } catch (e) { /* ignore */ } }
    if (p && opts.local) { try { await opts.local(p.uid); } catch (e) { console.warn('[cloud] local cleanup', e); } }
    if (this.guestless && this.o.profile.clear) this.o.profile.clear();
    this._emit();
    return { ok: true, error: '' };
  }
  async _delAll(paths) { for (let i = 0; i < paths.length; i += 400) await this.fs.commit(paths.slice(i, i + 400).map((x) => ({ del: x }))); }

  // ---------- history ----------
  async _reown(recs, oldUid, newUid) {
    const local = new Map((await this.o.history.list()).map((r) => [r.id, r]));
    const put = [], drop = [];
    for (const r of recs) {
      const c = reownRecord(r, oldUid, newUid);
      // same id: replaces the guest original itself; a new id (mp records): unless the account already has a better copy
      if (c.id !== r.id) { drop.push(r.id); if (!local.has(c.id) || betterRecord(c, local.get(c.id))) put.push(c); } else put.push(c);
    }
    if (put.length) await this.o.history.put(put);
    if (drop.length) await this.o.history.del(drop);
    this._queue('h', put.map((r) => r.id));
    return recs.length;
  }
  // a finished / abandoned match of this profile (main.js recordGame)
  onRecord(rec) {
    const p = this.o.profile.get();
    if (!this.loggedIn || !rec || !p || rec.uid !== p.uid) return;
    this._queue('h', [rec.id]);
    this.kick({ pull: true });
  }
  // records written by an import: the account's own ones are uploaded
  onRecords(recs) {
    const p = this.o.profile.get();
    if (!this.loggedIn || !p) return;
    const ids = (recs || []).filter((r) => r && r.uid === p.uid).map((r) => r.id);
    if (ids.length) { this._queue('h', ids); this.kick({ pull: false }); }
  }
  _queue(kind, ids) {
    if (!this.loggedIn || !ids.length) return;
    const q = this._st().queue[kind];
    for (const id of ids) if (!q.includes(id)) q.push(id);
    this._save(); this._emit();
  }
  _unqueue(kind, ids) { const st = this._st(); const s = new Set(ids); st.queue[kind] = st.queue[kind].filter((x) => !s.has(x)); this._save(); }
  // incremental pull (cursor = last (t, name) seen); merges into the local cache. -> number of new / changed records
  async _pull(sid) {
    const st = this._st(), p = this.o.profile.get();
    const first = !st.cursor;
    let cursor = st.cursor;
    const got = [];
    for (let page = 0; page < 50; page++) {
      const sq = { orderBy: [{ field: { fieldPath: 't' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: HIST_PAGE };
      if (cursor) sq.startAt = { values: [{ timestampValue: cursor.t }, { referenceValue: cursor.name }], before: false };
      const docs = await this.fs.query(this._base(), { collection: 'matches', structured: sq });
      this._alive(sid);
      for (const d of docs) {
        let r = null;
        try { r = JSON.parse(d.data.j); } catch (e) { r = null; }
        if (r && !P.recordError(r, this.now()) && r.id === d.id) got.push(r);
      }
      if (docs.length) { const l = docs[docs.length - 1]; if (l.data.t) cursor = { t: l.data.t, name: l.name }; }
      if (docs.length < HIST_PAGE) break;
    }
    const local = new Map((await this.o.history.list()).map((r) => [r.id, r]));
    this._alive(sid);
    const put = [], up = [], seen = new Set();
    for (const r of got) {
      seen.add(r.id);
      if (!p || (r.uid != null && r.uid !== p.uid)) continue;   // not this account's profile
      const l = local.get(r.id);
      if (betterRecord(r, l)) put.push(r);
      else if (l && betterRecord(l, r)) up.push(l.id);          // the local copy is better: send it
    }
    if (first && p) for (const r of local.values()) if (r.uid === p.uid && !seen.has(r.id)) up.push(r.id);
    if (put.length) await this.o.history.put(put);
    this._alive(sid);
    st.cursor = cursor; this._save();
    if (up.length) this._queue('h', up);
    return put.length;
  }
  async _pushHistory(sid) {
    const p = this.o.profile.get();
    for (let guard = 0; guard < 100; guard++) {
      this._alive(sid);
      const ids = this._st().queue.h.slice(0, HIST_BATCH);
      if (!ids.length) return;
      const writes = [], done = [];
      for (const id of ids) {
        const r = await this.o.history.get(id);
        done.push(id);
        if (!r || !p || r.uid !== p.uid || !KEY_RE.test(id)) continue;
        writes.push({ set: this._base() + '/matches/' + id, data: { j: JSON.stringify(r), e: r.endedAt || 0 }, serverTime: ['t'] });
      }
      this._alive(sid);
      if (writes.length) {
        try { await this.fs.commit(writes); } catch (e) {
          if (e.retryable || e.kind === 'auth' || e.kind === 'stale') throw e;
          // a rejected batch: one by one, so only the record the server refuses on its own is dropped
          for (const w of writes) {
            this._alive(sid);
            try { await this.fs.commit([w]); } catch (x) { if (x.retryable || x.kind === 'auth' || x.kind === 'stale') throw x; console.warn('[cloud] history write dropped', w.set, x); }
          }
        }
      }
      this._alive(sid);
      this._unqueue('h', done);
    }
  }
  async _pushCard(sid) {
    const p = this.o.profile.get(), st = this._st();
    if (!p) return;
    const mine = (await this.o.history.list()).filter((r) => r.uid === p.uid);
    this._alive(sid);
    const t = P.summarize(mine);
    // the account's name as the cloud has it (a stale local copy never puts an old name back on the card)
    const card = { name: st.name || p.name, games: t.games, wins: t.wins, avatar: avatarOf(p.avatar, p.uid) };
    if (st.card && st.card.name === card.name && st.card.games === card.games && st.card.wins === card.wins && st.card.avatar === card.avatar) return;
    await this.fs.commit([{ set: 'profiles/' + this.auth.user.uid, data: card, serverTime: ['updated'] }]);
    st.card = card; this._save();
  }
  // delete the account's history (local cache + cloud)
  async deleteHistory(ids) {
    if (!this.loggedIn) return;
    this._unqueue('h', ids);
    for (let i = 0; i < ids.length; i += 400) {
      await this.fs.commit(ids.slice(i, i + 400).filter((id) => KEY_RE.test(id)).map((id) => ({ del: this._base() + '/matches/' + id })));
    }
    this._st().card = null; this._save();
    this.kick();
  }

  // ---------- sync loop ----------
  // pull: also fetch new history. Concurrent calls coalesce; the returned promise never rejects.
  flush(opts = {}) {
    if (!this.loggedIn || this._accountDeleting) return Promise.resolve({ ok: false, added: 0 });
    const sid = this._sid();
    if (this._busy) {
      // a loop of an earlier session (signed out / switched meanwhile): run after it ends instead of joining it
      if (this._busySid !== sid) return this._busy.then(() => this.flush(opts));
      this._again = { pull: !!((this._again && this._again.pull) || opts.pull) };
      return this._busy;
    }
    this._busySid = sid;
    this._busy = (async () => {
      let res = { ok: true, added: 0 }, o = opts;
      do {
        this._again = null;
        const r = await this._flushOnce(o);
        res = { ok: r.ok, added: res.added + (r.added || 0) };
        o = this._again || {};
      } while (this._again !== null && this._sid() === sid && res.ok);
      return res;
    })().finally(() => { this._busy = null; this._busySid = null; this._emit(); });
    this._emit();
    return this._busy;
  }
  async _flushOnce({ pull } = {}) {
    if (!this.loggedIn || this.auth.dead || this._setup) return { ok: false, added: 0 };
    const sid = this._sid();
    let added = 0;
    try {
      const q = this._st().queue;
      if (pull) await this._pullMeta(sid);
      if (pull || q.h.length) added = await this._pull(sid);   // pull first: a finished record never loses to an older 'abandoned'
      await this._pushHistory(sid);
      await this._pushSaves(sid);
      await this._pushReleases(sid);
      await this._pushTp(sid);
      await this._pushCard(sid);
      if (this._sid() !== sid) return { ok: false, added };
      this.offline = false; this.lastError = ''; this._backoff = 0;
      return { ok: true, added };
    } catch (e) {
      if (this._sid() !== sid || (e && e.kind === 'stale')) return { ok: false, added };   // logged out / switched meanwhile
      this._failed(e);
      return { ok: false, added, error: e };
    }
  }
  _failed(e) {
    console.warn('[cloud]', e && (e.code || e.message));
    if (e && e.kind === 'stale') return;
    if (e && e.kind === 'auth') { this.auth.dead = true; this.lastError = authMessage(e); return; }
    this.offline = true;
    this.lastError = e && e.kind === 'quota' ? 'Bulut kotası doldu; daha sonra tekrar denenecek.' : e && e.kind === 'network' ? 'Çevrimdışı; bağlantı gelince tekrar denenecek.' : 'Bulut hatası; daha sonra tekrar denenecek.';
    this._schedule(e && e.kind === 'quota' ? RETRY_MAX : null);
  }
  _schedule(ms) {
    if (this._retry != null) return;
    this._backoff = Math.min(RETRY_MAX, this._backoff ? this._backoff * 2 : RETRY_MIN);
    this._retry = this.setTimer(() => { this._retry = null; this.kick({ pull: true }); }, ms || this._backoff);
  }
  // fire and forget
  kick(opts = {}) { if (this.loggedIn && !this.auth.dead && !this._setup) this.flush(opts); }
  // app start: resume the session in the background
  start() { if (this.loggedIn) { this._emit(); this.kick({ pull: true }); } }

  // ---------- saves ----------
  // a local save was written (key in the local store). info: {auto, game: match id / mp code}
  onSaved(key, info = {}) {
    if (!this.loggedIn || !KEY_RE.test(String(key))) return;
    const g = info.game || key;
    if (info.auto) {
      const last = this._autoAt.get(g);
      if (last != null && this.now() - last < AUTO_UPLOAD_MS) { this._pendingAuto.set(g, key); return; }
      this._autoAt.set(g, this.now());
    }
    this._pendingAuto.delete(g);
    this._queue('s', [key]);
    this.kick();
  }
  // leaving a game: the autosave that waited for the 5 minute gate goes up now
  onLeave(game) {
    if (!this.loggedIn || game == null) return;
    const k = this._pendingAuto.get(game);
    if (k == null) return;
    this._pendingAuto.delete(game);
    this._autoAt.set(game, this.now());
    this._queue('s', [k]);
    this.kick();
  }
  async _pushSaves(sid) {
    for (let guard = 0; guard < 100; guard++) {
      this._alive(sid);
      const key = this._st().queue.s[0];
      if (key == null) return;
      const rec = await this.o.saves.get(key);
      this._alive(sid);
      if (rec && rec.data) {
        try { await this._upload(key, rec, sid); } catch (e) { if (e.retryable || e.kind === 'auth' || e.kind === 'stale') throw e; console.warn('[cloud] save upload dropped', e); }
      }
      this._alive(sid);
      this._unqueue('s', [key]);
      this._emit();
    }
  }
  _metaOf(d) {
    const m = d.data || {};
    return {
      key: d.id, name: String(m.name || d.id), time: Number(m.time) || 0, mp: !!m.mp, code: m.code || null, tick: m.tick | 0, me: m.me, matchId: m.matchId || null,
      players: Array.isArray(m.players) ? m.players : [], hash: m.hash == null ? null : m.hash, size: m.size | 0, chunks: m.chunks | 0, sha: String(m.sha || ''), enc: m.enc || 'none', auto: !!m.auto,
      gen: typeof m.gen === 'string' && /^[0-9a-f]{1,64}$/.test(m.gen) ? m.gen : '',
    };
  }
  // the chunk doc i of a save version (empty meta.gen: the first layout, chunks/{i})
  _chunkPath(base, m, i) { return base + '/chunks/' + (m.gen ? m.gen + '-' + i : i); }
  async _upload(localKey, rec, sid) {
    const ck = cloudKeyOf(localKey, rec);
    if (!KEY_RE.test(ck)) return;
    const st = this._st();
    const pk = await packSave(rec, this.o.packOpts || {});
    this._alive(sid);
    if (st.up[ck] === pk.sha) return;   // the cloud already holds exactly this save
    // the version this upload replaces (from the cached list: at worst a stale entry leaves orphaned chunk docs of
    // a version another PC uploaded meanwhile; the meta doc always points to complete chunks)
    const list = await this.listCloudSaves({ strict: true });
    this._alive(sid);
    const base = this._base() + '/saves/' + ck;
    const old = list.find((x) => x.key === ck) || null;
    // every version has its own chunk docs (gen = sha prefix): the previous version stays readable until the meta
    // doc switches to the new one, and its chunks are deleted in that same commit
    const gen = pk.sha.slice(0, 12);
    const cur = { gen };
    const chunkW = pk.parts.map((d, j) => ({ set: this._chunkPath(base, cur, j), data: { i: j, sha: pk.sha, d } }));
    const drop = [];
    if (old && old.chunks > 0 && old.chunks <= 400) {
      for (let j = 0; j < old.chunks; j++) { const q = this._chunkPath(base, old, j); if (old.gen !== gen || j >= pk.parts.length) drop.push({ del: q }); }
    }
    const total = pk.parts.reduce((a, x) => a + x.length, 0);
    const atomic = total <= (this.o.atomicChars || ATOMIC_CHARS) && chunkW.length + drop.length + 1 <= 500;
    if (!atomic) {
      // too big for one request: the new version's chunks first (the old meta still points to the old chunks)
      for (let i = 0; i < chunkW.length; i += CHUNKS_PER_COMMIT) { await this.fs.commit(chunkW.slice(i, i + CHUNKS_PER_COMMIT), 120000); this._alive(sid); }
    }
    const meta = {
      v: 1, name: String(rec.name || ck).slice(0, 200), time: Number(rec.time) || this.now(), mp: !!rec.mp, code: rec.code || null, tick: rec.tick | 0,
      me: rec.me == null ? null : rec.me | 0, players: Array.isArray(rec.players) ? rec.players : [], hash: rec.hash == null ? null : rec.hash,
      matchId: MATCH_RE.test(rec.matchId || '') ? rec.matchId : null, auto: isAutoKey(ck) || isAutoKey(localKey),
      size: pk.size, chunks: pk.parts.length, sha: pk.sha, enc: pk.enc, gen,
    };
    const metaW = { set: base, data: meta, serverTime: ['up'] };
    if (atomic) await this.fs.commit(chunkW.concat([metaW], drop), 120000);
    else {
      await this.fs.commit([metaW].concat(drop.slice(0, 499)));
      for (let i = 499; i < drop.length; i += 400) { try { await this.fs.commit(drop.slice(i, i + 400)); } catch (e) { /* orphaned old chunks: harmless */ } }
    }
    this._alive(sid);
    st.up[ck] = pk.sha; this._save();
    const item = Object.assign({ key: ck }, meta);
    this._saveList = (this._saveList || []).filter((s) => s.key !== ck).concat([item]);
    for (const k of pruneList(this._saveList, MAX_CLOUD_SAVES, ck)) await this.deleteCloudSave(k);
  }
  // -> [meta] (cached for a minute). maxWait: answer from the cache (or []) after this many ms, the fetch goes on.
  // strict: errors are thrown (used by uploads); otherwise an error returns the cache (or []).
  async listCloudSaves({ force = false, maxWait = 0, strict = false } = {}) {
    if (!this.loggedIn) return [];
    if (!force && this._saveList && this.now() - this._saveListAt < SAVE_LIST_TTL) return this._saveList;
    if (!this._saveListP) {
      const uid = this.auth.user.uid;
      this._saveListP = this.fs.query(this._base(), { collection: 'saves', structured: { limit: 200 } }).then((docs) => {
        if (!this.auth.user || this.auth.user.uid !== uid) return [];
        this._saveList = docs.map((d) => this._metaOf(d)); this._saveListAt = this.now();
        return this._saveList;
      }).finally(() => { this._saveListP = null; });
    }
    const p = this._saveListP;
    if (strict) return p;
    const safe = p.catch((e) => { if (e && e.retryable) { this.offline = true; this._emit(); } return this._saveList || []; });
    if (!maxWait) return safe;
    return Promise.race([safe, new Promise((r) => this.setTimer(() => r(this._saveList || []), maxWait))]);
  }
  cachedSave(ck) { return (this._saveList || []).find((s) => s.key === ck) || null; }
  // download + verify; stored in the local store under localKey (default: the cloud key). -> the save record
  async downloadSave(ck, localKey) {
    if (!this.loggedIn) throw new CloudError('auth', 'NO_SESSION', 'Giriş yapılmadı.');
    const base = this._base() + '/saves/' + ck;
    const d = await this.fs.get(base);
    if (!d) throw new CloudError('notfound', 'NOT_FOUND', 'Kayıt bulutta bulunamadı.');
    const meta = this._metaOf(d);
    if (!(meta.chunks > 0) || meta.chunks > 400) throw new Error('Buluttaki kayıt bozuk.');
    const paths = [];
    for (let i = 0; i < meta.chunks; i++) paths.push(this._chunkPath(base, meta, i));
    const got = await this.fs.batchGet(paths);
    const parts = paths.map((p, i) => {
      const c = got.get(p);
      if (!c || c.data.sha !== meta.sha || (c.data.i | 0) !== i || typeof c.data.d !== 'string') throw new Error('Kayıt bütünlük denetimi başarısız (eksik ya da yarım yüklenmiş parça). Biraz sonra tekrar dene.');
      return c.data.d;
    });
    const rec = await unpackSave(parts, meta);
    if (!rec || typeof rec !== 'object' || !rec.data) throw new Error('Buluttaki kayıt okunamadı.');
    const key = localKey || ck;
    if (!(await this.o.saves.put(key, rec))) throw new Error('Kayıt bu bilgisayara yazılamadı.');
    this._st().up[ck] = meta.sha; this._save();
    return rec;
  }
  async deleteCloudSave(ck) {
    if (!this.loggedIn) return false;
    let m = this.cachedSave(ck);
    if (!m) { const d = await this.fs.get(this._base() + '/saves/' + ck); if (!d) return true; m = this._metaOf(d); }
    const base = this._base() + '/saves/' + ck;
    const w = [{ del: base }];
    for (let j = 0; j < Math.min(400, m.chunks | 0); j++) w.push({ del: this._chunkPath(base, m, j) });
    for (let i = 0; i < w.length; i += 400) await this.fs.commit(w.slice(i, i + 400));
    const st = this._st(); delete st.up[ck]; this._save();
    if (this._saveList) this._saveList = this._saveList.filter((s) => s.key !== ck);
    return true;
  }
}

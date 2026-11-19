// Aevum - in-memory fake of the Firebase REST endpoints the cloud client uses (test/cloud-test.mjs):
// Identity Toolkit (delete), Secure Token (refresh), a Google sign-in (ff.googleSignIn: what the SDK popup returns) and
// Firestore v1 (GET doc, :commit with exists-precondition / REQUEST_TIME transforms / deletes, :runQuery with
// orderBy + startAt cursor + where + limit, :batchGet). Enforces the project's deployed security rules:
//   users/{uid}/**  read, write: auth.uid == uid
//   names/{name}    read: auth; create: request.resource.data.uid == auth.uid; delete: resource.data.uid == auth.uid
//   profiles/{uid}  read: auth; write: auth.uid == uid
// Faults: ff.offline (fetch throws), ff.failNext(status, n, match), ff.expireAllTokens(); counters in ff.stats.
// fakeGoogleSdk(ff): a stand-in for the gstatic firebase-app.js / firebase-auth.js modules (GoogleSignIn loader).

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const fsErr = (code, status, message) => json(code, { error: { code, status, message } });
const idtErr = (message) => json(400, { error: { code: 400, message, errors: [{ message }] } });

export function fakeFirebase({ projectId = 'test-proj', apiKey = 'test-key', now = () => Date.now() } = {}) {
  const ROOT = `projects/${projectId}/databases/(default)/documents`;
  const users = new Map();          // email -> {uid, email, displayName}
  const idTokens = new Map();       // token -> {uid, exp}
  const refresh = new Map();        // refresh token -> uid
  const docs = new Map();           // path -> {fields, createTime, updateTime}
  const stats = { requests: 0, reads: 0, writes: 0, deletes: 0, queries: 0, refreshes: 0, signIns: 0 };
  let seq = 0, lastTs = 0;
  const faults = [];
  const ff = { users, docs, stats, offline: false, ttl: 3600 };
  const rnd = () => (++seq).toString(36) + Math.random().toString(36).slice(2, 10);
  const newUid = () => 'fb' + rnd().padEnd(26, 'x').slice(0, 26);
  // monotonic server time with millisecond precision (like REQUEST_TIME)
  const serverTime = () => { let t = now(); if (t <= lastTs) t = lastTs + 1; lastTs = t; return new Date(t).toISOString(); };

  function session(uid, email) {
    const id = 'id.' + rnd(), rt = 'rt.' + rnd();
    idTokens.set(id, { uid, exp: now() + ff.ttl * 1000 });
    refresh.set(rt, uid);
    return { idToken: id, refreshToken: rt, expiresIn: String(ff.ttl), localId: uid, email };
  }
  ff.failNext = (status, n = 1, match = null) => { faults.push({ status, n, match }); };
  ff.expireAllTokens = () => { for (const v of idTokens.values()) v.exp = 0; };
  ff.revokeRefresh = () => refresh.clear();
  ff.paths = (prefix) => [...docs.keys()].filter((p) => p.startsWith(prefix)).sort();
  ff.data = (path) => { const d = docs.get(path); return d ? decodeFields(d.fields) : null; };
  ff.setField = (path, field, value) => { const d = docs.get(path); if (d) d.fields[field] = value; };
  ff.userByEmail = (e) => users.get(String(e).toLowerCase()) || null;

  // ---------- values ----------
  function decodeValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('referenceValue' in v) return v.referenceValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return ((v.arrayValue || {}).values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields((v.mapValue || {}).fields || {});
    return null;
  }
  function decodeFields(f) { const o = {}; for (const [k, v] of Object.entries(f || {})) o[k] = decodeValue(v); return o; }
  const cmpVal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sortable = (v) => (v == null ? '' : v);

  // ---------- rules ----------
  const seg = (path) => path.split('/');
  function canRead(path, auth) {
    const s = seg(path);
    if (!auth) return false;
    if (s[0] === 'users') return s.length >= 2 && s[1] === auth.uid;
    if (s[0] === 'names' || s[0] === 'profiles') return s.length === 2;
    return false;
  }
  function canWrite(path, auth, op, newData, oldData) {
    const s = seg(path);
    if (!auth) return false;
    if (s[0] === 'users') return s.length >= 2 && s[1] === auth.uid;
    if (s[0] === 'profiles') return s.length === 2 && s[1] === auth.uid;
    if (s[0] === 'names' && s.length === 2) {
      if (op === 'create') return !!newData && newData.uid === auth.uid;
      if (op === 'delete') return !!oldData && oldData.uid === auth.uid;
      return false;
    }
    return false;
  }
  // a query is allowed when every possible result is readable (collection directly under users/{me}/..., or names/profiles)
  function canQuery(parent, coll, auth) {
    if (!auth) return false;
    if (!parent) return coll === 'names' || coll === 'profiles';
    return canRead(parent + '/' + coll + '/x', auth);
  }

  function authOf(init) {
    const h = (init && init.headers) || {};
    const a = h.Authorization || h.authorization || '';
    const t = a.startsWith('Bearer ') ? a.slice(7) : '';
    const s = idTokens.get(t);
    if (!t) return { auth: null };
    if (!s) return { bad: true };
    if (s.exp <= now()) return { expired: true };
    return { auth: { uid: s.uid } };
  }
  const rel = (name) => (name.startsWith(ROOT + '/') ? name.slice(ROOT.length + 1) : null);
  const outDoc = (path) => { const d = docs.get(path); return { name: ROOT + '/' + path, fields: d.fields, createTime: d.createTime, updateTime: d.updateTime }; };

  // ---------- handlers ----------
  // what signInWithPopup(GoogleAuthProvider) yields: one account per e-mail (a known e-mail gets its uid back)
  ff.googleOff = false;
  ff.googleSignIn = (email, displayName = '') => {
    if (ff.googleOff) throw Object.assign(new Error('Firebase: Error (auth/operation-not-allowed).'), { code: 'auth/operation-not-allowed' });
    const em = String(email).toLowerCase();
    let u = users.get(em);
    const isNew = !u;
    if (!u) { u = { uid: newUid(), email: em, displayName }; users.set(em, u); }
    stats.signIns++;
    const s = session(u.uid, em);
    return { uid: u.uid, email: em, displayName: displayName || u.displayName || '', refreshToken: s.refreshToken, idToken: s.idToken, isNew };
  };
  function idt(method, body) {
    if (method === 'delete') {
      const s = idTokens.get(body.idToken);
      if (!s || s.exp <= now()) return idtErr('INVALID_ID_TOKEN');
      const u = [...users.values()].find((x) => x.uid === s.uid);
      if (!u) return idtErr('USER_NOT_FOUND');
      users.delete(u.email);
      for (const [k, v] of idTokens) if (v.uid === u.uid) idTokens.delete(k);
      for (const [k, v] of refresh) if (v === u.uid) refresh.delete(k);
      return json(200, { kind: 'identitytoolkit#DeleteAccountResponse' });
    }
    return idtErr('UNKNOWN_METHOD');
  }
  function sts(bodyText) {
    stats.refreshes++;
    const p = new URLSearchParams(bodyText || '');
    if (p.get('grant_type') !== 'refresh_token') return idtErr('INVALID_GRANT_TYPE');
    const uid = refresh.get(p.get('refresh_token') || '');
    if (!uid) return idtErr('INVALID_REFRESH_TOKEN');
    if (![...users.values()].some((u) => u.uid === uid)) return idtErr('USER_NOT_FOUND');
    const s = session(uid, '');
    refresh.delete(s.refreshToken);
    const rt = p.get('refresh_token');
    return json(200, { access_token: s.idToken, expires_in: String(ff.ttl), token_type: 'Bearer', refresh_token: rt, id_token: s.idToken, user_id: uid, project_id: projectId });
  }
  function commit(body, auth) {
    const writes = Array.isArray(body.writes) ? body.writes : [];
    if (writes.length > 500) return fsErr(400, 'INVALID_ARGUMENT', 'too many writes');
    const t = serverTime();
    const plan = [];
    for (const w of writes) {
      if (w.delete) {
        const path = rel(w.delete);
        if (!path) return fsErr(400, 'INVALID_ARGUMENT', 'bad name');
        const old = docs.get(path);
        if (!canWrite(path, auth, 'delete', null, old ? decodeFields(old.fields) : null)) return fsErr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
        plan.push({ del: path });
        continue;
      }
      const path = rel(w.update && w.update.name);
      if (!path || seg(path).length % 2) return fsErr(400, 'INVALID_ARGUMENT', 'bad name');
      const old = docs.get(path);
      if (w.currentDocument && w.currentDocument.exists === false && old) return fsErr(409, 'ALREADY_EXISTS', 'Document already exists: ' + w.update.name);
      if (w.currentDocument && w.currentDocument.exists === true && !old) return fsErr(404, 'NOT_FOUND', 'No document to update');
      if (w.currentDocument?.updateTime && old?.updateTime !== w.currentDocument.updateTime) return fsErr(400, 'FAILED_PRECONDITION', 'Document changed');
      const fields = JSON.parse(JSON.stringify(w.update.fields || {}));
      for (const tr of w.updateTransforms || []) if (tr.setToServerValue === 'REQUEST_TIME') fields[tr.fieldPath] = { timestampValue: t };
      const size = JSON.stringify(fields).length;
      if (size > 1048576) return fsErr(400, 'INVALID_ARGUMENT', 'Document exceeds the maximum size');
      if (!canWrite(path, auth, old ? 'update' : 'create', decodeFields(fields), old ? decodeFields(old.fields) : null)) return fsErr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
      plan.push({ set: path, fields });
    }
    for (const p of plan) {
      if (p.del) { docs.delete(p.del); stats.deletes++; continue; }
      const old = docs.get(p.set);
      docs.set(p.set, { fields: p.fields, createTime: old ? old.createTime : t, updateTime: t });
      stats.writes++;
    }
    return json(200, { writeResults: plan.map(() => ({ updateTime: t })), commitTime: t });
  }
  function runQuery(parent, body, auth) {
    stats.queries++;
    const q = body.structuredQuery || {};
    const coll = q.from && q.from[0] && q.from[0].collectionId;
    if (!coll) return fsErr(400, 'INVALID_ARGUMENT', 'from');
    if (!canQuery(parent, coll, auth)) return fsErr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
    const prefix = (parent ? parent + '/' : '') + coll + '/';
    let rows = [...docs.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => ({ path: p, name: ROOT + '/' + p, data: decodeFields(docs.get(p).fields) }));
    const ff1 = q.where && q.where.fieldFilter;
    if (ff1) {
      const f = ff1.field.fieldPath, v = decodeValue(ff1.value);
      rows = rows.filter((r) => {
        const x = r.data[f];
        if (x === undefined) return false;
        if (ff1.op === 'EQUAL') return x === v;
        if (ff1.op === 'GREATER_THAN') return cmpVal(x, v) > 0;
        if (ff1.op === 'GREATER_THAN_OR_EQUAL') return cmpVal(x, v) >= 0;
        if (ff1.op === 'LESS_THAN') return cmpVal(x, v) < 0;
        return false;
      });
    }
    const ob = (q.orderBy || []).map((o) => ({ f: o.field.fieldPath, d: o.direction === 'DESCENDING' ? -1 : 1 }));
    if (!ob.some((o) => o.f === '__name__')) ob.push({ f: '__name__', d: 1 });
    // ordering by a field excludes docs without it (as in Firestore)
    rows = rows.filter((r) => ob.every((o) => o.f === '__name__' || r.data[o.f] !== undefined));
    const key = (r, f) => (f === '__name__' ? r.name : sortable(r.data[f]));
    rows.sort((a, b) => { for (const o of ob) { const c = cmpVal(key(a, o.f), key(b, o.f)) * o.d; if (c) return c; } return 0; });
    if (q.startAt && Array.isArray(q.startAt.values)) {
      const vals = q.startAt.values.map(decodeValue), before = !!q.startAt.before;
      rows = rows.filter((r) => {
        for (let i = 0; i < vals.length; i++) {
          const c = cmpVal(key(r, ob[i].f), vals[i]) * ob[i].d;
          if (c) return c > 0;
        }
        return before;   // equal to the cursor: included only with before:true
      });
    }
    if (q.limit) rows = rows.slice(0, q.limit);
    stats.reads += Math.max(1, rows.length);
    const t = new Date(now()).toISOString();
    if (!rows.length) return json(200, [{ readTime: t }]);
    return json(200, rows.map((r) => ({ document: outDoc(r.path), readTime: t })));
  }

  ff.fetch = async (url, init = {}) => {
    stats.requests++;
    if (ff.offline) throw new TypeError('fetch failed');
    const u = new URL(url);
    const f = faults.find((x) => x.n > 0 && (!x.match || url.includes(x.match)));
    if (f) {
      f.n--;
      if (f.status === 0) throw new TypeError('fetch failed');
      return fsErr(f.status, f.status === 429 ? 'RESOURCE_EXHAUSTED' : f.status >= 500 ? 'UNAVAILABLE' : 'FAILED', 'injected');
    }
    const bodyText = init.body == null ? '' : String(init.body);
    if (u.host === 'identitytoolkit.googleapis.com') {
      if (u.searchParams.get('key') !== apiKey) return json(400, { error: { code: 400, message: 'API key not valid.' } });
      const m = u.pathname.match(/^\/v1\/accounts:(\w+)$/);
      return idt(m ? m[1] : '', JSON.parse(bodyText || '{}'));
    }
    if (u.host === 'securetoken.googleapis.com') {
      if (u.searchParams.get('key') !== apiKey) return json(400, { error: { code: 400, message: 'API key not valid.' } });
      return sts(bodyText);
    }
    if (u.host !== 'firestore.googleapis.com') throw new TypeError('fetch failed (unknown host ' + u.host + ')');
    const a = authOf(init);
    if (a.bad || a.expired) return fsErr(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    const auth = a.auth;
    const pathname = decodeURIComponent(u.pathname);
    const pre = '/v1/' + ROOT;
    if (!pathname.startsWith(pre)) return fsErr(404, 'NOT_FOUND', 'bad path');
    let rest = pathname.slice(pre.length);
    const method = (init.method || 'GET').toUpperCase();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (rest === ':commit' && method === 'POST') return commit(body, auth);
    if (rest === ':batchGet' && method === 'POST') {
      const out = [];
      for (const n of body.documents || []) {
        const p = rel(n);
        if (!p || !canRead(p, auth)) return fsErr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
        stats.reads++;
        out.push(docs.has(p) ? { found: outDoc(p), readTime: new Date(now()).toISOString() } : { missing: n, readTime: new Date(now()).toISOString() });
      }
      return json(200, out);
    }
    if (rest === ':runQuery' && method === 'POST') return runQuery('', body, auth);
    if (rest.endsWith(':runQuery') && method === 'POST') return runQuery(rest.slice(1, -':runQuery'.length), body, auth);
    rest = rest.replace(/^\//, '');
    if (method === 'GET') {
      if (!canRead(rest, auth)) return fsErr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.');
      stats.reads++;
      if (!docs.has(rest)) return fsErr(404, 'NOT_FOUND', 'Document not found');
      return json(200, outDoc(rest));
    }
    return fsErr(400, 'INVALID_ARGUMENT', 'unsupported ' + method + ' ' + rest);
  };
  return ff;
}

// The two SDK modules GoogleSignIn imports from gstatic, faked. st.next: the outcome of the next popup / redirect:
// {email, displayName} (signed in through ff.googleSignIn) or {error: 'auth/...'}. Counters: loads, popups,
// redirects, signOuts; st.auths: every Auth instance (currentUser must be null after each hand-off).
export function fakeGoogleSdk(ff) {
  const st = { loads: 0, popups: 0, redirects: 0, signOuts: 0, inits: 0, next: null, loadFail: false, apps: [], auths: [], pendingRedirect: null, persistence: null };
  const sdkErr = (code) => Object.assign(new Error('Firebase: Error (' + code + ').'), { code });
  const userOf = (n) => {
    if (!n) throw sdkErr('auth/internal-error');
    if (n.error) throw sdkErr(n.error);
    let g;
    try { g = ff.googleSignIn(n.email, n.displayName); } catch (e) { throw sdkErr(e.code || 'auth/internal-error'); }
    return { uid: g.uid, email: g.email, displayName: g.displayName || null, refreshToken: g.refreshToken, providerData: [{ providerId: 'google.com', email: g.email }] };
  };
  const mod = {
    app: {
      getApps: () => st.apps.slice(),
      initializeApp: (options, name) => { const a = { name, options }; st.apps.push(a); return a; },
    },
    auth: {
      browserSessionPersistence: { type: 'SESSION' }, browserPopupRedirectResolver: { resolver: true },
      initializeAuth(app, deps) { st.inits++; st.persistence = deps && deps.persistence; const a = { app, currentUser: null, languageCode: null }; st.auths.push(a); return a; },
      getAuth(app) { return st.auths.find((a) => a.app === app); },
      GoogleAuthProvider: class { constructor() { this.providerId = 'google.com'; } setCustomParameters(p) { this.params = p; } },
      async signInWithPopup(auth) { st.popups++; const n = st.next; st.next = null; const u = userOf(n); auth.currentUser = u; return { user: u, providerId: 'google.com' }; },
      async signInWithRedirect() { st.redirects++; st.pendingRedirect = st.next; st.next = null; },
      async getRedirectResult(auth) { const n = st.pendingRedirect; st.pendingRedirect = null; if (!n) return null; const u = userOf(n); auth.currentUser = u; return { user: u }; },
      async signOut(auth) { st.signOuts++; auth.currentUser = null; },
    },
  };
  st.loader = async () => { st.loads++; if (st.loadFail) throw new TypeError('Failed to fetch dynamically imported module: https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'); return mod; };
  return st;
}

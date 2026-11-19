// Aevum - minimal Firebase REST client (Identity Toolkit, Secure Token, Firestore v1).
// Plain fetch only (no SDK, no build step); fetch is injected so the same code runs in node tests against a
// fake server. Nothing here knows about the game.

export const IDT = 'https://identitytoolkit.googleapis.com/v1/';
export const STS = 'https://securetoken.googleapis.com/v1/token';
export const FS = 'https://firestore.googleapis.com/v1/';

// kind: 'network' (offline / timeout / DNS), 'server' (5xx), 'quota' (429 / RESOURCE_EXHAUSTED),
// 'auth' (the session is no longer valid: log in again), 'denied' (rules), 'notfound', 'exists', 'bad' (4xx, input)
export class CloudError extends Error {
  constructor(kind, code, message, status) {
    super(message || code || kind);
    this.name = 'CloudError'; this.kind = kind; this.code = code || ''; this.status = status | 0;
  }
  get retryable() { return this.kind === 'network' || this.kind === 'server' || this.kind === 'quota'; }
}
export const isRetryable = (e) => !!(e && e.retryable);

// "TOKEN_EXPIRED : ..." -> "TOKEN_EXPIRED"
const errCode = (msg) => String(msg || '').split(/[\s:]/)[0];
const AUTH_DEAD = new Set(['TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'USER_NOT_FOUND', 'USER_DISABLED', 'INVALID_ID_TOKEN', 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN', 'INVALID_GRANT_TYPE', 'MISSING_REFRESH_TOKEN']);

function errorFrom(status, body) {
  const e = (body && body.error) || {};
  const msg = typeof e === 'string' ? e : e.message;
  const st = typeof e === 'object' ? e.status : '';
  const code = errCode(msg) || st || ('HTTP_' + status);
  if (status === 429 || st === 'RESOURCE_EXHAUSTED' || code === 'QUOTA_EXCEEDED') return new CloudError(code === 'TOO_MANY_ATTEMPTS_TRY_LATER' ? 'bad' : 'quota', code, msg, status);
  if (status >= 500 || st === 'UNAVAILABLE' || st === 'DEADLINE_EXCEEDED' || st === 'ABORTED' || st === 'INTERNAL') return new CloudError('server', code, msg, status);
  if (AUTH_DEAD.has(code) || status === 401 || st === 'UNAUTHENTICATED') return new CloudError('auth', code, msg, status);
  if (status === 403 || st === 'PERMISSION_DENIED') return new CloudError('denied', code, msg, status);
  if (status === 404 || st === 'NOT_FOUND') return new CloudError('notfound', code, msg, status);
  if (status === 409 || st === 'ALREADY_EXISTS') return new CloudError('exists', code, msg, status);
  return new CloudError('bad', code, msg, status);
}

// fetchFn(url, init) -> Response-like {ok, status, json(), text()}
export async function call(fetchFn, url, init, timeoutMs = 20000) {
  let res, timer = null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    if (ctl && timeoutMs > 0) timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
    res = await fetchFn(url, Object.assign({}, init, ctl ? { signal: ctl.signal } : {}));
  } catch (err) {
    throw new CloudError('network', 'NETWORK', 'Ağ hatası: ' + ((err && err.message) || err));
  } finally { if (timer) clearTimeout(timer); }
  let body = null;
  try { const t = await res.text(); body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
  if (!res.ok) throw errorFrom(res.status, body);
  return body;
}

// ---------------------------------------------------------------- auth (Identity Toolkit + Secure Token)
export function authApi({ fetch: fetchFn, apiKey, timeoutMs }) {
  const post = (method, body) => call(fetchFn, IDT + 'accounts:' + method + '?key=' + encodeURIComponent(apiKey),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
  // (sign in itself happens with Google through the SDK popup: google.js)
  return {
    remove: (idToken) => post('delete', { idToken }),
    // -> {id_token, refresh_token, expires_in, user_id}
    refresh: (refreshToken) => call(fetchFn, STS + '?key=' + encodeURIComponent(apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken),
    }, timeoutMs),
  };
}

// ---------------------------------------------------------------- Firestore values
export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { integerValue: String(v) } : { doubleValue: Number.isFinite(v) ? v : 0 };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(encodeValue) } : {} };
  if (typeof v === 'object') {
    if (v.__ts) return { timestampValue: v.__ts };
    return { mapValue: { fields: encodeFields(v) } };
  }
  return { nullValue: null };
}
export function encodeFields(o) {
  const f = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined) f[k] = encodeValue(v);
  return f;
}
export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  return null;
}
export function decodeFields(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) o[k] = decodeValue(v);
  return o;
}

// ---------------------------------------------------------------- Firestore REST
// token(force) -> a valid idToken (the auth session refreshes it)
export function firestoreApi({ fetch: fetchFn, projectId, token, timeoutMs = 30000 }) {
  const root = `projects/${projectId}/databases/(default)/documents`;
  const name = (path) => root + '/' + path;
  const url = (path) => FS + root + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '');
  const req = async (method, u, body, tmo) => {
    const init = (t) => ({ method, headers: Object.assign({ Authorization: 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    try { return await call(fetchFn, u, init(await token(false)), tmo || timeoutMs); } catch (e) {
      // an id token the server does not accept any more (revoked, clock skew): refresh once and retry
      if (e.kind === 'auth' && e.status === 401) return call(fetchFn, u, init(await token(true)), tmo || timeoutMs);
      throw e;
    }
  };
  const toDoc = (d) => (d && d.name ? { name: d.name, id: d.name.slice(d.name.lastIndexOf('/') + 1), data: decodeFields(d.fields), updateTime: d.updateTime || null } : null);
  return {
    root, name,
    // -> {id, name, data, updateTime} or null
    async get(path) {
      try { return toDoc(await req('GET', url(path))); } catch (e) { if (e.kind === 'notfound') return null; throw e; }
    },
    // writes: [{set: path, data, mustNotExist?, updateTime?, serverTime?: [field]}, {del: path}] -> commit response
    commit(writes, tmo) {
      const w = writes.map((x) => {
        if (x.del) return { delete: name(x.del) };
        const o = { update: { name: name(x.set), fields: encodeFields(x.data) } };
        if (x.mustNotExist) o.currentDocument = { exists: false };
        else if (x.updateTime) o.currentDocument = { updateTime: x.updateTime };
        if (x.serverTime && x.serverTime.length) o.updateTransforms = x.serverTime.map((f) => ({ fieldPath: f, setToServerValue: 'REQUEST_TIME' }));
        return o;
      });
      return req('POST', url('') + ':commit', { writes: w }, tmo);
    },
    // structuredQuery on the collection `collectionId` directly under `parentPath` -> [doc]
    async query(parentPath, q) {
      const sq = Object.assign({ from: [{ collectionId: q.collection }] }, q.structured || {});
      const res = await req('POST', url(parentPath) + ':runQuery', { structuredQuery: sq });
      if (!Array.isArray(res) || res.some((r) => !r || r.error || (r.document && !r.document.name))) {
        throw new CloudError('server', 'INVALID_QUERY_RESPONSE', 'Bulut sorgusu tamamlanamadı.');
      }
      return res.filter((r) => r && r.document).map((r) => toDoc(r.document));
    },
    // -> Map(path -> doc|null)
    async batchGet(paths) {
      const out = new Map();
      if (!paths.length) return out;
      const res = await req('POST', url('') + ':batchGet', { documents: paths.map(name) }, Math.max(timeoutMs, 60000));
      const byName = new Map();
      for (const r of Array.isArray(res) ? res : []) { if (r.found) byName.set(r.found.name, toDoc(r.found)); }
      for (const p of paths) out.set(p, byName.get(name(p)) || null);
      return out;
    },
  };
}

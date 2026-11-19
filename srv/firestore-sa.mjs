// Aevum - the stats store: one Firestore document per day (stats/{YYYY-MM-DD}), written by the server itself.
// The server signs in as a Google service account (OAuth JWT bearer, RS256 with node's crypto), so the documents need
// no client rules: players can neither read nor write them. Pure node, no npm deps.
//
// The key comes from the AEVUM_SA environment variable (the service account JSON, or that JSON in base64).
// It is a secret: it is set in the host's dashboard and never committed.
import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// AEVUM_SA -> {client_email, private_key, project_id} | null
export function serviceAccountFromEnv(env = process.env) {
  const raw = String(env.AEVUM_SA || '').trim();
  if (!raw) return null;
  let j = null;
  try { j = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
  return j && typeof j.client_email === 'string' && typeof j.private_key === 'string' ? j : null;
}

// Firestore REST values <-> plain {name: number|string}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(Math.trunc(v)) } : { stringValue: String(v) }]));
function fromFields(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) o[k] = v.integerValue != null ? Number(v.integerValue) : v.stringValue != null ? v.stringValue : null;
  return o;
}

export function createSaStore({ sa, projectId, fetch: fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const project = projectId || sa.project_id;
  const docRoot = `projects/${project}/databases/(default)/documents`;
  const base = 'https://firestore.googleapis.com/v1/' + docRoot;
  let tok = null, tokExp = 0, tokP = null;

  async function token() {
    if (tok && now() < tokExp - 60000) return tok;
    if (!tokP) {
      tokP = (async () => {
        const iat = Math.floor(now() / 1000);
        const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const body = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
        const sig = b64u(crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), sa.private_key));
        const r = await fetchFn(TOKEN_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + sig,
        });
        if (!r.ok) throw new Error('stats token ' + r.status);
        const j = await r.json();
        tok = j.access_token; tokExp = now() + (j.expires_in | 0) * 1000;
        return tok;
      })().finally(() => { tokP = null; });
    }
    return tokP;
  }
  async function call(url, init = {}) {
    const r = await fetchFn(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' }, init.headers || {}) }));
    if (r.status === 404) return null;
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error('stats firestore ' + r.status); }
    return r.json();
  }

  return {
    async get(day) {
      const d = await call(`${base}/stats/${day}`);
      return d ? fromFields(d.fields) : null;
    },
    async put(day, fields) {
      await call(`${base}/stats/${day}`, { method: 'PATCH', body: JSON.stringify({ fields: toFields(fields) }) });
    },
    // the last n days (Turkey time, today first), counts only: the id lists are not downloaded (no index needed)
    async list(n) {
      const names = [];
      for (let i = 0; i < n; i++) names.push(`${docRoot}/stats/${new Date(now() + 3 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10)}`);
      const arr = await call(`${base}:batchGet`, { method: 'POST', body: JSON.stringify({ documents: names, mask: { fieldPaths: ['nv', 'np', 'sp', 'mp', 'peak'] } }) });
      const out = [];
      for (const x of Array.isArray(arr) ? arr : []) if (x.found) out.push(Object.assign({ day: x.found.name.split('/').pop() }, fromFields(x.found.fields)));
      return out.sort((p, q) => (p.day < q.day ? 1 : -1));
    },
  };
}

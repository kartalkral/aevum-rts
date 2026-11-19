// Aevum - read every player's multiplayer chat log from Firestore (users/{uid}/chatlog/*, written by
// CloudSync.logChat for new lines sent after opt-in, plus pre-opt-in legacy records) and print it in time order.
//   node tools/read-chatlog.mjs [--since 2026-11-15] [--room ABCDE] [--out file.txt]
// Authorized operators only; needs a service-account key with Firestore IAM query permission (see docs/sohbet-gizliligi.md).
// Looked up in $AEVUM_SA, else ~/.aevum/firebase-sa.json. Never commit the key or output.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const saPath = process.env.AEVUM_SA || path.join(os.homedir(), '.aevum', 'firebase-sa.json');
if (!fs.existsSync(saPath)) { console.error('Service-account key not found: ' + saPath); process.exit(2); }
const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key));
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }) });
  const j = await r.json(); if (!j.access_token) throw new Error('token: ' + JSON.stringify(j));
  return j.access_token;
}
const val = (v) => (!v ? null : 'stringValue' in v ? v.stringValue : 'timestampValue' in v ? v.timestampValue : 'integerValue' in v ? +v.integerValue : null);

const tok = await accessToken();
const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
const rows = [];
let last = null;
for (;;) {   // a collection-group query over every users/*/chatlog, 300 at a time (ordered by document name)
  const q = { structuredQuery: { from: [{ collectionId: 'chatlog', allDescendants: true }], orderBy: [{ field: { fieldPath: '__name__' } }], limit: 300 } };
  if (last) q.structuredQuery.startAt = { values: [{ referenceValue: last }], before: false };
  const r = await fetch(base + ':runQuery', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  const out = await r.json(); if (!Array.isArray(out)) throw new Error(JSON.stringify(out));
  const docs = out.filter((x) => x.document).map((x) => x.document);
  for (const d of docs) { const f = d.fields || {}; rows.push({ at: val(f.at) || '', t: val(f.t) || '', room: val(f.room) || '', name: val(f.name) || '?', text: val(f.text) || '' }); }
  if (docs.length < 300) break;
  last = docs[docs.length - 1].name;
}
const since = arg('--since'), room = arg('--room');
const lines = rows.filter((r) => (!since || (r.t || r.at) >= since) && (!room || r.room === room.toUpperCase()))
  .sort((a, b) => (a.at || a.t).localeCompare(b.at || b.t))
  .map((r) => `${r.t || r.at}  [${r.room || '-'}]  ${r.name}: ${r.text}`);
const txt = lines.join('\n') + '\n';
if (arg('--out')) { fs.writeFileSync(arg('--out'), txt); console.log(lines.length + ' lines -> ' + arg('--out')); } else process.stdout.write(txt);

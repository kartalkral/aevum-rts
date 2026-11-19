import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler, requestPath } from '../srv/static.mjs';
import { logServerError, sanitizeForLog } from '../srv/logging.mjs';
import { createSseTickets, SSE_TICKET_TTL_MS } from '../srv/sse-tickets.mjs';
import { SSETransport } from '../src/net/transport-sse.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'aevum-server-test-'));
const web = path.join(temp, 'web');
const sentinel = 'CREDENTIAL-MUST-NOT-LEAK';
let proc, fixtureServer;
const http = (port, pathname, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
  // node:http sends the raw path; fetch() would normalize dot segments before they reach the server.
  const req = request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end();
});
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

try {
  await mkdir(web);
  for (const f of ['server.js', 'srv', 'package.json', 'index.html', 'style.css', 'src', 'assets']) await cp(path.join(root, f), path.join(web, f), { recursive: true });
  for (const file of ['.git/config', '.env', '.env.production', 'test/hidden.mjs', 'tools/hidden.mjs', 'assets/data/client.json', 'assets/data/ops-adminsdk-key.json', 'src/firebase-sa.json', 'server-error.log']) {
    await mkdir(path.dirname(path.join(web, file)), { recursive: true });
    await writeFile(path.join(web, file), file.endsWith('/client.json') ? '{"client":true}' : sentinel);
  }
  await writeFile(path.join(temp, 'secret.js'), sentinel);
  await writeFile(path.join(temp, 'public-check.js'), sentinel);
  await symlink(path.join(temp, 'secret.js'), path.join(web, 'src/outside.js'));
  await symlink(path.join(web, 'server.js'), path.join(web, 'src/inside.js'));
  await symlink(temp, path.join(web, 'src/link-dir'), 'junction');
  const portPicker = createServer();
  const port = await listen(portPicker);
  await new Promise(r => portPicker.close(r));
  proc = spawn(process.execPath, [path.join(web, 'server.js')], { env: { ...process.env, PORT: String(port), AEVUM_NO_AUTH: '', AEVUM_SA: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stderr.on('data', c => { output += c; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 5000);
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
    proc.stdout.on('data', c => { output += c; if (output.includes('calisiyor')) { clearTimeout(timeout); resolve(); } });
  });

  for (const file of ['/.git/config', '/.env', '/.env.production', '/server.js', '/srv/identity.mjs', '/srv/logging.mjs', '/test/hidden.mjs', '/tools/hidden.mjs', '/server-error.log', '/package.json', '/src/firebase-sa.json', '/assets/data/ops-adminsdk-key.json', '/src/outside.js', '/src/inside.js', '/src/link-dir/public-check.js']) {
    const r = await http(port, file);
    assert.ok([400, 404].includes(r.status), file);
    assert.ok(!r.body.includes(sentinel), file);
  }
  for (const file of ['/src/%2e%2e/index.html', '/assets/../index.html', '/src/%2E%2e%2Findex.html', '/src/%252e%252e/index.html', '/src/%5C../index.html', '/src/%00.js', '/mp/%2e%2e/index.html']) {
    assert.equal((await http(port, file)).status, 400, file);
  }
  for (const [file, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/style.css', 'text/css'], ['/src/main.js', 'text/javascript'], ['/src/net/transport-sse.js', 'text/javascript'], ['/assets/icons/icons.svg', 'image/svg+xml'], ['/assets/models/0/house.glb', 'model/gltf-binary'], ['/assets/sfx/armor_hit1.mp3', 'audio/mpeg']]) {
    const r = await http(port, file);
    assert.equal(r.status, 200, file);
    assert.ok(r.headers['content-type'].startsWith(type), file);
    assert.equal(r.body.length, Number(r.headers['content-length']), file);
    assert.ok(r.body.length > 0, file);
  }
  const head = await http(port, '/src/main.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.ok(Number(head.headers['content-length']) > 0);
  assert.equal((await http(port, '/src/main.js', 'POST')).status, 405);
  assert.equal((await http(port, '/mp/health')).status, 200);
  await http(port, `/mp/events?room=TEST&peer=p&tk=${sentinel}`, 'GET', { Authorization: `Bearer ${sentinel}`, Cookie: `session=${sentinel}` });
  assert.ok(!output.includes(sentinel));
  // The startup/request path did not create or append an in-repo log file.
  assert.equal(await readFile(path.join(web, 'server-error.log'), 'utf8'), sentinel);

  // No current static JSON asset; exercise how an explicitly approved JSON is served.
  const serve = createStaticHandler(web, { clientJson: new Set(['/assets/data/client.json']) });
  fixtureServer = createServer((req, res) => { serve(req, res, requestPath(req.url)).catch(() => res.destroy()); });
  const fixturePort = await listen(fixtureServer);
  const json = await http(fixturePort, '/assets/data/client.json');
  assert.equal(json.status, 200);
  assert.match(json.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(json.body), { client: true });
  assert.equal((await http(fixturePort, '/assets/data/ops-adminsdk-key.json')).status, 404);
  console.log('OK: static allowlist, raw path rejection, symlink rejection, MIME, HEAD, and approved JSON');
} finally {
  if (fixtureServer) await new Promise(r => fixtureServer.close(r));
  if (proc && proc.exitCode == null && proc.signalCode == null) { proc.kill(); await once(proc, 'exit'); }
  await rm(temp, { recursive: true, force: true });
}

const sample = { method: 'GET', url: '/mp/events?tk=one&%74oken=two&auth=three&key=four&st=five', headers: { authorization: 'secret-auth', cookie: 'secret-cookie', 'x-aevum-ticket': 'secret-ticket' }, body: 'secret-body' };
assert.equal(sanitizeForLog(sample), 'GET /mp/events');
assert.equal(sanitizeForLog({ method: 'secret-method', url: '/secret-path' }), 'OTHER [other route]');
const savedError = console.error;
const lines = [];
try {
  console.error = s => lines.push(s);
  logServerError('request', Object.assign(new Error(sentinel), { code: 'EPIPE' }), sample);
  logServerError(sentinel, Object.assign(new Error('private upstream payload'), { code: sentinel }));
} finally { console.error = savedError; }
assert.match(lines[0], /request EPIPE GET \/mp\/events$/);
assert.match(lines[1], /server ERROR$/);
assert.ok(!lines.join('\n').includes(sentinel));
console.log('OK: emitted error logs contain no URL values, headers, request bodies or raw error details');

let t = 0;
const tickets = createSseTickets({ now: () => t, capacity: 1 }), ident = { fb: 'user' };
const expired = tickets.issue('ROOM1', 'peer', ident);
assert.equal(tickets.issue('ROOM1', 'peer', ident), null);
t += SSE_TICKET_TTL_MS;
assert.equal(tickets.consume(expired, 'ROOM1', 'peer'), null);
const fresh = tickets.issue('ROOM1', 'peer', ident);
assert.notEqual(fresh, expired);
assert.equal(tickets.consume(fresh, 'ROOM2', 'peer'), null);
assert.equal(tickets.consume(fresh, 'ROOM1', 'wrong'), null);
assert.equal(tickets.consume(fresh, 'ROOM1', 'peer').ident, ident);
assert.equal(tickets.consume(fresh, 'ROOM1', 'peer'), null);
console.log('OK: SSE ticket expiry (controlled clock), binding and single use');

const oldFetch = globalThis.fetch, oldEventSource = globalThis.EventSource;
const streams = [], mintCalls = [], refreshes = [];
const tr = new SSETransport('https://aevum.invalid', { ticket: async fresh => {
  refreshes.push(fresh);
  return fresh ? 'relay-new' : 'relay-old';
} });
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for SSE transport');
    await new Promise(r => setTimeout(r, 20));
  }
}
try {
  globalThis.fetch = async (url, opts) => {
    assert.equal(new URL(url).pathname, '/mp/sse-ticket');
    assert.equal(opts.method, 'POST');
    assert.ok(!url.includes('relay-'));
    mintCalls.push(opts.headers['X-Aevum-Ticket']);
    if (mintCalls.length === 2) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ ticket: 'short-' + mintCalls.length }));
  };
  globalThis.EventSource = class {
    constructor(url) { this.url = new URL(url); this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
    hello() { this.onmessage({ data: '{"type":"hello","peers":[]}' }); }
  };
  const connecting = tr.connect('room1');
  await until(() => streams.length === 1);
  streams[0].hello();
  await connecting;
  streams[0].onerror();
  assert.equal(streams[0].readyState, 2, 'native retry is disabled immediately');
  assert.equal(tr.up, false);
  await until(() => streams.length === 2);
  streams[1].hello();
  assert.equal(tr.up, true);
  assert.deepEqual(mintCalls, ['relay-old', 'relay-old', 'relay-new']);
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(streams[1].url.searchParams.get('peer'), streams[0].url.searchParams.get('peer'));
  assert.equal(streams[1].url.searchParams.get('room'), 'ROOM1');
  assert.deepEqual(streams.map(s => s.url.searchParams.get('st')), ['short-1', 'short-3']);
  for (const s of streams) assert.ok(!String(s.url).includes('relay-'));
  console.log('OK: SSE reconnect closes native retry, refreshes auth after 401, and opens with a new grant and same peer');
} finally {
  tr.close();
  globalThis.fetch = oldFetch;
  if (oldEventSource) globalThis.EventSource = oldEventSource; else delete globalThis.EventSource;
}

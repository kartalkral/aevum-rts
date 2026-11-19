import { constants, realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary',
};
// Reviewed client JSON paths go here. Currently no static JSON is fetched by the game;
// the JSON import/export uses local files and multiplayer JSON is served by API handlers.
const CLIENT_JSON = new Set();

// Validate the raw pathname before WHATWG URL parsing or filesystem normalization removes dot segments.
export function requestPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return null;
  const raw = target.split('?', 1)[0];
  if (/%2f|%5c/i.test(raw)) return null;
  let name;
  try { name = decodeURIComponent(raw); } catch { return null; }
  if (name === '/') return name;
  return name.slice(1).split('/').every(s => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(s) && !s.endsWith('.')) ? name : null;
}

export function isPublicFile(file, clientJson = CLIENT_JSON) {
  if (typeof file !== 'string') return false;
  return file === '/index.html' || file === '/style.css' || file === '/assets/icons/icons.svg'
    || /^\/src\/(?:[\w-]+\/)*[\w-]+\.js$/.test(file)
    || /^\/assets\/models\/(?:[0-4]|trees)\/[\w-]+\.glb$/.test(file)
    || /^\/assets\/sfx\/[\w-]+\.mp3$/.test(file)
    || (path.extname(file) === '.json' && clientJson.has(file));
}

export function createStaticHandler(root, { clientJson = CLIENT_JSON } = {}) {
  const webRoot = realpathSync(root);
  return async function serveStatic(req, res, pathname) {
    const file = pathname === '/' ? '/index.html' : pathname;
    if (!isPublicFile(file, clientJson)) { res.writeHead(404).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const candidate = path.join(webRoot, file);
    let handle;
    try {
      const resolved = await realpath(candidate);
      // No links, even aliases inside the repo (e.g. public names pointing at private files).
      if (resolved !== candidate) { res.writeHead(404).end(); return; }
      handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const st = await handle.stat();
      if (res.destroyed || !st.isFile()) {
        await handle.close();
        if (!res.destroyed) res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)], 'Content-Length': st.size,
        'Cache-Control': 'no-store, no-cache, must-revalidate', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') { await handle.close(); res.end(); return; }
      const stream = handle.createReadStream();
      res.once('close', () => stream.destroy());
      if (res.destroyed) stream.destroy();
      stream.on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(e.code)) { res.writeHead(404).end(); return; }
      throw e;
    }
  };
}

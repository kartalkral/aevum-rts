const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE']);
const ROUTES = new Set(['/mp/auth', '/mp/beat', '/mp/blob', '/mp/events', '/mp/health', '/mp/inbox', '/mp/invite',
  '/mp/online', '/mp/ping', '/mp/poll', '/mp/send', '/mp/sse-ticket', '/mp/stats', '/mp/tp/claim', '/mp/tp/info', '/mp/tp/start', '/mp/ws']);
const TAGS = new Set(['auth', 'body cb', 'request', 'send', 'server', 'startup', 'stats', 'stats list', 'stats load',
  'stats put', 'sweep', 'tp', 'uncaughtException', 'unhandledRejection', 'upgrade', 'ws end', 'ws msg']);
const CODES = new Set(['EACCES', 'EADDRINUSE', 'ECONNRESET', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOENT', 'EPIPE', 'ETIMEDOUT']);

// Keep only known method/route labels: never copy input values, path segments, headers or request bodies.
export function sanitizeForLog(req) {
  const method = METHODS.has(req?.method) ? req.method : 'OTHER';
  const path = typeof req?.url === 'string' ? req.url.split('?', 1)[0] : '';
  return `${method} ${ROUTES.has(path) ? path : '[other route]'}`;
}

// stderr only; file destinations and retention are the deployment's responsibility.
// Exception messages/stacks can contain URLs, upstream responses, body fragments or credentials.
export function logServerError(tag, error, req) {
  try {
    const code = CODES.has(error?.code) ? error.code : 'ERROR';
    console.error(`${new Date().toISOString()} ${TAGS.has(tag) ? tag : 'server'} ${code}${req ? ' ' + sanitizeForLog(req) : ''}`);
  } catch { /* logging must not interrupt request handling */ }
}

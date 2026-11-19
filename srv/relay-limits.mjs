import { isIP } from 'node:net';

const MiB = 1024 * 1024;
// Rates are tokens/sec. HTTP requests and incoming WS frames cost one token each.
export const RELAY_LIMITS = {
  rates: {
    auth: { user: [1, 8], ip: [16, 64] },
    join: { user: [4, 12], ip: [32, 96] }, // SSE mint/open, WS open/probe
    poll: { user: [100, 200], ip: [1200, 2400] },
    message: { user: [120, 240], ip: [1200, 2400] },
    upload: { user: [0.5, 6], ip: [4, 32] },
    download: { user: [2, 12], ip: [24, 96] },
  },
  bucketIdleMs: 5 * 60_000, bucketsPerScope: 8192,
  maxMessageBytes: 64 * 1024, inputBytes: 32 * MiB, outputBytes: 32 * MiB,
  peerOutputBytes: 2 * MiB, pollQueueEntries: 4000, pollIdleMs: 10_000, pollWaitMs: 20_000,
  messageBodyMs: 10_000, authBodyBytes: 32 * 1024,
  maxRooms: 1000, maxPeersPerRoom: 16, maxPeers: 1024, maxKicked: 4096, kickedMs: 120_000,
  maxBlobBytes: 32 * MiB, blobBytes: 96 * MiB, blobTransferBytes: 96 * MiB,
  blobsPerRoom: 8, maxBlobs: 512, blobBodyMs: 60_000, blobIdleMs: 30 * 60_000,
  closedRoomMs: 60_000, sweepMs: 15_000,
};

export function createRateLimiter(config = RELAY_LIMITS, now = () => performance.now()) {
  const tables = { ip: new Map(), user: new Map() };
  return {
    take(scope, id, kind) {
      const table = tables[scope], [rate, burst] = config.rates[kind][scope];
      const t = now(), key = `${kind}:${id}`;
      let b = table.get(key);
      if (!b) {
        if (table.size >= config.bucketsPerScope) return false;
        b = { tokens: burst, t }; table.set(key, b);
      }
      b.tokens = Math.min(burst, b.tokens + Math.max(0, t - b.t) * rate / 1000);
      b.t = t;
      if (b.tokens < 1) return false;
      b.tokens--;
      return true;
    },
    sweep() {
      const t = now();
      for (const table of Object.values(tables)) for (const [key, b] of table) {
        if (t - b.t >= config.bucketIdleMs) table.delete(key);
      }
    },
  };
}

function normalizeIP(s) {
  const type = isIP(s);
  if (type === 4) return s;
  if (type !== 6 || s.includes('%')) return null;
  const v = new URL(`http://[${s}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(v);
  if (!mapped) return v;
  return mapped.slice(1).flatMap(h => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255]).join('.');
}

// Trust exact, explicitly configured proxy IPs only. Walk right to left through trusted hops.
export function createClientIP(trusted = '') {
  const proxies = new Set(trusted.split(',').map(s => normalizeIP(s.trim())).filter(Boolean));
  return req => {
    let ip = normalizeIP(req.socket.remoteAddress || '') || 'unknown';
    const forwarded = req.headers['x-forwarded-for'];
    if (!proxies.has(ip) || typeof forwarded !== 'string') return ip;
    const hops = forwarded.split(',');
    if (hops.length > 16) return ip;
    const chain = hops.map(s => normalizeIP(s.trim()));
    if (chain.some(s => !s)) return ip;
    for (let i = chain.length - 1; i >= 0 && proxies.has(ip); i--) ip = chain[i];
    return ip;
  };
}

// Explicit budgets for retained payloads, not a promise about Node's process RSS.
export function createByteBudget(limit) {
  let used = 0;
  return {
    reserve(bytes) {
      if (used + bytes > limit) return false;
      used += bytes;
      return true;
    },
    release(bytes) { used -= bytes; },
    get used() { return used; },
  };
}

// Aevum - tiny dependency-free static file server (works as CommonJS or ES module).
(async () => {
  const http = await import('node:http');
  const path = await import('node:path');
  const { RELAY_LIMITS: limits, createRateLimiter, createClientIP, createByteBudget } = await import('./srv/relay-limits.mjs');
  const { MemoryRoomStore } = await import('./srv/room-store.mjs');

  const ROOT = path.dirname(path.resolve(process.argv[1]));
  const PORT = Number(process.env.PORT) || 5173;
  // verified player identity (srv/identity.mjs): Firebase ID token -> relay ticket; TP ledger.
  // AEVUM_NO_AUTH=1 (local tests only): the relay also accepts peers without a ticket and dev identities.
  const { pathToFileURL } = await import('node:url');
  const { requestPath, createStaticHandler } = await import('./srv/static.mjs');
  const { logServerError: logErr } = await import('./srv/logging.mjs');
  const { createSseTickets } = await import('./srv/sse-tickets.mjs');
  const serveStatic = createStaticHandler(ROOT);
  const sseTickets = createSseTickets();
  setInterval(sseTickets.sweep, 20_000).unref();
  const IDM = await import(pathToFileURL(path.join(ROOT, 'srv', 'identity.mjs')).href);
  const NO_AUTH = /^(1|true|yes)$/i.test(process.env.AEVUM_NO_AUTH || '');
  const KEYS = IDM.keysFromEnv(process.env);
  const ID = IDM.createIdentity({ projectId: process.env.AEVUM_FIREBASE_PROJECT || undefined, keys: KEYS.keys, noAuth: NO_AUTH, tpMinMs: process.env.AEVUM_TP_MIN_MS != null ? Number(process.env.AEVUM_TP_MIN_MS) : undefined });
  if (KEYS.source === 'ephemeral') console.warn('AEVUM_SECRET yok: TP kayitlari bu surec kapaninca gecersiz olur (yalnizca yerel test icin uygun).');
  if (NO_AUTH) console.warn('AEVUM_NO_AUTH: kimlik dogrulamasi KAPALI (yalnizca yerel test).');
  // player statistics (srv/stats.mjs), shown only to the accounts in AEVUM_OWNERS (comma separated Firebase uids).
  // AEVUM_SA (a service account key, set in the host's dashboard) keeps the daily numbers in Firestore.
  const STM = await import(pathToFileURL(path.join(ROOT, 'srv', 'stats.mjs')).href);
  const SAM = await import(pathToFileURL(path.join(ROOT, 'srv', 'firestore-sa.mjs')).href);
  const OWNERS = new Set(String(process.env.AEVUM_OWNERS || '').split(',').map(s => s.trim()).filter(Boolean));
  const SA = SAM.serviceAccountFromEnv(process.env);
  const STATS = STM.createStats({
    store: SA ? SAM.createSaStore({ sa: SA, projectId: process.env.AEVUM_FIREBASE_PROJECT || undefined }) : null,
    log: (t, e) => logErr(t, e),
  });
  if (!SA) console.warn('AEVUM_SA yok: istatistikler yalnizca bellekte tutulur.');
  setInterval(() => { STATS.flush().catch(() => {}); }, 3 * 60 * 1000).unref();
  // a deploy or a restart: write the last minutes of numbers before going
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { const end = () => process.exit(0); STATS.flush().then(end, end); setTimeout(end, 4000).unref(); });
  // ---- multiplayer relay: in-memory rooms; SSE or long-polling down, POST up ----
  // Every peer is an object { send(obj), end(), sse|poll }; nothing here may throw into the event loop.
  // The relay keeps no game state: after a restart the clients reconnect with the same peer ids and rebuild the rooms.
  const T0 = Date.now();
  const J = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const store = new MemoryRoomStore(limits);
  const rates = createRateLimiter(limits);
  const clientIP = createClientIP(process.env.AEVUM_TRUSTED_PROXIES);
  const input = createByteBudget(limits.inputBytes), output = createByteBudget(limits.outputBytes);
  const transfers = createByteBudget(limits.blobTransferBytes);
  setInterval(() => { store.sweep(); rates.sweep(); }, limits.sweepMs).unref();
  const byIP = (ip, kind) => rates.take('ip', ip, kind);
  const byUser = (ident, kind) => !ident || rates.take('user', ident.fb, kind);
  const rejectRate = (res, kind) => reply(res, 429, {
    ...J, 'Retry-After': String(Math.ceil(1 / Math.min(...Object.values(limits.rates[kind]).map(([rate]) => rate)))), Connection: 'close',
  }, '{"error":"rate"}');
  const okName = s => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(s);
  const alive = res => !!res && !res.destroyed && !res.writableEnded;
  const reply = (res, code, headers, body) => { try { if (!alive(res)) return; if (!res.headersSent) res.writeHead(code, headers); res.end(body); } catch { /* closed */ } };
  const tell = (o, obj) => { try { o.send(obj); } catch (e) { logErr('send', e); } };
  function removePeer(room, peer, obj) {
    const r = store.removePeer(room, peer, obj);
    if (r) for (const o of r.peers.values()) tell(o, { type: 'left', peer });
  }
  // the public part of a verified identity, as the relay stamps it on messages
  const pub = (id) => (id ? { uid: id.uid, name: id.name, av: id.av, tp: id.tp } : null);
  function addPeer(room, peer, pe) {
    const old = store.getRoom(room)?.peers.get(peer);
    // Install the replacement before closing the old stream so its close handler cannot remove the new one.
    const { peers } = store.setPeer(room, peer, pe);
    if (old) { try { old.end(); } catch { /* ignore */ } }
    if (pe.ident) {
      for (const [p, o] of peers) {
        if (p === peer || o.ident?.fb !== pe.ident.fb) continue;
        store.kick(room, p);
        tell(o, { type: 'dup' });
        removePeer(room, p, o);
        try { o.end(); } catch { /* ignore */ }
      }
    }
    const ids = Object.create(null); for (const [p, o] of peers) if (o.ident) ids[p] = pub(o.ident);
    tell(pe, { type: 'hello', peers: [...peers.keys()], ids });
    if (!old) for (const [p, o] of peers) if (p !== peer) tell(o, { type: 'joined', peer, id: pub(pe.ident) });
  }
  // friends: one inbox per account {q, waiter, seen}; online = a long-poll is open or ended < 40 s ago
  const FB_OK = /^[A-Za-z0-9]{1,128}$/;
  const inboxes = new Map(), inviteRate = new Map();
  function inboxOf(fb) { let b = inboxes.get(fb); if (!b) { b = { q: [], waiter: null, seen: 0 }; inboxes.set(fb, b); } return b; }
  function isOnline(fb) { const b = inboxes.get(fb); return !!b && (!!b.waiter || Date.now() - b.seen < 40000); }
  setInterval(() => {
    const t = Date.now();
    for (const [fb, b] of inboxes) if (!b.waiter && t - b.seen > 10 * 60000) inboxes.delete(fb);
    for (const [fb, l] of inviteRate) if (!l.some(x => t - x < 60000)) inviteRate.delete(fb);
  }, 60000).unref();
  // The general relay ticket is never accepted by /mp/events; legacy query auth is for other transports.
  function identOf(req, url) {
    const tk = req.headers['x-aevum-ticket'] || url.searchParams.get('tk') || '';
    return tk ? ID.checkTicket(String(tk)) : null;
  }
  function budgetedWrite(pe, payload, write) {
    const size = Buffer.byteLength(payload) + 128;
    if ((pe.pendingRelayBytes || 0) + size > limits.peerOutputBytes || !output.reserve(size)) return false;
    pe.pendingRelayBytes = (pe.pendingRelayBytes || 0) + size;
    let done = false;
    const release = () => { if (!done) { done = true; pe.pendingRelayBytes -= size; output.release(size); } };
    try { write(release); return true; } catch { release(); return false; }
  }
  function makeSsePeer(res) {
    return {
      sse: true, res, dead: false,
      send(obj) {
        if (this.dead || !alive(res)) return;
        const data = 'data: ' + JSON.stringify(obj) + '\n\n';
        if (!budgetedWrite(this, data, cb => res.write(data, cb))) res.destroy();
      },
      end() { this.dead = true; try { res.end(); } catch { /* ignore */ } },
    };
  }
  function releaseOnResponse(res, release) {
    const done = () => { res.off('finish', done); res.off('close', done); release(); };
    if (!alive(res)) done();
    else { res.once('finish', done); res.once('close', done); }
  }
  function makePollPeer(room, peer) {
    return {
      poll: true, q: [], queued: 0, waiter: null, timer: null, dead: false,
      send(obj) {
        if (this.dead) return;
        const text = JSON.stringify(obj), size = Buffer.byteLength(text) * 3 + 128; // queue + response assembly
        while (this.q.length && (this.q.length >= limits.pollQueueEntries || this.queued + size > limits.peerOutputBytes)) {
          const old = this.q.shift(); this.queued -= old.size; output.release(old.size);
        }
        if (this.queued + size > limits.peerOutputBytes || !output.reserve(size)) return;
        this.q.push({ text, size }); this.queued += size; this.flush();
      },
      end() { this.dead = true; clearTimeout(this.timer); output.release(this.queued); this.queued = 0; this.q = []; this.answer('[]'); },
      answer(body, bytes = 0) {
        const w = this.waiter;
        if (!w) return;
        this.waiter = null; clearTimeout(w.to);
        if (bytes) releaseOnResponse(w.res, () => output.release(bytes));
        reply(w.res, 200, J, body);
      },
      flush() {
        if (!this.waiter || !this.q.length) return;
        const text = '[' + this.q.map(e => e.text).join(',') + ']', size = this.queued;
        this.q = []; this.queued = 0;
        this.answer(text, size); this.arm();
      },
      arm() {
        clearTimeout(this.timer);
        if (this.dead) return;
        this.timer = setTimeout(() => {
          if (this.dead) return;
          if (this.waiter) { this.arm(); return; }
          this.end(); removePeer(room, peer, this);
        }, limits.pollIdleMs);
      },
    };
  }
  function readBody(req, max, cb, pool, deadline) {
    let chunks = [], size = 0, retained = 0, done = false, timer;
    const finish = (err) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { cb(err, err ? undefined : Buffer.concat(chunks, size)); } catch (e) { logErr('body cb', e, req); }
      finally { chunks = []; if (pool) pool.release(retained); }
    };
    if (Number(req.headers['content-length']) > max) { finish('big'); return; }
    if (deadline) timer = setTimeout(() => finish('timeout'), deadline);
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > max) { finish('big'); return; }
      const bytes = c.length * 2 + 128; // chunks plus Buffer.concat peak
      if (pool && !pool.reserve(bytes)) { finish('busy'); return; }
      retained += bytes; chunks.push(c);
    });
    req.on('end', () => finish(null));
    req.on('error', () => finish('err'));
    req.on('aborted', () => finish('err'));
  }
  function bodyError(res, err) {
    reply(res, ({ big: 413, timeout: 408, busy: 503 })[err] || 400, { ...J, Connection: 'close' }, '');
  }

  // ---- WebSocket peers (GET /mp/ws upgrade): one socket both ways, so a turn packet costs one hop, not a POST
  // plus a long-poll round trip. Minimal RFC 6455 (text frames, ping/pong, close); no dependencies.
  const crypto = await import('node:crypto');
  const WS_MAX = limits.maxMessageBytes;
  function wsFrame(op, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
    return Buffer.concat([head, payload]);
  }
  function wsAccept(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return false; }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    socket.setNoDelay(true);
    return true;
  }
  // reads client frames; onText(string) per complete message; onEnd() once
  function wsReader(socket, allow, onText, onEnd) {
    let buf = Buffer.alloc(0), frag = [], fragLen = 0, charged = 0, partial = 0, fragmented = false, ended = false, bodyTimer;
    const end = () => {
      if (ended) return;
      ended = true; clearTimeout(bodyTimer); input.release(charged + partial); charged = partial = 0;
      buf = Buffer.alloc(0); frag = [];
      try { onEnd(); } catch (e) { logErr('ws end', e); }
    };
    const stop = () => { socket.destroy(); end(); };
    socket.on('data', (chunk) => {
      if (ended) return;
      input.release(partial); partial = 0;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; const big = buf.readBigUInt64BE(2); if (big > BigInt(WS_MAX)) return stop(); len = Number(big); off = 10; }
        if (len > WS_MAX || !masked || (op >= 8 && (!fin || len > 125))) return stop();
        if (buf.length < off + 4 + len) break;
        if (!allow()) { // 1013: retry later
          end(); socket.end(wsFrame(8, Buffer.from([0x03, 0xf5])), () => socket.destroy()); return;
        }
        const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } end(); return; }
        if (op === 9) { if (!budgetedWrite(socket, data, cb => socket.write(wsFrame(10, data), cb))) return stop(); continue; }
        if (op === 10) continue;
        if (op === 1 || op === 2 || op === 0) {
          fragmented = !fin;
          fragLen += len;
          if (fragLen > WS_MAX) return stop();
          if (len) {
            const cost = len * 3 + 128;
            if (!input.reserve(cost)) return stop();
            charged += cost; frag.push(data);
          }
          if (fin) {
            const msg = Buffer.concat(frag, fragLen).toString('utf8'); frag = []; fragLen = 0;
            clearTimeout(bodyTimer); bodyTimer = null; input.release(charged); charged = 0;
            try { onText(msg); } catch (e) { logErr('ws msg', e); }
          }
        }
      }
      if (buf.length) {
        if (!input.reserve(buf.length + 128)) return stop();
        partial = buf.length + 128; buf = Buffer.from(buf);
      } else buf = Buffer.alloc(0);
      if (partial || fragmented) bodyTimer ||= setTimeout(stop, limits.messageBodyMs);
      else { clearTimeout(bodyTimer); bodyTimer = null; }
    });
    socket.on('close', end); socket.on('end', end); socket.on('error', end);
  }
  function makeWsPeer(socket) {
    return {
      ws: true, socket, dead: false,
      send(obj) {
        if (this.dead || socket.destroyed) return;
        const payload = Buffer.from(JSON.stringify(obj));
        if (!budgetedWrite(socket, payload, cb => socket.write(wsFrame(1, payload), cb))) socket.destroy();
      },
      end() { this.dead = true; try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 1000).unref(); },
    };
  }
  // relays one {topic, data} message of `peer` to the rest of its room (shared by POST /mp/send and WebSocket)
  function relay(room, peer, sender, m) {
    const r = store.getRoom(room);
    if (!r || r.peers.get(peer) !== sender || !m || typeof m.topic !== 'string' || m.topic.length > 32) return;
    const msg = { type: 'msg', topic: m.topic, data: m.data, from: peer, id: pub(sender.ident) };
    for (const [p, o] of r.peers) if (p !== peer) tell(o, msg);
  }
  function handleUpgrade(req, socket) {
    let url; try { url = new URL(req.url || '', 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/mp/ws') { socket.destroy(); return; }
    if (!wsAccept(req, socket)) return;
    const say = (obj) => { try { socket.write(wsFrame(1, Buffer.from(JSON.stringify(obj)))); } catch { /* ignore */ } };
    const bye = (obj) => { say(obj); try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } };
    const ip = clientIP(req);
    if (!byIP(ip, 'join')) { bye({ type: 'err', code: 429 }); return; }
    // a probe: the client checks that WebSockets pass (proxies / tunnels) before it picks this transport
    if (url.searchParams.has('probe')) { bye({ type: 'probe' }); return; }
    const room = (url.searchParams.get('room') || '').toUpperCase(), peer = url.searchParams.get('peer') || '';
    if (!okName(room) || !okName(peer)) { bye({ type: 'err', code: 400 }); return; }
    const ident = identOf(req, url);
    if (!ident && !NO_AUTH) { bye({ type: 'err', code: 401 }); return; }
    if (!byUser(ident, 'join')) { bye({ type: 'err', code: 429 }); return; }
    if (store.isKicked(room, peer)) { bye({ type: 'dup' }); return; }
    if (store.getRoom(room)?.peers.has(peer) && !store.member(room, peer, ident, ip)) { bye({ type: 'err', code: 403 }); return; }
    if (!store.canJoin(room, peer)) { bye({ type: 'err', code: 429 }); return; }
    const pe = Object.assign(makeWsPeer(socket), { ident, ip });
    addPeer(room, peer, pe);
    const hb = setInterval(() => pe.send({ type: 'hb' }), 15000);
    wsReader(socket, () => byIP(ip, 'message') && byUser(ident, 'message'), text => {
      if (pe.dead) return;
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m && m.type === 'ping') { pe.send({ type: 'pong', t: m.t }); return; }
      relay(room, peer, pe, m);
    }, () => { clearInterval(hb); pe.dead = true; removePeer(room, peer, pe); });
  }

  function handleMp(req, res, url) {
    const room = (url.searchParams.get('room') || '').toUpperCase(), peer = url.searchParams.get('peer') || '';
    if (url.pathname === '/mp/ping') { reply(res, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'aevum-mp'); return; }
    if (url.pathname === '/mp/health') {
      reply(res, 200, J, JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), since: new Date(T0).toISOString(), ...store.stats(), rssMB: Math.round(process.memoryUsage().rss / 1048576), pid: process.pid, auth: NO_AUTH ? 'off' : 'on', tpKey: KEYS.source }));
      return;
    }
    // ---- statistics: a beat from every open game tab (a random browser id, what it is doing), the owner's report ----
    if (url.pathname === '/mp/beat') {
      const me = identOf(req, url);
      STATS.beat(url.searchParams.get('v') || '', url.searchParams.get('s') || '', me ? me.fb : null);
      reply(res, 204, { 'Cache-Control': 'no-store' });
      return;
    }
    if (url.pathname === '/mp/stats' && req.method === 'GET') {
      const me = identOf(req, url);
      if (!me) { reply(res, 401, J, '{"error":"ticket"}'); return; }
      if (!OWNERS.has(me.fb)) { reply(res, 403, J, '{"error":"owner"}'); return; }
      STATS.report(30).then(r => reply(res, 200, J, JSON.stringify(r)), e => { logErr('stats', e, req); reply(res, 500, J, '{"error":"stats"}'); });
      return;
    }
    // ---- friends: online status + room invites (an inbox per verified account; memory only) ----
    if (url.pathname === '/mp/inbox' && req.method === 'GET') {
      const me = identOf(req, url);
      if (!me) { reply(res, 401, J, '{"error":"ticket"}'); return; }
      const box = inboxOf(me.fb);
      box.seen = Date.now();
      if (box.waiter) { const w = box.waiter; box.waiter = null; clearTimeout(w.to); reply(w.res, 200, J, '[]'); }
      if (box.q.length) { reply(res, 200, J, JSON.stringify(box.q.splice(0))); return; }
      const w = { res, to: setTimeout(() => { if (box.waiter === w) { box.waiter = null; box.seen = Date.now(); reply(res, 200, J, '[]'); } }, 25000) };
      box.waiter = w;
      res.on('close', () => { if (box.waiter === w) { box.waiter = null; clearTimeout(w.to); box.seen = Date.now(); } });
      return;
    }
    if ((url.pathname === '/mp/invite' || url.pathname === '/mp/online') && req.method === 'POST') {
      readBody(req, 8192, (err, buf) => {
        if (err) { reply(res, 400, J, '{"error":"bad body"}'); return; }
        const me = identOf(req, url);
        if (!me) { reply(res, 401, J, '{"error":"ticket"}'); return; }
        let body; try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { reply(res, 400, J, '{"error":"bad json"}'); return; }
        if (url.pathname === '/mp/online') {
          const fbs = Array.isArray(body.fbs) ? body.fbs.filter(f => typeof f === 'string' && FB_OK.test(f)).slice(0, 200) : [];
          inboxOf(me.fb).seen = Date.now();
          reply(res, 200, J, JSON.stringify({ online: fbs.filter(isOnline) }));
          return;
        }
        const to = String(body.to || ''), code = String(body.code || '').toUpperCase();
        if (!FB_OK.test(to) || !/^[A-Z0-9]{5}$/.test(code) || to === me.fb) { reply(res, 400, J, '{"error":"bad invite"}'); return; }
        // at most 20 invites a minute per account
        const now = Date.now(), rl = inviteRate.get(me.fb) || [];
        const recent = rl.filter(t => now - t < 60000);
        if (recent.length >= 20) { reply(res, 429, J, '{"error":"Çok fazla davet; biraz bekle."}'); return; }
        recent.push(now); inviteRate.set(me.fb, recent);
        const online = isOnline(to);
        if (online) {
          const box = inboxOf(to);
          box.q.push({ type: 'invite', code, from: { fb: me.fb, uid: me.uid, name: me.name, av: me.av, tp: me.tp }, t: now });
          if (box.q.length > 20) box.q.splice(0, box.q.length - 20);
          if (box.waiter) { const w = box.waiter; box.waiter = null; clearTimeout(w.to); reply(w.res, 200, J, JSON.stringify(box.q.splice(0))); }
        }
        reply(res, 200, J, JSON.stringify({ online }));
      });
      return;
    }
    // ---- identity: Firebase ID token -> relay ticket; TP match tickets and ledger ----
    if (url.pathname.startsWith('/mp/auth') || url.pathname.startsWith('/mp/tp/')) {
      if (req.method !== 'POST') { reply(res, 405, {}, ''); return; }
      const authRequest = url.pathname === '/mp/auth';
      if (authRequest && !byIP(clientIP(req), 'auth')) { rejectRate(res, 'auth'); return; }
      readBody(req, authRequest ? limits.authBodyBytes : 32768, (err, buf) => {
        if (err) {
          if (authRequest) bodyError(res, err); else reply(res, 400, J, '{"error":"bad body"}');
          return;
        }
        let body; try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { reply(res, 400, J, '{"error":"bad json"}'); return; }
        const fail = (code, msg) => reply(res, code, J, JSON.stringify({ error: msg }));
        if (authRequest) {
          ID.auth(body).then((r) => {
            if (!byUser(r.ident, 'auth')) { rejectRate(res, 'auth'); return; }
            reply(res, 200, J, JSON.stringify(Object.assign(r, OWNERS.has(r.ident.fb) ? { owner: true } : {})));
          }, (e) => {
            if (e instanceof IDM.IdentityError) { fail(e.status, e.message); return; }
            logErr('auth', e, req); fail(503, 'Kimlik şu an doğrulanamadı.');
          });
          return;
        }
        const me = identOf(req, url);
        if (!me) { fail(401, 'Bilet geçersiz.'); return; }
        try {
          if (url.pathname === '/mp/tp/start') { reply(res, 200, J, JSON.stringify(ID.matchStart(me, body))); STATS.match(body.mode === 'mp' ? 'mp' : 'sp', typeof body.room === 'string' ? body.room.slice(0, 16) : null, me.fb); }
          else if (url.pathname === '/mp/tp/claim') reply(res, 200, J, JSON.stringify(ID.matchClaim(me, body)));
          else if (url.pathname === '/mp/tp/info') reply(res, 200, J, JSON.stringify(ID.ledgerInfo(me, body.ledger)));
          else reply(res, 404, {}, '');
        } catch (e) { logErr('tp', e, req); fail(500, 'Sunucu hatası.'); }
      }, authRequest ? input : null, authRequest ? limits.messageBodyMs : null);
      return;
    }
    const sse = url.pathname === '/mp/events', issueSse = url.pathname === '/mp/sse-ticket';
    const poll = url.pathname === '/mp/poll', send = url.pathname === '/mp/send', blob = url.pathname === '/mp/blob';
    if (!(sse || issueSse || poll || send || blob)) { reply(res, 404, {}, ''); return; }
    const method = req.method;
    const allow = blob ? ['GET', 'POST'] : [(sse || poll) ? 'GET' : 'POST'];
    if (!allow.includes(method)) { reply(res, 405, { Allow: allow.join(', ') }, ''); return; }
    const kind = sse || issueSse ? 'join' : poll ? 'poll' : send ? 'message' : method === 'POST' ? 'upload' : 'download';
    const ip = clientIP(req);
    if (!byIP(ip, kind)) { rejectRate(res, kind); return; }
    if (!okName(room) || !okName(peer)) { reply(res, 400, {}, 'bad room/peer'); return; }
    const grant = sse ? sseTickets.consume(url.searchParams.get('st'), room, peer) : null;
    const header = issueSse && req.headers['x-aevum-ticket'];
    const ident = sse ? grant?.ident : issueSse ? (header ? ID.checkTicket(String(header)) : null) : identOf(req, url);
    if ((sse && !grant) || (!ident && (!NO_AUTH || header))) { reply(res, 401, J, '{"error":"ticket"}'); return; }
    if (!byUser(ident, kind)) { rejectRate(res, kind); return; }
    if (store.isKicked(room, peer)) { reply(res, 409, J, '{"error":"dup"}'); return; }
    const member = store.member(room, peer, ident, ip);
    if (!member && ((send || blob) || store.getRoom(room)?.peers.has(peer))) {
      reply(res, 403, { ...J, Connection: 'close' }, '{"error":"peer"}'); return;
    }
    if (issueSse) {
      const ticket = sseTickets.issue(room, peer, ident);
      if (!ticket) { reply(res, 429, J, '{"error":"full"}'); return; }
      reply(res, 200, J, JSON.stringify({ ticket })); return;
    }
    if (sse) {
      if (!store.canJoin(room, peer)) { reply(res, 429, {}, 'full'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' });
      const pe = Object.assign(makeSsePeer(res), { ident, ip });
      const hb = setInterval(() => pe.send({ type: 'hb' }), 15000);
      res.on('close', () => { pe.dead = true; clearInterval(hb); removePeer(room, peer, pe); });
      addPeer(room, peer, pe);
      return;
    }
    if (poll) {
      let pe = member;
      if (!pe?.poll) {
        if (!store.canJoin(room, peer)) { reply(res, 429, {}, 'full'); return; }
        pe = Object.assign(makePollPeer(room, peer), { ident, ip });
        addPeer(room, peer, pe);
      }
      pe.answer('[]');
      clearTimeout(pe.timer);
      if (pe.q.length) { pe.waiter = { res, to: null }; pe.flush(); return; }
      const w = { res, to: setTimeout(() => { if (pe.waiter === w) { pe.answer('[]'); pe.arm(); } }, limits.pollWaitMs) };
      pe.waiter = w;
      res.on('close', () => { if (pe.waiter === w) { pe.waiter = null; clearTimeout(w.to); pe.arm(); } });
      return;
    }
    if (send) {
      readBody(req, limits.maxMessageBytes, (err, buf) => {
        if (err) { bodyError(res, err); return; }
        if (store.member(room, peer, ident, ip) !== member) { reply(res, 403, J, '{"error":"peer"}'); return; }
        let m; try { m = JSON.parse(buf.toString('utf8')); } catch { reply(res, 400, {}, 'bad json'); return; }
        relay(room, peer, member, m);
        reply(res, 204, { 'Cache-Control': 'no-store' });
      }, input, limits.messageBodyMs);
      return;
    }
    if (method === 'POST') {
      readBody(req, limits.maxBlobBytes, (err, buf) => {
        if (err) { bodyError(res, err); return; }
        if (!buf.length) { reply(res, 400, J, '{"error":"empty blob"}'); return; }
        const id = store.putBlob(room, peer, ident, ip, member, buf);
        if (!id) { reply(res, 403, J, '{"error":"peer"}'); return; }
        reply(res, 200, J, JSON.stringify({ id, size: buf.length }));
      }, transfers, limits.blobBodyMs);
      return;
    }
    const buf = store.getBlob(room, peer, ident, ip, url.searchParams.get('id'));
    if (!buf) { reply(res, 404, J, '{"error":"not found"}'); return; }
    if (!transfers.reserve(buf.length)) { reply(res, 503, J, '{"error":"busy"}'); return; }
    const deadline = setTimeout(() => res.destroy(), limits.blobBodyMs);
    releaseOnResponse(res, () => { clearTimeout(deadline); transfers.release(buf.length); });
    reply(res, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }, buf);
  }

  // Never let one bad request or a dropped connection take the whole server (and every running match) down.
  process.on('uncaughtException', e => logErr('uncaughtException', e));
  process.on('unhandledRejection', e => logErr('unhandledRejection', e));

  const server = http.createServer((req, res) => {
    req.on('error', () => {}); res.on('error', () => {});
    handle(req, res).catch(e => { logErr('request', e, req); if (res.headersSent) res.destroy(); else reply(res, 500, {}, ''); });
  });
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    if (requestPath(req.url) !== '/mp/ws') { socket.destroy(); return; }
    try { handleUpgrade(req, socket); } catch (e) { logErr('upgrade', e, req); try { socket.destroy(); } catch { /* ignore */ } }
  });
  async function handle(req, res) {
    const pathname = requestPath(req.url);
    if (!pathname) { reply(res, 400, {}, 'Bad request'); return; }
    if (pathname.startsWith('/mp/')) {
      const url = new URL(req.url, 'http://x');
      handleMp(req, res, url); return;
    }
    await serveStatic(req, res, pathname);
  }
  let listening = false;
  server.on('error', e => {
    if (e && e.code === 'EADDRINUSE') { console.error(`Port ${PORT} kullanimda. Oyun zaten acik olabilir: http://localhost:${PORT}`); process.exit(1); }
    if (!listening) { logErr('startup', e); process.exit(1); }
    logErr('server', e); // a runtime error (e.g. EMFILE) must not end every running match
  });
  // SSE / long-poll responses stay open; never let the http defaults cut them
  server.requestTimeout = 0; server.headersTimeout = 60000; server.keepAliveTimeout = 30000;
  server.listen(PORT, '0.0.0.0', async () => {
    listening = true;
    console.log(`Aevum calisiyor: http://localhost:${PORT}  (kapatmak icin Ctrl+C)`);
    try {
      const os = await import('node:os');
      const ips = [];
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
      if (ips.length) console.log('Ayni agdaki diger bilgisayarlar icin: ' + ips.map(ip => `http://${ip}:${PORT}`).join('  '));
    } catch { /* ignore */ }
  });
})();

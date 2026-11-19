// Aevum - tiny dependency-free static file server (works as CommonJS or ES module).
(async () => {
  const http = await import('node:http');
  const path = await import('node:path');

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
  const MAX_PEERS = 16, MAX_ROOMS = 1000, MAX_Q = 4000, MAX_SSE_BUF = 2 * 1024 * 1024;
  const MAX_BODY = 65536, BLOB_MAX = 32 * 1024 * 1024,   // (saves of 512 maps)
    BLOB_TTL = 30 * 60 * 1000, BLOB_TOTAL = 96 * 1024 * 1024, BLOB_EMPTY_KEEP = 60 * 1000;
  const J = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const rooms = new Map();      // room -> Map(peer -> peer object)
  const blobs = new Map();      // room -> Map(id -> { buf, t })
  const emptySince = new Map(); // room -> time it became empty (its blobs are kept a little longer)
  const okName = s => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(s);
  const alive = res => !!res && !res.destroyed && !res.writableEnded;
  const reply = (res, code, headers, body) => { try { if (!alive(res)) return; if (!res.headersSent) res.writeHead(code, headers); res.end(body); } catch { /* closed */ } };
  const tell = (o, obj) => { try { o.send(obj); } catch (e) { logErr('send', e); } };
  function getRoom(room) { let r = rooms.get(room); if (!r) { r = new Map(); rooms.set(room, r); } emptySince.delete(room); return r; }
  function removePeer(room, peer, obj) {
    const r = rooms.get(room);
    if (!r || r.get(peer) !== obj) return;
    r.delete(peer);
    for (const o of r.values()) tell(o, { type: 'left', peer });
    if (!r.size) { rooms.delete(room); emptySince.set(room, Date.now()); }
  }
  // the public part of a verified identity, as the relay stamps it on messages
  const pub = (id) => (id ? { uid: id.uid, name: id.name, av: id.av, tp: id.tp } : null);
  const kicked = new Map();   // room + ' ' + peer -> time: replaced by a newer connection of the same account
  function addPeer(room, peer, pe, r) {
    const old = r.get(peer);
    if (old) { try { old.end(); } catch { /* ignore */ } }
    // one account = one player: the same uid under another peer id (a second tab) replaces the older connection
    if (pe.ident) {
      for (const [p, o] of [...r]) {
        if (p === peer || !o.ident || o.ident.uid !== pe.ident.uid) continue;
        kicked.set(room + ' ' + p, Date.now());
        tell(o, { type: 'dup' });
        r.delete(p);
        try { o.dead = true; o.end(); } catch { /* ignore */ }
        for (const q of r.values()) if (q !== pe) tell(q, { type: 'left', peer: p });
      }
    }
    r.set(peer, pe);
    const ids = {}; for (const [p, o] of r) if (o.ident) ids[p] = pub(o.ident);
    tell(pe, { type: 'hello', peers: [...r.keys()], ids });
    if (!old) for (const [p, o] of r) if (p !== peer) tell(o, { type: 'joined', peer, id: pub(pe.ident) });
  }
  setInterval(() => { const t = Date.now(); for (const [k, v] of kicked) if (t - v > 120000) kicked.delete(k); }, 30000).unref();
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
  function makeSsePeer(room, peer, res) {
    return {
      sse: true, res,
      send(obj) {
        if (!alive(res)) return;
        if (res.writableLength > MAX_SSE_BUF) { try { res.destroy(); } catch { /* ignore */ } return; } // client stopped reading
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* closed */ }
      },
      end() { try { res.end(); } catch { /* ignore */ } },
    };
  }
  function makePollPeer(room, peer) {
    return {
      poll: true, q: [], waiter: null, timer: null, dead: false,
      send(obj) { if (this.dead) return; this.q.push(obj); if (this.q.length > MAX_Q) this.q.splice(0, this.q.length - MAX_Q); this.flush(); },
      end() { this.dead = true; clearTimeout(this.timer); this.answer('[]'); },
      answer(body) { const w = this.waiter; if (!w) return false; this.waiter = null; clearTimeout(w.to); reply(w.res, 200, J, body); return true; },
      flush() { if (this.waiter && this.q.length) { let body; try { body = JSON.stringify(this.q.splice(0)); } catch { body = '[]'; } this.answer(body); this.arm(); } },
      arm() {
        clearTimeout(this.timer);
        if (this.dead) return;
        this.timer = setTimeout(() => {
          if (this.dead) return;
          if (this.waiter) { this.arm(); return; }
          this.dead = true; this.q.length = 0;
          removePeer(room, peer, this);
        }, 10000);
      },
    };
  }
  function readBody(req, max, cb) {
    const chunks = []; let size = 0, done = false;
    const finish = (err, buf) => { if (done) return; done = true; try { cb(err, buf); } catch (e) { logErr('body cb', e, req); } };
    req.on('data', c => { if (done) return; size += c.length; if (size > max) { chunks.length = 0; finish('big'); return; } chunks.push(c); });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', () => finish('err'));
    req.on('aborted', () => finish('err'));
  }
  function blobBytes() { let n = 0; for (const m of blobs.values()) for (const b of m.values()) n += b.buf.length; return n; }
  function sweepBlobs(force) {
    const now = Date.now();
    for (const [room, m] of blobs) {
      const es = emptySince.get(room);
      if (!rooms.has(room) && (es == null || now - es > BLOB_EMPTY_KEEP)) { blobs.delete(room); continue; }
      for (const [id, b] of m) if (now - b.t > BLOB_TTL) m.delete(id);
      if (!m.size) blobs.delete(room);
    }
    for (const [room, t] of emptySince) if (now - t > BLOB_EMPTY_KEEP * 2) emptySince.delete(room);
    while (force && blobBytes() > BLOB_TOTAL) { // evict the oldest blob
      let old = null; for (const [room, m] of blobs) for (const [id, b] of m) if (!old || b.t < old.b.t) old = { room, id, b };
      if (!old) break; blobs.get(old.room).delete(old.id);
    }
  }
  setInterval(() => { try { sweepBlobs(false); } catch (e) { logErr('sweep', e); } }, 30000).unref();

  // ---- WebSocket peers (GET /mp/ws upgrade): one socket both ways, so a turn packet costs one hop, not a POST
  // plus a long-poll round trip. Minimal RFC 6455 (text frames, ping/pong, close); no dependencies.
  const crypto = await import('node:crypto');
  const WS_MAX = 65536;
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
  function wsReader(socket, onText, onEnd) {
    let buf = Buffer.alloc(0), frag = [], fragLen = 0, ended = false;
    const end = () => { if (ended) return; ended = true; try { onEnd(); } catch (e) { logErr('ws end', e); } };
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(WS_MAX)) { socket.destroy(); return; } len = Number(big); off = 10; }
        if (len > WS_MAX || !masked) { socket.destroy(); return; }   // (clients must mask)
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } end(); return; }
        if (op === 9) { try { socket.write(wsFrame(10, data)); } catch { /* ignore */ } continue; }
        if (op === 10) continue;
        if (op === 1 || op === 2 || op === 0) {
          frag.push(data); fragLen += len;
          if (fragLen > WS_MAX) { socket.destroy(); return; }
          if (fin) { const msg = Buffer.concat(frag).toString('utf8'); frag = []; fragLen = 0; try { onText(msg); } catch (e) { logErr('ws msg', e); } }
        }
      }
    });
    socket.on('close', end); socket.on('end', end); socket.on('error', end);
  }
  function makeWsPeer(socket) {
    return {
      ws: true, socket, dead: false,
      send(obj) {
        if (this.dead || socket.destroyed) return;
        if (socket.writableLength > MAX_SSE_BUF) { try { socket.destroy(); } catch { /* ignore */ } return; }   // client stopped reading
        try { socket.write(wsFrame(1, Buffer.from(JSON.stringify(obj)))); } catch { /* closed */ }
      },
      end() { this.dead = true; try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 1000).unref(); },
    };
  }
  // relays one {topic, data} message of `peer` to the rest of its room (shared by POST /mp/send and WebSocket)
  function relay(room, peer, m) {
    const r = rooms.get(room);
    if (!r || !m || typeof m.topic !== 'string' || m.topic.length > 32) return;
    const sender = r.get(peer);
    if (!sender && !NO_AUTH) return;   // (only a peer that is in the room may post; its verified identity travels with the message)
    const msg = { type: 'msg', topic: m.topic, data: m.data, from: peer, id: pub(sender && sender.ident) };
    for (const [p, o] of r) if (p !== peer) tell(o, msg);
  }
  function handleUpgrade(req, socket) {
    let url; try { url = new URL(req.url || '', 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/mp/ws') { socket.destroy(); return; }
    if (!wsAccept(req, socket)) return;
    const say = (obj) => { try { socket.write(wsFrame(1, Buffer.from(JSON.stringify(obj)))); } catch { /* ignore */ } };
    const bye = (obj) => { say(obj); try { socket.end(wsFrame(8, Buffer.alloc(0))); } catch { /* ignore */ } };
    // a probe: the client checks that WebSockets pass (proxies / tunnels) before it picks this transport
    if (url.searchParams.has('probe')) { bye({ type: 'probe' }); return; }
    const room = (url.searchParams.get('room') || '').toUpperCase(), peer = url.searchParams.get('peer') || '';
    if (!okName(room) || !okName(peer)) { bye({ type: 'err', code: 400 }); return; }
    const ident = identOf(req, url);
    if (!ident && !NO_AUTH) { bye({ type: 'err', code: 401 }); return; }
    if (kicked.has(room + ' ' + peer)) { bye({ type: 'dup' }); return; }
    const known = rooms.get(room) && rooms.get(room).get(peer);
    if (known && known.ident && (!ident || ident.uid !== known.ident.uid)) { bye({ type: 'err', code: 403 }); return; }
    const r0 = rooms.get(room);
    if ((!r0 && rooms.size >= MAX_ROOMS) || (r0 && !r0.has(peer) && r0.size >= MAX_PEERS)) { bye({ type: 'err', code: 429 }); return; }
    const pe = makeWsPeer(socket);
    pe.ident = ident;
    addPeer(room, peer, pe, getRoom(room));
    const hb = setInterval(() => pe.send({ type: 'hb' }), 15000);
    wsReader(socket, (text) => {
      if (pe.dead) return;
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m && m.type === 'ping') { pe.send({ type: 'pong', t: m.t }); return; }
      relay(room, peer, m);
    }, () => { clearInterval(hb); pe.dead = true; removePeer(room, peer, pe); });
  }

  function handleMp(req, res, url) {
    const room = (url.searchParams.get('room') || '').toUpperCase(), peer = url.searchParams.get('peer') || '';
    if (url.pathname === '/mp/ping') { reply(res, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'aevum-mp'); return; }
    if (url.pathname === '/mp/health') {
      let peers = 0; for (const r of rooms.values()) peers += r.size;
      let nb = 0; for (const m of blobs.values()) nb += m.size;
      reply(res, 200, J, JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), since: new Date(T0).toISOString(), rooms: rooms.size, peers, blobs: nb, blobBytes: blobBytes(), rssMB: Math.round(process.memoryUsage().rss / 1048576), pid: process.pid, auth: NO_AUTH ? 'off' : 'on', tpKey: KEYS.source }));
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
      readBody(req, 32768, (err, buf) => {
        if (err) { reply(res, 400, J, '{"error":"bad body"}'); return; }
        let body; try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { reply(res, 400, J, '{"error":"bad json"}'); return; }
        const fail = (code, msg) => reply(res, code, J, JSON.stringify({ error: msg }));
        if (url.pathname === '/mp/auth') {
          ID.auth(body).then((r) => reply(res, 200, J, JSON.stringify(Object.assign(r, OWNERS.has(r.ident.fb) ? { owner: true } : {}))), (e) => {
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
      });
      return;
    }
    if (!okName(room) || !okName(peer)) { reply(res, 400, {}, 'bad room/peer'); return; }
    const sse = url.pathname === '/mp/events', issueSse = url.pathname === '/mp/sse-ticket';
    if ((sse && req.method !== 'GET') || (issueSse && req.method !== 'POST')) {
      reply(res, 405, { Allow: sse ? 'GET' : 'POST' }, ''); return;
    }
    const grant = sse ? sseTickets.consume(url.searchParams.get('st'), room, peer) : null;
    const header = issueSse && req.headers['x-aevum-ticket'];
    const ident = sse ? grant?.ident : issueSse ? (header ? ID.checkTicket(String(header)) : null) : identOf(req, url);
    if ((sse && !grant) || (!ident && (!NO_AUTH || header))) { reply(res, 401, J, '{"error":"ticket"}'); return; }
    if (kicked.has(room + ' ' + peer)) { reply(res, 409, J, '{"error":"dup"}'); return; }
    // a peer id belongs to the identity that registered it
    const known = rooms.get(room) && rooms.get(room).get(peer);
    const ownerKey = sse || issueSse ? 'fb' : 'uid';
    if (known && known.ident && (!ident || ident[ownerKey] !== known.ident[ownerKey])) { reply(res, 403, J, '{"error":"peer"}'); return; }
    if (issueSse) {
      const ticket = sseTickets.issue(room, peer, ident);
      if (!ticket) { reply(res, 429, J, '{"error":"full"}'); return; }
      reply(res, 200, J, JSON.stringify({ ticket }));
      return;
    }
    if (sse) {
      const r0 = rooms.get(room);
      if ((!r0 && rooms.size >= MAX_ROOMS) || (r0 && !r0.has(peer) && r0.size >= MAX_PEERS)) { reply(res, 429, {}, 'full'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' });
      const pe = makeSsePeer(room, peer, res);
      pe.ident = ident;
      addPeer(room, peer, pe, getRoom(room));
      // a data heartbeat (not a comment) so the client can notice a silently dead stream
      const hb = setInterval(() => pe.send({ type: 'hb' }), 15000);
      res.on('close', () => { clearInterval(hb); removePeer(room, peer, pe); });
      return;
    }
    if (url.pathname === '/mp/poll' && req.method === 'GET') {
      // long-polling peer (for tunnels/proxies that do not pass SSE); shares rooms with SSE peers
      let r = rooms.get(room);
      let pe = r && r.get(peer);
      if (!pe || !pe.poll || pe.dead) {
        if ((!r && rooms.size >= MAX_ROOMS) || (r && !pe && r.size >= MAX_PEERS)) { reply(res, 429, {}, 'full'); return; }
        r = getRoom(room);
        pe = makePollPeer(room, peer);
        pe.ident = ident;
        addPeer(room, peer, pe, r);
      }
      pe.answer('[]');                      // an older waiting request of the same peer
      clearTimeout(pe.timer);
      if (pe.q.length) { pe.waiter = { res, to: null }; pe.flush(); return; }
      const w = { res, to: setTimeout(() => { if (pe.waiter === w) { pe.answer('[]'); pe.arm(); } }, 20000) };
      pe.waiter = w;
      res.on('close', () => { if (pe.waiter === w) { pe.waiter = null; clearTimeout(w.to); pe.arm(); } });
      return;
    }
    if (url.pathname === '/mp/send' && req.method === 'POST') {
      readBody(req, MAX_BODY, (err, buf) => {
        if (err) { reply(res, err === 'big' ? 413 : 400, { Connection: 'close' }, ''); return; }
        let m; try { m = JSON.parse(buf.toString('utf8')); } catch { reply(res, 400, {}, 'bad json'); return; }
        relay(room, peer, m);
        reply(res, 204, { 'Cache-Control': 'no-store' });
      });
      return;
    }
    if (url.pathname === '/mp/blob' && req.method === 'POST') {
      // a saved match handed from the host to the other players (in memory, per room, 30 min)
      readBody(req, BLOB_MAX, (err, buf) => {
        if (err) { reply(res, err === 'big' ? 413 : 400, { Connection: 'close' }, err === 'big' ? 'too big' : ''); return; }
        let m = blobs.get(room); if (!m) { m = new Map(); blobs.set(room, m); }
        while (m.size >= 8) { const k = m.keys().next().value; m.delete(k); }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        m.set(id, { buf, t: Date.now() });
        if (!rooms.has(room) && !emptySince.has(room)) emptySince.set(room, Date.now());
        try { sweepBlobs(true); } catch (e) { logErr('sweep', e); }
        reply(res, 200, J, JSON.stringify({ id, size: buf.length }));
      });
      return;
    }
    if (url.pathname === '/mp/blob' && req.method === 'GET') {
      const m = blobs.get(room), b = m && m.get(url.searchParams.get('id') || '');
      if (!b) { reply(res, 404, J, '{"error":"not found"}'); return; }
      reply(res, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.buf.length, 'Cache-Control': 'no-store' }, b.buf);
      return;
    }
    reply(res, 404, {}, '');
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

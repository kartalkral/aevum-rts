// Aevum - transport over the local node server (Server-Sent Events down, POST up).
// Each attempt obtains a single-use stream grant. After a disconnect or a silent heartbeat,
// retry with backoff under the same peer id so the relay rebuilds the room.
import { PollTransport, backoff, identMixin } from './transport-poll.js';
function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

export class SSETransport {
  constructor(base = '', opts = {}) {
    this.base = base;
    this._ticketFn = typeof opts.ticket === 'function' ? opts.ticket : null;
    this._ticket = ''; this._ids = new Map(); this.dup = false;
    this.id = rid();
    this.room = null;
    this.up = false;
    this._h = new Map();
    this._peerFns = [];
    this._statusFns = [];
    this._peers = new Set();
    this.es = null; this._opening = null;
    this._run = false;
    this._fails = 0; this._retryT = null; this._wd = null; this._lastMsg = 0;
  }

  connect(roomCode) {
    this.room = String(roomCode).toUpperCase();
    this._run = true;
    return new Promise((resolve, reject) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; this.close(); reject(new Error('Sunucuya bağlanılamadı (node server.js çalışıyor mu?).')); } }, 6000);
      this._onHello = () => { if (!done) { done = true; clearTimeout(to); resolve(); } };
      this._open();
      this._wd = setInterval(() => {
        // a stream that stopped delivering (even heartbeats) is dead: re-open it
        if (this._run && this.es && Date.now() - this._lastMsg > 40000) { this._setUp(false); this._open(); }
      }, 5000);
    });
  }

  _closeStream() {
    const es = this.es; this.es = null;
    try { es?.close(); } catch { /* ignore */ }
  }

  async _open() {
    if (!this._run || this._opening) return;
    this._closeStream();
    const opening = new AbortController(), room = this.room;
    this._opening = opening;
    const active = () => this._run && this._opening === opening && this.room === room && !opening.signal.aborted;
    const params = new URLSearchParams({ room, peer: this.id });
    let es, timeout;
    try {
      if (this._ticketFn && !this._ticket) {
        const fresh = !!this._refreshTicket;
        await this._tk(fresh);
        if (active() && this._ticket) this._refreshTicket = false;
      }
      if (!active()) return;
      if (this._ticketFn && !this._ticket) { this._retry(); return; }
      timeout = setTimeout(() => opening.abort(), 4500);
      const r = await fetch(`${this.base}/mp/sse-ticket?${params}`, {
        method: 'POST', headers: this._hdr(), cache: 'no-store', redirect: 'error', signal: opening.signal,
      });
      if (!active()) { if (this._opening === opening) this._retry(); return; }
      if (!r.ok) r.body?.cancel().catch(() => {});
      if (r.status === 409) { this._dupStop(); return; }
      if (r.status === 401 && this._ticketFn) {
        // Obtain a new general relay ticket on the next attempt, through the account's refresh hook.
        this._ticket = '';
        this._refreshTicket = true;
      }
      if (!r.ok) { this._retry(); return; }
      const { ticket } = await r.json();
      if (!active()) { if (this._opening === opening) this._retry(); return; }
      if (typeof ticket !== 'string' || !ticket) { this._retry(); return; }
      params.set('st', ticket);
      es = new EventSource(`${this.base}/mp/events?${params}`);
    } catch { if (this._opening === opening) this._retry(); return; }
    finally {
      clearTimeout(timeout);
      if (this._opening === opening) this._opening = null;
    }
    this.es = es; this._lastMsg = Date.now();
    es.onmessage = ev => {
      if (this.es !== es) return;
      this._lastMsg = Date.now();
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hb') { this._setUp(true); return; }
      this._noteIds(m);
      if (m.type === 'dup') { this._dupStop(); this._closeStream(); return; }
      if (m.type === 'hello') {
        const before = new Set(this._peers);
        this._peers = new Set((m.peers || []).filter(p => p !== this.id));
        const joined = [...this._peers].filter(p => !before.has(p)), left = [...before].filter(p => !this._peers.has(p));
        if (joined.length || left.length) this._emitPeers(joined, left);
        this._fails = 0;
        this._setUp(true);
        if (this._onHello) this._onHello();
      } else if (m.type === 'joined') {
        if (m.peer !== this.id && !this._peers.has(m.peer)) { this._peers.add(m.peer); this._emitPeers([m.peer], []); }
      } else if (m.type === 'left') {
        if (this._peers.delete(m.peer)) this._emitPeers([], [m.peer]);
      } else if (m.type === 'msg') {
        if (m.from === this.id) return;
        for (const fn of this._h.get(m.topic) || []) { try { fn(m.data, m.from, m.id || null); } catch (err) { console.error('[sse]', err); } }
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      this._setUp(false);
      // Native retry would reuse a consumed URL. Close immediately and obtain a new grant.
      this._closeStream();
      this._retry();
    };
  }

  _retry() {
    if (!this._run || this._retryT) return;
    this._fails++;
    this._retryT = setTimeout(() => { this._retryT = null; this._open(); }, backoff(this._fails));
  }

  _setUp(up) {
    if (this.up === up) return;
    this.up = up;
    for (const fn of this._statusFns) { try { fn({ up }); } catch (err) { console.error('[sse]', err); } }
  }
  onStatus(fn) { this._statusFns.push(fn); }
  putBlob(text) { return PollTransport.prototype.putBlob.call(this, text); }
  getBlob(id) { return PollTransport.prototype.getBlob.call(this, id); }

  _emitPeers(joined, left) {
    const ch = { joined, left, peers: [...this._peers] };
    for (const fn of this._peerFns) { try { fn(ch); } catch (err) { console.error('[sse]', err); } }
  }

  send(topic, data) {
    if (!this.room) return;
    const body = JSON.stringify({ topic, data });
    fetch(`${this.base}/mp/send?room=${encodeURIComponent(this.room)}&peer=${encodeURIComponent(this.id)}`, {
      method: 'POST', headers: this._hdr({ 'Content-Type': 'application/json' }), body, keepalive: body.length < 60000,
    }).then(r => { if (r && r.status === 401 && this._ticketFn) this._tk(true); }).catch(() => { /* dropped; lockstep re-requests */ });
  }

  on(topic, fn) { if (!this._h.has(topic)) this._h.set(topic, []); this._h.get(topic).push(fn); }
  peers() { return [...this._peers]; }
  onPeers(fn) { this._peerFns.push(fn); }
  close() {
    this._run = false;
    clearTimeout(this._retryT); this._retryT = null; clearInterval(this._wd); this._wd = null;
    this._opening?.abort(); this._opening = null;
    this._closeStream(); this.room = null; this._peers.clear(); this.up = false;
  }
}
identMixin(SSETransport);

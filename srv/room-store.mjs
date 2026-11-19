import { randomBytes } from 'node:crypto';
import { RELAY_LIMITS } from './relay-limits.mjs';

// RoomStore contract (synchronous): room lookup/admission, peer registration/removal and ownership,
// replacement tombstones, member-only blob get/put, sweep and stats. Transport handles remain in-process;
// each getRoom() result has a read-only-by-convention peers Map.
export class MemoryRoomStore {
  #rooms = new Map();
  #kicked = new Map();
  #blobBytes = 0;
  #blobCount = 0;
  #active = 0;
  #peers = 0;
  constructor(config = RELAY_LIMITS, now = () => performance.now()) { this.limits = config; this.now = now; }
  getRoom(code) {
    const r = this.#rooms.get(code);
    return r?.closedAt === null ? r : null;
  }
  canJoin(code, peer) {
    const r = this.getRoom(code);
    if (r?.peers.has(peer)) return true;
    return (r ? r.peers.size < this.limits.maxPeersPerRoom : this.#active < this.limits.maxRooms)
      && this.#peers < this.limits.maxPeers;
  }
  setPeer(code, peer, member) {
    if (!this.canJoin(code, peer)) return null;
    let r = this.getRoom(code);
    if (!r) {
      // Reusing a code starts a new room, not a way to inherit the prior occupants' saves.
      this.#dropClosed(code);
      r = { peers: new Map(), blobs: new Map(), closedAt: null };
      this.#rooms.set(code, r); this.#active++;
    }
    if (!r.peers.has(peer)) this.#peers++;
    r.peers.set(peer, member);
    return r;
  }
  removePeer(code, peer, member) {
    const r = this.getRoom(code);
    if (!r || r.peers.get(peer) !== member) return null;
    r.peers.delete(peer); this.#peers--;
    if (!r.peers.size) {
      r.closedAt = this.now(); this.#active--;
      if (!r.blobs.size) this.#rooms.delete(code);
    }
    return r;
  }
  member(code, peer, ident, ip) {
    const o = this.getRoom(code)?.peers.get(peer);
    if (!o || o.dead || o.res?.destroyed || o.socket?.destroyed) return null;
    return (ident ? o.ident?.fb === ident.fb : !o.ident && o.ip === ip) ? o : null;
  }
  kick(code, peer) {
    const key = `${code} ${peer}`;
    this.#kicked.delete(key);
    if (this.#kicked.size >= this.limits.maxKicked) this.#kicked.delete(this.#kicked.keys().next().value);
    this.#kicked.set(key, this.now() + this.limits.kickedMs);
  }
  isKicked(code, peer) { return (this.#kicked.get(`${code} ${peer}`) ?? -Infinity) > this.now(); }
  #dropBlob(r, id) {
    this.#blobBytes -= r.blobs.get(id).buf.length; this.#blobCount--;
    r.blobs.delete(id);
  }
  #dropClosed(code) {
    const r = this.#rooms.get(code);
    if (!r || r.closedAt === null) return;
    for (const id of r.blobs.keys()) this.#dropBlob(r, id);
    this.#rooms.delete(code);
  }
  putBlob(code, peer, ident, ip, member, buf) {
    if (!member || this.member(code, peer, ident, ip) !== member) return null;
    if (!buf.length || buf.length > Math.min(this.limits.maxBlobBytes, this.limits.blobBytes)) return null;
    this.sweep();
    const r = this.getRoom(code);
    while (r.blobs.size >= this.limits.blobsPerRoom) this.#dropBlob(r, r.blobs.keys().next().value);
    while (this.#blobBytes + buf.length > this.limits.blobBytes || this.#blobCount >= this.limits.maxBlobs) {
      let old;
      for (const [roomCode, entry] of this.#rooms) for (const [id, b] of entry.blobs) {
        if (!old || b.t < old.t) old = { roomCode, entry, id, t: b.t };
      }
      this.#dropBlob(old.entry, old.id);
      if (!old.entry.blobs.size && old.entry.closedAt !== null) this.#rooms.delete(old.roomCode);
    }
    const id = randomBytes(18).toString('base64url');
    r.blobs.set(id, { buf, t: this.now() }); this.#blobBytes += buf.length; this.#blobCount++;
    return id;
  }
  getBlob(code, peer, ident, ip, id) {
    if (!this.member(code, peer, ident, ip)) return null;
    const r = this.getRoom(code), b = r.blobs.get(id);
    if (!b) return null;
    const t = this.now();
    if (t - b.t >= this.limits.blobIdleMs) { this.#dropBlob(r, id); return null; }
    b.t = t;
    return b.buf;
  }
  sweep() {
    const t = this.now();
    for (const [k, exp] of this.#kicked) if (exp <= t) this.#kicked.delete(k);
    for (const [code, r] of this.#rooms) {
      if (r.closedAt !== null && t - r.closedAt >= this.limits.closedRoomMs) { this.#dropClosed(code); continue; }
      for (const [id, b] of r.blobs) if (t - b.t >= this.limits.blobIdleMs) this.#dropBlob(r, id);
      if (r.closedAt !== null && !r.blobs.size) this.#rooms.delete(code);
    }
  }
  stats() { return { rooms: this.#active, peers: this.#peers, blobs: this.#blobCount, blobBytes: this.#blobBytes }; }
}

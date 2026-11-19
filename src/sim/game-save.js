// Game save format and restoration of the simulation snapshot.
import { makeMap } from './game-shared.js';

// run-length code for small-valued grids (team vision): flat [value, count, value, count, ...]
function rleEncode(g) { const out = []; let i = 0; while (i < g.length) { const v = g[i]; let n = 1; while (i + n < g.length && g[i + n] === v) n++; out.push(v, n); i += n; } return out; }
// compact save helpers (2026-11-13, maps up to 512: a save was ~14 MB): heights as base64 Int16 (x1000),
// plain trees as short arrays IN PLACE in the entity list (the entity order is part of the simulation)
const TREE_KEYS = 'id,kind,type,owner,x,z,rot,hp,maxHp,dead,amount,maxAmount,variant,scale';
function b64FromBytes(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b) { const s = atob(b), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
function packHeights(h) { const a = new Int16Array(h.length); for (let i = 0; i < h.length; i++) a[i] = Math.max(-32768, Math.min(32767, Math.round(h[i] * 1000))); return b64FromBytes(new Uint8Array(a.buffer)); }
function unpackHeights(b, len) { const u8 = bytesFromB64(b), a = new Int16Array(u8.buffer, u8.byteOffset, Math.min(len, u8.length >> 1)), out = new Float32Array(len); for (let i = 0; i < a.length; i++) out[i] = a[i] / 1000; return out; }
const isPlainTree = (e) => e.kind === 'resource' && e.type === 'tree' && Object.keys(e).join(',') === TREE_KEYS;
// the same test on a live entity, ignoring its '_rm' key (what serialize leaves out), without building strings
const TREE_KEY_ARR = TREE_KEYS.split(',');
function plainTreeKeys(e) { let i = 0; for (const k in e) { if (k === '_rm') continue; if (k !== TREE_KEY_ARR[i++]) return false; } return i === TREE_KEY_ARR.length; }
// a value as JSON.stringify + JSON.parse would give it back inside an array (NaN / Infinity / undefined -> null, -0 -> 0)
const jsonVal = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? (v === 0 ? 0 : v) : null) : v === undefined || typeof v === 'function' || typeof v === 'symbol' ? null : v);
const packTree = (e) => [e.id, e.x, e.z, e.rot, e.hp, e.maxHp, e.dead ? 1 : 0, e.amount, e.maxAmount, e.variant, e.scale];
const unpackTree = (a) => ({ id: a[0], kind: 'resource', type: 'tree', owner: -1, x: a[1], z: a[2], rot: a[3], hp: a[4], maxHp: a[5], dead: !!a[6], amount: a[7], maxAmount: a[8], variant: a[9], scale: a[10] });

function rleDecode(a, len) { const g = new Uint8Array(len); if (!Array.isArray(a)) return g; let i = 0; for (let k = 0; k + 1 < a.length && i < len; k += 2) { const v = a[k] | 0, n = a[k + 1] | 0; g.fill(v, i, Math.min(len, i + n)); i += n; } return g; }

export const saveMethods = {
  // ---------- save / load ----------
  serialize() {
    // (speed, 2026-11-15: an autosave froze the game for ~65 ms on a 384 map, mostly ~12k trees copied, packed and
    // sent through the JSON round trip. A plain tree is now packed straight away with JSON's own value rules and kept
    // out of the round trip; the output is byte-for-byte the same.)
    const ents = [], packed = [];
    for (const e of this.entities.values()) {
      if (e.kind === 'resource' && e.type === 'tree' && plainTreeKeys(e)) { packed.push(packTree(e).map(jsonVal)); ents.push(null); continue; }
      const c = {}; for (const k in e) if (k !== '_rm') c[k] = e[k]; ents.push(c); packed.push(null);
    }
    let quests = null; try { quests = this.quests.serialize(); } catch (err) { /* ignore */ }
    const ais = this.ais.map(a => { try { return a.serialize(); } catch (err) { return null; } });
    // A group move order ({path}) is ONE object shared by every unit of the group (one finds the path, the others use
    // it). JSON copies it per unit, so each copy gets the group's number (gid) and _restore joins them again.
    const gids = new Map(), gidOf = g => { if (!g || typeof g !== 'object') return null; if (!gids.has(g)) gids.set(g, gids.size + 1); return gids.get(g); };
    const grpIds = ents.map(e => (e && e.kind === 'unit' ? [gidOf(e.order && e.order.grp), (e.queue || []).map(q => gidOf(q && q.grp))] : null));
    const out = JSON.parse(JSON.stringify({
      v: 1, cfg: this.cfg, time: this.time, tick: this.tick, nextId: this.nextId, rs: this.rs, over: this.over,
      players: this.players.map(p => ({ ...p, techs: [...p.techs], mods: undefined })),
      entities: ents.filter(e => e).map(e => (isPlainTree(e) ? packTree(e) : e)), projectiles: this.projectiles, fogR: rleEncode(this.fog),
      map: { size: this.map.size, h16: packHeights(this.map.heights), tilesR: rleEncode(this.map.tiles), blockedR: rleEncode(this.map.blocked) },
      quests, ais,
      // sim-side timers / state that is not on an entity (needed for an exact multiplayer continue)
      sim: { blkV: this._blkV || 0, fogT: this._fogT, winT: this._winT, expT: this._expT, bankT: this._bankT, lineId: this._lineId, railT: this._railT, railDirty: this._railDirty, railP: this._railP || null, navT: this._navT },
      tv: this._tv ? [...this._tv].map(([team, g]) => [team, rleEncode(g)]) : null,
    }));
    { const rt = out.entities; let j = 0; out.entities = packed.map(p => p || rt[j++]); }   // (the packed trees back in their places)
    out.entities.forEach((e, i) => {
      const g = grpIds[i]; if (!g) return;
      if (g[0] && e.order && e.order.grp) e.order.grp.gid = g[0];
      if (Array.isArray(e.queue)) e.queue.forEach((q, j) => { if (g[1][j] && q && q.grp) q.grp.gid = g[1][j]; });
    });
    return out;
  },
  _restore(s) {
    const N = s.map.size, V = N + 1;
    // (compact saves since 2026-11-13: h16 / tilesR / blockedR / fogR; older saves have plain arrays)
    const heights = s.map.h16 ? unpackHeights(s.map.h16, V * V) : Float32Array.from(s.map.heights);
    const tiles = s.map.tilesR ? rleDecode(s.map.tilesR, N * N) : Uint8Array.from(s.map.tiles);
    const blocked = s.map.blockedR ? rleDecode(s.map.blockedR, N * N) : Uint8Array.from(s.map.blocked);
    this.map = makeMap(N, heights, tiles, blocked);
    this.time = s.time; this.tick = s.tick | 0; this.nextId = s.nextId; this.rs = s.rs; this.over = s.over || null;
    this.fog = s.fogR ? rleDecode(s.fogR, N * N) : Uint8Array.from(s.fog); this._fogSeed = this.fog.slice();
    s.entities = s.entities.map(e => (Array.isArray(e) ? unpackTree(e) : e));
    this.players = s.players.map(p => { const q = { ...p, techs: new Set(p.techs), pending: p.pending || [] }; this._mods(q); return q; });
    // group move orders shared by several units are one object again (see serialize: gid)
    const grps = new Map(), join = g => { if (!g || typeof g !== 'object' || !g.gid) return g; const k = g.gid; delete g.gid; if (!grps.has(k)) grps.set(k, g); return grps.get(k); };
    for (const e of s.entities) {
      this.entities.set(e.id, e);
      if (e.kind === 'unit') {
        if (e.order && e.order.grp) e.order.grp = join(e.order.grp);
        if (Array.isArray(e.queue)) for (const q of e.queue) if (q && q.grp) q.grp = join(q.grp);
      }
      if (e.kind === 'unit') { if (!e.queue) e.queue = []; this.units.push(e); }
      else if (e.kind === 'building') this.buildings.push(e);
      else if (e.type === 'deer') this.deer.push(e);
      else this.resAt[(e.z | 0) * N + (e.x | 0)] = e.id;
    }
    // saves from before 2026-11-14: an unfinished foundation blocked its tiles like a finished building; now it is
    // passable (2) until it is finished (same on every client loading these bytes; no flow field exists yet)
    for (const b of this.buildings) {
      if (b.done || b.dead || b.type === 'farm' || b.type === 'pasture' || b.type === 'rail') continue;
      for (let j = 0; j < b.size; j++) for (let i = 0; i < b.size; i++) {
        const x = b.tx + i, z = b.tz + j; if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const k = z * N + x, v = blocked[k]; if (v === 1 || v >= 10) blocked[k] = 2;
      }
    }
    this.projectiles = s.projectiles || [];
    const sim = s.sim;
    if (sim && typeof sim === 'object') {
      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      if (num(sim.fogT) != null) this._fogT = sim.fogT;
      if (num(sim.winT) != null) this._winT = sim.winT;
      this._blkV = num(sim.blkV) || 0; this._expT = num(sim.expT); this._bankT = num(sim.bankT); this._lineId = num(sim.lineId); this._railT = num(sim.railT); this._navT = num(sim.navT);
      if (Array.isArray(sim.railP)) { this._railP = sim.railP; this._railDirty = sim.railDirty === false ? false : true; }
    }
    if (Array.isArray(s.tv)) {
      this._tv = new Map();
      for (const e of s.tv) if (Array.isArray(e)) this._tv.set(e[0] | 0, rleDecode(e[1], N * N));
      this._fogSeed = null; this._tvRestored = true;
    }
    try { if (!s.entities.some(e => e.type === 'fish')) this._navGenFish(); } catch (err) { console.error('fish gen', err); }
  },
};

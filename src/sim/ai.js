// Aevum AI opponent.
// Plays by the same rules as a human: it only spends what its own villagers / carts / banks / trains
// earned, pays the same costs and waits the same build / train / research times (all of that lives in
// game.js and is identical for every player). It knows its own entities, and about enemy things only
// what its own units and buildings have seen (an explored grid + a "seen" memory, see _vision()).
// Difficulty changes decision quality and tempo only (think interval, villager targets, how tightly it
// follows its plan, counter quality, how often it leaves villagers idle, attack timing / sizes).
import { aiMilitaryMethods } from './ai-military.js';
import { aiBuildOrderMethods } from './ai-build-order.js';
import { aiEconomyMethods } from './ai-economy.js';
import { installMethods } from '../method-table.js';
import { UNITS } from '../data.js';
import { unitLos, buildingLos, forDisc } from './game-shared.js';
import { MIN, RK, MIL_B, d2 } from './ai-shared.js';

const DIFF = {
  easy: {
    think: 2.5, vill: [11, 20, 28, 34, 38], army: [0.15, 0.3, 0.38, 0.45, 0.5], minArmy: [2, 3, 5, 6, 6],
    ageVill: [14, 23, 31, 37], ageDelay: [135, 110, 230, 170], barracksAt: 12,
    raidFrom: 16, pushFrom: 25, raidGap: 300, raidSize: 2, firstPush: 6, pushBase: 8, pushGrow: 3, pushGap: 300,
    counter: 0.25, moves: 1, builds: 1, prodQ: 1, tcQ: 1, prod: [1, 2, 2, 3, 3], tc2Age: 9, carts: 2,
    towers: [0, 1, 1, 2, 2], castle: false, techPar: 1, rescout: 330, idleChance: 0.35, floatMul: 2.2, slack: 0, banks: 1, rails: 1,
    elastic: 0.6, tradeMul: 1.8, armyCap: [6, 16, 28, 40, 50], prodMax: [1, 2, 3, 5, 6], prodQmax: 2, towersX: 1,
    wallFrom: 18, wallSides: 1, wallTowers: 0, wallRmax: 20, wallChunk: 12, wallKeep: 120, wallBuilders: 1, wallGates2: false,
  },
  normal: {
    think: 1.6, vill: [14, 28, 40, 50, 56], army: [0.2, 0.42, 0.52, 0.6, 0.65], minArmy: [2, 4, 6, 8, 10],
    ageVill: [12, 21, 28, 34], ageDelay: [50, 70, 75, 110], barracksAt: 12,
    raidFrom: 10, pushFrom: 18, raidGap: 200, raidSize: 3, firstPush: 7, pushBase: 10, pushGrow: 4, pushGap: 200,
    counter: 0.6, moves: 2, builds: 2, prodQ: 1, tcQ: 1, prod: [1, 2, 3, 4, 5], tc2Age: 2, carts: 4,
    towers: [0, 2, 3, 4, 4], castle: true, techPar: 2, rescout: 240, idleChance: 0.08, floatMul: 1.7, slack: 2, banks: 2, rails: 1,
    elastic: 0.8, tradeMul: 1.3, armyCap: [8, 22, 40, 60, 80], prodMax: [1, 3, 5, 7, 9], prodQmax: 3, towersX: 2,
    wallFrom: 14, wallSides: 3, wallTowers: 2, wallRmax: 24, wallChunk: 16, wallKeep: 60, wallBuilders: 1, wallGates2: true,
  },
  hard: {
    think: 1.0, vill: [17, 33, 46, 60, 72], army: [0.25, 0.5, 0.6, 0.7, 0.8], minArmy: [2, 5, 8, 10, 12],
    ageVill: [10, 18, 24, 30], ageDelay: [0, 0, 0, 0], barracksAt: 12,
    raidFrom: 7, pushFrom: 12, raidGap: 130, raidSize: 4, firstPush: 8, pushBase: 12, pushGrow: 5, pushGap: 120,
    counter: 1, moves: 3, builds: 3, prodQ: 2, tcQ: 2, prod: [1, 3, 4, 6, 7], tc2Age: 1, carts: 7,
    towers: [0, 2, 3, 5, 6], castle: true, techPar: 3, rescout: 180, idleChance: 0, floatMul: 1.5, slack: 3, banks: 3, rails: 2,
    elastic: 1, tradeMul: 1.1, armyCap: [10, 28, 50, 80, 110], prodMax: [1, 4, 6, 9, 12], prodQmax: 4, towersX: 3,
    wallFrom: 12, wallSides: 4, wallTowers: 4, wallRmax: 26, wallChunk: 16, wallKeep: 40, wallBuilders: 1, wallGates2: true,
  },
};

// controller fields that the generic save skips (references, caches handled separately, identity)
const AI_SKIP = new Set(['game', 'd', 'pid', 'playerId', 'mem', 'vis', 'exp', 'vstamp', '_idx', '_idxDirty', '_bound', '_expLoad', 'dbgInfo', 'debug', '_lostAt']);
const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
function nowMs() { try { return performance.now(); } catch (e) { return Date.now(); } }

export class AIController {
  constructor(game, playerId, difficulty) {
    this.game = game;
    this.pid = playerId;
    this.playerId = playerId;
    this.difficulty = DIFF[difficulty] ? difficulty : 'normal';
    this.d = DIFF[this.difficulty];
    this.rs = ((((game && game.cfg && game.cfg.seed) | 0) * 7919 + playerId * 104729 + 17) | 0) || 1;
    this.t = this.rand() * this.d.think;
    this.stats = { thinks: 0, ms: 0, raids: 0, pushes: 0, raidKills: 0 };
    this.errors = {};
    this.mem = new Map();        // enemy id -> what we saw (see _see)
    this.vstamp = 0; this.vis = null; this.exp = null;
    this.groups = [];            // raids and pushes: {kind, ids, initial, phase, tx, tz, targetId, start, kills, razed}
    this.threats = [];           // recent hits on our things
    this.danger = [];            // spots where our villagers died recently
    this.hist = [];              // income history
    this.vinc = { food: 0, wood: 0, gold: 0, stone: 0 }; // what our villagers deposited (events)
    this.assignT = new Map();    // villager id -> time of last reassignment
    this.failPlace = {};
    this.scoutId = null; this.scoutPts = null; this.scoutI = 0; this.nextScout = 0; this.scoutRuns = 0;
    this.nextRaid = this.d.raidFrom * MIN; this.nextPush = this.d.pushFrom * MIN; this.pushN = 0;
    this.lostVil = 0; this.trades = 0;
    this.lost = [];              // own buildings the enemy destroyed: {x, z, t, r} (see _lostNear)
    this._bound = false;
  }

  rand() { let t = (this.rs = (this.rs + 0x6D2B79F5) | 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

  _bind() {
    if (this._bound) return;
    const ev = this.game.events;
    if (!ev || !ev.on) return;
    this._bound = true;
    ev.on('attack', (p) => {
      try {
        if (p && p.attacker && p.target && p.attacker.owner === this.pid && p.target.kind === 'building' && this.foe(p.target.owner)) { this._bldHitT = this.game.time; return; }
        if (!p || !p.target || !p.attacker || p.target.owner !== this.pid || !this.foe(p.attacker.owner)) return;
        const a = p.attacker;
        this.threats.push({ x: p.target.x, z: p.target.z, t: this.game.time, aid: a.id, vil: p.target.type === 'villager' });
        if (this.threats.length > 60) this.threats.splice(0, this.threats.length - 60);
        this._see(a); // whoever hits us is visible to the victim
      } catch (e) { /* ignore */ }
    });
    ev.on('deposit', (p) => {
      try { if (p && p.owner === this.pid && p.unit && p.unit.type === 'villager' && this.vinc[p.res] != null) this.vinc[p.res] += p.amount || 0; } catch (e) { /* ignore */ }
    });
    ev.on('death', (p) => {
      try {
        const e = p && p.e; if (!e) return;
        const k = p.killer;
        if (e.owner === this.pid) {
          if (e.kind === 'building' && k && k.owner >= 0 && this.foe(k.owner)) { (this.lost || (this.lost = [])).push({ x: e.x, z: e.z, t: this.game.time, r: (e.size || 1) / 2 }); if (this.lost.length > 40) this.lost.shift(); }
          if (e.type === 'villager') { this.lostVil++; this.danger.push({ x: e.x, z: e.z, t: this.game.time }); if (this.danger.length > 20) this.danger.shift(); }
          return;
        }
        if (k && k.owner === this.pid) {
          this.mem.delete(e.id);
          for (const gr of this.groups) if (gr.ids.indexOf(k.id) >= 0) { gr.kills++; gr.lastHit = this.game.time; if (e.kind === 'building') gr.razed++; if (gr.kind === 'raid') this.stats.raidKills++; if (gr.targetId === e.id) gr.hitTarget = true; }
        }
      } catch (e2) { /* ignore */ }
    });
  }

  update(dt) {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = this.d.think;
    try { this._bind(); this.think(); } catch (e) { this._err('think', e); }
  }

  // probe-only snapshot of the decision state (enabled with ai.debug = true)
  _dbg(c) {
    const prods = c.blds.filter(b => b.done && MIL_B.includes(b.type));
    const R = {}; for (const k of RK) if (c.reserve[k]) R[k] = Math.round(c.reserve[k]);
    const shop = {}; for (const k of RK) if (c.shop && c.shop[k]) shop[k] = Math.round(c.shop[k]);
    const r = this.safe(() => this.game.canAgeUp(this.pid));
    this.dbgInfo = {
      phase: c.phase, vills: c.vills.length, villCap: c.villCap, mil: c.mil.length, armyT: c.armyTarget, minDef: c.minDef, floatBoost: c.floatBoost || 0, threatened: !!c.threatened,
      prod: prods.length, prodIdle: prods.filter(b => !(b.queue || []).length).length, q: prods.map(b => (b.queue || []).length).join(''),
      tcs: c.tcs.length, tcQ: c.tcs.map(b => (b.queue || []).length).join(''), reserve: R, shop, age: r ? (r.ok ? 'ok' : r.reason) : '-', blocked: (c.blockedBy || []).slice(0, 4).join(','),
      types: c.types ? c.types.size : 0, pendingB: c.pendingB, groups: this.groups.map(g => g.kind[0] + g.ids.length + g.phase[0]).join(' '),
      techs: c.me.techs.size, pending: (c.me.pending || []).length, extra: c.dbgExtra || '',
    };
  }

  _err(step, e) { if (!this.errors[step]) this.errors[step] = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }

  // ---------- helpers ----------
  me() { return this.game.players[this.pid]; }
  alive(id) { const e = id != null ? this.game.getEntity(id) : null; return e && !e.dead ? e : null; }
  // an enemy entity we may act on: a building we remember (a human can click its ghost), or a unit we see now
  // team-aware hostility: allies (same team) are never targets, never remembered as threats
  foe(owner) { const g = this.game; if (!(owner >= 0) || owner === this.pid) return false; return typeof g.isEnemy === 'function' ? g.isEnemy(this.pid, owner) : true; }
  seenEnt(id) { const e = this.alive(id); if (!e || !this.foe(e.owner)) return e; if (e.kind === 'building') return this.mem.has(id) ? e : null; return this.visible(e.x, e.z) ? e : null; }
  safe(fn) { try { return fn(); } catch (e) { return null; } }
  unlocked(kind, id) { return !!this.safe(() => this.game.isUnlocked(this.pid, kind, id)); }
  isMil(u) { const d = UNITS[u.type]; return !!d && d.cls !== 'civil' && d.cls !== 'train' && !d.naval && !u.aboard && !u.train; }
  countB(c, type, onlyDone) { let n = 0; for (const b of c.blds) if (b.type === type && (!onlyDone || b.done)) n++; return n; }
  minutes() { return this.game.time / MIN; }
  enemyPlayers() { return this.game.players.filter(p => this.foe(p.id) && !p.defeated); }
  tile(x, z) { const N = this.game.map.size; return Math.min(N - 1, Math.max(0, z | 0)) * N + Math.min(N - 1, Math.max(0, x | 0)); }
  visible(x, z) { return !!this.vis && this.vis[this.tile(x, z)] === this.vstamp; }
  explored(x, z) { return !!this.exp && this.exp[this.tile(x, z)] === 1; }

  think() {
    const g = this.game, me = this.me();
    if (!me || me.defeated || g.over) return;
    const t0 = nowMs();
    const c = this._ctx();
    const steps = ['_vision', '_income', '_plan', '_economy', '_spend', '_walls', 'camps', 'market', '_navAI', '_railAI', '_scout', '_defend', '_groupsUpdate', '_raidPlanner', '_pushPlanner', '_poolTidy'];
    for (const s of steps) { try { this[s](c); } catch (e) { this._err(s, e); } }
    if (this.debug) { try { this._dbg(c); } catch (e) { this._err('dbg', e); } }
    this.stats.thinks++; this.stats.ms += nowMs() - t0;
  }

  _ctx() {
    const g = this.game, me = this.me();
    const units = g.unitsOf(this.pid);
    const blds = g.buildingsOf(this.pid);
    const vills = units.filter(u => u.type === 'villager' && !u.aboard);
    const mil = units.filter(u => this.isMil(u));
    const tcs = blds.filter(b => b.type === 'towncenter');
    const tc = tcs.find(b => b.done) || tcs[0] || null;
    const home = tc ? { x: tc.x, z: tc.z } : (blds[0] ? { x: blds[0].x, z: blds[0].z } : { x: me.startX, z: me.startZ });
    const inGroup = new Set(); for (const gr of this.groups) for (const id of gr.ids) inGroup.add(id);
    const pool = mil.filter(u => !inGroup.has(u.id) && u.id !== this.scoutId);
    const c = { g, me, units, blds, vills, mil, tcs, tc, home, inGroup, pool, reserve: { food: 0, wood: 0, gold: 0, stone: 0 }, placed: 0 };
    // direction to the enemy (known base, else the map centre)
    const eb = this.enemyBase();
    const N = g.map.size, tx = eb ? eb.x : N / 2, tz = eb ? eb.z : N / 2;
    const L = Math.hypot(tx - home.x, tz - home.z) || 1;
    c.edir = { x: (tx - home.x) / L, z: (tz - home.z) / L };
    c.rally = this._freeish(home.x + c.edir.x * 8, home.z + c.edir.z * 8);
    return c;
  }
  _freeish(x, z) { const N = this.game.map.size; return { x: Math.min(N - 3, Math.max(3, x)), z: Math.min(N - 3, Math.max(3, z)) }; }

  // ---------- vision: explored grid + memory of seen enemy things ----------
  _vision(c) {
    const g = this.game, N = g.map.size;
    if (!this.vis || this.vis.length !== N * N) this.vis = new Int32Array(N * N);
    if (!this.exp || this.exp.length !== N * N) { this.exp = new Uint8Array(N * N); if (this._expLoad) { this._applyExp(this._expLoad); this._expLoad = null; } }
    const st = ++this.vstamp, vis = this.vis, exp = this.exp;
    // (the same sight as the fog: soldiers see past the longest weapon range, an unfinished foundation sees nothing)
    const span = (a, b) => { vis.fill(st, a, b); exp.fill(1, a, b); };
    for (const u of c.units) if (!u.aboard) forDisc(N, u.x, u.z, unitLos(u.type), span);
    for (const b of c.blds) if (b.done) forDisc(N, b.x, b.z, buildingLos(b, c.me), span);
    for (const u of g.units) {
      if (u.dead || !this.foe(u.owner) || u.aboard || u.train) continue;
      if (vis[this.tile(u.x, u.z)] === st) this._see(u);
    }
    for (const b of g.buildings) {
      if (b.dead || !this.foe(b.owner)) continue;
      if (vis[this.tile(b.x, b.z)] === st) this._see(b);
    }
    const now = g.time;
    { // coarse 12x12 cells: when did we last see the middle of each (for hunting the last enemy remains)
      const CS = 12, CN = Math.ceil(N / CS);
      if (!this.cellSeen || this.cellSeen.length !== CN * CN) this.cellSeen = new Float32Array(CN * CN).fill(-1e4);
      for (let cz = 0; cz < CN; cz++) for (let cx = 0; cx < CN; cx++) { const x = Math.min(N - 1, cx * CS + CS / 2) | 0, z = Math.min(N - 1, cz * CS + CS / 2) | 0; if (vis[z * N + x] === st) this.cellSeen[cz * CN + cx] = now; }
    }
    for (const [id, m] of this.mem) {
      if (m.st === st) continue;
      if (m.kind === 'building') { if (vis[this.tile(m.x, m.z)] === st) this.mem.delete(id); }
      else if (now - m.t > 240) this.mem.delete(id);
      else if (vis[this.tile(m.x, m.z)] === st) m.gone = true;
    }
  }
  _see(e) {
    const ud = e.kind === 'unit' ? UNITS[e.type] : null;
    let m = this.mem.get(e.id);
    if (!m) { m = { id: e.id, kind: e.kind, type: e.type, owner: e.owner }; this.mem.set(e.id, m); }
    m.x = e.x; m.z = e.z; m.t = this.game.time; m.st = this.vstamp; m.hp = e.hp; m.maxHp = e.maxHp; m.gone = false;
    if (e.kind === 'building') { m.done = !!e.done; m.size = e.size; }
    else { m.cls = ud ? ud.cls : 'civil'; m.mil = !!ud && ud.cls !== 'civil' && ud.atk > 0; m.naval = !!e.naval; }
  }
  enemyBase() {
    let best = null, bd = Infinity;
    const me = this.me();
    const hx = this._homeX != null ? this._homeX : me.startX, hz = this._homeZ != null ? this._homeZ : me.startZ;
    for (const m of this.mem.values()) if (m.kind === 'building' && m.type === 'towncenter') { const dd = d2(m.x, m.z, hx, hz); if (dd < bd) { bd = dd; best = m; } }
    if (best) return { x: best.x, z: best.z, tc: best };
    let n = 0, sx = 0, sz = 0;
    for (const m of this.mem.values()) if (m.kind === 'building' && m.type !== 'wall' && m.type !== 'rail') { n++; sx += m.x; sz += m.z; }
    return n ? { x: sx / n, z: sz / n, tc: null } : null;
  }
  enemyArmySeen(window = 150, near = null, r = 0) {
    const now = this.game.time, cls = { infantry: 0, ranged: 0, cavalry: 0, siege: 0 }; let n = 0;
    for (const m of this.mem.values()) if (m.kind === 'unit' && m.mil && !m.naval && now - m.t < window && cls[m.cls] != null && (!near || d2(m.x, m.z, near.x, near.z) < r * r)) { cls[m.cls]++; n++; }
    let towers = 0; for (const m of this.mem.values()) if (m.kind === 'building' && (m.type === 'tower' || m.type === 'castle')) towers++;
    return { cls, n, towers };
  }

  // ---------- persistence ----------
  _expRLE() {
    if (!this.exp) return null;
    const out = []; let cur = 0, run = 0;
    for (let i = 0; i < this.exp.length; i++) { const v = this.exp[i]; if (v === cur) run++; else { out.push(run); cur = v; run = 1; } }
    out.push(run); return out;
  }
  _applyExp(rle) {
    if (!Array.isArray(rle) || !this.exp) return;
    let i = 0, v = 0;
    for (const n of rle) { for (let k = 0; k < n && i < this.exp.length; k++) this.exp[i++] = v; v ^= 1; }
  }
  serialize() {
    const mem = [];
    for (const m of this.mem.values()) mem.push({ ...m });
    return {
      v: 2, difficulty: this.difficulty, rs: this.rs, stats: { ...this.stats },
      groups: this.groups.map(gr => ({ ...gr, ids: gr.ids.slice() })),
      mem, exp: this._expRLE(), vstamp: this.vstamp,
      scoutId: this.scoutId, scoutPts: this.scoutPts, scoutI: this.scoutI, nextScout: this.nextScout, scoutRuns: this.scoutRuns, scoutBase: !!this.scoutBase,
      nextRaid: this.nextRaid, nextPush: this.nextPush, pushN: this.pushN, lostVil: this.lostVil, trades: this.trades,
      vinc: { ...this.vinc }, affT: this._affT, affAge: this._affAge,
      // v2 extras (exact continue of a multiplayer save): every other field of the controller, encoded generically
      x: this._extraState(), bound: !!this._bound,
      visM: this.vis ? this._visMaskRLE() : null,
      idx: this._idx ? { t: this._idx.t, dirty: !!this._idxDirty, l: Object.fromEntries(Object.entries(this._idx).filter(([k, v]) => Array.isArray(v)).map(([k, v]) => [k, v.map(e => e.id)])) } : null,
      memSt: [...this.mem.values()].map(m => m.st),
    };
  }

  // ----- generic (de)serialization of the remaining controller fields -----
  _extraState() {
    const skip = AI_SKIP, out = {};
    for (const k of Object.keys(this)) { if (skip.has(k)) continue; const v = this._enc(this[k], 0); if (v !== undefined) out[k] = v; }
    return out;
  }
  _enc(v, depth) {
    if (depth > 8) return undefined;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { __n: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Inf' : '-Inf' };
    if (typeof v !== 'object') return undefined;
    if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, a: Array.from(v, x => (Number.isFinite(x) ? x : 0)) };
    if (v instanceof Map) return { __m: [...v].map(([a, b]) => [this._enc(a, depth + 1), this._enc(b, depth + 1)]) };
    if (v instanceof Set) return { __s: [...v].map(a => this._enc(a, depth + 1)) };
    if (Array.isArray(v)) return v.map(a => { const r = this._enc(a, depth + 1); return r === undefined ? null : r; });
    const ents = this.game && this.game.entities;
    if (ents && v.id != null && v.kind && ents.get(v.id) === v) return { __e: v.id };
    const o = {}; for (const k of Object.keys(v)) { const r = this._enc(v[k], depth + 1); if (r !== undefined) o[k] = r; }
    return o;
  }
  _dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(a => this._dec(a));
    if (v.__n) return v.__n === 'NaN' ? NaN : v.__n === 'Inf' ? Infinity : -Infinity;
    if (v.__ta) { const C = TYPED[v.__ta]; return C ? C.from(v.a || []) : Array.from(v.a || []); }
    if (v.__m) return new Map(v.__m.map(([a, b]) => [this._dec(a), this._dec(b)]));
    if (v.__s) return new Set(v.__s.map(a => this._dec(a)));
    if (v.__e != null && Object.keys(v).length === 1) { const e = this.game.entities.get(v.__e); return e || null; }
    const o = {}; for (const k of Object.keys(v)) o[k] = this._dec(v[k]); return o;
  }
  // tiles seen at the last think (vis[i] === vstamp), as alternating run lengths starting with "not seen"
  _visMaskRLE() { const out = [], vis = this.vis, st = this.vstamp; let cur = 0, n = 0; for (let i = 0; i < vis.length; i++) { const b = vis[i] === st ? 1 : 0; if (b === cur) n++; else { out.push(n); cur = b; n = 1; } } out.push(n); return out; }

  load(o) {
    if (!o || typeof o !== 'object') return;
    try {
      if (o.v !== 2) {
        // saves from the old AI: keep what maps over, the rest starts fresh
        if (typeof o.waveCount === 'number') this.pushN = o.waveCount;
        if (typeof o.nextWave === 'number') this.nextPush = Math.max(this.nextPush, o.nextWave);
        if (o.wave && Array.isArray(o.wave.ids) && o.wave.ids.length) this.groups.push({ kind: 'push', ids: o.wave.ids.slice(), initial: o.wave.initial || o.wave.ids.length, phase: 'fight', tx: 0, tz: 0, targetId: o.wave.targetId != null ? o.wave.targetId : null, start: o.wave.start || this.game.time, phaseT: this.game.time, kills: 0, razed: 0 });
        this.scoutId = o.scoutId != null ? o.scoutId : null;
        if (this.scoutId != null) this.scoutId = null; // re-pick with a fresh route
        return;
      }
      if (typeof o.rs === 'number') this.rs = o.rs | 0 || 1;
      if (o.stats) Object.assign(this.stats, o.stats);
      this.groups = Array.isArray(o.groups) ? o.groups.filter(gr => gr && Array.isArray(gr.ids)).map(gr => ({ ...gr, ids: gr.ids.slice() })) : [];
      this.mem = new Map();
      if (Array.isArray(o.mem)) for (const m of o.mem) if (m && m.id != null) this.mem.set(m.id, { ...m, st: -1 });
      this.vstamp = (o.vstamp | 0) + 1;
      if (Array.isArray(o.exp)) this._expLoad = o.exp;
      this.scoutId = o.scoutId != null ? o.scoutId : null; this.scoutPts = Array.isArray(o.scoutPts) ? o.scoutPts : null; this.scoutI = o.scoutI | 0;
      if (this.scoutId != null && !this.scoutPts) this.scoutId = null;
      this.nextScout = +o.nextScout || 0; this.scoutRuns = o.scoutRuns | 0; this.scoutBase = !!o.scoutBase;
      if (typeof o.nextRaid === 'number') this.nextRaid = o.nextRaid;
      if (typeof o.nextPush === 'number') this.nextPush = o.nextPush;
      this.pushN = o.pushN | 0; this.lostVil = o.lostVil | 0; this.trades = o.trades | 0;
      if (o.vinc) for (const r of RK) this.vinc[r] = +o.vinc[r] || 0;
      if (typeof o.affT === 'number') this._affT = o.affT; if (typeof o.affAge === 'number') this._affAge = o.affAge;
      if (o.x && typeof o.x === 'object') this._loadExact(o);
    } catch (e) { /* never throw on load */ }
  }
  // newer saves carry the whole controller: restore it exactly (think timer, vision stamps, caches, histories)
  _loadExact(o) {
    for (const k of Object.keys(o.x)) { if (AI_SKIP.has(k)) continue; try { this[k] = this._dec(o.x[k]); } catch (e) { /* keep default */ } }
    this.d = DIFF[this.difficulty] || this.d;
    this.vstamp = o.vstamp | 0;
    const mem = [...this.mem.values()];
    if (Array.isArray(o.memSt)) mem.forEach((m, i) => { m.st = o.memSt[i] != null ? o.memSt[i] : -1; });
    const N = this.game.map.size;
    if (Array.isArray(o.exp)) { this.exp = new Uint8Array(N * N); this._applyExp(o.exp); this._expLoad = null; }
    if (Array.isArray(o.visM)) {
      this.vis = new Int32Array(N * N); let i = 0, v = 0;
      for (const n of o.visM) { if (v) this.vis.fill(this.vstamp, i, Math.min(N * N, i + n)); i += n; v ^= 1; }
    }
    if (o.idx && o.idx.l) {
      const idx = { t: o.idx.t };
      for (const k of Object.keys(o.idx.l)) idx[k] = (o.idx.l[k] || []).map(id => this.game.entities.get(id) || { id, kind: 'resource', dead: true, amount: 0 }); // a tile felled since the index was built stays as a dead entry, like in the running game
      this._idx = idx; this._idxDirty = !!o.idx.dirty;
    }
    if (o.bound) { this._bound = false; this._bind(); }
  }
}

installMethods(AIController.prototype, aiEconomyMethods, aiBuildOrderMethods, aiMilitaryMethods);

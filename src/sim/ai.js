// Aevum AI opponent.
import { aiBuildOrderMethods } from './ai-build-order.js';
import { aiEconomyMethods } from './ai-economy.js';
import { installMethods } from '../method-table.js';
// Plays by the same rules as a human: it only spends what its own villagers / carts / banks / trains
// earned, pays the same costs and waits the same build / train / research times (all of that lives in
// game.js and is identical for every player). It knows its own entities, and about enemy things only
// what its own units and buildings have seen (an explored grid + a "seen" memory, see _vision()).
// Difficulty changes decision quality and tempo only (think interval, villager targets, how tightly it
// follows its plan, counter quality, how often it leaves villagers idle, attack timing / sizes).
import { UNITS } from '../data.js';
import { unitLos, buildingLos, forDisc } from './game-shared.js';
import { MIN, RK, MIL_B, d2, costSum } from './ai-shared.js';

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

let BREACH_BUF = null;   // scratch field for _breach (fully rewritten by every sweep; never part of the AI state)
// a push hunting the last enemy remains goes home only after this many seconds without a kill or a hit on a building;
// each hunt point gets the walk there (x1.5) plus HUNT_SLACK s before the next one is picked
const HUNT_GIVEUP = 600, HUNT_SLACK = 25;
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

  // ---------- scouting ----------
  _scoutRoute(c) {
    const g = this.game, me = c.me, N = g.map.size, h = c.home, pts = [];
    const eb = this.enemyBase();
    if (!eb) {
      if (this.scoutRuns === 0) for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.6; pts.push(this._freeish(h.x + Math.cos(a) * 16, h.z + Math.sin(a) * 16)); }
      // the four possible start corners of this map layout, nearest first
      const corners = [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]].map(f => ({ x: f[0] * N, z: f[1] * N })).filter(p => d2(p.x, p.z, me.startX, me.startZ) > 20 * 20);
      corners.sort((a, b) => d2(a.x, a.z, h.x, h.z) - d2(b.x, b.z, h.x, h.z));
      for (const p of corners) pts.push(this._freeish(p.x + (h.x - p.x) * 0.15, p.z + (h.z - p.z) * 0.15));
      pts.push(this._freeish(N / 2, N / 2));
    } else {
      const a0 = Math.atan2(h.z - eb.z, h.x - eb.x);
      for (let k = -2; k <= 2; k++) { const a = a0 + k * 0.75; pts.push(this._freeish(eb.x + Math.cos(a) * 19, eb.z + Math.sin(a) * 19)); }
      pts.push(this._freeish((eb.x + h.x) / 2, (eb.z + h.z) / 2));
    }
    pts.push({ x: c.rally.x, z: c.rally.z, home: true });
    return pts;
  }
  _scout(c) {
    const g = this.game, now = g.time;
    if (now < (this.difficulty === 'hard' ? 15 : this.difficulty === 'normal' ? 35 : 60)) return;
    let s = this.alive(this.scoutId);
    if (!s || s.owner !== this.pid) {
      this.scoutId = null;
      if (now < this.nextScout) return;
      const cand = c.pool.slice().sort((a, b) => (UNITS[b.type].speed || 0) - (UNITS[a.type].speed || 0) || (UNITS[a.type].cost.gold || 0) - (UNITS[b.type].cost.gold || 0))[0];
      // a villager scouts only until the enemy is found and only if there is no soldier at all (the old scout fix)
      const vil = !cand && !this.enemyBase() && c.vills.length > 7 && now > 90 ? c.vills[c.vills.length - 1] : null;
      s = cand || vil;
      if (!s) return;
      this.scoutId = s.id; this.scoutPts = this._scoutRoute(c); this.scoutI = 0; this.scoutBase = !!this.enemyBase();
      c.pool = c.pool.filter(u => u.id !== s.id);
    }
    if (s.type === 'villager' && this.enemyBase()) { g.cmdMove([s.id], c.home.x + 2, c.home.z + 3); this._endScout(); return; }
    // found the enemy during a blind route: switch to a ring around their base
    if (!this.scoutBase && this.enemyBase()) { this.scoutPts = this._scoutRoute(c); this.scoutI = 0; this.scoutBase = true; }
    if (s.hp < s.maxHp * 0.45 && !(this.scoutPts[this.scoutI] || {}).home) { this.scoutI = this.scoutPts.length - 1; }
    let p = this.scoutPts[this.scoutI];
    if (!p) { this._endScout(); return; }
    const o = s.order;
    if (d2(s.x, s.z, p.x, p.z) < 3.5 * 3.5 || (!o && this._scoutLast === this.scoutI && now - (this._scoutLastT || 0) > 6)) {
      this.scoutI++; p = this.scoutPts[this.scoutI];
      if (!p) { this._endScout(); return; }
    }
    if (!o || o.type !== 'move' || d2(o.x, o.z, p.x, p.z) > 4 * 4) { g.cmdMove([s.id], p.x, p.z); this._scoutLast = this.scoutI; this._scoutLastT = now; }
  }
  _endScout() { this.scoutId = null; this.scoutPts = null; this.scoutRuns++; this.nextScout = this.game.time + this.d.rescout; }

  // ---------- defence ----------
  _defend(c) {
    const g = this.game, now = g.time;
    this.threats = this.threats.filter(t => now - t.t < 8);
    const H = c.home;
    const nearBase = (x, z) => { if (d2(x, z, H.x, H.z) < 26 * 26) return true; for (const b of c.blds) if (d2(x, z, b.x, b.z) < 12 * 12) return true; return false; };
    const foes = [];
    for (const m of this.mem.values()) if (m.kind === 'unit' && m.st === this.vstamp && !m.naval && (m.mil || m.type === 'villager' && false) && nearBase(m.x, m.z)) foes.push(m);
    const hits = this.threats.filter(t => nearBase(t.x, t.z));
    this._baseThreat = foes.length > 0 || hits.length > 0;
    if (!this._baseThreat) { this._defending = false; return; }
    this._defending = true;
    // focus: the enemy closest to whatever it is hitting, else closest to the town center
    let focus = null, fd = Infinity;
    const ref = hits.length ? hits[hits.length - 1] : H;
    for (const m of foes) { const dd = d2(m.x, m.z, ref.x, ref.z); if (dd < fd) { fd = dd; focus = m; } }
    if (!focus && hits.length) { const a = this.mem.get(hits[hits.length - 1].aid); if (a && a.kind === 'unit') focus = a; }
    if (!focus) return;
    const big = foes.length;
    // nearby army responds; the whole pool for a real attack. Nobody chases past the base (leash).
    const leash = (x, z) => d2(x, z, H.x, H.z) > 34 * 34 && !c.blds.some(b => d2(x, z, b.x, b.z) < 14 * 14);
    const back = [];
    const responders = c.pool.filter(u => { if (leash(u.x, u.z)) { if (u.order && u.order.type === 'attack') back.push(u.id); return false; } return big >= 3 || d2(u.x, u.z, focus.x, focus.z) < 30 * 30; });
    if (back.length) this.game.cmdMove(back, c.rally.x, c.rally.z);
    if (!nearBase(focus.x, focus.z)) return;
    this._fight(responders, focus, 10);
    // recall raids if the threat is big; recall the push if it is bigger than what is home
    if (big >= 3 && big > c.pool.length) for (const gr of this.groups) if (gr.kind === 'raid' && gr.phase !== 'back') this._retreat(gr, c);
    if (big >= 6 && big > c.pool.length * 1.5) for (const gr of this.groups) if (gr.kind === 'push' && gr.phase !== 'back') { this._retreat(gr, c, true); this._fight(gr.ids.map(id => this.alive(id)).filter(Boolean), focus, 10); }
  }

  // send units at the nearest visible enemy around them, else at focus (memory or entity), no repeated orders
  _fight(units, focus, extra = 6, preferVil = false) {
    const g = this.game;
    const moveIds = [];
    for (const u of units) {
      if (!u || u.dead) continue;
      const d = UNITS[u.type]; if (!d || d.atk <= 0) continue;
      const o = u.order;
      const cur = o && o.type === 'attack' ? g.getEntity(o.targetId) : null;
      if (cur && !cur.dead && cur.kind === 'unit' && d2(cur.x, cur.z, u.x, u.z) < 12 * 12) continue; // already fighting a unit nearby
      const siege = d.cls === 'siege';
      let tgt = null;
      if (u.type !== 'ram') tgt = this._nearEnemyUnit(u, Math.min(10, (d.range || 0) + extra), preferVil, siege);
      if (!tgt && siege) tgt = this._nearEnemyBuilding(u, 12, focus);
      if (!tgt && focus) {
        const fe = this.seenEnt(focus.id);
        if (fe && this.foe(fe.owner) && !(u.type === 'ram' && fe.kind !== 'building') && !(fe.naval && !(d.range > 0))) tgt = fe;
        else if (!fe || fe.dead) { if (!o || o.type !== 'move' || d2(o.x, o.z, focus.x, focus.z) > 16) moveIds.push(u.id); continue; }
      }
      if (!tgt) continue;
      if (o && o.type === 'attack' && o.targetId === tgt.id) continue;
      // focus fire: everyone on the push's building; otherwise keep hitting the building we are on
      if (cur && !cur.dead && cur.kind === 'building' && tgt.kind === 'building' && !siege && !(focus && focus.id === tgt.id)) continue;
      g.cmdAttack([u.id], tgt.id);
    }
    if (moveIds.length && focus) g.cmdMove(moveIds, focus.x, focus.z);
  }
  _nearEnemyUnit(u, r, preferVil, siege) {
    const g = this.game, melee = !(UNITS[u.type].range > 0);
    let best = null, bs = Infinity;
    g._near(u.x, u.z, r, e => {
      if (e.dead || !this.foe(e.owner) || e.aboard || e.train) return;
      if (!this.visible(e.x, e.z)) return; // only what our units / buildings see now
      if (melee && e.naval) return;
      const dd = d2(e.x, e.z, u.x, u.z); if (dd > r * r) return;
      const ed = UNITS[e.type];
      let s = dd;
      if (ed.cls === 'civil') s *= preferVil ? 0.5 : 2.2;
      if (ed.atk <= 0 && ed.cls !== 'civil') s *= 3;
      if (siege && ed.cls !== 'siege') s *= 1.5;
      if (s < bs) { bs = s; best = e; }
    });
    return best;
  }
  _nearEnemyBuilding(u, r, focus) {
    if (focus && focus.kind === 'building') { const fe = this.seenEnt(focus.id); if (fe) return fe; }
    let best = null, bd = r * r;
    for (const m of this.mem.values()) { if (m.kind !== 'building' || m.type === 'wall' || m.type === 'rail') continue; const dd = d2(m.x, m.z, u.x, u.z); if (dd < bd) { const e = this.seenEnt(m.id); if (e) { bd = dd; best = e; } } }
    return best;
  }

  // ---------- raids and pushes ----------
  _raidTarget(from, ranged) {
    const now = this.game.time, eb = this.enemyBase();
    const guarded = (x, z) => {
      for (const m of this.mem.values()) {
        if (m.kind === 'building' && (m.type === 'tower' || m.type === 'castle' || m.type === 'towncenter') && d2(m.x, m.z, x, z) < 10 * 10) return true;
        if (m.kind === 'unit' && m.mil && now - m.t < 40 && d2(m.x, m.z, x, z) < 10 * 10) return true;
      }
      return false;
    };
    let best = null, bs = Infinity;
    for (const m of this.mem.values()) {
      let val = 0;
      if (m.kind === 'unit' && m.type === 'villager' && now - m.t < 60) val = 10;
      else if (m.kind === 'unit' && m.type === 'tradecart' && now - m.t < 60) val = 12;
      else if (m.kind === 'unit' && m.type === 'fishboat' && ranged && now - m.t < 60) val = 6;
      else if (m.kind === 'building' && !m.done && m.type !== 'wall' && m.type !== 'rail') val = 7;
      if (!val) continue;
      if (eb && eb.tc && d2(m.x, m.z, eb.x, eb.z) < 12 * 12) continue;
      if (guarded(m.x, m.z)) continue;
      let cl = 0; for (const o of this.mem.values()) if (o.kind === 'unit' && o.type === 'villager' && now - o.t < 60 && d2(o.x, o.z, m.x, m.z) < 36) cl++;
      const s = Math.sqrt(d2(m.x, m.z, from.x, from.z)) * 0.3 - val * 3 - cl * 6;
      if (s < bs) { bs = s; best = m; }
    }
    if (best) return best;
    // nothing seen: go and look at an enemy resource site we know (camps / mill)
    for (const m of this.mem.values()) if (m.kind === 'building' && (m.type === 'lumbercamp' || m.type === 'minecamp' || m.type === 'mill' || m.type === 'dock') && !guarded(m.x, m.z)) return { x: m.x, z: m.z, id: null, site: true };
    return null;
  }

  _raidPlanner(c) {
    const g = this.game, d = this.d, now = g.time;
    if (now < this.nextRaid || this._baseThreat) return;
    if (this.groups.some(gr => gr.kind === 'raid')) return;
    const size = Math.min(d.raidSize, c.age === 0 ? 3 : d.raidSize);
    const keep = 2;
    if (c.pool.length < size + keep) { this.nextRaid = now + 20; return; }
    const cand = c.pool.filter(u => UNITS[u.type].cls !== 'siege').sort((a, b) => this._raidScore(b) - this._raidScore(a)).slice(0, size);
    if (cand.length < 2) { this.nextRaid = now + 20; return; }
    const ranged = cand.some(u => UNITS[u.type].range > 0);
    const t = this._raidTarget(c.home, ranged);
    if (!t) { this.nextRaid = now + 30; return; }
    const gr = { kind: 'raid', ids: cand.map(u => u.id), initial: cand.length, phase: 'go', tx: t.x, tz: t.z, targetId: t.id != null ? t.id : null, start: now, kills: 0, razed: 0 };
    this.groups.push(gr);
    this.stats.raids++; if (this.stats.firstRaid == null) this.stats.firstRaid = now;
    this.nextRaid = now + d.raidGap * (0.8 + this.rand() * 0.4);
    g.cmdMove(gr.ids, t.x, t.z);
  }
  _raidScore(u) { const d = UNITS[u.type]; return d.speed * 2 + (d.range > 0 ? 2 : 0) + (d.cls === 'cavalry' ? 2 : 0) + u.hp / u.maxHp; }

  _pushPlanner(c) {
    const g = this.game, d = this.d, now = g.time;
    const live = this.groups.find(gr => gr.kind === 'push');
    if (live) { this._reinforce(c, live); return; }
    if (now < this.nextPush || this._baseThreat) return;
    const pool = c.pool;
    const first = this.pushN === 0;
    const size = first ? d.firstPush : d.pushBase + d.pushGrow * (this.pushN - 1);
    const late = now > d.pushFrom * MIN + 240 && pool.length >= Math.max(4, size * 0.6);
    if (pool.length < size && !late) return;
    if (!first && c.mil.length < c.armyTarget * 0.75 && pool.length < size * 1.3 && !late) return;
    // better players only push with an edge over the enemy army they have seen (plus its towers);
    // weaker ones go anyway. After 3 minutes of waiting they go regardless (the enemy keeps growing too).
    if (d.counter >= 0.6) {
      const pow = t => { const u = UNITS[t]; return u ? costSum(u.cost) : 60; };
      let mine = 0; for (const u of pool) mine += pow(u.type);
      let theirs = 0; for (const m of this.mem.values()) { if (m.kind === 'unit' && m.mil && !m.naval && !m.gone && now - m.t < 180) theirs += pow(m.type); else if (m.kind === 'building' && (m.type === 'tower' || m.type === 'castle')) theirs += m.type === 'castle' ? 600 : 180; }
      const edge = 1 + 0.4 * d.counter;
      if (mine < theirs * edge) { if (this._edgeWaitT == null) this._edgeWaitT = now; if (now - this._edgeWaitT < 180) return; }
    }
    this._edgeWaitT = null;
    // from the middle ages a push against buildings takes siege along: wait up to 90 s for it
    if (c.age >= 2 && this.countB(c, 'siege', true) + this.countB(c, 'factory', true) > 0 && !pool.some(u => UNITS[u.type].cls === 'siege')) {
      if (this._siegeWaitT == null) this._siegeWaitT = now;
      if (now - this._siegeWaitT < 90) return;
    }
    this._siegeWaitT = null;
    const guardN = first ? 0 : Math.floor(pool.length * 0.15);
    const guard = new Set(pool.filter(u => UNITS[u.type].cls !== 'siege').sort((a, b) => d2(a.x, a.z, c.home.x, c.home.z) - d2(b.x, b.z, c.home.x, c.home.z)).slice(0, guardN).map(u => u.id));
    const ids = pool.filter(u => !guard.has(u.id)).map(u => u.id);
    if (ids.length < 3) return;
    const tgt = this._pushTarget(c.home);
    const eb = this.enemyBase();
    let tx, tz;
    if (tgt) { tx = tgt.x; tz = tgt.z; }
    else {
      // nothing of the enemy seen yet: march on the most likely possible start spot of this map layout that is still
      // unexplored, as a player would (on big maps the scout route's first points lay next to home: the army
      // circled its own base and went back)
      const N = g.map.size, me = c.me;
      const spots = [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8], [0.5, 0.14], [0.86, 0.5], [0.5, 0.86], [0.14, 0.5]]
        .map(f => ({ x: f[0] * N, z: f[1] * N })).filter(p => d2(p.x, p.z, me.startX, me.startZ) > 30 * 30)
        // (most likely first: across the map from us - the mirror of our start through the centre - then the ones near it)
        .sort((a, b) => d2(a.x, a.z, N - me.startX, N - me.startZ) - d2(b.x, b.z, N - me.startX, N - me.startZ));
      const open = spots.filter(p => !this.explored(p.x, p.z));
      const p = open[0] || spots[this.pushN % Math.max(1, spots.length)] || { x: N / 2, z: N / 2 };
      const f = this._freeish(p.x, p.z); tx = f.x; tz = f.z;
    }
    // rally outside the enemy base, on our side
    const bx = eb ? eb.x : tx, bz = eb ? eb.z : tz;
    const L = Math.hypot(c.home.x - bx, c.home.z - bz) || 1;
    const rally = this._freeish(bx + (c.home.x - bx) / L * 20, bz + (c.home.z - bz) / L * 20);
    const gr = { kind: 'push', ids, initial: ids.length, phase: 'rally', rx: rally.x, rz: rally.z, tx, tz, targetId: tgt ? tgt.id : null, start: now, phaseT: now, kills: 0, razed: 0 };
    this.groups.push(gr);
    this.pushN++; this.stats.pushes++; if (this.stats.firstPush == null) this.stats.firstPush = now;
    g.cmdMove(ids, rally.x, rally.z);
  }

  // a push that is fighting gets the new soldiers from home (above the home guard) every ~20 s
  _reinforce(c, gr) {
    const g = this.game, now = g.time;
    if (gr.phase !== 'fight' || this._baseThreat || now - (gr.reinfT || gr.start) < 20) return;
    const keep = Math.max(2, Math.ceil(c.minDef * 0.5));
    const pool = c.pool.slice().sort((a, b) => d2(b.x, b.z, c.home.x, c.home.z) - d2(a.x, a.z, c.home.x, c.home.z));
    const n = pool.length - keep;
    if (n < 3) return;
    const add = pool.slice(0, n);
    const ids = add.map(u => u.id);
    gr.ids.push(...ids); gr.initial += ids.length; gr.reinfT = now; gr.reinf = (gr.reinf || 0) + ids.length;
    let ax = 0, az = 0, k = 0; for (const id of gr.ids) { const u = this.alive(id); if (u && ids.indexOf(id) < 0) { ax += u.x; az += u.z; k++; } }
    if (k) g.cmdMove(ids, ax / k, az / k); else g.cmdMove(ids, gr.tx, gr.tz);
  }

  // weakest defended production / eco building on the perimeter, then towers, then the town center
  _pushTarget(from) {
    const now = this.game.time, eb = this.enemyBase();
    const defOf = (x, z) => {
      let s = 0;
      for (const m of this.mem.values()) {
        if (m.kind === 'building' && (m.type === 'tower' || m.type === 'castle' || m.type === 'towncenter') && d2(m.x, m.z, x, z) < 9 * 9) s += m.type === 'castle' ? 3 : 1.2;
        else if (m.kind === 'unit' && m.mil && now - m.t < 45 && d2(m.x, m.z, x, z) < 10 * 10) s += 0.25;
      }
      return s;
    };
    let best = null, bs = Infinity, tower = null, tws = Infinity, tc = null;
    for (const m of this.mem.values()) {
      if (m.kind !== 'building' || m.type === 'wall' || m.type === 'rail' || m.type === 'gate') continue;
      if (m.type === 'towncenter') { if (!tc || d2(m.x, m.z, from.x, from.z) < d2(tc.x, tc.z, from.x, from.z)) tc = m; continue; }
      if (m.type === 'tower' || m.type === 'castle') { const s = Math.sqrt(d2(m.x, m.z, from.x, from.z)) + (m.type === 'castle' ? 40 : 0); if (s < tws) { tws = s; tower = m; } continue; }
      const per = eb ? Math.sqrt(d2(m.x, m.z, eb.x, eb.z)) : 10;
      const s = defOf(m.x, m.z) * 300 + (m.hp || 500) * 0.15 + Math.sqrt(d2(m.x, m.z, from.x, from.z)) * 3 - Math.min(per, 20) * 8;
      if (s < bs) { bs = s; best = m; }
    }
    if (best && (bs < 300 || !tower)) return best;
    if (tower) return tower;
    if (best) return best;
    return tc;
  }

  _retreat(gr, c, keep) {
    const ids = gr.ids.filter(id => this.alive(id));
    if (ids.length) this.game.cmdMove(ids, c.rally.x, c.rally.z);
    gr.phase = 'back'; gr.phaseT = this.game.time;
    if (gr.kind === 'push') this.nextPush = Math.max(this.nextPush, this.game.time + this.d.pushGap);
  }

  _groupsUpdate(c) {
    const g = this.game, now = g.time;
    for (const gr of this.groups.slice()) {
      const live = gr.ids.map(id => this.alive(id)).filter(u => u && u.owner === this.pid);
      gr.ids = live.map(u => u.id);
      if (!live.length) { this._dropGroup(gr); continue; }
      let ax = 0, az = 0, hp = 0, mhp = 0;
      for (const u of live) { ax += u.x; az += u.z; hp += u.hp; mhp += u.maxHp; }
      ax /= live.length; az /= live.length;
      let foes = 0;
      for (const m of this.mem.values()) if (m.kind === 'unit' && m.mil && m.st === this.vstamp && d2(m.x, m.z, ax, az) < 10 * 10) foes++;
      if (gr.phase === 'back') {
        if (d2(ax, az, c.rally.x, c.rally.z) < 10 * 10 || now - gr.phaseT > 120) { this._dropGroup(gr); continue; }
        const idle = live.filter(u => !u.order || u.order.auto).map(u => u.id);
        if (idle.length && now - (gr.backT || 0) > 6) { g.cmdMove(idle, c.rally.x, c.rally.z); gr.backT = now; }
        continue;
      }
      if (gr.kind === 'raid') {
        if (hp < mhp * 0.4 || foes > live.length || now - gr.start > 160) { this._retreat(gr, c); continue; }
        if (gr.phase === 'go') {
          if (d2(ax, az, gr.tx, gr.tz) < 11 * 11) gr.phase = 'fight';
          else {
            const near = live.some(u => this._nearEnemyUnit(u, 7, true));
            if (near) gr.phase = 'fight';
            else { const idle = live.filter(u => !u.order || u.order.type !== 'move').map(u => u.id); if (idle.length) g.cmdMove(idle, gr.tx, gr.tz); continue; }
          }
        }
        // fight: villagers first; when the area is empty pick the next prey nearby or go home
        let focus = gr.targetId != null ? this.mem.get(gr.targetId) : null;
        if (!focus || !this.seenEnt(focus.id) || (focus.kind === 'unit' && now - focus.t > 8)) {
          const nt = this._raidTarget({ x: ax, z: az }, live.some(u => UNITS[u.type].range > 0));
          if (nt && nt.id != null && d2(nt.x, nt.z, ax, az) < 22 * 22) { gr.targetId = nt.id; gr.tx = nt.x; gr.tz = nt.z; focus = nt; }
          else if (!live.some(u => this._nearEnemyUnit(u, 8, true))) { if (now - (gr.emptyT || now) > 12) { this._retreat(gr, c); continue; } gr.emptyT = gr.emptyT || now; }
        }
        this._fight(live, focus, 6, true);
        continue;
      }
      // push
      // a push that keeps destroying things stays out (and gets reinforced); one that stalls comes home
      const lost = 1 - live.length / gr.initial;
      const stale = now - Math.max(gr.lastHit || 0, gr.phase === 'fight' ? this._bldHitT || 0 : 0, gr.phaseT || gr.start) > 150;
      const losing = foes > live.length * 1.6 && hp < mhp * 0.5;
      // (playtest 2026-11-14: a push that had razed what it knew went home and left the enemy alive) a hunting push
      // does not go stale; it keeps looking until the enemy is gone, the push is beaten, or HUNT_GIVEUP s pass without
      // a kill or a hit on a building
      const huntOut = gr.hunting && now - Math.max(gr.lastHit || 0, this._bldHitT || 0, gr.huntS || gr.start) > HUNT_GIVEUP;
      if ((lost >= 0.6 && !gr.razed) || live.length < 2 || losing || (stale && now - gr.start > 300 && !gr.hunting) || huntOut) { this._retreat(gr, c); continue; }
      if (gr.phase === 'rally') {
        const slow = Math.min(...live.map(u => UNITS[u.type].speed));
        const far = Math.sqrt(d2(c.home.x, c.home.z, gr.rx, gr.rz));
        const arrived = live.filter(u => d2(u.x, u.z, gr.rx, gr.rz) < 8 * 8).length;
        const enemyNear = foes > 0;
        if (enemyNear) { this._fight(live, null, 6); }
        if (arrived >= live.length * 0.75 || now - gr.phaseT > far / slow + 25) { gr.phase = 'fight'; gr.phaseT = now; }
        else if (!enemyNear) { const idle = live.filter(u => !u.order).filter(u => d2(u.x, u.z, gr.rx, gr.rz) > 6 * 6).map(u => u.id); if (idle.length) g.cmdMove(idle, gr.rx, gr.rz); }
        continue;
      }
      let tgt = gr.targetId != null ? this.mem.get(gr.targetId) : null;
      // a hunted unit we lost sight of: look elsewhere (it used to hold the push on its last seen spot for minutes)
      if (tgt && tgt.kind === 'unit' && !this.visible(tgt.x, tgt.z) && (tgt.gone || now - tgt.t > 20)) tgt = null;
      if (!tgt || (tgt.kind === 'building' && !this.mem.has(tgt.id))) {
        const nt = this._pushTarget({ x: ax, z: az });
        if (nt) { gr.targetId = nt.id; gr.tx = nt.x; gr.tz = nt.z; tgt = nt; if (gr.hunting) { gr.hunting = false; gr.huntS = null; gr.hc = null; gr.phaseT = now; } }
        else {
          // nothing known: hunt. Remembered enemy units first, then the middle of a remembered enemy wall ring, else
          // the part of the map we have not looked at for the longest time (the game only ends when every villager
          // and town center is gone). A hunt point is done when we have looked at it, a unit got there, or its time
          // (the walk + HUNT_SLACK s) ran out; a spot we could not get to counts as looked at, so the next pick differs.
          const fresh = !gr.hunting, C = this.cellSeen;
          if (fresh) { gr.hunting = true; gr.huntS = now; }
          const looked = gr.hc != null && C && C[gr.hc] > (gr.huntT || 0);
          const there = live.some(u => d2(u.x, u.z, gr.tx, gr.tz) < 7 * 7);
          if (fresh || gr.targetId != null || looked || there || now > (gr.huntEnd || 0)) {
            if (!fresh && gr.hc != null && C) C[gr.hc] = Math.max(C[gr.hc], now);
            gr.targetId = null; gr.hc = null;
            const p = this._huntPoint({ x: ax, z: az });
            if (p) {
              gr.tx = p.x; gr.tz = p.z; if (p.id != null) gr.targetId = p.id; else gr.hc = this._cell(p.x, p.z);
              const slow = Math.min(...live.map(u => UNITS[u.type].speed));
              gr.huntT = now; gr.huntEnd = now + Math.sqrt(d2(ax, az, p.x, p.z)) / slow * 1.5 + HUNT_SLACK;
            }
          }
          tgt = gr.targetId != null ? this.mem.get(gr.targetId) || { id: null, x: gr.tx, z: gr.tz } : { id: null, x: gr.tx, z: gr.tz };
        }
      }
      // a target behind walls: break the nearest wall / gate piece first
      const br = this._breach(gr, live, tgt, ax, az);
      if (br && gr.hunting) gr.huntEnd = Math.max(gr.huntEnd || 0, now + 20);   // breaking in: the hunt point stays
      this._fight(live, br || tgt, 6);
    }
  }
  // The push's target building cannot be walked to (a walled town): flood from the target over the ground we can
  // walk; if the group is not in that pocket, focus the remembered enemy wall / gate piece on the pocket's rim
  // nearest the group. Checked every 10 s per group (deterministic: map state, our memory, our own units).
  _breach(gr, live, tgt, ax, az) {
    const g = this.game, N = g.map.size;
    if (!tgt) return null;
    // (a hunting push's target may be a point: the middle of a wall ring)
    const e = tgt.id != null ? this.alive(tgt.id) : null;
    if (tgt.id != null ? (!e || e.kind !== 'building' || e.type === 'wall' || e.type === 'gate') : !gr.hunting) return null;
    if (g.time < (gr.brT || 0)) { const w = gr.brId != null ? this.seenEnt(gr.brId) : null; return w && !w.dead ? w : null; }
    gr.brT = g.time + 10; gr.brId = null;
    const P = g._passMap(this.pid);
    let s0 = -1;
    if (!e) { const cx = tgt.x | 0, cz = tgt.z | 0; for (let r = 0; r <= 5 && s0 < 0; r++) for (let dz = -r; dz <= r && s0 < 0; dz++) for (let dx = -r; dx <= r; dx++) { const x = cx + dx, z = cz + dz; if (Math.max(Math.abs(dx), Math.abs(dz)) === r && x > 0 && z > 0 && x < N - 1 && z < N - 1 && P[z * N + x]) { s0 = z * N + x; break; } } }
    else for (let x = e.tx - 1; x <= e.tx + e.size && s0 < 0; x++) for (const z of [e.tz - 1, e.tz + e.size]) if (x > 0 && z > 0 && x < N - 1 && z < N - 1 && P[z * N + x]) { s0 = z * N + x; break; }
    if (e) for (let z = e.tz; z < e.tz + e.size && s0 < 0; z++) for (const x of [e.tx - 1, e.tx + e.size]) if (x > 0 && z > 0 && x < N - 1 && z < N - 1 && P[z * N + x]) { s0 = z * N + x; break; }
    if (s0 < 0) return null;
    let lead = live[0], ld = Infinity; for (const u of live) { const dd = d2(u.x, u.z, ax, az); if (dd < ld) { ld = dd; lead = u; } }
    const lk = (lead.z | 0) * N + (lead.x | 0);
    if (!BREACH_BUF || BREACH_BUF.length !== N * N) BREACH_BUF = new Int32Array(N * N);
    const dist = g._ffSweep(s0 % N, (s0 / N) | 0, this.pid, BREACH_BUF, Infinity, P[lk] ? [lk] : null);
    if (dist[lk] >= 0) return null;   // the group can walk there
    let best = null, bd = Infinity;
    for (const m of this.mem.values()) {
      if (m.kind !== 'building' || (m.type !== 'wall' && m.type !== 'gate')) continue;
      const w = this.seenEnt(m.id); if (!w || w.dead || !this.foe(w.owner)) continue;
      let rim = false;
      for (let j = -1; j <= 1 && !rim; j++) for (let i = -1; i <= 1; i++) { const x = w.tx + i, z = w.tz + j; if (x >= 0 && z >= 0 && x < N && z < N && dist[z * N + x] >= 0) { rim = true; break; } }
      if (!rim) continue;
      const dd = d2(w.x, w.z, ax, az); if (dd < bd) { bd = dd; best = w; }
    }
    if (best) gr.brId = best.id;
    return best;
  }
  _huntPoint(from) {
    const g = this.game, now = g.time, N = g.map.size;
    let best = null, bs = Infinity;
    for (const m of this.mem.values()) {
      if (m.kind !== 'unit' || m.gone || now - m.t > 90 || m.naval) continue;
      const s = Math.sqrt(d2(m.x, m.z, from.x, from.z)) + (now - m.t) * 0.3 - (m.type === 'villager' ? 15 : 0);
      if (s < bs) { bs = s; best = { x: m.x, z: m.z, id: m.id }; }
    }
    if (best) return best;
    const C = this.cellSeen, CS = 12, CN = Math.ceil(N / CS);
    if (!C) return null;
    const me = this.me(), hx = this._homeX != null ? this._homeX : me.startX, hz = this._homeZ != null ? this._homeZ : me.startZ;
    // enemy walls enclose something: the middle of each enemy's remembered wall / gate pieces, unless we looked
    // there in the last 2 minutes (a far wall ring with the town center deep inside kept pushes outside)
    const wc = new Map();
    for (const m of this.mem.values()) if (m.kind === 'building' && (m.type === 'wall' || m.type === 'gate')) { const a = wc.get(m.owner) || { n: 0, x: 0, z: 0 }; a.n++; a.x += m.x; a.z += m.z; wc.set(m.owner, a); }
    for (const a of wc.values()) {
      if (a.n < 6) continue;
      const x = a.x / a.n, z = a.z / a.n; if (now - C[this._cell(x, z)] < 120) continue;
      const s = Math.sqrt(d2(x, z, from.x, from.z)) - 1e5;
      if (s < bs) { bs = s; best = { x, z, id: null }; }
    }
    if (best) return best;
    for (let cz = 0; cz < CN; cz++) for (let cx = 0; cx < CN; cx++) {
      const x = Math.min(N - 3, cx * CS + CS / 2), z = Math.min(N - 3, cz * CS + CS / 2);
      if (!g.map.isWalkable(x | 0, z | 0)) continue;
      const s = Math.sqrt(d2(x, z, from.x, from.z)) * 0.6 - Math.min(600, now - C[cz * CN + cx]) - Math.min(80, Math.sqrt(d2(x, z, hx, hz))) * 0.4;   // (away from home first)
      if (s < bs) { bs = s; best = { x, z, id: null }; }
    }
    return best;
  }
  _cell(x, z) { const CS = 12, CN = Math.ceil(this.game.map.size / CS); return Math.min(CN - 1, Math.max(0, (z / CS) | 0)) * CN + Math.min(CN - 1, Math.max(0, (x / CS) | 0)); }
  _dropGroup(gr) { const i = this.groups.indexOf(gr); if (i >= 0) this.groups.splice(i, 1); }

  // idle soldiers that wandered off gather at the home rally point
  _poolTidy(c) {
    const g = this.game;
    if (this._defending) return;
    if (g.time - (this._tidyT || 0) < 5) return; this._tidyT = g.time;
    const H = c.home;
    const ids = c.pool.filter(u => (!u.order && d2(u.x, u.z, c.rally.x, c.rally.z) > 9 * 9)
      || (u.order && u.order.type === 'attack' && d2(u.x, u.z, H.x, H.z) > 36 * 36 && !c.blds.some(b => d2(u.x, u.z, b.x, b.z) < 14 * 14))).map(u => u.id);
    if (ids.length) g.cmdMove(ids, c.rally.x, c.rally.z);
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

installMethods(AIController.prototype, aiEconomyMethods, aiBuildOrderMethods);

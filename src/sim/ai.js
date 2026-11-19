// Aevum AI opponent.
// Plays by the same rules as a human: it only spends what its own villagers / carts / banks / trains
// earned, pays the same costs and waits the same build / train / research times (all of that lives in
// game.js and is identical for every player). It knows its own entities, and about enemy things only
// what its own units and buildings have seen (an explored grid + a "seen" memory, see _vision()).
// Difficulty changes decision quality and tempo only (think interval, villager targets, how tightly it
// follows its plan, counter quality, how often it leaves villagers idle, attack timing / sizes).
import { UNITS, BUILDINGS, TECHS, AGES, FARM_SLOTS } from '../data.js';
import { QUEUE_TIME_MUL, unitLos, buildingLos, forDisc } from './game-shared.js';

const MIN = 60;
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

const RK = ['food', 'wood', 'gold', 'stone'];
const RES_OF = { tree: 'wood', stone: 'stone', gold: 'gold', berries: 'food', deer: 'food' };
const NOMINAL = { food: 0.42, wood: 0.36, gold: 0.32, stone: 0.32 }; // per villager per second, before any history
const TYPE_ROLE = { spearman: 'pike', swordsman: 'inf', heavyinf: 'inf', musketeer: 'gun', rifleman: 'gun', archer: 'bow', crossbow: 'bow', lightcav: 'cav', knight: 'cav', cuirassier: 'cav', ram: 'siege', catapult: 'siege', cannon: 'siege', artillery: 'siege' };
const ROLE_UNITS = { pike: ['spearman'], inf: ['heavyinf', 'swordsman'], gun: ['rifleman', 'musketeer'], bow: ['crossbow', 'archer'], cav: ['cuirassier', 'knight', 'lightcav'], siege: ['artillery', 'cannon', 'catapult', 'ram'] };
const ROLE_W = [
  { pike: 1 },
  { pike: 0.1, inf: 0.3, bow: 0.32, cav: 0.28 },
  { pike: 0.05, inf: 0.3, bow: 0.3, cav: 0.25, siege: 0.1 },
  { inf: 0.2, gun: 0.3, bow: 0.1, cav: 0.28, siege: 0.12 },
  { inf: 0.1, gun: 0.42, cav: 0.3, siege: 0.18 },
];
const MIL_B = ['barracks', 'archery', 'stable', 'siege', 'factory'];
const ECO_TECHS = ['basket', 'axe', 'plow', 'wheelbarrow', 'pickaxe', 'crop', 'loom', 'breeding', 'caravan', 'saw', 'shaft', 'irrigation', 'handcart', 'banking', 'steam', 'guilds', 'nets', 'assembly', 'steelrails', 'coinage'];
const MIL_TECHS = {
  forging: ['infantry', 'cavalry'], ironcast: ['infantry', 'cavalry'], steel: ['infantry', 'cavalry'],
  fletching: ['ranged'], bodkin: ['ranged'], rifling: ['ranged'], corning: ['ranged'],
  scale: ['infantry'], plate: ['infantry'], formation: ['infantry'], drill: ['infantry'],
  barding: ['cavalry'], bloodlines: ['cavalry'], husbandry: ['cavalry'],
  siegecraft: ['siege'], ballistics: ['siege'], explosives: ['siege'], siegeeng: ['siege'],
  conscription: ['infantry', 'ranged', 'cavalry', 'siege'],
};
const DEF_TECHS = ['masonry', 'arrowslits', 'guardtower', 'townwatch', 'herbs', 'garrisonart', 'architecture', 'medicine'];
const NOT_TYPE = { house: 1, wall: 1, gate: 1, towncenter: 1 };

let BREACH_BUF = null;   // scratch field for _breach (fully rewritten by every sweep; never part of the AI state)
// a push hunting the last enemy remains goes home only after this many seconds without a kill or a hit on a building;
// each hunt point gets the walk there (x1.5) plus HUNT_SLACK s before the next one is picked
const HUNT_GIVEUP = 600, HUNT_SLACK = 25;
function d2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function addCost(acc, cost, m = 1) { if (cost) for (const k in cost) acc[k] = (acc[k] || 0) + (cost[k] || 0) * m; return acc; }
function costSum(c) { let s = 0; if (c) for (const k in c) s += c[k] || 0; return s; }
function qmul() { try { return QUEUE_TIME_MUL || 1.25; } catch (e) { return 1.25; } }
// drop-off camps (owner 2026-11-14: the AI built hundreds of lumber camps): at most this many of each kind
// (lumber / mine), one more on the biggest maps; a lumber camp only beside a real forest, none within CAMP_GAP of another
const CAMP_GAP = 14, CAMP_TREES = 16, CAMP_MINES = 3;
// a building of ours the enemy destroyed: no new foundation within LOST_R tiles of it for LOST_S seconds, nor while
// enemy soldiers are seen near it (owner: a razed farm was put back on the same spot at once)
const LOST_R = 8, LOST_S = 75, LOST_FOE_R = 14;
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

  // ---------- income: real per-villager rates and passive income over the last ~60 s ----------
  _income(c) {
    const g = this.game, now = g.time, gat = c.me.stats.gathered;
    const work = this._workers(c);
    c.work = work;
    // worker-seconds per resource, so the per-villager rate is not skewed by recent reassignments
    const last = this.hist[this.hist.length - 1];
    const ws = last ? { ...last.w } : { food: 0, wood: 0, gold: 0, stone: 0 };
    if (last) { const step = now - last.t; for (const r of RK) ws[r] += (last.n ? last.n[r] : 0) * step; }
    this.hist.push({ t: now, g: { ...gat }, v: { ...this.vinc }, w: ws, n: { ...work.cnt } });
    while (this.hist.length > 2 && now - this.hist[1].t > 60) this.hist.shift();
    const h0 = this.hist[0], dt = now - h0.t;
    c.rate = {}; c.passive = {}; c.income = {};
    for (const r of RK) {
      let rate = NOMINAL[r], passive = 0, inc = 0;
      if (dt >= 20) {
        const vin = (this.vinc[r] - h0.v[r]), all = ((gat[r] || 0) - (h0.g[r] || 0)) / dt;
        inc = all; passive = Math.max(0, all - vin / dt);
        const wsec = ws[r] - (h0.w ? h0.w[r] : 0);
        if (wsec >= 40) rate = Math.min(1.6, Math.max(0.12, vin / wsec));
      }
      c.rate[r] = rate; c.passive[r] = passive; c.income[r] = inc;
    }
  }

  // villagers by job
  _workers(c) {
    const cnt = { food: 0, wood: 0, gold: 0, stone: 0 }, list = { food: [], wood: [], gold: [], stone: [] }, idle = [], users = new Map();
    let build = 0;
    for (const v of c.vills) {
      if (v.id === this.scoutId) continue;
      let o = v.order;
      if (o && o.type === 'move' && v.queue && v.queue[0]) o = v.queue[0]; // fled to the TC, resumes afterwards
      if (!o) { idle.push(v); continue; }
      if (o.type === 'gather' || o.type === 'return') {
        let r = o.res;
        if (o.type === 'return' && o.resume) { r = o.resume.res; if (o.resume.targetId != null) users.set(o.resume.targetId, (users.get(o.resume.targetId) || 0) + 1); }
        if (o.type === 'gather' && o.targetId != null) users.set(o.targetId, (users.get(o.targetId) || 0) + 1);
        if (cnt[r] != null) { cnt[r]++; list[r].push(v); }
      } else if (o.type === 'build') { build++; if (o.targetId != null) users.set(o.targetId, (users.get(o.targetId) || 0) + 1); }
      else if (o.type === 'move' && !v.queue.length) { /* walking somewhere, becomes idle soon */ }
    }
    return { cnt, list, idle, users, build };
  }

  // ---------- planning: phase, targets and the 2-minute shopping list ----------
  villTargetFor(age) { const a = Math.min(4, age); return Math.max(this.d.vill[a], a < 4 ? this.d.ageVill[a] + 3 : 0); }
  _plan(c) {
    const g = this.game, me = c.me, d = this.d, age = me.age;
    this._homeX = c.home.x; this._homeZ = c.home.z;
    c.age = age;
    c.researching = c.tcs.some(b => (b.queue || []).some(q => q.kind === 'age'));
    const enemyAge = Math.max(0, ...this.enemyPlayers().map(p => p.age || 0)); // age-ups are announced to everyone
    c.behind = enemyAge > age;
    const types = new Set(), typesDone = new Set();
    for (const b of c.blds) if (!NOT_TYPE[b.type]) { types.add(b.type); if (b.done) typesDone.add(b.type); }
    c.types = types; c.typesDone = typesDone;
    const next = AGES[age + 1];
    c.reqMissing = next && next.reqTypes ? next.reqTypes.filter(t => !typesDone.has(t)) : [];
    c.typesMissing = next ? Math.max(0, (next.reqBuildings || 0) - types.size, c.reqMissing.filter(t => !types.has(t)).length) : 0;
    c.villTarget = this.villTargetFor(c.researching ? age + 1 : age);
    const effTarget = Math.round(c.villTarget * (c.behind ? 0.8 : 1));
    const min = this.minutes();
    if (age >= 4) c.phase = 'final';
    else if (c.researching) c.phase = 'research';
    else {
      // age up at the first sensible moment: the required building types exist and a small working
      // economy (ageVill) is in place. Villager production and a minimum defence continue alongside.
      // (the minimum stay in an age: start saving only in its last minute, so the economy keeps growing until then)
      const ready = c.typesMissing === 0 && !c.reqMissing.length && c.vills.length >= d.ageVill[age] && !(g.ageWait && g.ageWait(this.pid) > 60);
      // under attack, or the enemy army we saw clearly outnumbers ours: defence first, the age-up waits
      const eaN = this.enemyArmySeen(90, c.home, 40).n; // enemy soldiers seen near our base recently
      c.threatened = !!this._baseThreat || (eaN >= 4 && eaN > c.mil.length * 1.3);
      c.phase = ready && !c.threatened ? 'save' : 'grow';
      c.ready = ready;
    }
    c.villCap = c.phase === 'final' ? d.vill[4] : (c.phase === 'save' || c.ready) ? c.villTarget + d.slack : c.villTarget;
    // army target grows with the economy, and with what we saw of the enemy army
    const ea = this.enemyArmySeen();
    c.enemySeen = ea;
    // minimum standing defence: base value, more if the enemy is a full age ahead, sized to what we saw
    // of its army recently and to recent attacks on our base
    const recentHits = this.threats.filter(t => g.time - t.t < 60).length;
    c.minDef = Math.max(d.minArmy[age] + (c.behind ? 2 : 0), Math.round(this.enemyArmySeen(90).n * (0.6 + 0.4 * d.counter)), recentHits ? d.minArmy[age] + 3 : 0);
    let at = Math.max(c.minDef, Math.round(c.vills.length * d.army[age]));
    if (ea.n > at * 0.8) at = Math.max(at, Math.round(ea.n * (0.9 + 0.3 * d.counter)));
    if (this._baseThreat) at += 4;
    c.roleW = this._roleWeights(c);
    // elastic spending: resources floating above ~1.5x the last 2-minute shopping list are turned into
    // more soldiers (army target), more production buildings and deeper queues (c.surge), all techs,
    // towers / castle (stone) and market trades. Not during the age-up saving, which has priority.
    const ps = this._prevShop;
    c.surplus = 0; c.surge = false; c.floatBoost = 0;
    if (ps && c.phase !== 'save') {
      let fl = 0;
      for (const r of RK) fl += Math.max(0, (me.res[r] || 0) - (ps[r] || 0) * d.floatMul - (r === 'stone' ? 250 : 120)) * (r === 'stone' ? 0.3 : 1);
      c.surplus = fl;
      c.surge = fl > 500 && age >= 1;
      const uc = Math.max(60, costSum(this._avgUnitCost(c)));
      const capA = d.armyCap[age];
      const want = Math.min(capA, c.mil.length + Math.floor(fl * d.elastic / uc));
      if (want > at) { c.floatBoost = want - at; at = want; }
    }
    // the first age-up has priority over soldiers beyond the minimum defence (unless threatened)
    if (age === 0 && !c.threatened && !this._baseThreat) at = Math.min(at, c.minDef);
    c.armyTarget = d.ecoOnly ? 0 : at;
    c.plan = this._buildPlan(c);
    c.farmNeed = this._farmNeed(c);
    // shopping list for the next ~2 minutes
    const H = 120, s = { food: 0, wood: 0, gold: 0, stone: 0 };
    const tcsDone = c.tcs.filter(b => b.done).length;
    const vNeed = Math.max(0, c.villCap - c.vills.length);
    if (vNeed) addCost(s, UNITS.villager.cost, Math.min(vNeed, Math.max(1, tcsDone - (c.researching ? 1 : 0)) * H / (UNITS.villager.time * qmul())));
    if (next && !c.researching) addCost(s, next.cost, c.phase === 'save' ? 1 : 0.45 + 0.55 * Math.min(1, c.vills.length / Math.max(1, effTarget)));
    if (!c.tcs.length) addCost(s, BUILDINGS.towncenter.cost);
    for (const p of c.plan.slice(0, 3)) addCost(s, BUILDINGS[p.type].cost);
    if (age === 0 && !this.countB(c, 'barracks')) addCost(s, BUILDINGS.barracks.cost);
    if (age === 0 && !this.countB(c, 'lumbercamp')) addCost(s, BUILDINGS.lumbercamp.cost);
    // farms: the ones needed now, and the ones needed soon when the wild food runs low
    const wildLeft = this._wildLeft || 0, foodW = c.work ? c.work.cnt.food : 0;
    const soon = wildLeft < foodW * 60 ? Math.max(0, Math.ceil(foodW / FARM_SLOTS) - c.blds.filter(b => b.type === 'farm' || b.type === 'pasture').length) : 0;
    addCost(s, BUILDINGS[this.unlocked('building', 'farm') ? 'farm' : 'pasture'].cost, Math.min(5, Math.max(c.farmNeed, soon)));
    if (age >= 2 && d.castle && !this.countB(c, 'castle')) addCost(s, BUILDINGS.castle.cost, c.researching || age >= 3 ? 0.5 : 0.2);
    // army: what is missing, at least a steady trickle from the production buildings (losses, growth)
    const def = Math.max(0, c.armyTarget - c.mil.length);
    const prodN = c.blds.filter(b => b.done && MIL_B.includes(b.type)).length;
    const cap = Math.max(1, prodN) * H / (24 * qmul());
    const flow = age >= 1 ? prodN * H / (24 * qmul()) * 0.4 : 0;
    addCost(s, this._avgUnitCost(c), Math.max(Math.min(def, cap), flow));
    const nt = this._nextEcoTech(c, true); if (nt) addCost(s, TECHS[nt.tech].cost);
    if (age >= 2) addCost(s, { gold: 150 }); // steady military / tech gold demand from the middle ages on
    if (this.wall && this.wallLeft) addCost(s, { stone: Math.min(60, this.wallLeft) }); // the rest of the town wall
    c.shop = s; this._prevShop = s;
  }

  _roleWeights(c) {
    const age = c.age, w = { ...ROLE_W[age] }, k = this.d.counter, e = c.enemySeen;
    if (e.n >= 3) {
      const sh = {}; for (const cl in e.cls) sh[cl] = e.cls[cl] / e.n;
      if (age <= 2) w.pike = (w.pike || 0) + 0.6 * sh.cavalry * k; else w.gun = (w.gun || 0) + 0.45 * sh.cavalry * k;
      if (age >= 1) { if (age <= 2) w.bow = (w.bow || 0) + 0.45 * sh.infantry * k; else w.gun = (w.gun || 0) + 0.35 * sh.infantry * k; }
      if (age >= 1) { w.cav = (w.cav || 0) + 0.45 * sh.ranged * k + 0.4 * sh.siege * k; w.inf = (w.inf || 0) + 0.15 * sh.ranged * k; }
    }
    if (age >= 2 && e.towers) w.siege = (w.siege || 0) + 0.1 * k * Math.min(1, e.towers / 3);
    let tot = 0; for (const r in w) tot += w[r];
    for (const r in w) w[r] /= tot || 1;
    return w;
  }
  _avgUnitCost(c) {
    const out = {};
    for (const r in c.roleW) { const u = this._bestUnitOfRole(r, null); if (u) addCost(out, UNITS[u].cost, c.roleW[r]); }
    return out;
  }
  _bestUnitOfRole(role, b) {
    const list = ROLE_UNITS[role] || [];
    const def = b ? BUILDINGS[b.type] : null;
    for (const u of list) { if (def && !def.trains.includes(u)) continue; if (this.unlocked('unit', u)) return u; }
    return null;
  }

  // what to build next (production + age buildings), in priority order
  _buildPlan(c) {
    const d = this.d, age = c.age, out = [], vn = c.vills.length;
    const cnt = t => this.countB(c, t);
    const want = (type, n, ess) => { if (cnt(type) < n && BUILDINGS[type] && this.unlocked('building', type)) out.push({ type, ess: !!ess }); };
    if (d.ecoOnly) { // floor probe: economy + market + second town center only
      if (age >= 1) want('market', 1, true);
      if (age >= d.tc2Age && vn >= 18) want('towncenter', 2);
      if (age >= 2) want('storage', 1);
      return out;
    }
    if (vn >= d.barracksAt || this._baseThreat || age >= 1) want('barracks', 1, true);
    if (age >= 1) { want('archery', 1, true); want('stable', 1, true); want('blacksmith', 1); want('market', 1, true); }
    if (age >= d.tc2Age && vn >= 18) want('towncenter', 2);
    if (age >= 2) { want('siege', 1, true); want('university', 1); }
    if (age >= 3) { want('academy', 1); want('bank', 1); }
    if (age >= 4) want('factory', 1, true);
    if (age >= 2 && cnt('storage') < 1) want('storage', 1);
    const prod = MIL_B.reduce((s, t) => s + cnt(t), 0);
    // floating resources and every production building busy: one more, up to a cap that grows with the age
    const prodB = c.blds.filter(b => b.done && MIL_B.includes(b.type));
    const busy = prodB.length > 0 && prodB.filter(b => !(b.queue || []).length).length <= Math.floor(prodB.length / 4);
    const prodWant = c.surge && busy ? Math.min(d.prodMax[age], prod + 1) : d.prod[age];
    if (prod < prodWant) {
      const rot0 = age >= 4 ? ['factory', 'barracks', 'stable', 'archery', 'siege', 'barracks', 'stable', 'factory'] : age >= 2 ? ['barracks', 'stable', 'archery', 'siege', 'barracks', 'stable'] : ['barracks', 'archery', 'stable', 'barracks'];
      const rot = rot0.concat(rot0);
      const have = {}; for (const t of rot) have[t] = cnt(t);
      for (const t of rot) { if (have[t] > 0) { have[t]--; continue; } if (this.unlocked('building', t) && !out.some(p => p.type === t)) { out.push({ type: t, ess: false, extra: true }); break; } }
    }
    if (age >= 3) want('bank', Math.min(3, d.banks));
    return out;
  }

  // how many more farm / pasture plots food needs
  _farmNeed(c) {
    // (a big farm feeds 8 farmers, a pasture 2; a farm of an older save counts as 2)
    const room = c.blds.reduce((n, b) => n + (b.type === 'farm' ? (b.farm && b.farm.plots ? FARM_SLOTS : 2) : b.type === 'pasture' ? 2 : 0), 0);
    const wild = this._wildFood(c);
    c.wildCap = wild.cap;
    const foodT = c.foodTarget != null ? c.foodTarget : Math.round(c.vills.length * 0.45);
    const short = foodT - wild.cap - room;
    return short > 0 ? Math.ceil(short / FARM_SLOTS) : 0;
  }
  _wildFood(c) {
    const g = this.game; let bushes = 0, amount = 0, deer = 0;
    const drops = c.blds.filter(b => b.done && BUILDINGS[b.type].dropoff && BUILDINGS[b.type].dropoff.includes('food'));
    const idx = this._resIndex(c);
    for (const e of idx.berries) { if (e.dead || e.amount < 15) continue; if (!drops.some(b => d2(b.x, b.z, e.x, e.z) < 12 * 12)) continue; bushes++; amount += e.amount; }
    for (const e of idx.deer) { if (e.dead || e.amount < 15) continue; if (d2(e.x, e.z, c.home.x, c.home.z) < 15 * 15) deer++; }
    const cap = Math.min(8, Math.round(bushes * 1.5)) + Math.min(3, deer);
    this._wildLeft = amount + deer * 100;
    return { cap: amount + deer * 100 < 120 ? 0 : cap, bushes, deer };
  }

  // known (explored) resources, refreshed every few seconds
  _resIndex(c) {
    const g = this.game;
    if (this._idx && g.time - this._idx.t < 6 && !this._idxDirty) return this._idx;
    const idx = { t: g.time, tree: [], stone: [], gold: [], berries: [], deer: [] };
    const hx = c.home.x, hz = c.home.z, R2 = 70 * 70;
    for (const e of g.entities.values()) {
      if (e.kind !== 'resource' || e.dead || !(e.amount > 0) || !idx[e.type]) continue;
      if (!this.explored(e.x, e.z) || d2(e.x, e.z, hx, hz) > R2) continue;
      idx[e.type].push(e);
    }
    // distance of each candidate to our nearest drop-off of its kind
    const drops = { wood: [], stone: [], gold: [] };
    for (const b of c.blds) { const dd = BUILDINGS[b.type].dropoff; if (!dd || !b.done) continue; for (const r of ['wood', 'stone', 'gold']) if (dd.includes(r)) drops[r].push(b); }
    for (const type of ['tree', 'stone', 'gold']) {
      const r = RES_OF[type], ds = drops[r];
      for (const e of idx[type]) { let m = Infinity; for (const b of ds) { const dd = Math.sqrt(d2(b.x, b.z, e.x, e.z)) - b.size / 2; if (dd < m) m = dd; } e._dd = Number.isFinite(m) ? m : Math.sqrt(d2(e.x, e.z, hx, hz)) + 10; }
      idx[type].sort((a, b) => a._dd - b._dd);
      if (idx[type].length > 120) idx[type].length = 120;
    }
    this._idx = idx; this._idxDirty = false;
    return idx;
  }
  _unsafe(x, z) {
    const now = this.game.time;
    for (const dz of this.danger) if (now - dz.t < 70 && d2(dz.x, dz.z, x, z) < 8 * 8) return true;
    for (const m of this.mem.values()) {
      if (m.kind === 'building') { if ((m.type === 'tower' || m.type === 'castle' || m.type === 'towncenter') && d2(m.x, m.z, x, z) < 12 * 12) return true; if (d2(m.x, m.z, x, z) < 7 * 7) return true; }
    }
    return false;
  }

  // a spot within LOST_R of a building of ours the enemy razed less than LOST_S s ago, or while enemy soldiers are
  // seen near that ruin: no new foundation there (pad: half the new building's size). Old entries are dropped.
  _lostNear(x, z, pad = 0) {
    const L = this.lost; if (!L || !L.length) return false;
    const now = this.game.time;
    if (this._lostAt !== now) {   // (the ruins still in force, worked out once per think: findSpot asks for every candidate)
      this._lostAt = now;
      for (let i = L.length - 1; i >= 0; i--) {
        const e = L[i]; if (now - e.t < LOST_S) continue;
        let foes = false;
        for (const m of this.mem.values()) if (m.kind === 'unit' && m.mil && !m.gone && now - m.t < 8 && d2(m.x, m.z, e.x, e.z) < LOST_FOE_R * LOST_FOE_R) { foes = true; break; }
        if (!foes) L.splice(i, 1);
      }
    }
    for (const e of L) { const r = LOST_R + pad + (e.r || 0); if (d2(e.x, e.z, x, z) < r * r) return true; }
    return false;
  }

  // ---------- economy: villager allocation driven by the shopping list ----------
  _economy(c) {
    const g = this.game, d = this.d, me = c.me, work = c.work || this._workers(c);
    // target split: missing amount over the horizon, minus passive income, divided by per-villager rate
    const H = 120, s = c.shop, need = {};
    let tot = 0;
    for (const r of RK) {
      const short = Math.max((s[r] || 0) * 0.3, (s[r] || 0) - (me.res[r] || 0));
      // saving for the age: what the age-up still lacks should arrive within ~60 s
      const ageLack = c.phase === 'save' && AGES[c.age + 1] ? Math.max(0, (AGES[c.age + 1].cost[r] || 0) - (me.res[r] || 0)) / 60 : 0;
      need[r] = Math.max(0, short / H + ageLack - (c.passive[r] || 0)) / Math.max(0.12, c.rate[r]);
      tot += need[r];
    }
    const G = work.cnt.food + work.cnt.wood + work.cnt.gold + work.cnt.stone + work.idle.length;
    const idx = this._resIndex(c);
    const mineCap = r => { let n = 0; for (const e of idx[r]) if (!e.dead && !this._unsafe(e.x, e.z)) n++; return n * 4; };
    const cap = { food: Infinity, wood: idx.tree.length ? Infinity : 0, gold: mineCap('gold'), stone: mineCap('stone') };
    const base = c.age === 0 ? { food: 0.55, wood: 0.45, gold: 0, stone: 0 } : c.age === 1 ? { food: 0.4, wood: 0.3, gold: 0.2, stone: 0.1 } : { food: 0.35, wood: 0.25, gold: 0.25, stone: 0.15 };
    const tgt = {};
    let sum = 0;
    for (const r of RK) { const sh = tot > 0 ? need[r] / tot * 0.65 + base[r] * 0.35 : base[r]; tgt[r] = sh; sum += sh; }
    // floors: some wood and food always (farms / villagers / units), never more miners than spots
    const want = {};
    for (const r of RK) want[r] = G * tgt[r] / (sum || 1);
    want.wood = Math.max(want.wood, G * 0.12); want.food = Math.max(want.food, G * 0.2);
    let ws = 0; for (const r of RK) ws += want[r];
    for (const r of RK) want[r] = Math.min(cap[r], Math.round(want[r] * G / ws));
    let diff = G - RK.reduce((a, r) => a + want[r], 0);
    while (diff > 0) { const r = want.food < cap.food ? (want.food / G < 0.5 ? 'food' : 'wood') : 'wood'; want[r]++; diff--; }
    while (diff < 0) { const r = RK.slice().sort((a, b) => want[b] - want[a])[0]; want[r]--; diff++; }
    c.want = want; c.foodTarget = want.food;
    c.farmNeed = this._farmNeed(c);
    // abandoned foundations get a builder
    const builders = new Map();
    for (const v of c.vills) { const o = v.order; if (o && o.type === 'build' && o.targetId != null) builders.set(o.targetId, (builders.get(o.targetId) || 0) + 1); for (const q of v.queue || []) if (q.type === 'build') builders.set(q.targetId, (builders.get(q.targetId) || 0) + 1); }
    for (const b of c.blds) {
      if (b.done || builders.get(b.id)) continue;
      const v = this._nearestVill(c, b.x, b.z, work);
      if (v && g.cmdBuild([v.id], b.id)) { builders.set(b.id, 1); this._release(work, v); this.assignT.set(v.id, g.time); }
    }
    if (d.idleChance && this.rand() < d.idleChance) return; // weaker players leave villagers idle now and then
    // idle villagers first
    const cur = { ...work.cnt };
    const order = () => RK.slice().sort((a, b) => (cur[a] - want[a]) - (cur[b] - want[b]));
    const failed = {};
    for (const v of work.idle) {
      for (const r of order()) {
        if (failed[r]) continue;
        if (this._assign(c, v, r, work)) { cur[r]++; break; }
        failed[r] = true;
      }
    }
    // then move the minimum needed from surplus to deficit (hysteresis: surplus >= 2, villager not moved in the last 40 s)
    let moves = d.moves;
    while (moves > 0) {
      let from = null, to = null, fs = 1, td = 0;
      for (const r of RK) { const sur = cur[r] - want[r]; if (sur > fs) { fs = sur; from = r; } }
      for (const r of RK) { const def = want[r] - cur[r]; if (def > td && !failed[r]) { td = def; to = r; } }
      if (!from || !to || td < 1) break;
      const cand = work.list[from].filter(v => g.time - (this.assignT.get(v.id) || -99) > 40 && v.order && v.order.type === 'gather')
        .sort((a, b) => ((a.carry && a.carry.amount) || 0) - ((b.carry && b.carry.amount) || 0));
      const v = cand[0];
      if (!v) break;
      if (this._assign(c, v, to, work)) { cur[from]--; cur[to]++; work.list[from].splice(work.list[from].indexOf(v), 1); }
      else failed[to] = true;
      moves--;
    }
  }
  // a resource tile with at least one walkable side neighbour
  _openSide(e) { const g = this.game, x = e.x | 0, z = e.z | 0; return g._pass(x + 1, z, this.pid) || g._pass(x - 1, z, this.pid) || g._pass(x, z + 1, this.pid) || g._pass(x, z - 1, this.pid); }
  _release(work, v) { for (const r of RK) { const i = work.list[r].indexOf(v); if (i >= 0) { work.list[r].splice(i, 1); work.cnt[r]--; } } const j = work.idle.indexOf(v); if (j >= 0) work.idle.splice(j, 1); }
  // builder: idle first, else from the resource with the biggest surplus over its target, nearest
  _nearestVill(c, x, z, work) {
    let best = null, bd = Infinity;
    const cnt = work && work.cnt, want = c.want;
    for (const v of c.vills) {
      if (v.id === this.scoutId || v._aiBusy) continue;
      let o = v.order;
      if (o && o.type === 'build') continue;
      if (o && o.type === 'return' && o.resume) o = o.resume;
      let pen = 0;
      if (!o) pen = -200;
      else if (o.res && cnt && want && cnt[o.res] != null) pen = 40 - (cnt[o.res] - want[o.res]) * 25 + (o.rt === 'farm' || o.rt === 'pasture' ? 30 : 0);
      else if (o.res === 'gold' || o.res === 'stone') pen = 120;
      const dd = Math.sqrt(d2(v.x, v.z, x, z)) * 3 + pen;
      if (dd < bd) { bd = dd; best = v; }
    }
    return best;
  }

  _assign(c, v, r, work) {
    const g = this.game, t = this._pickRes(c, v, r, work.users);
    if (!t) return false;
    if (!g.cmdGather([v.id], t.id)) return false;
    work.users.set(t.id, (work.users.get(t.id) || 0) + 1);
    this.assignT.set(v.id, g.time);
    return true;
  }
  _pickRes(c, v, r, users) {
    const idx = this._resIndex(c);
    const u = id => users.get(id) || 0;
    if (r === 'food') {
      // wild food near a drop-off, then plots with free slots
      const drops = c.blds.filter(b => b.done && BUILDINGS[b.type].dropoff && BUILDINGS[b.type].dropoff.includes('food'));
      let best = null, bs = Infinity;
      for (const e of idx.berries) {
        if (e.dead || e.amount < 5 || u(e.id) >= 2) continue;
        let dm = Infinity; for (const b of drops) dm = Math.min(dm, Math.sqrt(d2(b.x, b.z, e.x, e.z)));
        if (dm > 12 || this._unsafe(e.x, e.z)) continue;
        const sc = dm * 2 + Math.sqrt(d2(e.x, e.z, v.x, v.z)) * 0.3 + u(e.id) * 3;
        if (sc < bs) { bs = sc; best = e; }
      }
      if (best) return best;
      for (const e of idx.deer) {
        if (e.dead || e.amount < 5 || u(e.id) >= 1 || d2(e.x, e.z, c.home.x, c.home.z) > 15 * 15) continue;
        const sc = Math.sqrt(d2(e.x, e.z, v.x, v.z));
        if (sc < bs) { bs = sc; best = e; }
      }
      if (best) return best;
      for (const lim of [2, 3]) {
        for (const b of c.blds) {
          if ((b.type !== 'farm' && b.type !== 'pasture') || u(b.id) >= (b.type === 'farm' && b.farm && b.farm.plots ? FARM_SLOTS : lim)) continue;
          const sc = Math.sqrt(d2(b.x, b.z, v.x, v.z)) + (b.done ? 0 : 6) + u(b.id) * 4;
          if (sc < bs) { bs = sc; best = b; }
        }
        if (best) return best;
      }
      return null;
    }
    const list = r === 'wood' ? idx.tree : idx[r];
    const lim = r === 'wood' ? 2 : 4;
    let best = null, bs = Infinity;
    for (let i = 0; i < list.length && i < 80; i++) {
      const e = list[i];
      if (e.dead || !(e.amount > 0) || u(e.id) >= lim) continue;
      if (r === 'wood' && !this._openSide(e)) continue;   // (solid forests since 2026-11-14: a tree inside the wood cannot be reached yet)
      if (this._unsafe(e.x, e.z)) continue;
      const sc = e._dd + Math.sqrt(d2(e.x, e.z, v.x, v.z)) * 0.15 + u(e.id) * 3;
      if (sc < bs) { bs = sc; best = e; }
    }
    return best;
  }

  // ---------- spending, in priority order, with reservations for blocked important items ----------
  _spend(c) {
    const g = this.game, d = this.d, me = c.me, R = c.reserve;
    const can = cost => { for (const k in cost) if ((me.res[k] || 0) - (R[k] || 0) < (cost[k] || 0)) return false; return true; };
    c.blockedBy = [];
    const block = (cost, why) => { addCost(R, cost); if (why) c.blockedBy.push(why); };
    c.can = can; c.block = block;
    const pending = c.blds.filter(b => !b.done && b.type !== 'farm' && b.type !== 'pasture' && b.type !== 'rail' && b.type !== 'wall').length;
    c.pendingB = pending;
    // 1) lost the town center: rebuild
    if (!c.tcs.length && c.vills.length) {
      if (can(BUILDINGS.towncenter.cost)) this.tryBuild(c, 'towncenter', 0, 14, { x: c.home.x, z: c.home.z }, 3); else block(BUILDINGS.towncenter.cost, 'tc');
    }
    // 2) under attack at home: soldiers first
    if (this._baseThreat && c.mil.length < c.armyTarget) this._trainMilitary(c, true);
    // 3) villagers (and town-center techs between them)
    if (c.vills.length < c.villCap) {
      for (const tc of c.tcs) {
        if (!tc.done) continue;
        const q = tc.queue || [];
        if (q.some(x => x.kind === 'age')) continue;
        const tq = this._tcTech(c, tc);
        if (tq && q.length < 1 && can(TECHS[tq].cost)) { if (g.research(tc.id, tq)) continue; }
        const qMax = d.tcQ > 1 && (me.res.food || 0) > 150 && c.phase !== 'save' ? d.tcQ : 1;
        // while saving for the age, villagers below the floor (the next age's minimum) are always made;
        // above it they only use food the age-up does not need
        const nextA = AGES[c.age + 1];
        const floorV = d.ageVill[Math.min(3, c.age + 1)];
        const ageFood = c.phase === 'save' && nextA && c.vills.length >= floorV ? (nextA.cost.food || 0) : 0;
        if (q.length < qMax) { if (can(UNITS.villager.cost) && (me.res.food || 0) - ageFood >= UNITS.villager.cost.food) g.train(tc.id, 'villager'); else if (q.length === 0 && !ageFood) block(UNITS.villager.cost, 'vil'); }
      }
    } else {
      for (const tc of c.tcs) { if (!tc.done || (tc.queue || []).length) continue; const tq = this._tcTech(c, tc); if (tq && can(TECHS[tq].cost)) g.research(tc.id, tq); }
    }
    // 4) minimum defence
    if (c.mil.length < c.minDef && (c.age > 0 || c.vills.length >= d.barracksAt)) this._trainMilitary(c, true, c.minDef);
    if (c.threatened && c.mil.length < c.armyTarget) this._trainMilitary(c, true);
    // 5) age up
    if (c.phase === 'save' && c.tcs.some(b => b.done)) {
      const r = this.safe(() => g.canAgeUp(this.pid));
      c.ageReason = r ? (r.ok ? 'ok' : r.reason) : 'err';
      if (r && r.ok) {
        // reaction time (difficulty): how long an affordable age-up waits before the click
        if (this._affT == null) this._affT = g.time;
        if (g.time - this._affT >= d.ageDelay[c.age]) {
          // the town center with the shortest queue (a queued villager would delay the age)
          const tc = c.tcs.filter(b => b.done).sort((a, b) => (a.queue || []).length - (b.queue || []).length)[0];
          if (tc && g.ageUp(tc.id)) { this._ageClickT = g.time; this._affT = null; }
        } else block(AGES[c.age + 1].cost, 'ageWait');
      } else block(AGES[c.age + 1].cost, 'age');
    }
    if (this._affAge !== c.age) { this._affAge = c.age; this._affT = null; } // the reaction clock runs once per age
    // 6) building types the next age requires
    if (c.typesMissing > 0 && c.vills.length >= 5) {
      const opts = [...c.reqMissing, 'lumbercamp', 'barracks', 'minecamp', 'pasture', 'farm', 'storage', 'blacksmith', 'market', 'archery', 'stable', 'temple', 'university', 'siege', 'tower', 'academy', 'bank', 'castle'];
      for (const t of opts) {
        if (c.types.has(t) || !this.unlocked('building', t)) continue;
        if ((t === 'lumbercamp' || t === 'minecamp') && !this._campSite(c, t, null)) continue;   // (no forest / mine where a camp may stand)
        if (this._buildType(c, t, true)) break; else { block(BUILDINGS[t].cost, 'type:' + t); break; }
      }
    }
    // 7) farms / pastures when wild food runs out
    this._farms(c);
    // 8) eco techs
    this._ecoTechs(c);
    // 9) production and age buildings
    let essBlocked = false;
    for (const p of c.plan) {
      if (c.pendingB >= d.builds) break;
      if (p.type === 'towncenter' && (me.res.stone || 0) - (R.stone || 0) < 200) continue;
      if (p.type === 'castle' && !(this.countB(c, 'university') || c.age >= 3)) continue;
      if (this._buildType(c, p.type, p.ess && !essBlocked)) continue;
      if (p.ess && !essBlocked && c.phase !== 'save') { block(BUILDINGS[p.type].cost, 'ess:' + p.type); essBlocked = true; } // the age-up comes first
    }
    // 10) army up to the target, from every production building in parallel
    if (c.mil.length < c.armyTarget) this._trainMilitary(c, false);
    // 11) military techs
    this._milTechs(c);
    // 12) floating resources: towers / castle with stone, carts / banks / techs with gold, more buildings with wood
    this._extras(c);
  }

  _tcTech(c, tc) {
    const me = c.me, vn = c.vills.length, has = t => me.techs.has(t) || (me.pending || []).includes(t);
    if (!has('basket') && vn >= 9 && this.unlocked('tech', 'basket')) return 'basket';
    if (!has('wheelbarrow') && vn >= 22 && this.unlocked('tech', 'wheelbarrow')) return 'wheelbarrow';
    if (!has('loom') && (this.lostVil >= 3 || c.age >= 2) && this.unlocked('tech', 'loom')) return 'loom';
    return null;
  }

  _buildType(c, type, essential) {
    const d = this.d, me = c.me;
    const def = BUILDINGS[type];
    if (!def || !this.unlocked('building', type)) return false;
    if (!c.can(def.cost)) return false;
    if (type !== 'farm' && type !== 'pasture' && c.pendingB >= d.builds + (essential ? 1 : 0)) return false;
    let ok = false;
    const H = c.home, ed = c.edir;
    if (type === 'market') ok = this.tryBuild(c, type, 11, 22, H, 2, { x: -ed.x, z: -ed.z });
    else if (type === 'towncenter') {
      // second town center beside a resource field away from the enemy
      const idx = this._resIndex(c);
      const site = idx.gold.concat(idx.stone).filter(e => { if (e.dead) return false; const dd = d2(e.x, e.z, H.x, H.z); return dd > 14 * 14 && dd < 30 * 30 && !this._unsafe(e.x, e.z); })[0];
      ok = this.tryBuild(c, type, 3, 10, site ? { x: site.x, z: site.z } : { x: H.x - ed.x * 16, z: H.z - ed.z * 16 }, 3);
    } else if (type === 'castle') ok = this.tryBuild(c, type, 7, 16, H, 3, ed);
    else if (type === 'tower') ok = this.tryBuild(c, type, 6, 10, H, 1, ed);
    else if (type === 'lumbercamp' || type === 'minecamp') { const at = this._campSite(c, type, null); ok = !!at && this.tryBuild(c, type, 0, 5, at, 1); }
    else if (type === 'mill') ok = false;   // (legacy: old saves only)
    else ok = this.tryBuild(c, type, 5, 30, H, (def.size || 1) >= 3 ? 2 : 1);
    if (ok) c.pendingB++;
    return ok;
  }

  _farms(c) {
    const d = this.d, need = c.farmNeed;
    if (!need || c.vills.length < 6) return;
    const pend = c.blds.filter(b => (b.type === 'farm' || b.type === 'pasture') && !b.done).length;
    if (pend >= Math.max(2, d.builds)) return;
    const anchor = c.tc || c.home;
    const nf = this.countB(c, 'farm'), np = this.countB(c, 'pasture');
    // (farms come with the Bronze Age since 2026-11-14: before it, pastures - at most 3)
    const farmOk = this.unlocked('building', 'farm');
    if (!farmOk && np >= 3) return;
    const wantPasture = !farmOk || (np * 2 < nf && (c.me.res.wood || 0) - (c.reserve.wood || 0) > 200);
    const type = wantPasture ? 'pasture' : 'farm';
    if (!c.can(BUILDINGS[type].cost)) { if (c.work && c.work.cnt.food < (c.want ? c.want.food : 0) - 2) c.block(BUILDINGS[type].cost, type); return; }
    // (the big farm needs room: it is searched farther out)
    const big = type === 'farm';
    if (!this.tryBuild(c, type, 3, big ? 26 : 16, { x: anchor.x, z: anchor.z }, big ? 2 : 1)) this.tryBuild(c, type, 3, big ? 34 : 20, c.home, big ? 2 : 1);
  }

  _ecoTechs(c) {
    const nt = this._nextEcoTech(c, false);
    if (nt && c.can(TECHS[nt.tech].cost)) this.game.research(nt.b.id, nt.tech);
  }
  _nextEcoTech(c, peek) {
    const me = c.me, has = t => me.techs.has(t) || (me.pending || []).includes(t);
    const cnt = t => this.countB(c, t, true);
    const units = c.units;
    for (const t of ECO_TECHS) {
      if (has(t) || !TECHS[t] || !this.unlocked('tech', t)) continue;
      if (t === 'basket' || t === 'wheelbarrow' || t === 'loom') continue; // town center, see _tcTech
      if (t === 'breeding' && cnt('pasture') < 2) continue;
      if (t === 'caravan' && units.filter(u => u.type === 'tradecart').length < 2) continue;
      if (t === 'guilds' && units.filter(u => u.type === 'tradecart').length < 3) continue;
      if (t === 'nets' && units.filter(u => u.type === 'fishboat').length < 2) continue;
      if (t === 'coinage' && this.trades < 6) continue;
      if (t === 'banking' && cnt('bank') < 1) continue;
      if (t === 'assembly' && units.filter(u => u.type === 'artillery' || u.type === 'cannon').length < 2) continue;
      if (t === 'steelrails' && !(this.safe(() => this.game.railPairs()) || []).some(p => p.owner === this.pid)) continue;
      if ((t === 'plow' || t === 'crop' || t === 'irrigation') && cnt('farm') < 1) continue;
      if ((t === 'pickaxe' || t === 'shaft') && c.work && c.work.cnt.gold + c.work.cnt.stone < 3) continue;
      const b = c.blds.find(x => x.done && BUILDINGS[x.type].researches.includes(t) && !(x.queue || []).length);
      if (!b) { if (peek && c.blds.some(x => x.done && BUILDINGS[x.type].researches.includes(t))) return { tech: t, b: null }; continue; }
      return { tech: t, b };
    }
    return null;
  }

  _milTechs(c) {
    const me = c.me, d = this.d, has = t => me.techs.has(t) || (me.pending || []).includes(t);
    const busy = (me.pending || []).filter(t => MIL_TECHS[t] || DEF_TECHS.includes(t)).length;
    if (busy >= d.techPar + (c.surge ? 2 : 0) || c.mil.length < 5) return;
    const sh = { infantry: 0, ranged: 0, cavalry: 0, siege: 0 };
    for (const u of c.mil) { const cl = UNITS[u.type].cls; if (sh[cl] != null) sh[cl]++; }
    for (const k in sh) sh[k] /= c.mil.length;
    let best = null, bs = c.surge ? 0.02 : 0.28; // with resources floating every useful tech is worth it
    for (const t in MIL_TECHS) {
      if (has(t) || !TECHS[t] || !this.unlocked('tech', t)) continue;
      let s = 0; for (const cl of MIL_TECHS[t]) s += sh[cl] || 0;
      if (t === 'conscription') s = 0.6;
      if (MIL_TECHS[t][0] === 'siege' && c.mil.filter(u => UNITS[u.type].cls === 'siege').length < 2) continue;
      s -= costSum(TECHS[t].cost) / 4000;
      if (s > bs) {
        const b = c.blds.find(x => x.done && BUILDINGS[x.type].researches.includes(t) && !(x.queue || []).length);
        if (b && c.can(TECHS[t].cost)) { bs = s; best = { t, b }; }
      }
    }
    if (best) this.game.research(best.b.id, best.t);
  }

  // pick a unit for every free production slot according to the role weights
  _trainMilitary(c, urgent, cap) {
    const g = this.game, d = this.d, me = c.me;
    const have = {};
    for (const u of c.mil) { const r = TYPE_ROLE[u.type]; if (r) have[r] = (have[r] || 0) + 1; }
    for (const b of c.blds) for (const q of b.queue || []) if (q.kind === 'unit' && TYPE_ROLE[q.id]) have[TYPE_ROLE[q.id]] = (have[TYPE_ROLE[q.id]] || 0) + 1;
    let total = c.mil.length + c.blds.reduce((s, b) => s + (b.queue || []).filter(q => q.kind === 'unit' && TYPE_ROLE[q.id]).length, 0);
    const target = cap || c.armyTarget;
    const W = c.roleW;
    const prods = c.blds.filter(b => b.done && MIL_B.includes(b.type)).sort((a, b) => (a.queue || []).length - (b.queue || []).length);
    for (const b of prods) {
      if (total >= target) break;
      const ql = (b.queue || []).length;
      const qn = c.surge ? d.prodQmax : d.prodQ;
      if (ql >= (urgent ? Math.max(2, qn) : qn)) continue;
      const def = BUILDINGS[b.type];
      const opts = [];
      for (const role in ROLE_UNITS) {
        let u = this._bestUnitOfRole(role, b);
        if (!u) continue;
        let w = W[role] || 0;
        if (role === 'pike' && !w && b.type === 'barracks' && !this._bestUnitOfRole('inf', b) && !this._bestUnitOfRole('gun', b)) w = 0.3;
        if (role === 'siege' && b.type === 'factory' && UNITS[u].age < 4 && this.unlocked('unit', 'artillery')) continue;
        if (w <= 0) continue;
        if (u === 'ram' && (have.siege || 0) % 2 === 1 && this.unlocked('unit', 'catapult') && def.trains.includes('catapult')) u = 'catapult';
        if (u === 'catapult' && (have.siege || 0) % 2 === 0 && this.unlocked('unit', 'ram') && def.trains.includes('ram')) u = 'ram';
        let sc = w * (target + 4) - (have[role] || 0) + this.rand() * 0.3;
        if (urgent && role === 'siege') sc -= 10;
        opts.push({ u, sc, role });
      }
      opts.sort((a, b2) => b2.sc - a.sc);
      // best fitting role first; if that one is not affordable, the next one that is (only if it is still wanted)
      for (const op of opts) {
        if (op !== opts[0] && op.sc < -1) break;
        if (!c.can(UNITS[op.u].cost)) continue;
        if (g.train(b.id, op.u)) { total++; have[op.role] = (have[op.role] || 0) + 1; }
        break;
      }
    }
  }

  _extras(c) {
    const g = this.game, d = this.d, me = c.me, s = c.shop, R = c.reserve, age = c.age;
    if (d.ecoOnly) return;
    const free = k => (me.res[k] || 0) - (R[k] || 0);
    const floatOf = k => free(k) - (s[k] || 0) * d.floatMul - 100;
    // trade carts: gold for the whole game (age 2+)
    const market = c.blds.find(b => b.type === 'market' && b.done);
    if (market && age >= 2 && this.unlocked('unit', 'tradecart')) {
      const carts = c.units.filter(u => u.type === 'tradecart').length + (market.queue || []).filter(q => q.id === 'tradecart').length;
      if (carts < d.carts + (age >= 3 ? 1 : 0) && !(market.queue || []).length && c.can(UNITS.tradecart.cost)) g.train(market.id, 'tradecart');
    }
    // stone: towers near the town center / exposed camps, then a castle
    if (age >= 1 && floatOf('stone') > 0 && c.pendingB < d.builds + 1) {
      const towers = this.countB(c, 'tower');
      if (towers < d.towers[age] + (c.surge ? d.towersX : 0) && c.can(BUILDINGS.tower.cost)) {
        const camp = c.blds.find(b => (b.type === 'minecamp' || b.type === 'lumbercamp') && b.done && d2(b.x, b.z, c.home.x, c.home.z) > 12 * 12 && !c.blds.some(t => t.type === 'tower' && d2(t.x, t.z, b.x, b.z) < 8 * 8));
        if (camp ? this.tryBuild(c, 'tower', 3, 7, { x: camp.x, z: camp.z }, 1) : this.tryBuild(c, 'tower', 6, 11, c.home, 1, c.edir)) c.pendingB++;
      }
    }
    if (age >= 2 && d.castle && !this.countB(c, 'castle') && (this.countB(c, 'university', true) || age >= 3) && c.can(BUILDINGS.castle.cost)) this._buildType(c, 'castle');
    // gold / everything floating: defensive techs, temple, more production
    let floating = 0; for (const k of RK) if (floatOf(k) > 0) floating++;
    if (floating >= 2 && c.pendingB < d.builds) {
      const prod = MIL_B.reduce((n, t) => n + this.countB(c, t), 0);
      if (age >= 1 && !this.countB(c, 'temple') && this.unlocked('building', 'temple')) this._buildType(c, 'temple');
      else if (prod < d.prod[age] + 2) { const t = ['barracks', 'stable', 'archery'][prod % 3]; this._buildType(c, age >= 4 && prod % 2 ? 'factory' : t); }
    }
    if (floatOf('gold') > 0 || floatOf('stone') > 0) {
      const has = t => me.techs.has(t) || (me.pending || []).includes(t);
      for (const t of DEF_TECHS) {
        if (has(t) || !TECHS[t] || !this.unlocked('tech', t)) continue;
        const b = c.blds.find(x => x.done && BUILDINGS[x.type].researches.includes(t) && !(x.queue || []).length);
        if (b && c.can(TECHS[t].cost)) { g.research(b.id, t); break; }
      }
    }
  }

  // ---------- town walls (2026-11-14, owner: "the enemy AI never builds walls; it must use them for a fair match") ----------
  // Once the town has a few buildings and stone to spare the AI fences it with a square ring round its town center
  // (radius: every own building near home inside, plus a margin). Hard walls all four sides, normal the three facing
  // the enemy, easy only the one facing it. Every walled side gets a gate (3 pieces, opened as soon as they stand,
  // placed where the villagers gather outside, else toward the enemy / the middle); the gates go up FIRST and the
  // rest of the ring only while they are open, so the town is never closed. Corners between two walled sides get
  // towers (normal / hard, the ones toward the enemy first) or wall pieces. Ring tiles next to mines, berries, camps,
  // farms and other buildings stay open, and every placement is checked with a flood fill: nothing the town center
  // could reach before (own buildings, villagers, the resources they work, the land round the ring) may become
  // unreachable. Broken pieces are put back while stone allows. Deterministic: game state, the AI's own explored
  // grid and its own rand only.
  _walls(c) {
    const g = this.game, d = this.d, me = c.me;
    if (!d.wallSides || d.ecoOnly || !c.tc || !c.tc.done || c.age < 1) return;
    if (g.time < (this.wallT || 0)) return;
    this.wallT = g.time + 5;
    if (!this.unlocked('building', 'wall') || !this.unlocked('building', 'gate')) return;
    const W = this.wall;
    if (W && Math.abs(W.cx - Math.floor(c.home.x)) + Math.abs(W.cz - Math.floor(c.home.z)) > 6) { this.wall = null; return; }   // the town moved (new town center)
    const freeStone = () => (me.res.stone || 0) - (c.reserve.stone || 0);
    if (!W) {
      if (this.minutes() < d.wallFrom || freeStone() < 120) return;
      if (c.blds.filter(b => b.done && b.type !== 'wall' && b.type !== 'gate' && b.type !== 'rail').length < 7) return;
      this.wall = this._wallPlan(c);
      return;
    }
    if (c.work && c.work.build >= Math.max(3, Math.ceil(c.vills.length * 0.16))) return;   // (same builder cap as tryBuild)
    const own = (x, z, type) => { const b = g.buildingAt(x, z); return b && b.owner === this.pid && (!type || b.type === type) ? b : null; };
    const keep = d.wallKeep;   // stone left over for towers, castle, town centers
    // 1) gates: build the three pieces, open them once they stand; a broken gate piece is put back as a gate
    let gatesOpen = true;
    for (const gt of W.gates) {
      if (gt.skip) continue;
      const pcs = gt.t.map(([x, z]) => own(x, z));
      if (pcs.every(b => b && b.type === 'gate')) continue;
      // foundations that made no progress for 3 minutes (nobody gets to them): pull them down, give the gate up
      if (pcs.some(b => b && !b.done)) {
        if (gt.uf == null) gt.uf = g.time;
        else if (g.time - gt.uf > 180) { for (const b of pcs) if (b && !b.done && b.progress < 0.05) g.deleteEntity(b.id); gt.skip = true; continue; }
      } else gt.uf = null;
      const free = gt.t.map(([x, z], i) => !pcs[i] && g.canPlace('wall', x, z, this.pid) && !this._lostNear(x + 0.5, z + 0.5));
      if (pcs.some((b, i) => !b && !free[i])) continue;   // something else stands in the run: that gap stays open
      gatesOpen = false;
      if (pcs.every(b => b && b.type === 'wall' && b.done)) {
        if (freeStone() >= BUILDINGS.gate.cost.stone && g.cmdOpenGate(pcs[1].id)) return;
        continue;
      }
      if (pcs.some(b => b && !b.done)) { if (this._wallHelp(c, pcs)) return; continue; }   // still being built
      const empty = gt.t.filter((t, i) => free[i]);
      const anyGate = pcs.some(b => b && b.type === 'gate');
      const cost = (anyGate ? BUILDINGS.gate.cost.stone : BUILDINGS.wall.cost.stone) * empty.length;
      if (freeStone() < cost) continue;
      if (!anyGate && !this._wallSafe(c, new Set(empty.map(([x, z]) => z * g.map.size + x)))) continue;
      if (this._wallPlace(c, anyGate ? 'gate' : 'wall', empty, 2)) return;
    }
    // 1b) villagers working outside a walled side far from its gates (new mines, the forest moved): open another gate
    //     in the finished wall there, like a player would (every 30 s, at most 3 gates a side)
    if (gatesOpen && g.time >= (W.dgT || 0)) {
      W.dgT = g.time + 30;
      if (this._wallMoreGates(c, freeStone)) return;
    }
    // the ring pieces still missing (never built, or broken)
    let left = 0;
    const todo = [];
    for (let i = 0; i < W.tiles.length; i++) {
      if (W.bad.includes(i)) continue;
      const [x, z] = W.tiles[i]; if (own(x, z)) continue;
      left++; if (g.canPlace('wall', x, z, this.pid) && this.explored(x + 0.5, z + 0.5) && !this._lostNear(x + 0.5, z + 0.5)) todo.push(i);
    }
    this.wallLeft = left * BUILDINGS.wall.cost.stone;
    // 2) towers on the corners once most of the ring stands (before more wall pieces: they take all the stone); a
    //    corner whose tower cannot go up gets wall pieces
    let towerWait = 0;
    if (gatesOpen && left <= W.tiles.length * 0.4) {
      for (const tw of W.towers) {
        if (tw.fill) continue;
        const [tx, tz] = tw.at; if (own(tx + 1, tz + 1, 'tower')) continue;
        if (!g.canPlace('tower', tx, tz, this.pid)) { if (!g.buildingAt(tx + 1, tz + 1)) { tw.fill = true; for (const t of tw.fillT) W.tiles.push(t); } continue; }
        if (freeStone() < BUILDINGS.tower.cost.stone + keep || !c.can(BUILDINGS.tower.cost)) { towerWait = BUILDINGS.tower.cost.stone; break; }   // (walls leave the stone for it)
        const N = g.map.size, blk = new Set(); for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) blk.add((tz + j) * N + tx + i);
        if (!this._wallSafe(c, blk)) { tw.fill = true; for (const t of tw.fillT) W.tiles.push(t); continue; }
        const v = this._nearestVill(c, tx + 1.5, tz + 1.5, c.work || null);
        if (!v) break;
        const id = g.placeBuilding(this.pid, 'tower', tx, tz, [v.id]);
        if (id != null && id !== false) { const b = g.getEntity(id); if (b) c.blds.push(b); if (c.work) { this._release(c.work, v); c.work.build++; } this.assignT.set(v.id, g.time); return; }
        break;
      }
    }
    // 3) the rest of the ring (and repairs), in chunks, only while every gate is open; a stalled piece gets a builder
    if (gatesOpen) {
      const uf = W.uf || (W.uf = {}), seen = {};
      for (const b of c.blds) {
        if (b.type !== 'wall' || b.done || b.dead) continue;
        seen[b.id] = 1; if (uf[b.id] == null) { uf[b.id] = g.time; continue; }
        if (g.time - uf[b.id] > 180 && b.progress < 0.05) {   // a ring piece nobody gets to: pull it down, leave the tile open
          const i = W.tiles.findIndex(([x, z]) => x === b.tx && z === b.tz);
          if (i >= 0) { g.deleteEntity(b.id); if (!W.bad.includes(i)) W.bad.push(i); }
        }
      }
      for (const id of Object.keys(uf)) if (!seen[id]) delete uf[id];
      if (this._wallHelp(c, c.blds.filter(b => b.type === 'wall' && !b.done && !b.dead))) return;
    }
    if (gatesOpen && todo.length) {
      const unfinished = c.blds.filter(b => b.type === 'wall' && !b.done).length;
      const n = Math.min(d.wallChunk - unfinished, Math.floor((freeStone() - keep - towerWait) / BUILDINGS.wall.cost.stone), todo.length);
      if (n > 0 && n >= Math.min(4, todo.length)) {
        const N = g.map.size, blk = new Set(), pick = [];
        for (const i of todo.slice(0, n)) { const [x, z] = W.tiles[i]; blk.add(z * N + x); pick.push(i); }
        if (!this._wallSafe(c, blk)) {   // one by one: a piece that would shut something in is dropped for good
          blk.clear(); pick.length = 0;
          for (const i of todo.slice(0, n)) { const [x, z] = W.tiles[i], k = z * N + x; blk.add(k); if (this._wallSafe(c, blk)) pick.push(i); else { blk.delete(k); W.bad.push(i); } }
        }
        if (pick.length && this._wallPlace(c, 'wall', pick.map(i => W.tiles[i]), d.wallBuilders)) return;
      }
    }
  }
  _wallMoreGates(c, freeStone) {
    const g = this.game, W = this.wall, NRM = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    if (freeStone() < BUILDINGS.gate.cost.stone) return false;
    const sideOf = (x, z) => { const dx = x - W.cx, dz = z - W.cz; return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 0 : 2) : (dz > 0 ? 1 : 3); };
    const along = (s, x, z) => (NRM[s][0] ? z - W.cz : x - W.cx);
    const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (const v of c.vills) {
      let o = v.order; if (o && o.type === 'return' && o.resume) o = o.resume;
      if (!o || o.type !== 'gather' || o.rt === 'farm' || o.rt === 'pasture') continue;
      if (Math.max(Math.abs(o.x - W.cx), Math.abs(o.z - W.cz)) <= W.R + 1) continue;   // inside the ring
      const s = sideOf(o.x, o.z); if (!W.sides.includes(s)) continue;
      sum[s] += along(s, o.x, o.z); n[s]++;
    }
    for (const s of W.sides) {
      if (n[s] < 3) continue;
      const aim = Math.max(-(W.R - 4), Math.min(W.R - 4, Math.round(sum[s] / n[s])));
      const mine = W.gates.filter(gt => sideOf(gt.t[1][0], gt.t[1][1]) === s && !gt.skip);
      if (mine.length >= 3 || mine.some(gt => Math.abs(along(s, gt.t[1][0], gt.t[1][1]) - aim) <= 8)) continue;
      // the nearest finished straight run of three of our wall pieces to that point
      for (let k = 0; k <= 4; k++) for (const t of k ? [aim - k, aim + k] : [aim]) {
        const [nx, nz] = NRM[s], at = tt => (nx ? [W.cx + nx * W.R, W.cz + tt] : [W.cx + tt, W.cz + nz * W.R]);
        const run = [at(t - 1), at(t), at(t + 1)], pcs = run.map(([x, z]) => g.buildingAt(x, z));
        if (!pcs.every(b => b && b.type === 'wall' && b.owner === this.pid && b.done)) continue;
        if (!g.cmdOpenGate(pcs[1].id)) continue;
        W.gates.push({ t: run });
        return true;
      }
    }
    return false;
  }
  // an unfinished piece nobody is building (its builder died, or was taken for other work): send the nearest villager
  _wallHelp(c, pcs) {
    const g = this.game, open = pcs.filter(b => b && !b.done && !b.dead);
    if (!open.length) return false;
    const ids = new Set(open.map(b => b.id));
    for (const v of c.vills) { const o = v.order; if ((o && o.type === 'build' && ids.has(o.targetId)) || (v.queue || []).some(q => q && q.type === 'build' && ids.has(q.targetId))) return false; }
    const b = open[0], v = this._nearestVill(c, b.x, b.z, c.work || null);
    if (!v || !g.cmdBuild([v.id], b.id)) return false;
    if (c.work) { this._release(c.work, v); c.work.build++; }
    this.assignT.set(v.id, g.time);
    return true;
  }
  // place wall / gate pieces with up to n of the nearest villagers as builders
  _wallPlace(c, type, tiles, n) {
    const g = this.game; let sx = 0, sz = 0; for (const [x, z] of tiles) { sx += x; sz += z; } sx /= tiles.length; sz /= tiles.length;
    const ids = [], work = c.work || { list: { food: [], wood: [], gold: [], stone: [] }, idle: [], cnt: {} };
    for (let i = 0; i < n; i++) {
      const v = this._nearestVill(c, sx, sz, work);
      if (!v || ids.includes(v.id)) break;
      ids.push(v.id); if (c.work) this._release(c.work, v); v._aiBusy = true;
    }
    for (const id of ids) { const v = g.getEntity(id); if (v) delete v._aiBusy; }
    if (!ids.length) return false;
    const out = g.placeLine(this.pid, type, tiles.map(([x, z]) => [x, z]), ids);
    if (!out || !out.length) return false;
    for (const id of ids) this.assignT.set(id, g.time);
    if (c.work) c.work.build += ids.length;
    for (const id of out) { const b = g.getEntity(id); if (b) c.blds.push(b); }
    return true;
  }
  _wallPlan(c) {
    const g = this.game, d = this.d, N = g.map.size, cx = Math.floor(c.home.x), cz = Math.floor(c.home.z), pid = this.pid;
    // radius: the furthest own building near home (Chebyshev, footprint edge) plus room to walk round it
    let ext = 9;
    for (const b of c.blds) {
      if (b.type === 'wall' || b.type === 'gate' || b.type === 'rail' || b.type === 'dock' || b.type === 'tower') continue;
      const r = Math.max(Math.abs(b.tx - cx), Math.abs(b.tx + b.size - 1 - cx), Math.abs(b.tz - cz), Math.abs(b.tz + b.size - 1 - cz));
      if (r <= d.wallRmax) ext = Math.max(ext, r);
    }
    const R = Math.max(12, Math.min(d.wallRmax, ext + 3));
    const F = this._wallFlood(c, cx, cz, R, null), reach = (x, z) => F.at(x, z);
    // sides (0 +x, 1 +z, 2 -x, 3 -z), the ones facing the enemy first
    const NRM = [[1, 0], [0, 1], [-1, 0], [0, -1]], ed = c.edir;
    const sides = [0, 1, 2, 3].sort((a, b) => (NRM[b][0] * ed.x + NRM[b][1] * ed.z) - (NRM[a][0] * ed.x + NRM[a][1] * ed.z) || a - b).slice(0, d.wallSides);
    // tiles next to mines / berries, drop-off buildings, farms or any other own building stay open
    const ok = (x, z) => {
      if (x < 1 || z < 1 || x > N - 2 || z > N - 2 || !reach(x, z)) return false;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const xx = x + i, zz = z + j; if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
        const rid = g.resAt[zz * N + xx]; if (rid) { const e = g.getEntity(rid); if (e && e.type !== 'tree') return false; }
      }
      for (const b of c.blds) {
        if (b.type === 'wall' || b.type === 'gate' || b.type === 'rail') continue;
        const m = BUILDINGS[b.type].dropoff || b.type === 'farm' || b.type === 'pasture' || b.type === 'towncenter' || b.type === 'dock' ? 2 : 1;
        if (x >= b.tx - m && x < b.tx + b.size + m && z >= b.tz - m && z < b.tz + b.size + m) return false;
      }
      return true;
    };
    const at = (s, t) => { const [nx, nz] = NRM[s]; return nx ? [cx + nx * R, cz + t] : [cx + t, cz + nz * R]; };
    // where villagers gather outside the ring, per side (offset along the side)
    const want = [0, 0, 0, 0], wn = [0, 0, 0, 0];
    for (const v of c.vills) {
      let o = v.order; if (o && o.type === 'return' && o.resume) o = o.resume;
      if (!o || o.type !== 'gather' || o.rt === 'farm' || o.rt === 'pasture') continue;
      const dx = o.x - cx, dz = o.z - cz; if (Math.max(Math.abs(dx), Math.abs(dz)) < R - 2) continue;
      const s = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 0 : 2) : (dz > 0 ? 1 : 3);
      want[s] += NRM[s][0] ? dz : dx; wn[s]++;
    }
    const tiles = [], gates = [], towers = [];
    for (const s of sides) {
      const span = new Set();
      for (let t = -(R - 2); t <= R - 2; t++) { const p = at(s, t); if (ok(p[0], p[1])) span.add(t); }
      // the gate: three free tiles in a row, nearest the gatherers outside this side (else toward the enemy / the middle)
      let goal = wn[s] ? want[s] / wn[s] : s === sides[0] ? (NRM[s][0] ? ed.z : ed.x) * R : 0;
      goal = Math.max(-(R - 4), Math.min(R - 4, goal));
      const pickGate = (aim, away) => {
        let gt = null, gd = Infinity;
        for (const t of span) {
          if (!span.has(t - 1) || !span.has(t + 1) || (away != null && Math.abs(t - away) < 10)) continue;
          if (![t - 1, t, t + 1].every(k => { const p = at(s, k); return g.canPlace('wall', p[0], p[1], pid); })) continue;
          { const p = at(s, t), [nx, nz] = NRM[s]; if (!reach(p[0] - nx, p[1] - nz) || !reach(p[0] + nx, p[1] + nz)) continue; }   // open ground inside and outside
          const dd = Math.abs(t - aim) + this.rand() * 0.5; if (dd < gd) { gd = dd; gt = t; }
        }
        return gt;
      };
      const gts = [], g1 = pickGate(goal, null);
      if (g1 == null) continue;   // no room for a gate on this side: the side stays open
      gts.push(g1);
      // a long side gets a second gate in its other half (shorter walks for villagers working outside)
      if (d.wallGates2 && span.size >= 28) { const g2 = pickGate(g1 > 0 ? -R / 2 : R / 2, g1); if (g2 != null) gts.push(g2); }
      for (const gt of gts) gates.push({ t: [at(s, gt - 1), at(s, gt), at(s, gt + 1)] });
      // wall pieces from the gates outwards (the parts next to a gate close first)
      const gap = t => Math.min(...gts.map(gt => Math.abs(t - gt)));
      const rest = [...span].filter(t => gap(t) > 1).sort((a, b) => gap(a) - gap(b) || a - b);
      for (const t of rest) tiles.push(at(s, t));
    }
    // corners between two walled sides: a tower (toward the enemy first) or three wall pieces
    const corners = [];
    for (const s of sides) {
      const s2 = (s + 1) % 4; if (!sides.includes(s2)) continue;
      const ex = cx + (NRM[s][0] || NRM[s2][0]) * R, ez = cz + (NRM[s][1] || NRM[s2][1]) * R, sx = Math.sign(ex - cx), sz = Math.sign(ez - cz);
      const fillT = [[ex - sx, ez], [ex, ez], [ex, ez - sz]].filter(([x, z]) => ok(x, z));
      corners.push({ at: [ex - 1, ez - 1], fillT, score: sx * ed.x + sz * ed.z });
    }
    corners.sort((a, b) => b.score - a.score);
    corners.forEach((k, i) => {
      if (i < d.wallTowers && this.unlocked('building', 'tower')) towers.push({ at: k.at, fillT: k.fillT, fill: false });
      else for (const t of k.fillT) tiles.push(t);
    });
    return { cx, cz, R, sides, tiles, gates, towers, bad: [], t0: g.time };
  }
  // flood fill from the town center over the AI's own walkable tiles in a box round the ring, without and with the
  // tiles in blk (a set of z*N+x) blocked: false if anything reachable before (an own building, a villager, the
  // resource it works, a tile on the box's edge) would no longer be reachable
  // the tiles the town center reaches over our walkable ground in the box round a ring (radius R + 6), with the
  // tiles in blk (a set of z*N+x, or null) blocked; at(x, z) reads it
  _wallFlood(c, cx, cz, R, blk) {
    const g = this.game, N = g.map.size, pid = this.pid, tc = c.tc;
    const x0 = Math.max(1, cx - R - 6), x1 = Math.min(N - 2, cx + R + 6), z0 = Math.max(1, cz - R - 6), z1 = Math.min(N - 2, cz + R + 6);
    const w = x1 - x0 + 1, h = z1 - z0 + 1, seen = new Uint8Array(w * h), q = [];
    const P = g._passMap(pid);
    // (foundations block nobody until they are finished, 2026-11-14; the flood counts them as the walls they become)
    const fnd = new Uint8Array(w * h);
    for (const b of g.buildings) {
      if (b.done || b.dead || g._solidV(b) !== 1 || b.tx > x1 || b.tz > z1 || b.tx + b.size <= x0 || b.tz + b.size <= z0) continue;
      for (let j = 0; j < b.size; j++) for (let i = 0; i < b.size; i++) { const x = b.tx + i, z = b.tz + j; if (x >= x0 && x <= x1 && z >= z0 && z <= z1) fnd[(z - z0) * w + x - x0] = 1; }
    }
    const okc = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1 && P[z * N + x] === 1 && !fnd[(z - z0) * w + x - x0] && !(blk && blk.has(z * N + x));
    if (tc) for (let x = tc.tx - 1; x <= tc.tx + tc.size; x++) for (let z = tc.tz - 1; z <= tc.tz + tc.size; z++) {
      if (x >= tc.tx && x < tc.tx + tc.size && z >= tc.tz && z < tc.tz + tc.size) continue;
      if (okc(x, z) && !seen[(z - z0) * w + x - x0]) { seen[(z - z0) * w + x - x0] = 1; q.push(x, z); }
    }
    for (let i = 0; i < q.length; i += 2) {
      const qx = q[i], qz = q[i + 1];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const nx = qx + dx, nz = qz + dz;
        if (!okc(nx, nz)) continue; const k = (nz - z0) * w + nx - x0; if (seen[k]) continue;
        if (dx && dz && (!okc(nx, qz) || !okc(qx, nz))) continue;
        seen[k] = 1; q.push(nx, nz);
      }
    }
    return { x0, x1, z0, z1, at: (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1 && seen[(z - z0) * w + x - x0] === 1 };
  }
  _wallSafe(c, blk) {
    const g = this.game, W = this.wall, N = g.map.size;
    if (!W || !c.tc) return false;
    const FA = this._wallFlood(c, W.cx, W.cz, W.R, null), FB = this._wallFlood(c, W.cx, W.cz, W.R, blk);
    const { x0, x1, z0, z1 } = FA, A = FA, B = FB;
    const at = (S, x, z) => S.at(x, z);
    const near = (S, bx, bz, s) => { for (let x = bx - 1; x <= bx + s; x++) for (let z = bz - 1; z <= bz + s; z++) if (at(S, x, z)) return true; return false; };
    for (const b of c.blds) {
      if (b.dead || b.type === 'wall' || b.type === 'gate' || b.type === 'rail') continue;
      if (b.tx + b.size < x0 || b.tx > x1 || b.tz + b.size < z0 || b.tz > z1) continue;
      if (near(A, b.tx, b.tz, b.size) && !near(B, b.tx, b.tz, b.size)) return false;
    }
    for (const v of c.vills) {
      const vx = v.x | 0, vz = v.z | 0;
      if (!blk.has(vz * N + vx) && at(A, vx, vz) && !at(B, vx, vz)) return false;
      let o = v.order; if (o && o.type === 'return' && o.resume) o = o.resume;
      const t = o && o.targetId != null ? g.getEntity(o.targetId) : null;
      if (t && !t.dead && t.kind === 'resource') { const rx = t.x | 0, rz = t.z | 0; if (near(A, rx, rz, 1) && !near(B, rx, rz, 1)) return false; }
    }
    for (let x = x0; x <= x1; x++) for (const z of [z0, z1]) if (at(A, x, z) && !at(B, x, z)) return false;
    for (let z = z0; z <= z1; z++) for (const x of [x0, x1]) if (at(A, x, z) && !at(B, x, z)) return false;
    return true;
  }
  // a new building must not stand on the planned ring (or a corner tower's spot) nor in front of / behind a gate
  _wallClash(tx, tz, size) {
    const W = this.wall; if (!W) return false;
    for (const gt of W.gates) { const [mx, mz] = gt.t[1]; if (tx - 4 <= mx && tx + size + 3 >= mx && tz - 4 <= mz && tz + size + 3 >= mz) return true; }
    for (let z = tz - 1; z <= tz + size; z++) for (let x = tx - 1; x <= tx + size; x++) {
      const r = Math.max(Math.abs(x - W.cx), Math.abs(z - W.cz));
      if (r >= W.R - 2 && r <= W.R + 1) {
        const s = Math.abs(x - W.cx) >= Math.abs(z - W.cz) ? (x > W.cx ? 0 : 2) : (z > W.cz ? 1 : 3);
        if (W.sides.includes(s)) return true;
      }
    }
    return false;
  }

  // ---------- placement ----------
  findSpot(type, cx, cz, minR, maxR, dir) {
    const g = this.game, def = BUILDINGS[type];
    if (!def) return null;
    // (big footprints - the 12x12 farm - on a finer grid: on a coarse one a free spot rarely lines up)
    const N = g.map.size, size = def.size || 1, step = size >= 9 ? 3 : size <= 3 ? 2 : size + 1;   // (3x3 towers too: a 4-grid round a camp has ~5 spots)
    const bx = Math.floor(cx), bz = Math.floor(cz);
    for (let r = minR; r <= maxR; r++) {
      const cands = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const tx = bx + dx, tz = bz + dz;
          if (tx < 2 || tz < 2 || tx + size > N - 2 || tz + size > N - 2) continue;
          if (((tx % step) + step) % step !== 0 || ((tz % step) + step) % step !== 0) continue;
          const L = Math.hypot(dx, dz) || 1;
          cands.push([tx, tz, (dir ? -(dx * dir.x + dz * dir.z) / L : 0) + this.rand() * 0.8]);
        }
      }
      cands.sort((a, b) => a[2] - b[2]);
      for (const [tx, tz] of cands) {
        if (dir && r > minR + 2) { /* keep looking along preferred side first */ }
        // (seen ground only - its centre, or for a big footprint one of its corners: a 12x12 farm's centre lies
        //  beyond the base's sight even when its near corner is right at the edge of it)
        const seen = this.explored(tx + size / 2, tz + size / 2) || (size >= 6 && [[0, 0], [size, 0], [0, size], [size, size]].some(([ox, oz]) => this.explored(tx + ox, tz + oz)));
        if (seen && !(this.wall && this._wallClash(tx, tz, size)) && !this._lostNear(tx + size / 2, tz + size / 2, size / 2) && this.safe(() => g.canPlace(type, tx, tz, this.pid))) return { tx, tz };
      }
    }
    return null;
  }

  tryBuild(c, type, minR, maxR, at, nBuilders, dir) {
    const g = this.game, def = BUILDINGS[type];
    if (!def || !this.unlocked('building', type) || !g.canAfford(this.pid, def.cost)) return false;
    const small = type === 'farm' || type === 'pasture';
    if (!small && type !== 'towncenter' && c.work && c.work.build >= Math.max(3, Math.ceil(c.vills.length * 0.16))) return false;
    const ctr = at || c.home;
    const key = type + ':' + Math.round(ctr.x / 4) + ':' + Math.round(ctr.z / 4);
    if (this.failPlace[key] && g.time - this.failPlace[key] < 20) return false;
    const size = def.size || 1;
    const spot = this.findSpot(type, ctr.x - size / 2, ctr.z - size / 2, minR, maxR, dir);
    if (!spot) { this.failPlace[key] = g.time; return false; }
    const cx = spot.tx + size / 2, cz = spot.tz + size / 2;
    const work = c.work;
    const ids = [];
    const n = nBuilders || (size >= 3 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const v = this._nearestVill(c, cx, cz, work || { list: { food: [], wood: [], gold: [], stone: [] }, idle: [], cnt: {} }, true);
      if (!v || ids.includes(v.id)) break;
      ids.push(v.id);
      if (work) this._release(work, v);
      v._aiBusy = true;
    }
    if (!ids.length) return false;
    const id = g.placeBuilding(this.pid, type, spot.tx, spot.tz, ids);
    for (const vid of ids) { const v = g.getEntity(vid); if (v) delete v._aiBusy; }
    if (id == null || id === false) { this.failPlace[key] = g.time; return false; }
    for (const vid of ids) this.assignT.set(vid, g.time);
    if (c.work) c.work.build += ids.length;
    const b = g.getEntity(id); if (b) c.blds.push(b);
    if (BUILDINGS[type].dropoff) this._idxDirty = true;
    return true;
  }

  // drop-off camps next to far-away resources (wood / mines). Capped (2026-11-14, the AI used to build hundreds):
  // at most _campCap() lumber camps and as many mine camps, a lumber camp only beside a real forest (CAMP_TREES
  // trees close by) and a mine camp beside a deposit, never within CAMP_GAP tiles of another camp of its kind.
  // No more mills (legacy): food goes to the town center / a storage.
  camps(c) {
    const { blds, vills } = c;
    if (vills.length < 4) return false;
    const CAMPS = [['lumbercamp', ['wood'], 6], ['minecamp', ['stone', 'gold'], 5]];
    for (const [type, kinds, far] of CAMPS) {
      const def = BUILDINGS[type];
      if (!def || blds.some(b => b.type === type && !b.done) || !this.unlocked('building', type)) continue;
      if (this.countB(c, type) >= this._campCap() || !c.can(def.cost)) continue;
      let n = 0, sx = 0, sz = 0;
      const drops = blds.filter(b => { const dd = BUILDINGS[b.type].dropoff; return dd && kinds.some(k => dd.includes(k)); });
      for (const v of vills) {
        let o = v.order; if (o && o.type === 'return') o = o.resume;
        if (!o || o.type !== 'gather' || o.rt === 'farm' || o.rt === 'pasture' || !kinds.includes(o.res)) continue;
        let near = Infinity; for (const b of drops) near = Math.min(near, Math.sqrt(d2(b.x, b.z, o.x, o.z)) - b.size / 2);
        if (near < far) continue;
        n++; sx += o.x; sz += o.z;
      }
      if (n < 2) continue;
      const at = this._campSite(c, type, { x: sx / n, z: sz / n });
      if (at && this.tryBuild(c, type, 0, 5, at, 1)) return true;
    }
    return false;
  }
  _campCap() { return this.game.map.size >= 448 ? 4 : 3; }
  // may a camp of this type stand by the resource at (x, z): no camp of its kind within CAMP_GAP, a real forest /
  // a deposit around it (explored tiles only), no fresh ruin there
  _campOk(c, type, x, z) {
    const g = this.game, N = g.map.size, lumber = type === 'lumbercamp';
    if (c.blds.some(b => b.type === type && d2(b.x, b.z, x, z) < CAMP_GAP * CAMP_GAP)) return false;
    if (this._lostNear(x, z)) return false;
    const R = lumber ? 6 : 4, need = lumber ? CAMP_TREES : CAMP_MINES;
    let n = 0;
    for (let tz = Math.max(0, Math.floor(z - R)); tz <= Math.min(N - 1, Math.floor(z + R)); tz++) for (let tx = Math.max(0, Math.floor(x - R)); tx <= Math.min(N - 1, Math.floor(x + R)); tx++) {
      const id = g.resAt[tz * N + tx]; if (!id) continue;
      const e = g.entities.get(id); if (!e || e.dead || !(e.amount > 0)) continue;
      if (lumber ? e.type !== 'tree' : e.type !== 'stone' && e.type !== 'gold') continue;
      if (d2(e.x, e.z, x, z) > R * R || !this.explored(e.x, e.z)) continue;
      if (++n >= need) return true;
    }
    return false;
  }
  // where to put a camp: by the known resource nearest 'at' (within 10; at = null: nearest home) that passes
  // _campOk, a little toward home; null when none qualifies or the cap is reached
  _campSite(c, type, at) {
    if (this.countB(c, type) >= this._campCap()) return null;
    const idx = this._resIndex(c), list = type === 'lumbercamp' ? idx.tree : idx.gold.concat(idx.stone);
    const ref = at || c.home, cand = [];
    for (const e of list) {
      if (e.dead || !(e.amount > 0) || this._unsafe(e.x, e.z)) continue;
      const dd = d2(e.x, e.z, ref.x, ref.z); if (at ? dd > 10 * 10 : dd > 34 * 34) continue;
      cand.push([dd, e.id, e]);
    }
    cand.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (let i = 0; i < cand.length && i < 24; i++) {
      const e = cand[i][2]; if (!this._campOk(c, type, e.x, e.z)) continue;
      const hx = c.home.x - e.x, hz = c.home.z - e.z, hl = Math.hypot(hx, hz) || 1;
      return { x: e.x + hx / hl * 2.5, z: e.z + hz / hl * 2.5 };
    }
    return null;
  }

  // sell what floats well above the shopping list for what is short
  market(c) {
    const g = this.game, me = c.me;
    if (!c.blds.some(b => b.type === 'market' && b.done)) return;
    const s = c.shop || {}, R = c.reserve || {};
    for (let i = 0; i < 3; i++) {
      let buy = null, bd = 99;
      for (const k of RK) { const dd = (s[k] || 0) + (R[k] || 0) - (me.res[k] || 0); if (dd > bd) { bd = dd; buy = k; } }
      // lopsided surplus: a resource nearly empty while another piles up, even if nothing is listed yet
      if (!buy && c.surge) { let lo = 350; for (const k of ['wood', 'food', 'gold']) if ((me.res[k] || 0) < lo) { lo = me.res[k] || 0; buy = k; } }
      if (!buy) return;
      let sell = null, sv = 0;
      for (const k of RK) {
        if (k === buy) continue;
        // what is held beyond its own 2-minute need (with a margin that is wider for weaker players)
        const extra = (me.res[k] || 0) - (s[k] || 0) * this.d.tradeMul - 250 - (R[k] || 0);
        if (extra >= 100 && extra > sv) { sv = extra; sell = k; }
      }
      if (!sell || !g.trade(this.pid, sell, buy)) return;
      this.trades++;
    }
  }

  // ---------- railway (age 4): two stations 14-20 tiles apart + a rail line between them ----------
  _railAI(c) {
    const { g, me, blds, vills } = c;
    if (me.age < 4 || vills.length < 10 || !BUILDINGS.station || !this.unlocked('building', 'station')) return;
    if (g.time - (this.railT || 0) < 8) return; this.railT = g.time;
    if (this.railFail && g.time - this.railFail < 60) return;
    const res = me.res; if ((res.wood || 0) < 500 || (res.stone || 0) < 300) return;
    if (!c.can(BUILDINGS.station.cost)) return;
    const sts = blds.filter(b => b.type === 'station');
    if (sts.some(b => !b.done) || blds.some(b => b.type === 'rail' && !b.done)) return;
    const pairs = this.safe(() => g.railPairs()) || [];
    const myPairs = pairs.filter(p => p.owner === this.pid);
    const unpaired = sts.filter(b => !myPairs.some(p => p.a === b.id || p.b === b.id));
    if (!unpaired.length && myPairs.length >= this.d.rails) return;
    if (unpaired.length === 0) { if (!this.tryBuild(c, 'station', 7, 18, c.home, 2, { x: -c.edir.x, z: -c.edir.z })) this.railFail = g.time; return; }
    if (unpaired.length === 1) {
      const s = unpaired[0], a0 = Math.atan2(s.z - c.home.z, s.x - c.home.x);
      for (const da of [Math.PI / 2, -Math.PI / 2, 0, Math.PI]) {
        const a = a0 + da, at = { x: s.x + Math.cos(a) * 17, z: s.z + Math.sin(a) * 17 };
        const spot = this.findSpot('station', at.x - 1.5, at.z - 1.5, 0, 3);
        if (!spot) continue;
        const dd = Math.hypot(spot.tx + 1.5 - s.x, spot.tz + 1.5 - s.z); if (dd < 14 || dd > 21) continue;
        const b = vills.slice().sort((p, q) => d2(p.x, p.z, at.x, at.z) - d2(q.x, q.z, at.x, at.z)).slice(0, 2).map(v => v.id);
        if (g.placeBuilding(this.pid, 'station', spot.tx, spot.tz, b) != null) return;
      }
      this.railFail = g.time; return;
    }
    const fin = unpaired.filter(b => b.done);
    if (fin.length < 2) return;
    const A = fin[0], B = fin.slice(1).sort((p, q) => d2(p.x, p.z, A.x, A.z) - d2(q.x, q.z, A.x, A.z))[0];
    const adj = (s, o) => g._railAdj(s).sort((p, q) => d2(p[0] + 0.5, p[1] + 0.5, o.x, o.z) - d2(q[0] + 0.5, q[1] + 0.5, o.x, o.z));
    const N = g.map.size, own = new Set(blds.filter(b => b.type === 'rail').map(b => b.tz * N + b.tx));
    const okT = (x, z) => own.has(z * N + x) || g.canPlace('rail', x, z, this.pid);
    for (const sa of adj(A, B).slice(0, 3)) for (const sb of adj(B, A).slice(0, 3)) for (const xFirst of [true, false]) {
      const tiles = []; let x = sa[0], z = sa[1]; tiles.push([x, z]);
      const mvX = () => { while (x !== sb[0]) { x += Math.sign(sb[0] - x); tiles.push([x, z]); } }, mvZ = () => { while (z !== sb[1]) { z += Math.sign(sb[1] - z); tiles.push([x, z]); } };
      if (xFirst) { mvX(); mvZ(); } else { mvZ(); mvX(); }
      if (!tiles.every(t => okT(t[0], t[1]))) continue;
      const todo = tiles.filter(t => !own.has(t[1] * N + t[0]));
      const cost = BUILDINGS.rail.cost; if (!g.canAfford(this.pid, { wood: (cost.wood || 0) * todo.length, stone: (cost.stone || 0) * todo.length })) return;
      const mid = tiles[tiles.length >> 1];
      const b = vills.slice().sort((p, q) => d2(p.x, p.z, mid[0], mid[1]) - d2(q.x, q.z, mid[0], mid[1])).slice(0, 3).map(v => v.id);
      g.placeLine(this.pid, 'rail', todo, b); return;
    }
    this.railFail = g.time;
  }

  // ---------- naval: one dock if (explored) water + fish lie near home, fishing boats, a few guard warships ----------
  _navAI(c) {
    const { g, me, blds, units, vills } = c;
    if (!BUILDINGS.dock || !UNITS.fishboat || typeof g._navShoals !== 'function') return;
    if (g.time - (this.navT || 0) < 5) return; this.navT = g.time;
    if (this.navNo && g.time < this.navNo) return;
    const docks = blds.filter(b => b.type === 'dock');
    const shoals = g._navShoals().filter(s => this.explored(s.x, s.z));
    if (!docks.length) {
      if (me.age > 1 || vills.length < 6 || !this.unlocked('building', 'dock') || !c.can(BUILDINGS.dock.cost)) return;
      if ((this.navTries || 0) >= 3) { this.navNo = Infinity; return; }
      if (!shoals.some(s => d2(s.x, s.z, c.home.x, c.home.z) < 32 * 32)) { this.navNo = g.time + 60; return; }
      const hx = Math.floor(c.home.x), hz = Math.floor(c.home.z); let best = null, bd = 1e9;
      for (let tz = hz - 25; tz <= hz + 25; tz++) for (let tx = hx - 25; tx <= hx + 25; tx++) {
        const dd = d2(tx + 1.5, tz + 1.5, c.home.x, c.home.z); if (dd > 625 || dd >= bd) continue;
        if (!this.explored(tx + 1.5, tz + 1.5)) continue;
        if (this.safe(() => g.canPlace('dock', tx, tz, this.pid))) { best = { tx, tz }; bd = dd; }
      }
      if (!best) { this.navNo = g.time + 90; return; }
      this.navTries = (this.navTries || 0) + 1;
      const b = vills.slice().filter(v => !v.order || v.order.type !== 'build').sort((p, q) => d2(p.x, p.z, best.tx, best.tz) - d2(q.x, q.z, best.tx, best.tz)).slice(0, 2).map(v => v.id);
      g.placeBuilding(this.pid, 'dock', best.tx, best.tz, b);
      return;
    }
    const dock = docks.find(b => b.done); if (!dock) return;
    const boats = units.filter(u => u.type === 'fishboat'), war = units.filter(u => UNITS[u.type] && UNITS[u.type].naval && UNITS[u.type].atk > 0);
    const wantBoats = this.difficulty === 'easy' ? 2 : this.difficulty === 'normal' ? 3 : 4;
    for (const b of boats) if (!b.order) { const s = this._shoalNear(shoals, dock); if (s) g.cmdGather([b.id], s.id); }
    if (!(dock.queue || []).length) {
      if (boats.length < wantBoats) { if (c.can(UNITS.fishboat.cost)) g.train(dock.id, 'fishboat'); }
      else if (me.age >= 1 && war.length < (wantBoats > 2 ? 3 : 2)) {
        for (const id of ['ironclad', 'galleon', 'galley']) { const ud = UNITS[id]; if (ud && this.unlocked('unit', id) && c.can(ud.cost)) { g.train(dock.id, id); break; } }
      }
    }
    if (!war.length) return;
    let tgt = null, td = 20 * 20;
    for (const m of this.mem.values()) { if (m.kind !== 'unit' || !m.naval || m.st !== this.vstamp) continue; const dd = d2(m.x, m.z, dock.x, dock.z); if (dd < td) { td = dd; tgt = m; } }
    if (!tgt && war.length >= 2) { let bd = 34 * 34; for (const m of this.mem.values()) { if (m.kind !== 'building' || m.type !== 'dock') continue; const dd = d2(m.x, m.z, dock.x, dock.z); if (dd < bd) { bd = dd; tgt = m; } } }
    const free = war.filter(w => !w.order || w.order.auto);
    if (tgt) { const f = free.filter(w => !(w.order && w.order.targetId === tgt.id)); if (f.length) g.cmdAttack(f.map(w => w.id), tgt.id); return; }
    const s = this._shoalNear(shoals, dock), gx = s ? s.x : dock.x, gz = s ? s.z : dock.z;
    const idle = war.filter(w => !w.order && d2(w.x, w.z, gx, gz) > 8 * 8);
    if (idle.length) g.cmdMove(idle.map(w => w.id), gx, gz);
  }

  _shoalNear(shoals, at) { let best = null, bd = Infinity; for (const s of shoals) { if (s.dead || s.amount <= 0) continue; const dd = d2(s.x, s.z, at.x, at.z); if (dd < bd) { bd = dd; best = s; } } return best; }

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

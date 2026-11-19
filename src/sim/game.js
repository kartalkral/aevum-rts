// Aevum — headless simulation core (pure JS, no DOM/three)
import { combatMethods } from './game-combat.js';
import { saveMethods } from './game-save.js';
import { installMethods } from '../method-table.js';
import { AGES, UNITS, BUILDINGS, TECHS, PLAYER_COLORS, FARM_SLOTS } from '../data.js';
// big farm: cells (x, z) of its 3x3 grid, ring order around the granary (1, 1); food / s of a farmer while his plot is ripe
export const FARM_CELLS = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
const FARM_RATE = 16 / 9 * 0.85;
const FARM_SPOT_S = 5;   // seconds a farmer hoes on one spot of his plot before moving on along the row
import { AIController } from './ai.js';
import { QuestSystem } from './quests.js';
import { TOWER_AGE_ATK, towerAgeBonus, BUILD_TIME_MUL, QUEUE_TIME_MUL, unitLos, buildingLos, forDisc, makeMap } from './game-shared.js';
export { BUILD_TIME_MUL, QUEUE_TIME_MUL, MAX_WEAPON_RANGE, COMBAT_LOS, unitLos, buildingLos, TOWER_AGE_ATK, TOWER_AGE_RANGE, towerAgeBonus, forDisc } from './game-shared.js';

const RES_OF = { tree: 'wood', stone: 'stone', gold: 'gold', berries: 'food', deer: 'food', fish: 'food' };
const RATE = { tree: 0.42, stone: 0.36, gold: 0.36, berries: 0.4, deer: 0.5 };
// stand spots per resource tile (deer move: none) and their offsets from the tile centre (sides, then corners)
const SPOTS = { stone: 4, gold: 4, tree: 3, berries: 3 }, SPOT_R = 6, SPOT_BOX = 8, SPOT_O = [0, 1.3, 1.3, 0, 0, -1.3, -1.3, 0, 1.12, 1.12, 1.12, -1.12, -1.12, -1.12, -1.12, 1.12];
const ANIM_OF = { tree: 'chop', stone: 'mine', gold: 'mine', berries: 'forage', deer: 'forage' };
// unit stances (owner 2026-11-15: a catapult behind the wall walked out of the gate and died): aggressive chases as
// before; defensive chases at most DEF_LEASH tiles from where it stood and walks back; hold never moves for an auto
// fight (only what is in weapon reach). A player's own order is always obeyed.
export const STANCES = ['aggressive', 'defensive', 'hold'];
// body radius per class for the idle separation (two infantry stay 0.56 apart as before; siege engines need more room)
const SEP_R = { siege: 0.75, cavalry: 0.38, other: 0.28 };
const CELL = 4;
const FF_GAP = 15;   // ticks between two rebuilds of one group's stale flow field (see _flowField)
const FF_WALK = 1500;   // flow-field route cells walked per tick (300 units starting a long trip spread over a few ticks)
const FF_MARGIN = 32;   // a group's field reaches this many steps beyond its furthest unit (see _ffSweep)
const FF_SEG = 64;   // cells of one flow-field route; a unit asks for the next stretch at its end (cheap: the field stays)
const TRADE_VAL = { food: 1, wood: 1, stone: 1.3, gold: 2 };
const BARTER_BONUS = 1.15;   // resource for resource at the market: one step, a bit better than selling then buying
const TRIBUTE_RES = ['food', 'wood', 'stone', 'gold'];
// players start with this many villagers (owner 2026-11-14: 3 -> 5; AI and multiplayer starts alike)
export const START_VILLAGERS = 20;   // (owner 2026-11-14: a quick start)
// pasture without herders: food / s per sheep (8 sheep 0.32 food/s; a fully worked big farm makes ~3.1 food/s) and the
// seconds one more sheep takes to grow up to PASTURE_SHEEP
export const PASTURE_IDLE_RATE = 0.04, PASTURE_GROW_S = 45, PASTURE_SHEEP = 8;
// the temple heals own units within this many tiles of its centre (the view draws it when a temple is selected)
export const TEMPLE_HEAL_R = 7;
// the castle shoots a volley at up to this many targets every 2 s, its attack +4 per age (2026-11-17 playtest)
export const CASTLE_VOLLEY = 3, CASTLE_AGE_ATK = 4;
// from the Gunpowder Age on, towers fire cannonballs (with their splash) instead of arrows
export const TOWER_CANNON_AGE = 3;
// a building queues as many units as the player can pay for (paid when queued); this only stops runaway queues
export const TRAIN_QUEUE_MAX = 100;
// wood in one tree (owner decision 2026-11-12: a tree is worth as much as a big mine)
export const TREE_WOOD = 800;
// commands a client may send over the network (Game.execCommand); the app may wrap these on the instance
export const CMD_METHODS = ['cmdMove', 'cmdAttack', 'cmdGather', 'cmdBuild', 'cmdStop', 'cmdExplore', 'cmdBoard', 'cmdUnload', 'cmdReturn', 'placeBuilding', 'placeLine', 'train', 'research', 'ageUp', 'cancelQueue', 'setRally', 'trade', 'deleteEntity', 'cmdOpenGate', 'cmdTribute', 'cmdGroup', 'cmdStance'];
const CMD_SET = new Set(CMD_METHODS);
const _strH = new Map();
function strHash(s) { let h = _strH.get(s); if (h !== undefined) return h; h = 2166136261; const t = String(s); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); h >>>= 0; _strH.set(s, h); return h; }
// start spots (fractions of N) for cfg.players games: a ring, so consecutive players (sorted by team) sit side by side
const RING4 = [[0.2, 0.8], [0.2, 0.2], [0.8, 0.2], [0.8, 0.8]];
const RING8 = [[0.2, 0.8], [0.14, 0.5], [0.2, 0.2], [0.5, 0.14], [0.8, 0.2], [0.86, 0.5], [0.8, 0.8], [0.5, 0.86]];
// map types (cfg.mapType; 'random' resolves from the seed in _generate)
export const MAP_TYPES = ['river', 'continent', 'highlands', 'plains', 'inlandsea', 'islands'];
// per-type terrain: base/amp hills, mountains (mt threshold, mg gain, mc cap), lakes (lt threshold, lg gain), river,
// start plateau (pi inner radius, po blend radius), forest share of open land (fs), grass variant threshold (vt), shape mask, sea border
const MAP_P = {
  river: { base: 0.45, amp: 2.2, mt: 0.63, mg: 45, mc: 5, lt: 0.33, lg: 30, river: true, pi: 9, po: 16, fs: 0.2, vt: 0.6 },
  continent: { base: 0.5, amp: 2.0, mt: 0.66, mg: 40, mc: 5, lt: 0.28, lg: 30, pi: 12, po: 20, fs: 0.2, vt: 0.6, shape: 'continent', border: true },
  highlands: { base: 0.8, amp: 2.0, mt: 0.66, mg: 45, mc: 5, lt: 0.2, lg: 30, ridge: true, pi: 9, po: 16, fs: 0.24, vt: 0.6 },
  plains: { base: 0.75, amp: 1.0, mt: 9, mg: 0, mc: 0, lt: 0.31, lg: 25, pi: 9, po: 16, fs: 0.14, vt: 0.58 },
  inlandsea: { base: 0.5, amp: 2.0, mt: 0.67, mg: 40, mc: 5, lt: 0.25, lg: 30, pi: 12, po: 20, fs: 0.2, vt: 0.6, shape: 'inlandsea' },
  islands: { base: 0.55, amp: 1.6, mt: 0.7, mg: 40, mc: 4, lt: 0.2, lg: 30, pi: 12, po: 20, fs: 0.18, vt: 0.6, shape: 'islands', border: true },
};

class Events {
  constructor() { this.m = new Map(); }
  on(n, f) { if (!this.m.has(n)) this.m.set(n, []); this.m.get(n).push(f); return f; }
  off(n, f) { const a = this.m.get(n); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
  emit(n, p) { const a = this.m.get(n); if (!a) return; for (const f of a.slice()) { try { f(p); } catch (err) { console.error('[event ' + n + ']', err); } } }
}

export class Game {
  constructor(cfg = {}, saved = null) {
    this.cfg = Object.assign({ mapSize: 128, enemies: 1, difficulty: 'normal', startRes: 'normal', startAge: 0, sandbox: false, seed: 12345, mapType: 'river' }, cfg);
    if (![96, 128, 160, 192, 256, 320, 384, 448, 512].includes(this.cfg.mapSize)) this.cfg.mapSize = 128;
    if (!MAP_TYPES.includes(this.cfg.mapType) && this.cfg.mapType !== 'random') this.cfg.mapType = 'river';
    // multiplayer: cfg.players [{kind, team, difficulty?, name?}] (index = player id), cfg.me = local human (view only)
    this.mp = !!this.cfg.mp;
    if (this.mp) this.cfg.sandbox = false;
    this.me = Math.max(0, this.cfg.me | 0);
    this.tick = 0;
    this.events = new Events();
    this.time = 0; this.nextId = 1; this.over = null;
    this.rs = (this.cfg.seed | 0) || 1;
    this.entities = new Map(); this.units = []; this.buildings = []; this.deer = [];
    this.projectiles = []; this.players = [];
    this.fogVersion = 0; this._fogT = 0; this._winT = 2; this._uaT = 0; this._uaLast = -1e9; this._uaX = null; this._uaZ = 0; this._popWarnT = 0;
    const N = this.cfg.mapSize;
    this.fog = new Uint8Array(N * N);
    if (this.cfg.fog === 'explored') this.fog.fill(1);   // (explored map, owner 2026-11-15: the land is known from the start)
    this.resAt = new Int32Array(N * N);
    this._g = new Float32Array(N * N); this._st = new Int32Array(N * N); this._par = new Int32Array(N * N); this._stamp = 0;
    this._hn = []; this._hf = [];
    const hc = Math.ceil(N / CELL); this._hc = hc; this._cells = []; for (let i = 0; i < hc * hc; i++) this._cells.push([]);
    if (saved) this._restore(saved); else this._generate();
    this._initTeams();
    this.ais = [];
    for (const p of this.players) if (p.isAI) { try { this.ais.push(new AIController(this, p.id, p.difficulty || this.cfg.difficulty)); } catch (err) { console.error('AI init', err); } }
    const noQuests = { list: [], update() {}, serialize() { return null; }, load() {} };
    if (this.mp) this.quests = noQuests;
    else try { this.quests = new QuestSystem(this); } catch (err) { console.error('Quest init', err); this.quests = noQuests; }
    if (saved) {
      try { if (saved.quests) this.quests.load(saved.quests); } catch (err) { console.error(err); }
      (saved.ais || []).forEach((o, i) => { try { if (o && this.ais[i]) this.ais[i].load(o); } catch (err) { console.error(err); } });
    }
    if (this._tvRestored) {
      // exact team grids came with the save: only build the local view copy, the sim keeps its own cadence
      this._tvRestored = false;
      const N = this.map.size;
      for (const p of this.players) if (!this._tv.has(p.team)) this._tv.set(p.team, new Uint8Array(N * N));
      const mine = this._tv.get(this.teamOf(this.me)); if (mine) this.fog.set(mine);
      this.fogVersion++;
    } else this._updateFog();
  }

  rand() { let t = (this.rs += 0x6D2B79F5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

  // ---------- players / teams ----------
  _cfgPlayers() { const cp = this.cfg.players; return Array.isArray(cp) && cp.length ? cp.slice(0, 8) : null; }
  // fills team/kind/name for every player (legacy cfg and old saves: player 0 human on team 1, every AI on team 2)
  _initTeams() {
    const cp = this._cfgPlayers();
    for (const p of this.players) {
      const c = cp && cp[p.id];
      if (p.team == null) p.team = c && c.team != null ? Math.max(0, Math.min(15, c.team | 0)) : (p.isAI ? 2 : 1);
      if (!p.kind) p.kind = p.isAI ? 'ai' : 'human';
      if (p.name == null) p.name = (c && c.name) ? String(c.name).slice(0, 24) : (p.isAI ? 'Bilgisayar ' + p.id : 'Oyuncu ' + (p.id + 1));
      if (p.difficulty == null && c && c.difficulty) p.difficulty = c.difficulty;
    }
    this._tm = new Int16Array(Math.max(8, this.players.length)).fill(-1);
    for (const p of this.players) this._tm[p.id] = p.team;
    if (this.me >= this.players.length) this.me = 0;
  }
  teamOf(pid) { return pid >= 0 && pid < this._tm.length ? this._tm[pid] : -1; }
  isAlly(a, b) { if (a === b) return a >= 0; if (!(a >= 0) || !(b >= 0)) return false; const ta = this.teamOf(a); return ta >= 0 && ta === this.teamOf(b); }
  isEnemy(a, b) { if (a === b || !(a >= 0) || !(b >= 0)) return false; const ta = this.teamOf(a), tb = this.teamOf(b); return ta >= 0 && tb >= 0 && ta !== tb; }
  _mpStarts(cp, N) {
    const np = cp.length, ring = np <= 4 ? RING4 : RING8, R = ring.length;
    const order = cp.map((c, i) => ({ i, t: (c && c.team) | 0 })).sort((a, b) => a.t - b.t || a.i - b.i);
    const starts = new Array(np);
    order.forEach((o, k) => { const f = ring[Math.round(k * R / np) % R]; starts[o.i] = [Math.round(f[0] * N), Math.round(f[1] * N)]; });
    return starts;
  }
  // unsigned 32-bit FNV-style hash over simulation state only (no fog, no cfg.me, no view data)
  hash() {
    let h = 2166136261;
    const mix = v => { h = Math.imul(h ^ (v | 0), 16777619); };
    mix(this.tick); mix(this.rs); mix(this.nextId); mix(this.units.length); mix(this.buildings.length); mix(this.projectiles.length);
    for (const e of this.entities.values()) {
      mix(e.id); mix(strHash(e.type)); mix(e.owner); mix(Math.round(e.x * 100)); mix(Math.round(e.z * 100)); mix(Math.round((e.hp || 0) * 10));
      if (e.kind === 'resource') mix(Math.round((e.amount || 0) * 10)); else if (e.dead) mix(7);
    }
    for (const p of this.players) { mix(p.age); mix(p.pop); mix(p.defeated ? 1 : 0); mix(p.left ? 1 : 0); for (const k of ['food', 'wood', 'stone', 'gold']) mix(Math.round((p.res[k] || 0) * 10)); }
    for (const a of this.ais) mix(a.rs);
    return h >>> 0;
  }
  // run fn with the plain prototype command methods (the app may have wrapped them on the instance to route
  // the local player's input through the network; the simulation itself and the AIs must never hit those wrappers)
  _sim(fn) {
    if (this._inSim) return fn();
    let saved = null;
    for (const m of CMD_METHODS) if (Object.prototype.hasOwnProperty.call(this, m)) { try { const f = this[m]; if (delete this[m]) (saved || (saved = {}))[m] = f; } catch (err) { /* non-configurable: leave it */ } }
    this._inSim = true;
    try { return fn(); } finally { this._inSim = false; if (saved) for (const m in saved) this[m] = saved[m]; }
  }
  // one whitelisted command on behalf of player pid; ids not owned by pid are dropped, owner args forced to pid
  execCommand(pid, method, args) {
    pid = pid | 0;
    if (!CMD_SET.has(method) || !this.players[pid] || this.players[pid].left) return false;
    const a = Array.isArray(args) ? args.slice() : [];
    const own = id => { const e = this.entities.get(id); return !!e && e.owner === pid && !e.dead; };
    const ids = v => Array.isArray(v) ? v.filter(own) : [];
    const fin = v => typeof v === 'number' && Number.isFinite(v);
    switch (method) {
      case 'cmdMove': a[0] = ids(a[0]); if (!a[0].length || !fin(a[1]) || !fin(a[2])) return false; break;
      case 'cmdStance': a[0] = ids(a[0]); if (!a[0].length || !STANCES.includes(a[1])) return false; break;
      case 'cmdAttack': case 'cmdGather': case 'cmdBuild': case 'cmdStop': case 'cmdExplore': case 'cmdBoard': case 'cmdReturn':
        a[0] = ids(a[0]); if (!a[0].length) return false; break;
      case 'cmdUnload': if (!own(a[0]) || !fin(a[1]) || !fin(a[2])) return false; break;
      case 'train': case 'research': case 'ageUp': case 'cancelQueue': case 'deleteEntity': case 'cmdOpenGate': if (!own(a[0])) return false; break;
      case 'setRally': if (!own(a[0]) || !fin(a[1]) || !fin(a[2])) return false; break;
      case 'placeBuilding': a[0] = pid; a[4] = ids(a[4] || []); break;
      case 'placeLine': a[0] = pid; if (!Array.isArray(a[2])) return false; a[2] = a[2].slice(0, 200); a[3] = ids(a[3] || []); break;
      case 'trade': a[0] = pid; break;
      case 'cmdTribute': case 'cmdGroup': a[0] = pid; break;
    }
    try { return this._sim(() => Game.prototype[method].apply(this, a)); } catch (err) { console.error('[execCommand ' + method + ']', err); return false; }
  }
  // mark a disconnected human as gone (agreed turn, same on every client): units stay, they no longer block victory
  markLeft(pid) { const p = this.players[pid]; if (!p || p.left) return false; p.left = true; return true; }
  // an AI takes over a human's civilization (continuing a saved match without that player); same on every client
  convertToAI(pid, difficulty = 'normal') {
    const p = this.players[pid];
    if (!p || p.isAI) return false;
    const d = ['easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal';
    p.isAI = true; p.kind = 'ai'; p.left = false; p.difficulty = d;
    const cp = this._cfgPlayers();
    if (cp && cp[pid]) { this.cfg.players = this.cfg.players.slice(); this.cfg.players[pid] = Object.assign({}, cp[pid], { kind: 'ai', difficulty: d }); }
    try { this.ais.push(new AIController(this, pid, d)); } catch (err) { console.error('AI init', err); return false; }
    this.ais.sort((a, b) => a.pid - b.pid);   // same order as a fresh load (players order), so saves map back
    return true;
  }
  // continue a saved multiplayer match: r = {humans:[pid], idle:[pid], ai:[[pid, difficulty]]}
  // humans who came back play on, absent humans stay idle (marked left) or are taken over by an AI
  applyResume(r) {
    if (!r) return;
    for (const i of r.humans || []) { const p = this.players[i]; if (p && !p.isAI) p.left = false; }
    for (const i of r.idle || []) this.markLeft(i);
    for (const e of r.ai || []) if (Array.isArray(e)) this.convertToAI(e[0] | 0, e[1]);
  }

  // ---------- generation ----------
  _generate() {
    const cfg = this.cfg, N = cfg.mapSize, V = N + 1, seed = cfg.seed | 0;
    const heights = new Float32Array(V * V), tiles = new Uint8Array(N * N), blocked = new Uint8Array(N * N);
    this.map = makeMap(N, heights, tiles, blocked);
    const hsh = (x, y, s) => { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const vn = (x, y, s) => { const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); const a = hsh(xi, yi, s), b = hsh(xi + 1, yi, s), c = hsh(xi, yi + 1, s), d = hsh(xi + 1, yi + 1, s); return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy; };
    const fbm = (x, y, s) => vn(x, y, s) * 0.5 + vn(x * 2, y * 2, s + 7) * 0.27 + vn(x * 4, y * 4, s + 13) * 0.15 + vn(x * 8, y * 8, s + 19) * 0.08;
    const cp = this._cfgPlayers();
    const np = cp ? cp.length : 1 + Math.max(0, Math.min(3, cfg.enemies | 0));
    const fr = [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]];
    let starts = []; for (let i = 0; i < 4; i++) starts.push([Math.round(fr[i][0] * N), Math.round(fr[i][1] * N)]);
    if (cp) starts = this._mpStarts(cp, N);
    const ph = (seed % 7);
    const rx = z => N / 2 + Math.sin(z * 0.07 + ph) * N * 0.07 + Math.sin(z * 0.023 + ph * 2) * N * 0.04;
    const sDist = (x, z) => { let m = 1e9; for (const s of starts) { const d = Math.hypot(x - s[0], z - s[1]); if (d < m) m = d; } return m; };
    // map type: 'random' picks from the seed only (same on every client), written back so saves / UI see the real type
    let mt = cfg.mapType;
    if (mt === 'random') mt = MAP_TYPES[Math.min(MAP_TYPES.length - 1, (hsh(seed, 7331, 911) * MAP_TYPES.length) | 0)];
    if (!MAP_P[mt]) mt = 'river';
    cfg.mapType = mt;
    const P = MAP_P[mt], riv = mt === 'river', SEA = -1.3, H = N / 2;
    const sstep = (a, b, x) => { let t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // non-river plateaus: per start, the inner radius stays clear of the map border (sea border must not cut it)
    // (the flat settling ground around a start: 1.7x since 2026-11-13, sized for the bigger buildings and a town around them)
    const plat = starts.map(s => { const bd = Math.min(s[0], s[1], N - s[0], N - s[1]); const pi = Math.max(6, Math.min(Math.round(P.pi * 1.7), bd - 4)); return [s[0], s[1], pi, pi + Math.round((P.po - P.pi) * 1.7)]; });
    // shape mask: 0 = keep terrain, 1 = open sea
    const shape = !P.shape ? null : P.shape === 'continent' ? (vx, vz) => {
      const dx = Math.abs(vx - H) / H, dz = Math.abs(vz - H) / H, r = Math.max(dx, dz) * 0.55 + Math.hypot(dx, dz) * 0.45;
      return sstep(0.8, 0.92, r + (fbm(vx / N * 5 + 400, vz / N * 5 + 400, seed + 5) - 0.5) * 0.5);
    } : P.shape === 'inlandsea' ? (vx, vz) => {
      const r = Math.hypot(vx - H, vz - H) / H;
      return 1 - sstep(0.44, 0.56, r + (fbm(vx / N * 5 + 400, vz / N * 5 + 400, seed + 5) - 0.5) * 0.45);
    } : (() => { // islands: low-frequency fbm with edge falloff, thresholded at a fixed quantile (stable land share)
      const iq = new Float32Array(V * V);
      for (let vz = 0; vz < V; vz++) for (let vx = 0; vx < V; vx++) iq[vz * V + vx] = fbm(vx / N * 4 + 600, vz / N * 4 + 600, seed + 6) - (1 - sstep(0, 0.14, Math.min(vx, vz, N - vx, N - vz) / N)) * 0.3;
      // ~44 % land overall: the start plateaus count first, the threshold is the quantile of the rest
      const out = []; for (let vz = 0; vz < V; vz++) for (let vx = 0; vx < V; vx++) if (!plat.some(s => Math.hypot(vx - s[0], vz - s[1]) < (s[2] + s[3]) / 2)) out.push(iq[vz * V + vx]);
      out.sort((a, b) => b - a); const thr = out[Math.max(0, Math.min(out.length - 1, Math.round(V * V * 0.44) - (V * V - out.length)))] ?? 9;
      return (vx, vz) => 1 - sstep(thr - 0.03, thr + 0.03, iq[vz * V + vx]);
    })();
    for (let vz = 0; vz < V; vz++) for (let vx = 0; vx < V; vx++) {
      let h = P.base + fbm(vx / N * 5, vz / N * 5, seed) * P.amp;
      const m = fbm(vx / N * 3 + 50, vz / N * 3 + 50, seed + 1);
      if (m > P.mt) h += Math.min(P.mc, (m - P.mt) * P.mg);
      const l = fbm(vx / N * 4 + 100, vz / N * 4 + 100, seed + 2);
      if (l < P.lt) h -= (P.lt - l) * P.lg;
      if (P.ridge) { // winding ridges along a noise contour, broken by passes
        const rr = 1 - Math.abs(fbm(vx / N * 3.5 + 700, vz / N * 3.5 + 700, seed + 7) - 0.5) * 2;
        // (2026-11-13: lower, softer ridges with more and wider passes - they stood like walls and boxed starts in)
        if (rr > 0.9) h += Math.min(3.6, (rr - 0.9) * 45) * sstep(0.42, 0.58, vn(vx / N * 8 + 800, vz / N * 8 + 800, seed + 8));
      }
      if (P.river) {
        const dr = Math.abs(vx - rx(vz)), w = 2.2;
        if (dr < w + 2.5) { const ford = (vz % 26) < 6; const dep = ford ? -0.15 : -0.9; const t = Math.max(0, (dr - w) / 2.5); h = dep + (Math.min(h, 1.2) - dep) * t; }
      }
      if (shape) h += (SEA - h) * shape(vx, vz);
      if (riv) {
        const ds = sDist(vx, vz);
        // (river start ground widened 1.7x with the bigger buildings, 2026-11-13: 9..16 -> 15..27)
        if (ds < 27) { let t = Math.max(0, Math.min(1, (ds - 15) / 12)); t = t * t * (3 - 2 * t); h = 1.0 + (h - 1.0) * t; }
      } else {
        let t = 1; for (const s of plat) { const d = Math.hypot(vx - s[0], vz - s[1]); if (d < s[3]) t = Math.min(t, sstep(s[2], s[3], d)); }
        if (t < 1) h = 1.0 + (h - 1.0) * t;
      }
      if (P.border) { const bd = Math.min(vx, vz, N - vx, N - vz); if (bd < 3) h += (SEA - h) * (bd < 2 ? 1 : 0.6); }
      if (h < -1.5) h = -1.5; if (h > 7) h = 7;
      if (h >= -0.02 && h < 0.2) h = 0.2;
      heights[vz * V + vx] = h;
    }
    this._mapConnect(heights, N, starts.slice(0, np), seed, hsh);
    // Forests take a fixed share (P.fs) of the open land on every seed: the fbm threshold is the matching quantile,
    // so one seed cannot bury the map in trees. Forest is held back from the starts (none within FC0 tiles, thinning
    // in up to FC1) so every player has room to build a town; the start's own wood cluster sits inside that ring.
    // (only the starts in use: single-player keeps 4 corner spots even with fewer players)
    const live = starts.slice(0, np), aDist = (x, z) => { let m = 1e9; for (const s of live) { const d = Math.hypot(x - s[0], z - s[1]); if (d < m) m = d; } return m; };
    const FC0 = 18, FC1 = 28, fv = new Float64Array(N * N).fill(-9), cand = [], grassV = new Uint8Array(N * N);
    for (let tz = 0; tz < N; tz++) for (let tx = 0; tx < N; tx++) {
      const i = tz * V + tx, ha = (heights[i] + heights[i + 1] + heights[i + V] + heights[i + V + 1]) / 4;
      let t = 0;
      if (ha < -0.4) t = 4; else if (ha < 0.05) t = 3; else if (ha < 0.38) t = 2; else if (ha > 3.3) t = 5;
      else {
        const sd = aDist(tx + 0.5, tz + 0.5);
        if (sDist(tx + 0.5, tz + 0.5) >= (riv ? 8 : 13)) {   // (inside that radius: open ground round the start)
          const v = fbm(tx / N * 7 + 200, tz / N * 7 + 200, seed + 3) - (sd < FC0 ? 9 : sd < FC1 ? (FC1 - sd) / (FC1 - FC0) * 0.18 : 0);
          fv[tz * N + tx] = v; cand.push(v);
        }
        if (fbm(tx / N * 6 + 300, tz / N * 6 + 300, seed + 4) > P.vt) t = 1;
      }
      tiles[tz * N + tx] = t;
    }
    if (cand.length && P.fs > 0) {
      cand.sort((a, b) => a - b);
      // (solid groves since 2026-11-14: the grass lanes below cut ~1/5 of it, so the tree count stays about as before)
      const thr = cand[Math.min(cand.length - 1, Math.floor(cand.length * (1 - P.fs)))];
      for (let k = 0; k < N * N; k++) if (fv[k] > -5 && fv[k] >= thr) { grassV[k] = tiles[k]; tiles[k] = 6; }
    }
    // groves, not one mass (owner 2026-11-14: nearly all the wood stood as one solid block by his base): the forest
    // is cut along the edges of jittered Voronoi cells (GC tiles apart) by grass lanes about GW tiles wide, so every
    // wood is a copse of at most ~GC*GC tiles with open land between them (seeded hash only, no rand())
    {
      const GC = 18, GW = 1.6, CN = Math.ceil(N / GC) + 1, sx = new Float64Array(CN * CN), sz = new Float64Array(CN * CN);
      for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) { sx[j * CN + i] = (i + 0.15 + hsh(i, j, seed + 41) * 0.7) * GC; sz[j * CN + i] = (j + 0.15 + hsh(i, j, seed + 43) * 0.7) * GC; }
      for (let tz = 0; tz < N; tz++) for (let tx = 0; tx < N; tx++) {
        const k = tz * N + tx; if (tiles[k] !== 6) continue;
        const x = tx + 0.5, z = tz + 0.5, ci = Math.floor(x / GC), cj = Math.floor(z / GC);
        let d1 = 1e9, d2 = 1e9;
        for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
          if (i < 0 || j < 0 || i >= CN || j >= CN) continue;
          const d = Math.hypot(x - sx[j * CN + i], z - sz[j * CN + i]); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        if (d2 - d1 < GW * 2) tiles[k] = grassV[k];   // (|d2 - d1| / 2 is about the distance to the cell edge)
      }
    }
    // fairness: every start needs FQ forest tiles within FR; one short of that gets up to two groves just outside
    // the town ring, in the direction where the forest noise is highest (so they join the map's own woods when they can)
    const GR = 5, GD = FC0 + GR + 0.5, FR = FC1 + 12, FQ = 120;
    const woodNear = st => { let n = 0; for (let tz = Math.max(0, st[1] - FR | 0); tz < Math.min(N, st[1] + FR); tz++) for (let tx = Math.max(0, st[0] - FR | 0); tx < Math.min(N, st[0] + FR); tx++) if (tiles[tz * N + tx] === 6 && Math.hypot(tx + .5 - st[0], tz + .5 - st[1]) < FR) n++; return n; };
    for (const st of live) for (let gi = 0; gi < 2; gi++) {
      if (woodNear(st) >= FQ) break;
      let bx = -1, bz = -1, bv = -1e9;
      for (let k = 0; k < 72; k++) {   // (24 directions at three distances: small islands may only have room further out)
        const an = (k % 24) / 24 * 6.283, gd = GD + ((k / 24) | 0) * 4, cx = st[0] + Math.cos(an) * gd, cz = st[1] + Math.sin(an) * gd;
        let n = 0, sv = 0;
        for (let dz = -GR; dz <= GR; dz++) for (let dx = -GR; dx <= GR; dx++) { const tx = Math.round(cx + dx), tz = Math.round(cz + dz); if (tx < 2 || tz < 2 || tx >= N - 2 || tz >= N - 2 || Math.hypot(dx, dz) > GR) continue; const t = tiles[tz * N + tx]; if ((t === 0 || t === 1) && aDist(tx + .5, tz + .5) >= FC0) { n++; sv += fbm(tx / N * 7 + 200, tz / N * 7 + 200, seed + 3); } }
        if (n < 24) continue;   // mostly water / rock / another town's ring
        const v = sv / n + n * 0.002 - ((k / 24) | 0) * 0.05; if (v > bv) { bv = v; bx = cx; bz = cz; }
      }
      if (bx < 0) continue;
      for (let dz = -GR; dz <= GR; dz++) for (let dx = -GR; dx <= GR; dx++) { const tx = Math.round(bx + dx), tz = Math.round(bz + dz); if (tx < 2 || tz < 2 || tx >= N - 2 || tz >= N - 2 || Math.hypot(dx, dz) > GR) continue; const t = tiles[tz * N + tx]; if ((t === 0 || t === 1) && aDist(tx + .5, tz + .5) >= FC0) { grassV[tz * N + tx] = t; tiles[tz * N + tx] = 6; } }
    }
    // forests come in groups (owner 2026-11-14: lone trees scattered round his base kept a 12x12 farm out): a forest
    // bit of fewer than FMIN touching tiles goes back to grass; the forest tiles left are solid wood (see below)
    {
      const FMIN = 8, lab = new Uint8Array(N * N), q = new Int32Array(N * N);
      for (let k0 = 0; k0 < N * N; k0++) {
        if (tiles[k0] !== 6 || lab[k0]) continue;
        let h = 0, t = 0; q[t++] = k0; lab[k0] = 1;
        while (h < t) { const c = q[h++], x = c % N, z = (c / N) | 0; for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= N || Z >= N) continue; const j = Z * N + X; if (tiles[j] === 6 && !lab[j]) { lab[j] = 1; q[t++] = j; } } }
        if (t < FMIN) for (let k = 0; k < t; k++) tiles[q[k]] = grassV[q[k]];
      }
    }
    // players
    const sr = cfg.sandbox ? { food: 99999, wood: 99999, stone: 99999, gold: 99999 } : cfg.startRes === 'low' ? { food: 200, wood: 200, stone: 100, gold: 0 } : cfg.startRes === 'high' ? { food: 900, wood: 900, stone: 450, gold: 300 } : { food: 300, wood: 300, stone: 150, gold: 100 };
    for (let i = 0; i < np; i++) {
      const p = { id: i, isAI: cp ? (cp[i] && cp[i].kind) === 'ai' : i > 0, color: PLAYER_COLORS[i], res: (cfg.sandbox && i > 0) ? { food: 300, wood: 300, stone: 150, gold: 100 } : { ...sr }, age: Math.max(0, Math.min(4, cfg.startAge | 0)), pop: 0, popCap: 0, techs: new Set(), pending: [], defeated: false, startX: starts[i][0], startZ: starts[i][1], ageProgress: 0, ageAt: 0,
        stats: { gathered: { food: 0, wood: 0, stone: 0, gold: 0 }, unitsTrained: 0, unitsLost: 0, kills: 0, buildingsBuilt: 0, buildingsLost: 0, razed: 0, techs: 0 } };
      this._mods(p); this.players.push(p);
    }
    // resources
    const land = (tx, tz) => { if (tx < 1 || tz < 1 || tx >= N - 1 || tz >= N - 1) return false; const t = tiles[tz * N + tx]; return (t === 0 || t === 1 || t === 6 || t === 2) && blocked[tz * N + tx] === 0 && !this.resAt[tz * N + tx]; };
    for (let tz = 1; tz < N - 1; tz++) for (let tx = 1; tx < N - 1; tx++) {
      const t = tiles[tz * N + tx]; const r = this.rand();
      if (sDist(tx + 0.5, tz + 0.5) < 10) continue;
      // (solid groves; no lone trees on open grass anywhere since 2026-11-14 - r is still drawn, one per tile as before)
      if (t === 6 && r >= 0) this._addRes('tree', tx, tz, 80);
    }
    // (start resources keep clear of the 6x6 town centre and leave room to build camps next to them)
    const cluster = (type, cx, cz, n, rad, amount) => {
      if (type !== 'deer') return clump(type, cx, cz, n, rad, amount);
      let placed = 0; for (let k = 0; k < n * 8 && placed < n; k++) { const tx = Math.round(cx + (this.rand() * 2 - 1) * rad), tz = Math.round(cz + (this.rand() * 2 - 1) * rad); if (land(tx, tz) && sDist(tx + 0.5, tz + 0.5) > 6.5) { this._addRes(type, tx, tz, amount); placed++; } } return placed;
    };
    // One compact clump (owner 2026-11-14: mines looked like scattered pebbles): it starts on the free tile nearest
    // (cx, cz) within rad and grows one tile at a time onto the free side neighbour that touches the most tiles of
    // the clump (seeded rand breaks ties), so the tiles touch each other with no gaps and read as one deposit / grove.
    const clump = (type, cx, cz, n, rad, amount) => {
      const ok = (x, z) => land(x, z) && sDist(x + 0.5, z + 0.5) > 6.5;
      let sx = -1, sz = -1, sd = 1e9;
      for (let z = Math.floor(cz - rad - 1); z <= Math.ceil(cz + rad + 1); z++) for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x++) { const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz); if (d <= rad + 1 && d < sd && ok(x, z)) { sd = d; sx = x; sz = z; } }
      if (sx < 0) return 0;
      const inC = new Set(), pts = [];
      const add = (x, z) => { this._addRes(type, x, z, amount); inC.add(z * N + x); pts.push(x, z); };
      add(sx, sz);
      const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      while (pts.length / 2 < n) {
        let bx = -1, bz = -1, bs = -1e9;
        for (let i = 0; i < pts.length; i += 2) for (const [dx, dz] of D4) {
          const x = pts[i] + dx, z = pts[i + 1] + dz; if (inC.has(z * N + x) || !ok(x, z)) continue;
          let nb = 0; for (const [ex, ez] of D4) if (inC.has((z + ez) * N + x + ex)) nb++;
          const sc = nb * 2 - Math.hypot(x + 0.5 - sx - 0.5, z + 0.5 - sz - 0.5) * 0.35 + this.rand() * 0.9;
          if (sc > bs) { bs = sc; bx = x; bz = z; }
        }
        if (bx < 0) break;
        add(bx, bz);
      }
      return pts.length / 2;
    };
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i], a0 = this.rand() * 6.283;
      const at = (a, d) => [s[0] + Math.cos(a0 + a) * d, s[1] + Math.sin(a0 + a) * d];
      // other types: a cluster that mostly fell into water / rock is topped up at turned angles, a bit closer in
      const put = (type, a, d, n, rad, amount) => { let q = at(a, d), got = cluster(type, q[0], q[1], n, rad, amount); for (let k = 1; k < 8 && got < (n + 1 >> 1); k++) { q = at(a + k * 0.8, Math.max(8.5, d - k * 0.6)); got += cluster(type, q[0], q[1], n - got, rad, amount); } };
      put('stone', 0, 11, 4, 1.6, 350);
      put('gold', 1.6, 12, 4, 1.6, 350);
      put('berries', 3.1, 9, 3, 1.5, 800);   // (owner 2026-11-15: 800 food a bush, three bushes)
      put('tree', 4.4, 10.5, 14, 3, 80);
      put('deer', 5.4, 11, 4, 2.5, 110);
    }
    const extra = Math.round(N / 9);
    for (let k = 0; k < extra * 4; k++) {
      let cx = 4 + this.rand() * (N - 8), cz = 4 + this.rand() * (N - 8);
      // wet maps: retry the centre a few times until it is on land (river keeps its old rand() sequence)
      if (!riv) for (let a = 0; a < 6 && !land(cx | 0, cz | 0); a++) { cx = 4 + this.rand() * (N - 8); cz = 4 + this.rand() * (N - 8); }
      if (sDist(cx, cz) < 18) continue;
      const m = k % 4;
      if (m === 0) cluster('stone', cx, cz, 3 + (this.rand() * 3 | 0), 1.8, 400);
      else if (m === 1) cluster('gold', cx, cz, 3 + (this.rand() * 3 | 0), 1.8, 400);
      else if (m === 2) cluster('berries', cx, cz, 3, 1.5, 800);
      else cluster('deer', cx, cz, 3, 3, 110);
    }
    try { this._navGenFish(); } catch (err) { console.error('fish gen', err); }
    this._ensureWalkable(starts.slice(0, this.players.length));
    // no stray trees: a tree with fewer than two others touching it (left by a pass cut through a grove, or a start
    // clump squeezed by water) goes (2026-11-14, owner: no lone trees on open grass)
    for (const e of [...this.entities.values()]) {
      if (e.kind !== 'resource' || e.type !== 'tree') continue;
      const x = e.x | 0, z = e.z | 0; let nb = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dz) continue; const id = this.resAt[(z + dz) * N + x + dx], o = id && this.entities.get(id); if (o && o.type === 'tree') nb++; }
      if (nb < 2) { this.entities.delete(e.id); this.resAt[z * N + x] = 0; blocked[z * N + x] = 0; }
    }
    // starting bases
    for (const p of this.players) {
      const ts = BUILDINGS.towncenter.size, h = ts / 2;   // (centred on the start)
      const b = this._addBuilding('towncenter', p.id, Math.round(p.startX - h), Math.round(p.startZ - h), true);
      for (let k = 0; k < START_VILLAGERS; k++) { const col = k % 5, row = (k / 5) | 0; const f = this._freeNear(b.x + (col - 2) * 1.3, b.z + h + 1.5 + row * 1.2, p.id); this._addUnit('villager', p.id, f.x, f.z); }   // (rows of 5 in front of the town centre)
      const f = this._freeNear(b.x + h + 1.5, b.z, p.id); this._addUnit('spearman', p.id, f.x, f.z);
      this._popCap(p);
    }
  }
  // land connectivity: every start must reach start 0 over tiles that are not deep water / mountain (the AI cannot ferry
  // armies). Unreached starts (ascending) get a ~3-tile wobbling corridor to the nearest reached start: water raised to a
  // shallow ford, mountains cut down to a pass. No-op on an already connected map; no rand() (seeded hash only).
  // After the resources are placed: every start must reach every other one ON FOOT - _mapConnect only looks at
  // the terrain, but a forest (trees block their tile) or the impassable outer tile ring can still close the only
  // way out, and a player boxed in by ridges and woods cannot leave his valley. A start that cannot walk to the
  // others gets a 3-tile-wide pass along the cheapest line: trees and rocks on it are removed, mountains cut down,
  // deep water made a ford. No rand() (deterministic); a no-op on maps that are already open.
  _ensureWalkable(starts) {
    const m = this.map, N = m.size, V = N + 1, T = m.tiles, H = m.heights, B = m.blocked;
    if (!starts || starts.length < 2) return 0;
    const ring = (x, z) => x < 1 || z < 1 || x >= N - 1 || z >= N - 1;
    const walk = (i) => { const t = T[i]; return t !== 4 && t !== 5 && B[i] === 0; };
    const tileOf = (s) => Math.max(1, Math.min(N - 2, s[1] | 0)) * N + Math.max(1, Math.min(N - 2, s[0] | 0));
    const seen = new Uint8Array(N * N), q = new Int32Array(N * N);
    const flood = (from) => {
      seen.fill(0); let h = 0, t = 0; seen[from] = 1; q[t++] = from;
      while (h < t) {
        const c = q[h++], x = c % N, z = (c / N) | 0;
        for (const d of [-1, 1, -N, N]) {
          const j = c + d, X = j % N, Z = (j / N) | 0;
          if (j < 0 || j >= N * N || Math.abs(X - x) + Math.abs(Z - z) !== 1 || ring(X, Z) || seen[j] || !walk(j)) continue;
          seen[j] = 1; q[t++] = j;
        }
      }
    };
    // (stone, gold and berries are never cut away: the pass goes around them; only trees and the land give way)
    const mine = (i) => { const e = this.resAt[i] && this.entities.get(this.resAt[i]); return !!e && (e.type === 'stone' || e.type === 'gold' || e.type === 'berries'); };
    const removeRes = (i) => {
      const id = this.resAt[i]; if (!id) return;
      const e = this.entities.get(id); if (e && e.type !== 'fish' && !mine(i)) { this.entities.delete(id); this.resAt[i] = 0; B[i] = 0; }
    };
    let carved = 0;
    for (let it = 0; it < starts.length * 2; it++) {
      const s0 = tileOf(starts[0]);   // (the start tiles themselves are kept clear by the generator)
      flood(s0);
      const ui = starts.findIndex((s) => !seen[tileOf(s)]);
      if (ui < 0) return carved;
      // cheapest way from the cut-off start to the open part: open ground 1, trees / rocks 4, mountain / deep water 9
      const cost = new Float32Array(N * N).fill(1e9), from = new Int32Array(N * N).fill(-1), done = new Uint8Array(N * N);
      const a = tileOf(starts[ui]); cost[a] = 0;
      const heap = [[0, a]];
      const push = (c, i) => { heap.push([c, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let mn = k; if (l < heap.length && heap[l][0] < heap[mn][0]) mn = l; if (r < heap.length && heap[r][0] < heap[mn][0]) mn = r; if (mn === k) break; [heap[mn], heap[k]] = [heap[k], heap[mn]]; k = mn; } } return top; };
      let goal = -1;
      while (heap.length) {
        const [c, i] = pop(); if (done[i]) continue; done[i] = 1;
        if (seen[i]) { goal = i; break; }
        const x = i % N, z = (i / N) | 0;
        for (const d of [-1, 1, -N, N]) {
          const j = i + d, X = j % N, Z = (j / N) | 0;
          if (j < 0 || j >= N * N || Math.abs(X - x) + Math.abs(Z - z) !== 1 || ring(X, Z) || done[j]) continue;
          const t = T[j], w = t === 4 || t === 5 ? 9 : B[j] ? (mine(j) ? 400 : 4) : 1, nc = c + w;
          if (nc < cost[j]) { cost[j] = nc; from[j] = i; push(nc, j); }
        }
      }
      if (goal < 0) return carved;
      // carve a 3-wide pass along it
      for (let i = goal; i >= 0; i = from[i]) {
        const x = i % N, z = (i / N) | 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Z = z + dz; if (ring(X, Z)) continue;
          const j = Z * N + X;
          if (B[j] === 1) removeRes(j);
          if (T[j] === 5 || T[j] === 4) {
            const wasMtn = T[j] === 5; T[j] = wasMtn ? 0 : 3;
            for (const v of [Z * V + X, Z * V + X + 1, (Z + 1) * V + X, (Z + 1) * V + X + 1]) H[v] = wasMtn ? Math.min(H[v], 2.2) : Math.max(H[v], -0.3);
          }
          carved++;
        }
        if (i === a) break;
      }
    }
    return carved;
  }
  _mapConnect(heights, N, starts, seed, hsh) {
    const V = N + 1, cls = new Uint8Array(N * N), seen = new Uint8Array(N * N), q = new Int32Array(N * N);
    const tileOf = s => Math.max(0, Math.min(N - 1, s[1] | 0)) * N + Math.max(0, Math.min(N - 1, s[0] | 0));
    for (let it = 0; it < starts.length * 3 + 2; it++) {
      for (let tz = 0; tz < N; tz++) for (let tx = 0; tx < N; tx++) {
        const i = tz * V + tx, ha = (heights[i] + heights[i + 1] + heights[i + V] + heights[i + V + 1]) / 4;
        cls[tz * N + tx] = ha < -0.4 || ha > 3.3 ? 1 : 0;
      }
      seen.fill(0); let qh = 0, qt = 0; const s0 = tileOf(starts[0]); seen[s0] = 1; q[qt++] = s0;
      while (qh < qt) {
        const c = q[qh++], cx = c % N, cz = (c / N) | 0;
        if (cx > 0 && !seen[c - 1] && !cls[c - 1]) { seen[c - 1] = 1; q[qt++] = c - 1; }
        if (cx < N - 1 && !seen[c + 1] && !cls[c + 1]) { seen[c + 1] = 1; q[qt++] = c + 1; }
        if (cz > 0 && !seen[c - N] && !cls[c - N]) { seen[c - N] = 1; q[qt++] = c - N; }
        if (cz < N - 1 && !seen[c + N] && !cls[c + N]) { seen[c + N] = 1; q[qt++] = c + N; }
      }
      const ui = starts.findIndex(s => !seen[tileOf(s)]);
      if (ui < 0) return it;
      const a = starts[ui]; let b = null, bd = 1e9;
      for (const s of starts) if (seen[tileOf(s)]) { const d = Math.hypot(s[0] - a[0], s[1] - a[1]); if (d < bd) { bd = d; b = s; } }
      const len = Math.max(1, bd), nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
      const ph = hsh(a[0] * 31 + b[0], a[1] * 31 + b[1], seed + 9) * 6.283, amp = Math.min(4, len * 0.07), R = 2.2;
      for (let k = 0, n = Math.ceil(len * 2); k <= n; k++) {
        const t = k / n, off = Math.sin(t * 6.283 + ph) * amp * Math.sin(t * 3.1416);
        const px = a[0] + (b[0] - a[0]) * t + nx * off, pz = a[1] + (b[1] - a[1]) * t + nz * off;
        for (let vz = Math.max(0, Math.ceil(pz - R)); vz <= Math.min(N, Math.floor(pz + R)); vz++) for (let vx = Math.max(0, Math.ceil(px - R)); vx <= Math.min(N, Math.floor(px + R)); vx++) {
          if (Math.hypot(vx - px, vz - pz) > R) continue;
          const i = vz * V + vx;
          if (heights[i] < -0.12) heights[i] = -0.12; else if (heights[i] > 2.6) heights[i] = 2.6;
        }
      }
    }
    return -1;
  }

  // ---------- entity creation ----------
  _mods(p) {
    const m = { gather: { food: 1, wood: 1, stone: 1, gold: 1 }, carry: 0, farm: 0, vspeed: 0, atk: {}, armor: {}, range: {}, speed: {}, atkMul: {}, bhp: 0, wallhp: 0, towerAtk: 0, towerRange: 0, vhp: 0, hp: {}, heal: 0, blos: 0, train: 0, factory: 0, trade: 0, cart: 0, bank: 0, pasture: 0, rail: 0 };
    for (const id of p.techs) { const fx = TECHS[id] && TECHS[id].fx; if (!fx) continue;
      for (const k in fx) { const v = fx[k]; if (typeof v === 'number') m[k] = (m[k] || 0) + v; else for (const c in v) (m[k] || (m[k] = {}))[c] = (m[k][c] || (k === 'gather' ? 1 : 0)) + v[c]; } }
    p.mods = m;
  }
  _bMaxHp(type, owner) { const d = BUILDINGS[type], p = this.players[owner]; let h = d.hp * (1 + 0.15 * p.age) * (1 + p.mods.bhp); if (type === 'wall' || type === 'gate') h *= 1 + p.mods.wallhp; return Math.round(h); }
  _rescaleBuildings(p) { for (const b of this.buildings) if (b.owner === p.id) { const n = this._bMaxHp(b.type, p.id); b.hp = n > b.maxHp ? Math.min(n, b.hp + (n - b.maxHp)) : Math.max(1, Math.round(b.hp * n / b.maxHp)); b.maxHp = n; b.ageLook = p.age; } }
  _uMaxHp(type, owner) { const d = UNITS[type], m = this.players[owner].mods; return Math.round(d.hp * (1 + (m.hp[d.cls] || 0) + (type === 'villager' ? m.vhp : 0))); }
  _rescaleUnits(p) { for (const u of this.units) if (u.owner === p.id && !u.dead) { const n = this._uMaxHp(u.type, p.id); if (n !== u.maxHp) { u.hp = n > u.maxHp ? u.hp + (n - u.maxHp) : Math.max(1, Math.min(n, u.hp)); u.maxHp = n; } } }
  _addUnit(type, owner, x, z) {
    const d = UNITS[type], uh = this._uMaxHp(type, owner);
    const u = { id: this.nextId++, kind: 'unit', type, owner, x, z, rot: this.rand() * 6.283, hp: uh, maxHp: uh, dead: false, state: 'idle', anim: 'idle', carry: null, targetId: null, deathTime: 0, attackT: -99, order: null, queue: [], path: null, pi: 0, pk: null, rpT: 0, cd: 0, scanT: this.rand() * 0.5 };
    this.entities.set(u.id, u); this.units.push(u); this.players[owner].pop += d.pop;
    if (type === 'tradecart') u.order = { type: 'trade', phase: 0 };
    if (d.naval) u.naval = true;
    this.events.emit('spawn', { e: u }); return u;
  }
  _addBuilding(type, owner, tx, tz, done) {
    const d = BUILDINGS[type], mh = this._bMaxHp(type, owner);
    const b = { id: this.nextId++, kind: 'building', type, owner, x: tx + d.size / 2, z: tz + d.size / 2, rot: 0, hp: done ? mh : Math.max(1, Math.round(mh * 0.05)), maxHp: mh, dead: false, tx, tz, size: d.size, progress: done ? 1 : 0, done: !!done, queue: [], rally: null, ageLook: this.players[owner].age, cd: 0, nb: 0, nw: 0 };
    // (a big farm has 8 plots around its granary, each growing on its own; a farm of an older save keeps one field)
    if (type === 'farm') b.farm = b.size >= 9 ? { stage: 0, growth: 0, plots: Array.from({ length: FARM_SLOTS }, () => ({ g: 0, s: 0 })), w: new Array(FARM_SLOTS).fill(0) } : { stage: 0, growth: 0 };
    if (type === 'pasture') b.pasture = { sheep: 3, g: 0 };
    // map.blocked: 1 solid, 3 open (farm, pasture, rail), 10 + owner a gate, 2 an unfinished foundation (owner meeting
    // 2026-11-14: foundations block nobody until they are finished; placement still refuses every non-zero tile)
    const bv = done ? this._solidV(b) : (this._solidV(b) === 3 ? 3 : 2);
    if (type === 'dock') this._navBlockDock(b, bv, bv === 2); else this._block(b, bv, bv === 2);   // (2 on free ground changes nobody's way: no flow-field rebuild)
    if (type !== 'dock' && type !== 'wall' && type !== 'gate' && type !== 'rail') this._flatten(b);   // a level foundation
    this.entities.set(b.id, b); this.buildings.push(b);
    this.events.emit('spawn', { e: b }); return b;
  }
  // A foundation levels the ground under it (owner 2026-11-13): the footprint's corners take their average
  // height and a one-vertex ring around eases into the land. Part of the simulation (map.heights is saved and the
  // same on every client); the view redraws that patch on the 'terrain' event.
  _flatten(b) {
    const m = this.map, N = m.size, V = N + 1, H = m.heights, s = b.size || 1;
    const x0 = b.tx, z0 = b.tz, x1 = b.tx + s, z1 = b.tz + s;
    let sum = 0, n = 0;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (x >= 0 && z >= 0 && x <= N && z <= N) { sum += H[z * V + x]; n++; }
    if (!n) return;
    const avg = Math.max(0.05, sum / n);
    // a wide, smooth bank around the level pad (a 1-vertex ring cut the slope into a wall and the building looked
    // sunk in): R vertices out, eased; ground under other buildings, trees / rocks and the shore is left alone
    const R = s >= 9 ? 6 : s >= 5 ? 5 : 3, tileFree = (tx, tz) => tx < 0 || tz < 0 || tx >= N || tz >= N || (B[tz * N + tx] === 0 && !this.resAt[tz * N + tx]) || (tx >= x0 && tx < x1 && tz >= z0 && tz < z1);
    const B = m.blocked;
    for (let z = z0 - R; z <= z1 + R; z++) for (let x = x0 - R; x <= x1 + R; x++) {
      if (x < 0 || z < 0 || x > N || z > N) continue;
      const i = z * V + x, dout = Math.max(x0 - x, x - x1, z0 - z, z - z1, 0);
      if (dout === 0) { H[i] = avg; continue; }   // (the pad)
      if (H[i] <= -0.05) continue;                                        // (the shore stays as it is)
      if (!tileFree(x - 1, z - 1) || !tileFree(x, z - 1) || !tileFree(x - 1, z) || !tileFree(x, z)) continue;
      // (the first vertex out is level with the pad too: no foundation side shows; then the bank eases out)
      const t = dout <= 1 ? 1 : 1 - (dout - 1) / (R + 1), w = t * t * (3 - 2 * t);
      H[i] += (avg - H[i]) * w;
    }
    this.events.emit('terrain', { x0: x0 - R, z0: z0 - R, x1: x1 + R, z1: z1 + R });
  }
  // what a finished building writes into map.blocked
  _solidV(b) { const t = b.type; return t === 'farm' || t === 'pasture' || t === 'rail' ? 3 : t === 'gate' ? 10 + b.owner : 1; }
  _block(b, v, quiet) { const N = this.map.size; for (let j = 0; j < b.size; j++) for (let i = 0; i < b.size; i++) this.map.blocked[(b.tz + j) * N + b.tx + i] = v; if (!quiet) this._blkMark(b.tx, b.tz, b.size, b.size); }
  _addRes(type, tx, tz, amount) {
    if (type === 'tree') amount = TREE_WOOD;   // (every tree, whatever the map generator asked for)
    const N = this.map.size;
    const e = { id: this.nextId++, kind: 'resource', type, owner: -1, x: tx + 0.5, z: tz + 0.5, rot: this.rand() * 6.283, hp: 1, maxHp: 1, dead: false, amount, maxAmount: amount, variant: (this.rand() * 4) | 0, scale: 0.8 + this.rand() * 0.5 };
    this.entities.set(e.id, e);
    if (type === 'deer') { e.wt = this.rand() * 5; e.wx = e.x; e.wz = e.z; e.hunted = false; this.deer.push(e); }
    else { this.resAt[tz * N + tx] = e.id; if (type !== 'fish') { this.map.blocked[tz * N + tx] = 1; this._blkMark(tx, tz, 1, 1); } else this._navFishC = null; }
    return e;
  }
  // (the outer ring of tiles is impassable for land units: nothing can be built there, so a wall that reaches the
  //  map edge must close the way; otherwise armies walked around its end along the border)
  _pass(tx, tz, owner) { if (this._navMode) return this._navPass(tx, tz); const m = this.map, N = m.size; if (tx < 1 || tz < 1 || tx >= N - 1 || tz >= N - 1) return false; const i = tz * N + tx, t = m.tiles[i]; if (t === 4 || t === 5) return false; const b = m.blocked[i]; return b === 0 || b === 2 || b === 3 || b === 10 + owner || (b >= 10 && owner >= 0 && this._tm !== undefined && this._tm[owner] >= 0 && this._tm[b - 10] === this._tm[owner]); }
  _freeNear(x, z, owner) {
    const cx = Math.floor(x), cz = Math.floor(z);
    if (this._pass(cx, cz, owner)) return { x, z };
    for (let r = 1; r < 16; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue; if (this._pass(cx + i, cz + j, owner)) return { x: cx + i + 0.5, z: cz + j + 0.5 }; }
    return { x, z };
  }
  _popCap(p) { let c = 0; for (const b of this.buildings) if (b.owner === p.id && b.done) c += BUILDINGS[b.type].popCap; p.popCap = 1000; } // owner request: fixed 1000 cap, houses not needed

  // ---------- public queries ----------
  getEntity(id) { return this.entities.get(id) || null; }
  canAfford(owner, cost) { const p = this.players[owner]; if (!p) return false; for (const k in cost) if ((p.res[k] || 0) < cost[k]) return false; return true; }
  _pay(owner, cost) { const p = this.players[owner]; for (const k in cost) p.res[k] -= cost[k]; }
  _refund(owner, cost) { const p = this.players[owner]; for (const k in cost) p.res[k] += cost[k]; }
  isUnlocked(owner, kind, id) {
    const p = this.players[owner]; if (!p) return false;
    const d = kind === 'unit' ? UNITS[id] : kind === 'building' ? BUILDINGS[id] : TECHS[id];
    if (!d || d.age > p.age || d.legacy) return false;   // (legacy: the mill, kept for old saves only)
    if (kind === 'tech' && p.techs.has(id)) return false;
    return true;
  }
  unitsOf(owner) { return this.units.filter(u => u.owner === owner && !u.dead); }
  buildingsOf(owner) { return this.buildings.filter(b => b.owner === owner && !b.dead); }
  isEntityVisible(e) {
    if (!e) return false; if (this.reveal) return true; if (e.owner === this.me || this.isAlly(e.owner, this.me)) return true;
    if (e.revT !== undefined && this.time - e.revT < 4 && !e.dead && (e.revO === this.me || this.isAlly(e.revO, this.me))) return true;
    const N = this.map.size, tx = Math.min(N - 1, Math.max(0, e.x | 0)), tz = Math.min(N - 1, Math.max(0, e.z | 0)), f = this.fog[tz * N + tx];
    if (e.kind === 'unit') return f === 2;
    if (e.kind === 'building' && this.cfg.fog === 'explored') return f === 2 || (f >= 1 && !!((e.sv | 0) & (1 << (this.teamOf(this.me) & 31))));   // (explored map: only buildings the team has seen)
    return f >= 1;
  }
  resourceNear(x, z, r = 1.5, type = null) {
    const N = this.map.size; let best = null, bd = r * r;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(N - 1, Math.floor(x + r)), z0 = Math.max(0, Math.floor(z - r)), z1 = Math.min(N - 1, Math.floor(z + r));
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) { const id = this.resAt[tz * N + tx]; if (!id) continue; const e = this.entities.get(id); if (!e || e.dead || (type && e.type !== type)) continue; const d = (e.x - x) ** 2 + (e.z - z) ** 2; if (d <= bd) { bd = d; best = e; } }
    if (!type || type === 'deer') for (const e of this.deer) { if (e.dead) continue; const d = (e.x - x) ** 2 + (e.z - z) ** 2; if (d <= bd) { bd = d; best = e; } }
    return best;
  }
  tradeRate(sell, buy, owner = 0) {
    if (!TRADE_VAL[sell] || !TRADE_VAL[buy] || sell === buy) return 0; const p = this.players[owner], k = 0.7 * (1 + (p ? p.mods.trade : 0));
    // barter (neither side gold, owner playtest 2026-11-14): priced like selling for gold and buying back, as one
    // step 15 % better (100 wood -> 56 food; was 70, cheaper than going through gold)
    if (sell !== 'gold' && buy !== 'gold') return Math.round(100 * TRADE_VAL[sell] / TRADE_VAL[buy] * k * k * BARTER_BONUS);
    return Math.round(100 * TRADE_VAL[sell] / TRADE_VAL[buy] * k);
  }
  trade(owner, sell, buy) {
    const p = this.players[owner]; if (!p) return false;
    if (!this.buildings.some(b => b.owner === owner && b.type === 'market' && b.done)) return false;
    const amt = this.tradeRate(sell, buy, owner); if (!amt || p.res[sell] < 100) return false;
    p.res[sell] -= 100; p.res[buy] += amt; return true;
  }
  // ---- tribute (owner playtest 2026-11-14: his ally ran out of wood): send resources to an ally, no fee.
  // amount is capped at what the sender has; refused for enemies, oneself, defeated / gone players.
  canTribute(from, to, res, amount) {
    const a = this.players[from], b = this.players[to];
    if (!a || !b || from === to || !this.isAlly(from, to)) return { ok: false, reason: 'Yalnızca müttefike gönderilebilir' };
    if (a.defeated || b.defeated || b.left) return { ok: false, reason: 'Bu oyuncu oyunda değil' };
    if (!TRIBUTE_RES.includes(res) || !(typeof amount === 'number' && amount >= 1 && Number.isFinite(amount))) return { ok: false, reason: 'Geçersiz miktar' };
    if (Math.floor(a.res[res] || 0) < 1) return { ok: false, reason: 'Yetersiz kaynak' };
    return { ok: true, amount: Math.min(Math.floor(amount), Math.floor(a.res[res] || 0)) };
  }
  cmdTribute(from, to, res, amount) {
    to = to | 0; const c = this.canTribute(from, to, res, amount); if (!c.ok) return false;
    const a = this.players[from], b = this.players[to];
    a.res[res] -= c.amount; b.res[res] = (b.res[res] || 0) + c.amount;
    const st = a.stats || (a.stats = {}); st.tribute = (st.tribute || 0) + c.amount;
    this.events.emit('tribute', { from, to, res, amount: c.amount });
    return true;
  }
  // ---- control groups 1-9 (Ctrl+number): kept per player in the save (p.cg) so a loaded game has them back.
  // Not part of any decision or the hash; the local UI keeps its own copy and sends changes through the lockstep
  // like any command, so every client's save (and a continued multiplayer match) carries every player's groups.
  cmdGroup(owner, n, ids) {
    const p = this.players[owner]; n = n | 0; if (!p || n < 1 || n > 9) return false;
    const list = (Array.isArray(ids) ? ids : []).filter(id => { const e = this.entities.get(id); return !!e && !e.dead && e.owner === owner && (e.kind === 'unit' || e.kind === 'building'); }).slice(0, 1000);
    const cg = p.cg && typeof p.cg === 'object' ? p.cg : (p.cg = {});
    if (list.length) cg[n] = list; else delete cg[n];
    return true;
  }
  // a player's saved control groups with the dead / lost entities dropped: {n: [ids]}
  controlGroups(owner) {
    const p = this.players[owner], out = {}; if (!p || !p.cg) return out;
    for (const k in p.cg) { const n = k | 0; if (n < 1 || n > 9 || !Array.isArray(p.cg[k])) continue; const ids = p.cg[k].filter(id => { const e = this.entities.get(id); return !!e && !e.dead && e.owner === owner; }); if (ids.length) out[n] = ids; }
    return out;
  }

  // ---------- building commands ----------
  canPlace(type, tx, tz, owner) {
    const d = BUILDINGS[type]; if (!d) return false; const m = this.map, N = m.size;
    tx |= 0; tz |= 0;
    // walls, gates and towers may stand on the outer tile ring too (it is impassable: a wall can run right to
    // the map's edge); everything else keeps one tile off it
    const edge = type === 'wall' || type === 'gate' || type === 'tower' ? 0 : 1;
    if (tx < edge || tz < edge || tx + d.size > N - edge || tz + d.size > N - edge) return false;
    if (type === 'dock') return this._navCanPlaceDock(tx, tz) && !this.buildings.some(b => !b.dead && b.type === 'dock' && tx < b.tx + b.size && tx + d.size > b.tx && tz < b.tz + b.size && tz + d.size > b.tz);
    // a gate may replace a finished own wall segment
    if (type === 'gate' && owner != null && this._wallToGate(tx, tz, owner)) return true;
    // walls, gates and towers may also stand in shallow water (owner 2026-11-15: land units wade the shallows, so a
    // wall line that met a ford or a shore left a way round its end that could not be closed); deep water never
    for (let j = 0; j < d.size; j++) for (let i = 0; i < d.size; i++) { const k = (tz + j) * N + tx + i, t = m.tiles[k]; if ((t === 3 && edge) || t === 4 || t === 5) return false; if (m.blocked[k] !== 0) return false; }
    return true;
  }
  // building whose footprint covers tile (tx,tz), or null
  buildingAt(tx, tz) {
    for (const b of this.buildings) { if (b.dead) continue; if (tx >= b.tx && tx < b.tx + b.size && tz >= b.tz && tz < b.tz + b.size) return b; }
    return null;
  }
  // ---- gates are opened in a wall (Empire Earth style): select a finished wall piece, "Kapı aç" turns it and its two
  // neighbours on a straight run into a 3-tile gate at once (no construction), for the gate's cost.
  gatePlan(wallId) {
    const w = this.entities.get(wallId);
    if (!w || w.dead || w.kind !== 'building' || w.type !== 'wall') return { ok: false, reason: 'Sur seç' };
    if (!w.done) return { ok: false, reason: 'Sur henüz bitmedi' };
    const own = (x, z) => { const b = this.buildingAt(x, z); return b && b.type === 'wall' && b.owner === w.owner && b.done && !b.dead ? b : null; };
    // along the run: x if a neighbour wall sits left/right, z if up/down (prefer the wall's own straight direction)
    const hx = !!(own(w.tx - 1, w.tz) || own(w.tx + 1, w.tz)), hz = !!(own(w.tx, w.tz - 1) || own(w.tx, w.tz + 1));
    const dirs = hx && !hz ? [[1, 0]] : hz && !hx ? [[0, 1]] : [[1, 0], [0, 1]];
    for (const [dx, dz] of dirs) for (const c of [0, -1, 1]) {   // the clicked piece in the middle first, else shifted one
      const cx = w.tx + dx * c, cz = w.tz + dz * c, pcs = [-1, 0, 1].map(k => own(cx + dx * k, cz + dz * k));
      if (pcs.every(Boolean)) return { ok: true, pieces: pcs, dx, dz };
    }
    return { ok: false, reason: 'Kapı için düz bir hatta yan yana 3 sur parçası gerekli' };
  }
  canOpenGate(owner, wallId) {
    const pl = this.gatePlan(wallId); if (!pl.ok) return pl;
    if (!this.canAfford(owner, BUILDINGS.gate.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
    return pl;
  }
  cmdOpenGate(wallId) {
    const w = this.entities.get(wallId); if (!w) return false;
    const owner = w.owner, pl = this.canOpenGate(owner, wallId); if (!pl.ok) return false;
    this._pay(owner, BUILDINGS.gate.cost);
    let mid = null;
    pl.pieces.forEach((old, k) => {
      const hp = old.hp / old.maxHp, tx = old.tx, tz = old.tz;
      this._dropBuilding(old);
      const b = this._addBuilding('gate', owner, tx, tz, true);
      b.hp = Math.max(1, Math.round(b.maxHp * hp)); b.progress = 1; b.done = true;   // (_addBuilding already announced it)
      if (k === 1) mid = b;
    });
    this.events.emit('buildComplete', { e: mid });
    return true;
  }
  _wallToGate(tx, tz, owner) { const b = this.buildingAt(tx, tz); return b && b.type === 'wall' && b.owner === owner && b.done ? b : null; }
  // silently remove a building (no stats, no death event): used when a gate replaces a wall
  _dropBuilding(b) {
    this._block(b, 0); b.dead = true;
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    this.entities.delete(b.id); this.events.emit('remove', { e: b });
  }
  // land units standing on a tile of b's footprint that they can no longer walk (a building just finished: any size;
  // a gate pushes out only the units it now shuts out) step to the nearest free tile (by tile: one standing exactly
  // on its edge, x = tx, counts as inside)
  _pushOut(b) {
    const s = b.size;
    for (const u of this.units) {
      if (u.dead || u.naval || u.aboard || u.train) continue;
      const ux = u.x | 0, uz = u.z | 0;
      if (ux < b.tx || ux >= b.tx + s || uz < b.tz || uz >= b.tz + s || this._pass(ux, uz, u.owner)) continue;
      const f = this._freeNear(u.x, u.z, u.owner); u.x = f.x; u.z = f.z; u.path = null; u.pk = null;
    }
  }
  // Place a line of 1-tile segments (walls). Pays per segment, stops when resources run out.
  // Builders get the whole line as their job; several builders are spread along it.
  placeLine(owner, type, tiles, builderIds = [], queue = false) {
    const d = BUILDINGS[type]; if (!d || !this.players[owner] || !tiles || !tiles.length) return [];
    if (!this.isUnlocked(owner, 'building', type)) return [];
    const line = (this._lineId = (this._lineId || 0) + 1);
    const ids = [];
    for (const t of tiles) {
      const tx = t[0] | 0, tz = t[1] | 0;
      if (!this.canPlace(type, tx, tz, owner)) continue;
      if (!this.canAfford(owner, d.cost)) break;
      const old = type === 'gate' ? this._wallToGate(tx, tz, owner) : null;
      if (old) this._dropBuilding(old);
      this._pay(owner, d.cost);
      const b = this._addBuilding(type, owner, tx, tz, false);
      b.line = line;   // (a foundation blocks nobody: repath / push-out happen when it is finished, _complete)
      this.events.emit('buildStart', { e: b });
      ids.push(b.id);
    }
    if (!ids.length) return ids;
    let us = this._live(builderIds).filter(u => u.type === 'villager' && u.owner === owner);
    if (!us.length) {
      // no builder given: nearest idle villager, else nearest villager
      const b0 = this.entities.get(ids[0]); let best = null, bd = 1e9, bi = false;
      for (const u of this.units) { if (u.dead || u.owner !== owner || u.type !== 'villager') continue; const idle = !u.order, dd = (u.x - b0.x) ** 2 + (u.z - b0.z) ** 2; if ((idle && !bi) || (idle === bi && dd < bd)) { best = u; bd = dd; bi = idle; } }
      if (best) us = [best];
    }
    const n = ids.length, k = us.length;
    us.forEach((u, i) => {
      const s = Math.floor(i * n / k);
      // start at own segment, continue forward, then wrap to the rest (already-done ones are skipped)
      const order = ids.slice(s).concat(ids.slice(0, s));
      this._setOrder(u, { type: 'build', targetId: order[0], line }, queue); // queue: whole line is appended after current jobs
      for (let j = 1; j < order.length; j++) u.queue.push({ type: 'build', targetId: order[j], line });
    });
    return ids;
  }
  // after a build job: next queued order, else the nearest unfinished own foundation (<=14 tiles), else idle
  _nextBuild(u, o) {
    // a wall / gate line is one job (owner 2026-11-15: a builder on a wall left it for a Shift-queued tower): while
    // pieces of the same line are unfinished, the builder goes on with them before the queued orders
    if (u.queue.length && o && o.line && !u.queue.some(q => q.type === 'build' && q.line === o.line)) {
      let lb = null, ld = 1e9;
      for (const b of this.buildings) { if (b.dead || b.done || b.owner !== u.owner || b.line !== o.line) continue; const dd = this._edge(u, b); if (dd < ld) { ld = dd; lb = b; } }
      if (lb && ld <= 40) { u.order = { type: 'build', targetId: lb.id, line: o.line }; u.targetId = lb.id; u.path = null; u.pk = null; u.rpT = 0; return; }
    }
    if (u.queue.length) return this._next(u);
    const line = o && o.line, cnt = new Map();
    for (const w of this.units) { if (w.dead || w === u || w.owner !== u.owner || !w.order || w.order.type !== 'build') continue; cnt.set(w.order.targetId, (cnt.get(w.order.targetId) || 0) + 1); }
    let best = null, bs = 1e9;
    for (const b of this.buildings) {
      if (b.dead || b.done || b.owner !== u.owner) continue;
      const dd = this._edge(u, b); if (dd > 14) continue;
      const s = dd + (cnt.get(b.id) || 0) * 4 - (line && b.line === line ? 20 : 0);
      if (s < bs) { bs = s; best = b; }
    }
    if (!best) return this._next(u);
    u.order = { type: 'build', targetId: best.id, line: best.line || null }; u.targetId = best.id; u.path = null; u.pk = null; u.rpT = 0;
  }
  placeBuilding(owner, type, tx, tz, builderIds = [], queue = false) {
    const d = BUILDINGS[type]; if (!d || !this.players[owner]) return null;
    tx |= 0; tz |= 0;
    if (!this.isUnlocked(owner, 'building', type) || !this.canPlace(type, tx, tz, owner) || !this.canAfford(owner, d.cost)) return null;
    const old = type === 'gate' ? this._wallToGate(tx, tz, owner) : null;
    if (old) this._dropBuilding(old);
    this._pay(owner, d.cost);
    const b = this._addBuilding(type, owner, tx, tz, false);
    // (the foundation blocks nobody yet: units walk through it; _complete pushes them out and re-plans routes across it)
    this.events.emit('buildStart', { e: b });
    if (builderIds && builderIds.length) this.cmdBuild(builderIds, b.id, queue);
    else {
      // no builder given: nearest idle villager, else nearest villager
      let best = null, bd = 1e9, bi = false;
      for (const u of this.units) { if (u.dead || u.owner !== owner || u.type !== 'villager') continue; const idle = !u.order, dd = (u.x - b.x) ** 2 + (u.z - b.z) ** 2; if ((idle && !bi) || (idle === bi && dd < bd)) { best = u; bd = dd; bi = idle; } }
      if (best) this.cmdBuild([best.id], b.id);
    }
    return b.id;
  }
  _live(ids) { const out = []; for (const id of ids || []) { const u = this.entities.get(id); if (u && u.kind === 'unit' && !u.dead && !u.aboard && !u.train) out.push(u); } return out; }
  // Explore: units wander toward unexplored tiles until they get any other order.
  cmdExplore(ids) { let n = 0; for (const u of this._live(ids)) { if (this._exploreStep(u)) n++; } return n > 0; }
  _exploreStep(u) {
    const m = this.map, N = m.size; let bx = -1, bz = -1, bs = -1e9;
    for (let k = 0; k < 40; k++) {
      const tx = 2 + (this.rand() * (N - 4) | 0), tz = 2 + (this.rand() * (N - 4) | 0);
      if (!m.isWalkable(tx, tz)) continue;
      const d = Math.hypot(tx - u.x, tz - u.z);
      // humans prefer tiles their team has not explored yet (sim-side team grid, never the local view fog)
      const ep = this.players[u.owner], eg = ep && !ep.isAI && this._tv ? this._tv.get(ep.team) : null;
      const fresh = eg ? (eg[tz * N + tx] === 0 ? 60 : eg[tz * N + tx] === 1 ? 10 : 0) : 30;
      const s = fresh - Math.abs(d - 22) * 0.8 + this.rand() * 15;
      if (s > bs) { bs = s; bx = tx; bz = tz; }
    }
    if (bx < 0) return false;
    this.cmdMove([u.id], bx + 0.5, bz + 0.5, false);
    u.explore = true; u.exploreT = this.time + 1.5;
    return true;
  }
  // Shift-queue (playtest 2026-11-14): an open-ended order (gathering: trees, farms, endless mines...; trade runs;
  // fishing) never finishes on its own, so nothing queued behind it would ever run. Queuing behind one ends it now
  // (queued open-ended orders are dropped the same way); a villager walking to drop off a load delivers it first.
  _setOrder(u, o, queue) { u.explore = false; if (queue && u.order && !u.order.auto) { const open = q => !!q && (q.type === 'gather' || q.type === 'trade' || q.type === 'fish'); for (let i = u.queue.length - 1; i >= 0; i--) if (open(u.queue[i])) u.queue.splice(i, 1); u.queue.push(o); if (open(u.order)) this._next(u); else if (u.order.type === 'return') u.order.resume = null; return; } if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.queue.length = 0; u.order = o; u.targetId = o.targetId || null; u.path = null; u.pk = null; u.rpT = 0; }
  _unhunt(o) { const t = this.entities.get(o.targetId); if (t && t.type === 'deer') t.hunted = false; }
  cmdMove(ids, x, z, queue = false) {
    const us = this._live(ids); if (!us.length) return false;
    const N = this.map.size; x = Math.min(N - 1.01, Math.max(1, x)); z = Math.min(N - 1.01, Math.max(1, z));
    const land = us.filter(u => !u.naval), sea = us.filter(u => u.naval);
    // a flow field pays off for a crowd, or a few units on a long trip; a lone unit (scouts, explorers: often sent
    // at unreachable tiles, where a field costs two whole-map sweeps) and a few units going a short way keep plain A*
    let mx = 0, mz = 0; for (const u of land) { mx += u.x; mz += u.z; }
    const far = land.length && Math.hypot(mx / land.length - x, mz / land.length - z) > 40;
    const grp = land.length >= 6 || (far && land.length >= 2) ? { path: null, tx: x, tz: z } : null;
    if (!grp && land.length) {
      if (land.length === 1) { const f = this._freeNear(x, z, land[0].owner); this._setOrder(land[0], { type: 'move', x: f.x, z: f.z }, queue); }
      else for (const s of this._formation(land, x, z)) { const f = this._freeNear(s.x, s.z, s.u.owner); this._setOrder(s.u, { type: 'move', x: f.x, z: f.z }, queue); }
    }
    if (grp) {
      const owner = land[0].owner, d = this._flowField(grp, owner, land[0], land), used = new Set();
      // every unit's spot on a cell the group can actually walk to (not inside a closed forest pocket), one unit per cell
      const spot = (sx, sz) => {
        const N = this.map.size, cx = Math.min(N - 2, Math.max(1, sx | 0)), cz = Math.min(N - 2, Math.max(1, sz | 0));
        for (let r = 0; r <= 10; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const nx = cx + i, nz = cz + j; if (nx < 1 || nz < 1 || nx >= N - 1 || nz >= N - 1) continue;
          const k = nz * N + nx; if (d[k] < 0 || used.has(k)) continue;
          used.add(k); return r === 0 ? { x: sx, z: sz } : { x: nx + 0.5, z: nz + 0.5 };
        }
        return this._freeNear(sx, sz, owner);
      };
      for (const s of this._formation(land, grp.sx + 0.5, grp.sz + 0.5)) { const p = spot(s.x, s.z); this._setOrder(s.u, { type: 'move', x: p.x, z: p.z, grp }, queue); }
    }
    const cols = Math.ceil(Math.sqrt(sea.length));
    sea.forEach((u, i) => {
      const ox = ((i % cols) - (cols - 1) / 2) * 1.6, oz = (Math.floor(i / cols) - (Math.ceil(sea.length / cols) - 1) / 2) * 1.6;
      this._navMode = true; const f = this._freeNear(x + ox, z + oz, u.owner); this._navMode = false;
      this._setOrder(u, { type: 'move', x: f.x, z: f.z }, queue);
    });
    return true;
  }
  // Line formation facing the direction of travel: melee in the front ranks, ranged behind them,
  // siege and civilians at the back. Each rank is wide and shallow ("like a rope"), and units are
  // matched to slots left-to-right by their current lateral position so paths do not cross.
  _formation(us, x, z) {
    let cx = 0, cz = 0; for (const u of us) { cx += u.x; cz += u.z; } cx /= us.length; cz /= us.length;
    let fx = x - cx, fz = z - cz; const fl = Math.hypot(fx, fz);
    if (fl < 0.5) { fx = 0; fz = 1; } else { fx /= fl; fz /= fl; }
    const rx = fz, rz = -fx; // right-hand vector
    const rank = u => { const d = UNITS[u.type]; return d.cls === 'siege' ? 3 : d.cls === 'civil' || !(d.atk > 0) ? 4 : d.range > 0 ? 2 : 1; };
    const groups = [1, 2, 3, 4].map(r => us.filter(u => rank(u) === r)).filter(g => g.length);
    const total = us.length, width = Math.max(4, Math.min(16, Math.ceil(Math.sqrt(total) * 2.2)));
    const out = []; let back = 0, first = true;
    for (const g of groups) {
      const sp = rank(g[0]) === 3 ? 2.0 : 1.15, cols = Math.min(g.length, Math.max(1, Math.round(width * 1.15 / sp)));
      const rows = Math.ceil(g.length / cols);
      if (!first) back += sp * 0.5 + 0.6; first = false;
      for (let r = 0; r < rows; r++) {
        const row = g.slice(r * cols, (r + 1) * cols);
        // order this row's units by lateral position so the leftmost unit takes the leftmost slot
        const row2 = row.map(u => ({ u, l: (u.x - cx) * rx + (u.z - cz) * rz, id: u.id })).sort((p, q) => p.l - q.l || p.id - q.id);
        row2.forEach((p, i) => { const lo = (i - (row2.length - 1) / 2) * sp; out.push({ u: p.u, x: x + rx * lo - fx * back, z: z + rz * lo - fz * back }); });
        back += sp;
      }
      back -= sp;
    }
    // centre the block on the clicked point
    const sh = back / 2; const N = this.map.size;
    for (const o of out) { o.x = Math.min(N - 1.01, Math.max(1, o.x + fx * sh)); o.z = Math.min(N - 1.01, Math.max(1, o.z + fz * sh)); }
    return out;
  }
  cmdAttack(ids, targetId, queue = false) {
    const t = this.entities.get(targetId); if (!t || t.dead || t.kind === 'resource') return false;
    const us = this._live(ids); let ok = false;
    for (const u of us) { if (!this.isEnemy(u.owner, t.owner) || UNITS[u.type].atk <= 0) continue; if (u.type === 'ram' && t.kind !== 'building') continue; if (t.naval && !(UNITS[u.type].range > 0)) continue; this._setOrder(u, { type: 'attack', targetId }, queue); ok = true; }
    return ok;
  }
  cmdGather(ids, targetId, queue = false) {
    const t = this.entities.get(targetId); if (!t || t.dead) return false;
    if (t.type === 'fish') return this._navCmdFish(ids, t);
    const us = this._live(ids).filter(u => u.type === 'villager'); if (!us.length) return false;
    if (t.kind === 'building') {
      if (t.type === 'pasture') return this._pasCmd(us, t, queue);
      if (t.type !== 'farm') return false;
      for (const u of us) { if (u.owner !== t.owner) continue; this._setOrder(u, t.done ? { type: 'gather', targetId, res: 'food', rt: 'farm', x: t.x, z: t.z, acc: 0, tick: 0, dep: 0 } : { type: 'build', targetId }, queue); }
      return true;
    }
    if (t.kind !== 'resource') return false;
    for (const u of us) this._setOrder(u, { type: 'gather', targetId, res: RES_OF[t.type], rt: t.type, x: t.x, z: t.z, acc: 0, tick: 0 }, queue);
    return true;
  }
  cmdBuild(ids, buildingId, queue = false) {
    const b = this.entities.get(buildingId); if (!b || b.dead || b.kind !== 'building') return false;
    const us = this._live(ids).filter(u => u.type === 'villager' && u.owner === b.owner); if (!us.length) return false;
    for (const u of us) this._setOrder(u, { type: 'build', targetId: buildingId, line: b.line || null }, queue);   // (a wall piece: the builder knows its line)
    return true;
  }
  cmdStance(ids, stance) {
    if (!STANCES.includes(stance)) return false;
    let n = 0; for (const u of this._live(ids)) { const d = UNITS[u.type]; if (d.cls === 'civil' || !(d.atk > 0)) continue; u.stance = stance === 'aggressive' ? undefined : stance; n++; }
    return n > 0;
  }
  cmdStop(ids) { for (const u of this._live(ids)) { if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.order = null; u.queue.length = 0; u.path = null; u.pk = null; u.targetId = null; u.state = 'idle'; u.anim = 'idle'; } return true; }

  train(buildingId, unitType) {
    const b = this.entities.get(buildingId), d = UNITS[unitType];
    if (!b || b.dead || b.kind !== 'building' || !b.done || !d) return false;
    if (!BUILDINGS[b.type].trains.includes(unitType) || !this.isUnlocked(b.owner, 'unit', unitType) || b.queue.length >= TRAIN_QUEUE_MAX || !this.canAfford(b.owner, d.cost)) return false;
    this._pay(b.owner, d.cost); b.queue.push({ kind: 'unit', id: unitType, t: 0, total: d.time }); return true;
  }
  research(buildingId, techId) {
    const b = this.entities.get(buildingId), d = TECHS[techId];
    if (!b || b.dead || b.kind !== 'building' || !b.done || !d) return false;
    const p = this.players[b.owner];
    if (!BUILDINGS[b.type].researches.includes(techId) || !this.isUnlocked(b.owner, 'tech', techId) || p.pending.includes(techId) || !this.canAfford(b.owner, d.cost)) return false;
    this._pay(b.owner, d.cost); p.pending.push(techId); b.queue.push({ kind: 'tech', id: techId, t: 0, total: d.time }); return true;
  }
  // the named buildings the next age still needs (finished ones count)
  ageMissingTypes(owner) {
    const p = this.players[owner], a = p && AGES[p.age + 1]; if (!a || !a.reqTypes) return [];
    return a.reqTypes.filter(t => !this.buildings.some(b => b.owner === owner && b.type === t && b.done && !b.dead));
  }
  // seconds left before the next age-up may start (the minimum stay in the current age)
  ageWait(owner) {
    const p = this.players[owner], a = p && AGES[p.age + 1]; if (!a || !a.minStay) return 0;
    return Math.max(0, (p.ageAt || 0) + a.minStay - this.time);
  }
  _typesOwned(owner) { const s = new Set(); for (const b of this.buildings) if (b.owner === owner && b.done && !['house', 'wall', 'gate', 'towncenter'].includes(b.type)) s.add(b.type); return s.size; }
  canAgeUp(owner) {
    const p = this.players[owner]; if (!p) return { ok: false, reason: 'Oyuncu yok' };
    if (p.age >= 4) return { ok: false, reason: 'Zaten son çağdasın' };
    if (this.buildings.some(b => b.owner === owner && b.queue.some(q => q.kind === 'age'))) return { ok: false, reason: 'Çağ atlama sürüyor' };
    const a = AGES[p.age + 1];
    if (this._typesOwned(owner) < a.reqBuildings) return { ok: false, reason: `En az ${a.reqBuildings} farklı bina türü gerekli (ev ve sur hariç)` };
    const miss = this.ageMissingTypes(owner);
    if (miss.length) return { ok: false, reason: miss.map(t => BUILDINGS[t].name).join(', ') + ' gerekli' };
    const wait = this.ageWait(owner);
    if (wait > 0) return { ok: false, reason: `Bu çağda biraz daha kalmalısın (${Math.ceil(wait / 60)} dk)` };
    if (!this.canAfford(owner, a.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
    return { ok: true, reason: '' };
  }
  // developer mode: jump straight to any age (also back), as if aged up there; cancels a running age-up
  devSetAge(age) {
    if (!this.cfg.dev) return false;
    const p = this.players[this.me]; if (!p) return false;
    age = Math.max(0, Math.min(AGES.length - 1, age | 0)); if (age === p.age) return false;
    for (const b of this.buildings) if (b.owner === p.id) for (let i = b.queue.length - 1; i >= 0; i--) if (b.queue[i].kind === 'age') b.queue.splice(i, 1);
    p.age = age; p.ageProgress = 0; p.ageAt = this.time; this._rescaleBuildings(p);
    this.events.emit('ageUp', { owner: p.id, age, dev: true });
    this.events.emit('notify', { text: AGES[age].name + ' (geliştirici modu)', type: 'good' });
    return true;
  }
  ageUp(buildingId) {
    const b = this.entities.get(buildingId); if (!b || b.dead || b.type !== 'towncenter' || !b.done) return false;
    if (!this.canAgeUp(b.owner).ok) return false;
    const p = this.players[b.owner], a = AGES[p.age + 1];
    // (owner 2026-11-14: the age-up goes to the FRONT of the queue; a unit in training keeps its progress and goes on afterwards)
    this._pay(b.owner, a.cost); b.queue.unshift({ kind: 'age', id: a.id, t: 0, total: a.time }); p.ageProgress = 0;
    this.events.emit('ageUpStart', { owner: b.owner }); return true;
  }
  cancelQueue(buildingId, index) {
    const b = this.entities.get(buildingId); if (!b || b.kind !== 'building') return false;
    const q = b.queue[index]; if (!q) return false;
    b.queue.splice(index, 1); this._refundQ(b.owner, q); return true;
  }
  _refundQ(owner, q) {
    const p = this.players[owner];
    if (q.kind === 'unit') this._refund(owner, UNITS[q.id].cost);
    else if (q.kind === 'tech') { this._refund(owner, TECHS[q.id].cost); const i = p.pending.indexOf(q.id); if (i >= 0) p.pending.splice(i, 1); }
    else if (q.kind === 'age') { this._refund(owner, AGES[q.id].cost); p.ageProgress = 0; }
  }
  setRally(buildingId, x, z, targetId = null) { const b = this.entities.get(buildingId); if (!b || b.kind !== 'building' || !(BUILDINGS[b.type] && (BUILDINGS[b.type].trains || []).length)) return false; /* (only buildings that train units take a flag, owner 2026-11-15) */ const t = targetId != null ? this.entities.get(targetId) : null; b.rally = { x, z, tid: t ? t.id : null, rtype: t && t.kind === 'resource' ? t.type : null }; return true; }
  // Where a freshly trained villager should work when the rally flag sits on a resource / farm / pasture.
  _rallyWork(b) {
    const ra = b.rally; if (!ra) return null;
    const t = ra.tid != null ? this.entities.get(ra.tid) : null;
    if (t && !t.dead && (t.kind === 'building' || t.amount > 0)) return t;
    const want = ra.rtype; if (!want) return null; // flag on plain ground: villager just walks there
    let best = null, bd = 1e9;
    for (const e of this.entities.values()) { if (e.kind !== 'resource' || e.dead || !(e.amount > 0)) continue; if (want && e.type !== want) continue; const d = Math.hypot(e.x - ra.x, e.z - ra.z); if (d < (want ? 10 : 1.6) && d < bd) { bd = d; best = e; } }
    if (best && want) ra.tid = best.id;
    return best;
  }
  deleteEntity(id) { const e = this.entities.get(id); if (!e || e.dead || e.owner < 0) return false; if (e.kind === 'building') for (const q of e.queue.slice()) this._refundQ(e.owner, q); this._kill(e, null); return true; }

  // ---------- pathfinding ----------
  _findPath(sx, sz, gx, gz, half, owner) {
    const N = this.map.size, g = this._g, st = this._st, par = this._par, hn = this._hn, hf = this._hf;
    const stamp = ++this._stamp; hn.length = 0; hf.length = 0;
    const s0x = Math.min(N - 1, Math.max(0, sx | 0)), s0z = Math.min(N - 1, Math.max(0, sz | 0));
    const gtx = gx | 0, gtz = gz | 0, reach = half + 0.75;
    const isGoal = half < 0 ? ((x, z) => x === gtx && z === gtz) : ((x, z) => Math.abs(x + 0.5 - gx) <= reach && Math.abs(z + 0.5 - gz) <= reach);
    const hh = (x, z) => { const dx = Math.abs(x + 0.5 - gx), dz = Math.abs(z + 0.5 - gz); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    const push = (n, f) => { let i = hn.length; hn.push(n); hf.push(f); while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hn[i] = hn[p]; hf[i] = hf[p]; i = p; } hn[i] = n; hf[i] = f; };
    const pop = () => { const top = hn[0], n = hn.pop(), f = hf.pop(), len = hn.length; if (len > 0) { let i = 0; for (;;) { let c = i * 2 + 1; if (c >= len) break; if (c + 1 < len && hf[c + 1] < hf[c]) c++; if (hf[c] >= f) break; hn[i] = hn[c]; hf[i] = hf[c]; i = c; } hn[i] = n; hf[i] = f; } return top; };
    const start = s0z * N + s0x; g[start] = 0; st[start] = stamp; par[start] = -1; push(start, hh(s0x, s0z));
    let best = start, bestH = hh(s0x, s0z), found = -1, count = 0;
    while (hn.length) {
      const cur = pop(), cx = cur % N, cz = (cur / N) | 0;
      if (isGoal(cx, cz)) { found = cur; break; }
      if (++count > (N * N > 28000 ? N * N >> 2 : 7000)) break;   // (bigger maps: a quarter of the tiles)
      const cg = g[cur];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const nx = cx + dx, nz = cz + dz;
        if (!this._pass(nx, nz, owner)) continue;
        if (dx && dz && (!this._pass(cx + dx, cz, owner) || !this._pass(cx, cz + dz, owner))) continue;
        const ni = nz * N + nx, ng = cg + (dx && dz ? 1.414 : 1);
        if (st[ni] === stamp && g[ni] <= ng) continue;
        st[ni] = stamp; g[ni] = ng; par[ni] = cur; const h = hh(nx, nz);
        if (h < bestH) { bestH = h; best = ni; }
        push(ni, ng + h);
      }
    }
    let n = found >= 0 ? found : best; const out = [];
    while (n !== start && n >= 0) { out.push((n / N | 0) + 0.5, (n % N) + 0.5); n = par[n]; }
    out.reverse(); // now [x,z,...] reversed pairs -> fix order
    const path = []; for (let i = 0; i < out.length; i += 2) path.push(out[i], out[i + 1]);
    if (found >= 0 && half < 0) { if (path.length >= 2) { path[path.length - 2] = gx; path[path.length - 1] = gz; } else path.push(gx, gz); }
    this._pn = (this._pn || 0) + count;
    return path;
  }
  // straight-line walkability (centre + two side samples so corners are not clipped)
  _los(x0, z0, x1, z1, owner) {
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 0.01) return true;
    const n = Math.ceil(L / 0.25), ox = -dz / L * 0.3, oz = dx / L * 0.3;
    for (let i = 0; i <= n; i++) {
      const x = x0 + dx * i / n, z = z0 + dz * i / n;
      if (!this._pass(x | 0, z | 0, owner) || !this._pass((x + ox) | 0, (z + oz) | 0, owner) || !this._pass((x - ox) | 0, (z - oz) | 0, owner)) return false;
    }
    return true;
  }
  // string-pull: drop waypoints that can be skipped in a straight walkable line
  _smooth(p, sx, sz, owner) {
    if (!p || p.length < 4) return p;
    const out = []; let ax = sx, az = sz;
    for (let i = 0; i < p.length - 2; i += 2) {
      const nx = p[i + 2], nz = p[i + 3];
      if (Math.abs(nx - ax) + Math.abs(nz - az) < 24 && this._los(ax, az, nx, nz, owner)) continue;
      out.push(p[i], p[i + 1]); ax = p[i]; az = p[i + 1];
    }
    out.push(p[p.length - 2], p[p.length - 1]);
    return out;
  }
  // budgeted path request: null when this tick's A* budget is spent (caller steers straight and retries)
  _reqPath(u, gx, gz, half) {
    if ((this._pn || 0) > 5000) return null;
    return this._smooth(this._findPath(u.x, u.z, gx, gz, half, u.owner), u.x, u.z, u.owner);
  }
  // ---- flow field for move orders (2026-11-14: 300 soldiers stalled mid-route). A* stops after a node cap and then
  // returns a part route to the point nearest the goal, often a dead end in a forest, where units dropped their order.
  // One breadth-first sweep from the goal over the whole map gives every cell its step count to the goal; each unit of
  // the group then walks downhill on it: complete routes of any length, one search per order instead of one per unit.
  // Kept on the order's group object, not saved (non-enumerable). Lockstep + save/load: the field must be a function
  // of saved state only, so it is valid only while the map's blocking version (blkV, saved) still equals the one it was
  // built at (grp.fv, saved). A loaded game rebuilds it from the same map; a stale field is rebuilt at most every
  // FF_GAP ticks (grp.fb = build tick, saved); in between the unit waits (null = wait). The sweep stops FF_MARGIN
  // steps past the group's furthest unit (grp.fd = that depth, saved, -1 = whole map): a short move costs a small patch.
  _flowField(grp, owner, from, units) {
    const V = this._blkV || 0;
    if (grp.ff && grp.fv === V) return grp.ff;
    const N = this.map.size, cl = v => Math.min(N - 2, Math.max(1, v | 0));
    if (grp.sx !== undefined && grp.fv !== V && this.tick - (grp.fb | 0) < FF_GAP) return null;
    grp.fv = V; grp.fb = this.tick;
    if (grp.sx === undefined) {   // first build: seed at the click, or, if the leader cannot get there, at the nearest point it can reach
      const gx = grp.tx !== undefined ? grp.tx : from.x, gz = grp.tz !== undefined ? grp.tz : from.z, f = this._freeNear(gx, gz, owner);
      grp.sx = cl(f.x); grp.sz = cl(f.z);
      grp.fd = -1;
      if (from) {
        const P = this._passMap(owner), want = [];
        for (const u of units && units.length ? units : [from]) { const k = cl(u.z) * N + cl(u.x); if (P[k]) want.push(k); }
        let d0 = this._ffSweep(grp.sx, grp.sz, owner, null, Infinity, want); const fc = cl(from.z) * N + cl(from.x);
        if (d0[fc] < 0) {   // the click is out of reach: sweep from the leader, take its reachable cell closest to the click
          const dl = this._ffSweep(cl(from.x), cl(from.z), owner, null); let bk = -1, bd = 1e18;
          for (let k = 0; k < N * N; k++) { if (dl[k] < 0) continue; const ddx = (k % N) + 0.5 - gx, ddz = ((k / N) | 0) + 0.5 - gz, dd = ddx * ddx + ddz * ddz; if (dd < bd) { bd = dd; bk = k; } }
          if (bk >= 0) { grp.sx = bk % N; grp.sz = (bk / N) | 0; d0 = this._ffSweep(grp.sx, grp.sz, owner, d0, Infinity, want); }
        }
        if (this._ffLim !== Infinity) grp.fd = this._ffLim;
        return this._ffKeep(grp, d0);
      }
    }
    return this._ffKeep(grp, this._ffSweep(grp.sx, grp.sz, owner, grp.ff && grp.ff.length === N * N ? grp.ff : null, grp.fd >= 0 ? grp.fd : Infinity));
  }
  _ffKeep(grp, d) {
    Object.defineProperty(grp, 'ff', { value: d, writable: true, enumerable: false, configurable: true });
    return d;
  }
  // where owner can walk, one byte per cell; kept up to date cell by cell (_blkMark), fully rebuilt when the teams change
  _passMap(owner) {
    const N = this.map.size, c = this._pmc || (this._pmc = new Map()), key = this._tm ? this._tm.join(',') : '';
    const e = c.get(owner);
    if (e && e.k === key && e.P.length === N * N) return e.P;
    const P = e && e.P.length === N * N ? e.P : new Uint8Array(N * N), nm = this._navMode; this._navMode = false;
    for (let z = 0, k = 0; z < N; z++) for (let x = 0; x < N; x++, k++) P[k] = this._pass(x, z, owner) ? 1 : 0;
    this._navMode = nm;
    c.set(owner, { k: key, P }); return P;
  }
  // something blocking changed in a w x h box: bump the version (flow fields go stale) and refresh the cached pass maps
  _blkMark(x0, z0, w, h) {
    this._blkV = (this._blkV || 0) + 1;
    if (!this._pmc || !this._pmc.size) return;
    const N = this.map.size, nm = this._navMode; this._navMode = false;
    for (const [owner, e] of this._pmc) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = x0 + i, z = z0 + j; if (x < 0 || z < 0 || x >= N || z >= N) continue;
      e.P[z * N + x] = this._pass(x, z, owner) ? 1 : 0;
    }
    this._navMode = nm;
  }
  // breadth-first step counts from (sx, sz) over the cells owner can walk (8 directions, no corner cutting), -1 beyond
  // depth maxD; with want (cells), the sweep ends FF_MARGIN steps after the last of them is reached (_ffLim: the depth
  // it stopped at, Infinity when it covered everything it could reach)
  _ffSweep(sx, sz, owner, into, maxD = Infinity, want = null) {
    const N = this.map.size, s0 = sz * N + sx;
    const d = into || new Int32Array(N * N); d.fill(-1);
    const q = this._ffq && this._ffq.length === N * N ? this._ffq : (this._ffq = new Int32Array(N * N));
    const P = this._passMap(owner), ws = want && want.length ? new Set(want) : null;
    let lim = maxD, need = ws ? ws.size : 0;
    if (ws && ws.has(s0) && --need === 0) lim = Math.min(lim, FF_MARGIN);
    let h = 0, t = 0, cut = false; d[s0] = 0; q[t++] = s0;
    while (h < t) {
      const c = q[h++]; if (d[c] >= lim) { cut = true; break; }   // (breadth-first: every later cell is at least as deep)
      const cx = c % N, cz = (c / N) | 0, nd = d[c] + 1;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const k = nz * N + nx; if (d[k] >= 0 || !P[k]) continue;
        if (dx && dz && (!P[cz * N + nx] || !P[nz * N + cx])) continue;
        d[k] = nd; q[t++] = k;
        if (need > 0 && ws.has(k) && --need === 0) lim = Math.min(lim, nd + FF_MARGIN);
      }
    }
    this._ffLim = cut ? lim : Infinity;
    return d;
  }
  // a unit's route down the flow field (cell centres, then the exact goal), smoothed like an A* route, at most FF_SEG
  // cells at a time (u.fpp marks such a stretch: at its end the unit asks again); null when the unit stands where the
  // goal cannot be reached from (another island, a walled pocket): the caller falls back to A*; false: wait a tick
  _fieldPath(u, o) {
    if ((this._fpn || 0) > FF_WALK) return false;   // this tick's budget is spent: wait (deterministic, like _pn)
    const N = this.map.size, d = this._flowField(o.grp, u.owner, u); if (!d) return false;
    let c = Math.min(N - 1, Math.max(0, u.z | 0)) * N + Math.min(N - 1, Math.max(0, u.x | 0));
    if (d[c] < 0) {   // a cell joined to the rest only through a diagonal squeeze (straight lines may cut corners, the sweep may not): start next door
      const cx = c % N, cz = (c / N) | 0; let bk = -1;
      for (let r = 1; r <= 2 && bk < 0; r++) for (let j = -r; j <= r && bk < 0; j++) for (let i = -r; i <= r; i++) { const nx = cx + i, nz = cz + j; if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue; const k = nz * N + nx; if (d[k] >= 0) { bk = k; break; } }
      if (bk < 0) return null;
      c = bk;
    }
    const p = [(c % N) + 0.5, ((c / N) | 0) + 0.5];
    let part = false;
    for (let guard = 0; d[c] > 0; guard++) {
      if (guard >= FF_SEG) { part = true; break; }
      const cx = c % N, cz = (c / N) | 0; let bn = -1, bd = d[c];
      if (Math.abs(cx + 0.5 - o.x) + Math.abs(cz + 0.5 - o.z) < 12 && this._los(cx + 0.5, cz + 0.5, o.x, o.z, u.owner)) break;   // own spot in sight
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const k = nz * N + nx; if (d[k] < 0 || d[k] >= bd) continue;
        if (dx && dz && (!this._pass(cx + dx, cz, u.owner) || !this._pass(cx, cz + dz, u.owner))) continue;
        bd = d[k]; bn = k;
      }
      if (bn < 0) break;
      c = bn; p.push((c % N) + 0.5, ((c / N) | 0) + 0.5);
    }
    this._fpn = (this._fpn || 0) + p.length / 2 + 8;
    if (part) u.fpp = 1; else { if (u.fpp) delete u.fpp; p.push(o.x, o.z); }
    return this._smooth(p, u.x, u.z, u.owner);
  }
  _steer(u, x, z, dt) {
    const dx = x - u.x, dz = z - u.z, L = Math.hypot(dx, dz); if (L < 0.05) return;
    const s = Math.min(L, this._speed(u) * dt), nx = u.x + dx / L * s, nz = u.z + dz / L * s;
    if (this._pass(nx | 0, nz | 0, u.owner)) { u.x = nx; u.z = nz; u.rot = Math.atan2(dx, dz); }
  }
  _speed(u) { const d = UNITS[u.type], m = this.players[u.owner].mods; let s = d.speed * (1 + (m.speed[d.cls] || 0)); if (u.type === 'villager') s *= 1 + m.vspeed; const t = this.map.tiles[(u.z | 0) * this.map.size + (u.x | 0)]; if (t === 3 && !u.naval) s *= 0.6; return s; }
  _step(u, dt) {
    if (!u.path || u.pi >= u.path.length) return true;
    let d = this._speed(u) * dt;
    while (d > 0 && u.pi < u.path.length) {
      const px = u.path[u.pi], pz = u.path[u.pi + 1], dx = px - u.x, dz = pz - u.z, L = Math.hypot(dx, dz);
      if (L <= d) { u.x = px; u.z = pz; d -= L; u.pi += 2; }
      else { u.x += dx / L * d; u.z += dz / L * d; u.rot = Math.atan2(dx, dz); d = 0; }
    }
    return u.pi >= u.path.length;
  }
  // a new foundation: land units whose stored route runs across it plan again (they used to walk into it, following
  // the old route, and stand stuck inside)
  _repathAround(b) {
    const x0 = b.tx - 0.35, x1 = b.tx + b.size + 0.35, z0 = b.tz - 0.35, z1 = b.tz + b.size + 0.35;
    const hits = (ax, az, bx, bz) => {   // segment / box (Liang-Barsky)
      let t0 = 0, t1 = 1; const dx = bx - ax, dz = bz - az;
      for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return true;
    };
    for (const u of this.units) {
      if (u.dead || u.naval || u.aboard || u.train || !u.path || u.pi >= u.path.length) continue;
      let ax = u.x, az = u.z;
      for (let i = u.pi; i < u.path.length; i += 2) { if (hits(ax, az, u.path[i], u.path[i + 1])) { u.path = null; u.pk = null; break; } ax = u.path[i]; az = u.path[i + 1]; }
    }
  }
  _edge(u, t) {
    const half = t.kind === 'building' ? t.size / 2 : (t.kind === 'resource' && t.type !== 'deer') ? 0.5 : 0;
    const dx = Math.max(Math.abs(u.x - t.x) - half, 0), dz = Math.max(Math.abs(u.z - t.z) - half, 0);
    return Math.hypot(dx, dz);
  }
  // walk toward entity t until within reach; true when in reach
  _approach(u, t, dt, reach) {
    if (this._edge(u, t) <= reach) { u.path = null; u.pk = null; return true; }
    u.state = 'move'; u.anim = 'walk';
    const half = t.kind === 'building' ? t.size / 2 : (t.kind === 'resource' && t.type !== 'deer') ? 0.5 : 0;
    const key = t.id + ':' + (t.x | 0) + ':' + (t.z | 0);
    if (!u.path || (u.pk !== key && this.time >= u.rpT)) {
      const p = this._reqPath(u, t.x, t.z, half);
      if (p) { u.path = p; u.pi = 0; u.pk = key; u.rpT = this.time + 0.6; }
      else if (!u.path) {
        // no path this tick (search budget spent, or none): steer; an auto attack that keeps steering gives up
        const o = u.order; if (o && o.auto) { o.st = (o.st || 0) + dt; if (o.st > 6) { this._giveUp(u); return false; } }
        this._steer(u, t.x, t.z, dt); return false;
      }
    }
    if (this._step(u, dt)) {
      // end of path but not in reach: steer directly if close, else fail
      const dx = t.x - u.x, dz = t.z - u.z, L = Math.hypot(dx, dz);
      if (L < 3.5 && L > 0.01) { const s = this._speed(u) * dt, nx = u.x + dx / L * s, nz = u.z + dz / L * s; if (this._pass(nx | 0, nz | 0, u.owner)) { u.x = nx; u.z = nz; u.rot = Math.atan2(dx, dz); return false; } }
      if (this.time >= u.rpT) { u.path = null; const o = u.order; if (o) { o.fail = (o.fail || 0) + 1; if (o.fail > 5) this._giveUp(u); } }
    }
    return false;
  }
  _next(u) { if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.order = u.queue.shift() || null; u.path = null; u.pk = null; u.rpT = 0; u.targetId = u.order ? (u.order.targetId || null) : null; if (!u.order) { u.state = 'idle'; u.anim = 'idle'; u.scanT = 0; } }   // (scanT 0: a soldier whose foe just fell looks for the next one at once - 2026-11-17 playtest)
  // First free spot in a square spiral around (x, z): not taken by a friendly unit standing there or already walking there.
  // Keeps freshly trained units from piling up on the rally point.
  _slotNear(x, z, self) {
    const sp = UNITS[self.type].cls === 'siege' ? 1.8 : 1.1, taken = [];
    for (const v of this.units) {
      if (v === self || v.dead || v.owner !== self.owner || v.naval) continue;
      const tx = v.order && v.order.type === 'move' ? v.order.x : v.x, tz = v.order && v.order.type === 'move' ? v.order.z : v.z;
      if (Math.abs(tx - x) < 12 && Math.abs(tz - z) < 12) taken.push(tx, tz);
    }
    const free = (px, pz) => { for (let i = 0; i < taken.length; i += 2) if (Math.abs(taken[i] - px) < sp * 0.6 && Math.abs(taken[i + 1] - pz) < sp * 0.6) return false; return this._pass(Math.floor(px), Math.floor(pz), self.owner); };
    for (let r = 0; r < 6; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      const px = x + i * sp, pz = z + j * sp; if (free(px, pz)) return { x: px, z: pz };
    }
    return this._freeNear(x, z, self.owner);
  }
  _nearestB(u, pred) { let best = null, bd = 1e9; for (const b of this.buildings) { if (b.owner !== u.owner || !b.done || b.dead || !pred(b)) continue; const d = (b.x - u.x) ** 2 + (b.z - u.z) ** 2; if (d < bd) { bd = d; best = b; } } return best; }
  _near(x, z, r, fn) {
    const hc = this._hc, c0 = Math.max(0, ((x - r) / CELL) | 0), c1 = Math.min(hc - 1, ((x + r) / CELL) | 0), r0 = Math.max(0, ((z - r) / CELL) | 0), r1 = Math.min(hc - 1, ((z + r) / CELL) | 0);
    for (let j = r0; j <= r1; j++) for (let i = c0; i <= c1; i++) { const c = this._cells[j * hc + i]; for (let k = 0; k < c.length; k++) fn(c[k]); }
  }

  // ---------- unit update ----------
  _updateUnit(u, dt) {
    if (u.cd > 0) u.cd -= dt;
    const o = u.order;
    if (!o) {
      u.state = 'idle'; u.anim = 'idle';
      const d = UNITS[u.type];
      if (d.cls !== 'civil' && d.atk > 0) { u.scanT -= dt; if (u.scanT <= 0) { u.scanT = 0.5; const t = this._acquire(u, u.stance === 'hold' ? (d.range > 0 ? this._wRange(u) : 1.6) : d.los, false, u.type === 'ram'); if (t) { u.order = { type: 'attack', targetId: t.id, auto: true, ox: u.x, oz: u.z }; u.targetId = t.id; } } }
      return;
    }
    switch (o.type) {
      case 'move': {
        u.state = 'move'; u.anim = 'walk';
        if (!u.naval && UNITS[u.type].atk > 0 && UNITS[u.type].cls !== 'civil' && u.type !== 'ram') {
          u.scanT -= dt;
          if (u.scanT <= 0) { u.scanT = 0.5; const t = this._acquire(u, UNITS[u.type].los, true); if (t && this._canEngage(u, t)) { this._engage(u, t); break; } }
        }
        if (!u.path) {
          let p = o.grp && !u.naval ? this._fieldPath(u, o) : null;
          if (p === false) break;   // the group's field is being rebuilt (see _flowField): wait a moment
          if (!p) p = this._reqPath(u, o.x, o.z, -1);
          // no path this tick (search budget spent): wait, unless the way ahead is clear (walking straight into trees wedges units)
          if (!p) { if (this._los(u.x, u.z, o.x, o.z, u.owner)) this._steer(u, o.x, o.z, dt); break; }
          u.path = p; u.pi = 0;
        }
        if (this._step(u, dt)) {
          if (u.fpp) { delete u.fpp; u.path = null; break; }   // end of a flow-field stretch: next one
          // a route that ends short of the goal (a partial search, or something built across it): plan again from here
          if (Math.hypot(u.x - o.x, u.z - o.z) > 1.6 && (o.rp = (o.rp || 0) + 1) <= 3) { u.path = null; break; }
          this._next(u);
        }
        break;
      }
      case 'attack': this._uAttack(u, o, dt); break;
      case 'gather': this._uGather(u, o, dt); break;
      case 'return': this._uReturn(u, o, dt); break;
      case 'build': this._uBuild(u, o, dt); break;
      case 'trade': this._uTrade(u, o, dt); break;
      default: this._next(u);
    }
  }
  _credit(p, res, n) { p.res[res] += n; p.stats.gathered[res] += n; }
  _uGather(u, o, dt) {
    const p = this.players[u.owner], cap = 10 + p.mods.carry;
    let t = this.entities.get(o.targetId);
    if (o.rt === 'pasture') return this._pasGather(u, o, dt, t, p);
    if (o.rt === 'farm' && t && !t.dead && t.done && t.farm && Array.isArray(t.farm.plots)) return this._plotFarm(u, o, dt, t, p, cap);
    if (o.rt === 'farm') {
      if (!t || t.dead) return this._next(u);
      if (!t.done) { u.order = { type: 'build', targetId: t.id }; return; }
      if (!this._approach(u, t, dt, 1.0)) return;
      // up to 8 farmers work INSIDE the plot, each on its own spot (diminishing returns)
      t.nw++; if (t.nw > 8) return this._next(u);
      const si = t.nw - 1, FO = [-0.9, -0.9, 0.9, 0.9, 0.9, -0.9, -0.9, 0.9, 0, -0.9, 0, 0.9, -0.9, 0, 0.9, 0];
      const k = Math.max(1, t.size / 4);   // (herder spots spread with the pasture: 6x6 since 2026-11-17)
    const sx = t.x + FO[si * 2] * k + Math.sin(this.time * 0.12 + si * 2.1) * 0.3, sz = t.z + FO[si * 2 + 1] * k + Math.cos(this.time * 0.1 + si * 1.7) * 0.3;
      const fdx = sx - u.x, fdz = sz - u.z, fd = Math.hypot(fdx, fdz);
      u.state = 'gather';
      if (fd > 0.25) { const st = Math.min(fd, 1.6 * dt); u.x += fdx / fd * st; u.z += fdz / fd * st; u.rot = Math.atan2(fdx, fdz); u.anim = 'walk'; return; }
      if (fd > 0.01) { const st = Math.min(fd, 0.3 * dt); u.x += fdx / fd * st; u.z += fdz / fd * st; }
      u.anim = 'farm'; u.rot = si * 1.3 + Math.sin(this.time * 0.2 + si) * 0.6;
      const c = [1, 0.7, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15][si];
      const f = t.farm, prev = f.stage; f.growth += dt / 30 * c;
      if (f.growth >= 1) f.growth -= 1;
      const g = f.growth; f.stage = g < 0.15 ? 1 : g < 0.3 ? 2 : g < 0.6 ? 3 : g < 0.7 ? 4 : 5;
      if (f.stage !== prev) this.events.emit('farmStage', { e: t });
      if (f.stage === 5) {
        o.acc += dt * c * 16 * (1 + p.mods.farm) / 9;
        if (o.acc >= 1) { const n = o.acc | 0; o.acc -= n; this._credit(p, 'food', n); o.dep = (o.dep || 0) + n; if (o.dep >= 5) { this.events.emit('deposit', { unit: u, owner: u.owner, res: 'food', amount: o.dep }); o.dep = 0; } }
      }
      o.tick += dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('gatherTick', { unit: u, res: 'food' }); }
      return;
    }
    if (u.carry && u.carry.type !== o.res) u.carry = null;
    if (u.carry && u.carry.amount >= cap) { u.order = { type: 'return', res: o.res, resume: o }; u.path = null; u.pk = null; return; }
    if (!t || t.dead || t.amount <= 0) {
      const n = this.resourceNear(o.x, o.z, 10, o.rt);
      if (n) { o.targetId = n.id; u.targetId = n.id; o.x = n.x; o.z = n.z; o.fail = 0; u.path = null; u.pk = null; return; }
      if (u.carry && u.carry.amount > 0) { u.order = { type: 'return', res: o.res, resume: null }; u.path = null; u.pk = null; return; }
      return this._next(u);
    }
    if (SPOTS[t.type]) {
      // stationary resource: every worker stands on its own spot around the tile instead of all stacking on one point
      if (o.sp === t.id && !this._pass(o.sx | 0, o.sz | 0, u.owner)) o.sp = 0;
      if (o.sp === t.id) {
        const d = Math.hypot(o.sx - u.x, o.sz - u.z);
        if (d > (o.so ? 0.45 : 0.05)) { // a shared spot: close is enough (the others standing there keep pushing walkers off it)
          // coming back from the drop-off: path straight to the spot (back to the plain tile approach if that keeps failing)
          if (d > 2.5 && !this._approach(u, { id: 'sp', kind: 'pt', x: o.sx, z: o.sz }, dt, 2.5)) { if (o.fail >= 3) { o.sp = 0; o.fail = 0; } return; }
          // someone already stands there (or a lower id is walking to the same point): choose again
          if (!o.so) { let hit = false; this._near(o.sx, o.sz, 1.2, e => { if (hit || e === u || e.dead) return; const q = e.order; if (!q || q.type !== 'gather' || !q.sp || Math.hypot(q.sx - o.sx, q.sz - o.sz) >= 0.5) return; if (e.id < u.id || Math.hypot(e.x - q.sx, e.z - q.sz) < 0.1) hit = true; }); if (hit) { o.sp = 0; u.path = null; u.pk = null; return; } }
          if (!u.path || u.pk !== 'sp') { const pa = this._losC(u.x, u.z, o.sx, o.sz, u.owner) ? [o.sx, o.sz] : this._spotPath(u, t, o.sx, o.sz); if (!pa) { o.sp = 0; return; } u.path = pa; u.pi = 0; u.pk = 'sp'; }
          u.state = 'move'; u.anim = 'walk';
          if (!this._step(u, dt)) return;
          u.path = null; u.pk = null;
        }
      }
      if (o.sp !== t.id) {
        if (this._edge(u, t) > 2.5 || this.time < (o.np || 0)) { if (!this._approach(u, t, dt, 1.0)) return; }
        else {
          this._pickSpot(u, o, t); // a few steps before arriving, so the walk bends straight to the spot
          if (o.targetId !== t.id || o.sp === t.id) return; // walking to the new tile / spot from the next tick
          o.np = this.time + 1; // no reachable stand spot: work from the tile edge (old behaviour), look again in a second
          if (!this._approach(u, t, dt, 1.0)) return;
        }
      }
    } else if (!this._approach(u, t, dt, 1.0)) return;
    if (t.type === 'deer') t.hunted = true;
    u.state = 'gather'; u.anim = ANIM_OF[t.type]; u.rot = Math.atan2(t.x - u.x, t.z - u.z);
    o.acc += RATE[t.type] * p.mods.gather[o.res] * dt;
    while (o.acc >= 1 && t.amount > 0) { o.acc -= 1; if (t.type !== 'stone' && t.type !== 'gold') t.amount--; /* mines never run out */ if (!u.carry) u.carry = { type: o.res, amount: 0 }; u.carry.amount++; }
    o.tick += dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('gatherTick', { unit: u, res: o.res }); }
    if (t.amount <= 0) this._kill(t, u);
  }
  // center-line walkability between two close points (local moves to a stand spot)
  _losC(x0, z0, x1, z1, owner) { const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 0.2); for (let i = 1; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n; if (!this._pass(x | 0, z | 0, owner)) return false; } return true; }
  // stand spots around a resource tile: 4 sides then 4 corners, only on tiles this owner can walk
  _spotCands(t, owner) { const out = []; for (let i = 0; i < 16; i += 2) { const x = t.x + SPOT_O[i], z = t.z + SPOT_O[i + 1]; if (this._pass(x | 0, z | 0, owner)) out.push(x, z); } return out; }
  // spots claimed by other gatherers near (x, z): derived from their orders every time, nothing stored besides the order itself
  _spotClaims(u, x, z) { const cl = []; this._near(x, z, 2.6, e => { if (e === u || e.dead) return; const q = e.order; if (q && q.type === 'gather' && q.sp && Math.abs(q.sx - x) < 2.6 && Math.abs(q.sz - z) < 2.6) cl.push(q.sx, q.sz, q.sp); }); return cl; }
  _spotFree(cl, x, z) { for (let k = 0; k < cl.length; k += 3) if (Math.hypot(cl[k] - x, cl[k + 1] - z) < 0.55) return false; return true; }
  // local BFS (8-way, no corner cutting, like _findPath) from the unit's tile in a box around t: steps per tile, -1 = not reached
  _spotBfs(u, t) {
    const B = SPOT_BOX, W = B * 2 + 1, ox = (t.x | 0) - B, oz = (t.z | 0) - B, dist = new Int16Array(W * W).fill(-1), q = [];
    const sx = (u.x | 0) - ox, sz = (u.z | 0) - oz; if (sx < 0 || sz < 0 || sx >= W || sz >= W) return { dist, ox, oz, W, par: null };
    const par = new Int16Array(W * W).fill(-1), ok = (x, z) => x >= 0 && z >= 0 && x < W && z < W && this._pass(x + ox, z + oz, u.owner);
    dist[sz * W + sx] = 0; q.push(sz * W + sx);
    for (let h = 0; h < q.length; h++) {
      const c = q[h], cx = c % W, cz = (c / W) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const nx = cx + dx, nz = cz + dz, ni = nz * W + nx;
        if (!ok(nx, nz) || dist[ni] >= 0 || (dx && dz && (!ok(cx + dx, cz) || !ok(cx, cz + dz)))) continue;
        dist[ni] = dist[c] + 1; par[ni] = c; q.push(ni);
      }
    }
    return { dist, ox, oz, W, par };
  }
  _bfsAt(bf, x, z) { const i = (x | 0) - bf.ox, j = (z | 0) - bf.oz; return i < 0 || j < 0 || i >= bf.W || j >= bf.W ? -1 : bf.dist[j * bf.W + i]; }
  // waypoints (tile centres, then the spot itself) for a short walk around the resource to a stand spot
  _spotPath(u, t, x, z) {
    const bf = this._spotBfs(u, t); if (this._bfsAt(bf, x, z) < 0) return null;
    const out = []; let c = ((z | 0) - bf.oz) * bf.W + ((x | 0) - bf.ox); c = bf.par[c];
    while (c >= 0 && bf.dist[c] > 0) { out.push(c % bf.W + bf.ox + 0.5, ((c / bf.W) | 0) + bf.oz + 0.5); c = bf.par[c]; }
    const p = []; for (let i = out.length - 2; i >= 0; i -= 2) p.push(out[i], out[i + 1]); p.push(x, z); return p;
  }
  _pickSpot(u, o, t) {
    const K = SPOTS[t.type], c = this._spotCands(t, u.owner), cl = this._spotClaims(u, t.x, t.z), bf = this._spotBfs(u, t);
    o.sp = 0; o.so = 0;
    let on = 0; for (let k = 2; k < cl.length; k += 3) if (cl[k] === t.id) on++;
    if (on < K) {
      // the free reachable spot with the shortest walk (straight distance breaks ties, then candidate order)
      let bi = -1, bd = 1e9;
      for (let i = 0; i < c.length; i += 2) { const s = this._bfsAt(bf, c[i], c[i + 1]); if (s < 0 || !this._spotFree(cl, c[i], c[i + 1])) continue; const d = s * 2 + Math.hypot(c[i] - u.x, c[i + 1] - u.z); if (d < bd - 1e-9) { bd = d; bi = i; } }
      if (bi >= 0) { o.sp = t.id; o.sx = c[bi]; o.sz = c[bi + 1]; return; }
    }
    // full: another tile of the same type (same deposit / forest) with a free reachable spot, the shortest walk from here
    // (then straight distance from t, then id)
    const N = this.map.size, R = SPOT_R, tx = t.x | 0, tz = t.z | 0, alt = [];
    for (let z = Math.max(0, tz - R); z <= Math.min(N - 1, tz + R); z++) for (let x = Math.max(0, tx - R); x <= Math.min(N - 1, tx + R); x++) {
      const id = this.resAt[z * N + x]; if (!id || id === t.id) continue; const e = this.entities.get(id);
      if (!e || e.dead || e.type !== t.type || !(e.amount > 0)) continue; const d = Math.hypot(e.x - t.x, e.z - t.z); if (d <= R) alt.push([d, e.id, e]);
    }
    let be = null, bs = 1e9, bd = 1e9;
    for (const [d, id, e] of alt) {
      const ec = this._spotCands(e, u.owner); if (!ec.length) continue;
      const ecl = this._spotClaims(u, e.x, e.z); let n = 0; for (let k = 2; k < ecl.length; k += 3) if (ecl[k] === e.id) n++;
      if (n >= K) continue;
      for (let i = 0; i < ec.length; i += 2) { const st = this._bfsAt(bf, ec[i], ec[i + 1]); if (st < 0 || !this._spotFree(ecl, ec[i], ec[i + 1])) continue; if (st < bs || (st === bs && (d < bd || (d === bd && id < be.id)))) { bs = st; bd = d; be = e; } }
    }
    if (be) { o.targetId = be.id; u.targetId = be.id; o.x = be.x; o.z = be.z; o.fail = 0; u.path = null; u.pk = null; return; }
    // nothing free nearby: share the least crowded reachable spot (no freezing)
    let bi = -1, bn = 1e9;
    for (let i = 0; i < c.length; i += 2) { if (this._bfsAt(bf, c[i], c[i + 1]) < 0) continue; let n = 0; for (let k = 0; k < cl.length; k += 3) if (Math.hypot(cl[k] - c[i], cl[k + 1] - c[i + 1]) < 0.55) n++; if (n < bn) { bn = n; bi = i; } }
    if (bi >= 0) { o.sp = t.id; o.sx = c[bi]; o.sz = c[bi + 1]; o.so = 1; }
  }
  _uReturn(u, o, dt) {
    if (!u.carry || u.carry.amount <= 0) { u.carry = null; if (o.resume) { u.order = o.resume; u.targetId = o.resume.targetId; u.path = null; u.pk = null; } else this._next(u); return; }
    let b = this.entities.get(o.dropId);
    if (!b || b.dead) { b = this._nearestB(u, x => { const d = BUILDINGS[x.type].dropoff; return d && d.includes(u.carry.type); }); if (!b) { u.state = 'idle'; u.anim = 'idle'; return; } o.dropId = b.id; }
    if (this._approach(u, b, dt, 1.0)) {
      const p = this.players[u.owner]; this._credit(p, u.carry.type, u.carry.amount);
      this.events.emit('deposit', { unit: u, owner: u.owner, res: u.carry.type, amount: u.carry.amount });
      u.carry = null;
      if (o.resume) { u.order = o.resume; u.order.fail = 0; if (u.order.so) u.order.sp = u.order.so = 0; /* shared spot: look for a free one again */ u.targetId = o.resume.targetId; u.path = null; u.pk = null; } else this._next(u);
    }
  }
  _uBuild(u, o, dt) {
    const b = this.entities.get(o.targetId);
    if (!b || b.dead) return this._nextBuild(u, o);
    if (b.done && b.hp >= b.maxHp) {
      // (a finished farm / pasture keeps its builder working it, unless more orders are queued: playtest 2)
      if (b.type === 'farm' && !u.queue.length) { u.order = { type: 'gather', targetId: b.id, res: 'food', rt: 'farm', x: b.x, z: b.z, acc: 0, tick: 0, dep: 0 }; return; }
      if (b.type === 'pasture' && !u.queue.length) { u.order = { type: 'gather', targetId: b.id, res: 'food', rt: 'pasture', x: b.x, z: b.z, acc: 0, tick: 0, dep: 0 }; return; }
      // builder of a lumber camp / mine camp starts working the nearest matching resource next to it
      if ((b.type === 'lumbercamp' || b.type === 'minecamp') && !u.queue.length && u.type === 'villager') {
        let best = null, bd = 1e9;
        for (const r of this.entities.values()) {
          if (r.kind !== 'resource' || r.dead || !(r.amount > 0)) continue;
          if (b.type === 'lumbercamp' ? r.type !== 'tree' : (r.type !== 'stone' && r.type !== 'gold')) continue;
          const d = Math.hypot(r.x - b.x, r.z - b.z); if (d < 10 && d < bd) { bd = d; best = r; }
        }
        if (best) { Game.prototype.cmdGather.call(this, [u.id], best.id); return; }
      }
      return this._nextBuild(u, o);
    }
    if (!this._approach(u, b, dt, 1.0)) return;
    u.state = 'build'; u.anim = 'build'; u.rot = Math.atan2(b.x - u.x, b.z - u.z);
    b.nb++; const c = 1 / b.nb, d = BUILDINGS[b.type];
    o.tick = (o.tick || 0) + dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('buildTick', { unit: u, building: b }); } // view only (hammer sound)
    if (!b.done) {
      if (!b.started && (b.type === 'wall' || b.type === 'tower' || b.type === 'gate')) { b.started = true; this._block(b, this._solidV(b)); this._repathAround(b); this._pushOut(b); }   // (work begun: solid, see _addBuilding)
      const dp = dt / (d.time * BUILD_TIME_MUL) * c * (this.cfg.sandbox && b.owner === 0 ? 2 : 1); b.progress += dp; b.hp = Math.min(b.maxHp, b.hp + b.maxHp * dp);
      if (b.progress >= 1) this._complete(b);
    } else b.hp = Math.min(b.maxHp, b.hp + b.maxHp * dt / d.time * 0.6 * c);
  }
  _complete(b) {
    b.progress = 1; b.done = true; const p = this.players[b.owner];
    // the foundation becomes solid now (flow fields go stale through _blkMark); units inside step out, routes across it are planned again
    const v = this._solidV(b);
    if (v !== 3) { if (b.type === 'dock') this._navBlockDock(b, v); else this._block(b, v); this._repathAround(b); this._pushOut(b); }
    p.stats.buildingsBuilt++; this._popCap(p);
    if (b.type === 'rail' || b.type === 'station') this._railDirty = true;
    this.events.emit('buildComplete', { e: b });
    if (b.owner === this.me) this.events.emit('notify', { text: BUILDINGS[b.type].name + ' tamamlandı', type: 'good', x: b.x, z: b.z });
  }
  _uTrade(u, o, dt) {
    let m = this.entities.get(o.m), tc = this.entities.get(o.tc);
    if (!m || m.dead) { m = this._nearestB(u, b => b.type === 'market'); o.m = m ? m.id : 0; }
    if (!tc || tc.dead) { tc = this._nearestB(u, b => b.type === 'towncenter'); o.tc = tc ? tc.id : 0; }
    if (!m || !tc) { u.state = 'idle'; u.anim = 'idle'; return; }
    const t = o.phase ? tc : m;
    if (this._approach(u, t, dt, 1.2)) {
      // a leg takes at least 5 s: with a market right next to a town center the cart used to flip every
      // frame and credit gold ~15x per second (an unlimited-gold exploit for any player)
      if (this.time - (o.lt != null ? o.lt : -99) < 5) { u.state = 'idle'; u.anim = 'idle'; return; }
      o.lt = this.time;
      if (o.phase) { const g = Math.round((8 + Math.hypot(m.x - tc.x, m.z - tc.z) * 0.6) * (1 + this.players[u.owner].mods.cart)); this._credit(this.players[u.owner], 'gold', g); this.events.emit('deposit', { unit: u, owner: u.owner, res: 'gold', amount: g }); }
      o.phase = o.phase ? 0 : 1; o.fail = 0;
    }
  }

  // ---------- building update ----------
  _updateBuilding(b, dt) {
    b.nb = 0; b.nw = 0;
    if (!b.done) return;
    const d = BUILDINGS[b.type], p = this.players[b.owner];
    if (d.atk > 0) {
      if (b.cd > 0) b.cd -= dt;
      else {
        // (castle, 2026-11-17 playtest "the castle has no real power, you can't even tell it shoots"): a volley of
        // CASTLE_VOLLEY arrows at as many targets, and its attack grows every age like a tower's
        b.cd = 0.4; const castle = b.type === 'castle';
        const ts = this._bTargets(b, d.range + p.mods.towerRange + towerAgeBonus(b.type, p.age), castle ? CASTLE_VOLLEY : 1);
        if (ts.length) {
          b.cd = 2; const atk = d.atk + p.mods.towerAtk + p.age * (b.type === 'tower' ? TOWER_AGE_ATK : castle ? CASTLE_AGE_ATK : 1);
          const proj = b.type === 'tower' && p.age >= TOWER_CANNON_AGE ? 'cannonball' : 'arrow';
          this.events.emit('attack', { attacker: b, target: ts[0], ranged: true });
          for (const t of ts) this._fire(b, t, this._dmg(atk, {}, false, t), proj);
        }
      }
    }
    if (b.type === 'pasture') {
      // (2026-11-14) sheep graze and slowly multiply up to PASTURE_SHEEP and give a little food with nobody working
      // there (about 1/10 of a fully worked big farm at 8 sheep); herders still gather much more (_pasGather)
      const ps = b.pasture || (b.pasture = { sheep: 3, g: 0 });
      if (ps.sheep < PASTURE_SHEEP) { ps.g = (ps.g || 0) + dt / PASTURE_GROW_S; if (ps.g >= 1) { ps.g = 0; ps.sheep++; this.events.emit('pastureSheep', { e: b, sheep: ps.sheep }); } }
      ps.acc = (ps.acc || 0) + dt * PASTURE_IDLE_RATE * ps.sheep * (1 + (p.mods.pasture || 0));
      if (ps.acc >= 1) { const n = ps.acc | 0; ps.acc -= n; this._credit(p, 'food', n); }
    }
    if (b.type === 'temple') {
      // heal own units within 7 tiles that have not been hit for 5 s: 1 hp/s, faster with techs
      b.healT = (b.healT || 0) + dt;
      if (b.healT >= 1) { b.healT -= 1; b.healAcc = (b.healAcc || 0) + 1 + p.mods.heal; const n = b.healAcc | 0; b.healAcc -= n;
        if (n > 0) this._near(b.x, b.z, TEMPLE_HEAL_R, e => { if (e.dead || e.owner !== b.owner || e.hp >= e.maxHp || e.state === 'attack' || this.time - (e.hitT || -99) < 5 || Math.hypot(e.x - b.x, e.z - b.z) > TEMPLE_HEAL_R) return; e.hp = Math.min(e.maxHp, e.hp + n); }); }
    }
    const q = b.queue[0]; if (!q) return;
    const sp = (this.cfg.sandbox && b.owner === 0 ? 2 : 1) / QUEUE_TIME_MUL * (q.kind === 'unit' ? 1 + p.mods.train + (b.type === 'factory' ? p.mods.factory : 0) : 1);
    if (q.t < q.total) q.t = Math.min(q.total, q.t + dt * sp);
    if (q.kind === 'age') p.ageProgress = q.t / q.total;
    if (q.t < q.total) return;
    if (q.kind === 'unit') {
      const ud = UNITS[q.id];
      if (p.pop + ud.pop > p.popCap) { if (b.owner === this.me && this.time > this._popWarnT) { this._popWarnT = this.time + 20; this.events.emit('notify', { text: 'Nüfus sınırı dolu (1000)!', type: 'warn' }); } return; }
      b.queue.shift();
      this._navMode = !!ud.naval; const f = ud.naval ? this._navSpawn(b) : this._freeNear(b.x + (this.rand() - 0.5) * b.size, b.z + b.size / 2 + 0.6, b.owner); this._navMode = false;
      const u = this._addUnit(q.id, b.owner, f.x, f.z); p.stats.unitsTrained++;
      this.events.emit('trained', { e: u, building: b });
      if (ud.naval && (!b.rally || !this._navPass(b.rally.x | 0, b.rally.z | 0))) { if (f.rx !== f.x || f.rz !== f.z) this.cmdMove([u.id], f.rx, f.rz); }
      else if (b.rally) {
        const r = this._rallyWork(b);
        if (r && u.type === 'villager') this.cmdGather([u.id], r.id); else if (u.type !== 'tradecart') { const sl = this._slotNear(b.rally.x, b.rally.z, u); this.cmdMove([u.id], sl.x, sl.z); }
      } else if (!ud.naval && u.type !== 'villager' && u.type !== 'tradecart') { const sl = this._slotNear(b.x, b.z + b.size / 2 + 2.2, u); this._setOrder(u, { type: 'move', x: sl.x, z: sl.z }, false); }
    } else if (q.kind === 'tech') {
      b.queue.shift(); p.techs.add(q.id); const i = p.pending.indexOf(q.id); if (i >= 0) p.pending.splice(i, 1);
      p.stats.techs++; this._mods(p); this._rescaleBuildings(p); this._rescaleUnits(p);
      this.events.emit('researched', { owner: b.owner, tech: q.id });
      if (b.owner === this.me) this.events.emit('notify', { text: TECHS[q.id].name + ' araştırıldı', type: 'good' });
    } else if (q.kind === 'age') {
      b.queue.shift(); p.age = Math.min(4, q.id); p.ageProgress = 0; p.ageAt = this.time; this._rescaleBuildings(p);
      this.events.emit('ageUp', { owner: b.owner, age: p.age });
      if (b.owner === this.me) { const cnt = o => Object.values(o).filter(x => x.age === p.age && x.id !== 'house').length, nb = cnt(BUILDINGS), nu = cnt(UNITS), nt = cnt(TECHS);
        this.events.emit('notify', { text: `Yeni çağ: ${nb} bina, ${nu} birlik ve ${nt} teknoloji açıldı. Tüm binaların güçlendi!`, type: 'good' }); }
      const mine = b.owner === this.me, ally = !mine && this.isAlly(b.owner, this.me);
      this.events.emit('notify', { text: mine ? AGES[p.age].name + ' başladı!' : (ally ? 'Bir müttefik ' : 'Bir rakip ') + AGES[p.age].name + ' seviyesine ulaştı', type: mine || ally ? 'good' : 'warn' });
    }
  }

  // ---------- main update ----------
  update(dt) {
    if (this.over && !this.spectate) return; // spectate (single player only): keep simulating after the end so the map can be watched
    if (!(dt > 0)) return; if (dt > 0.1) dt = 0.1;
    if (!this._inSim) return this._sim(() => this.update(dt));
    this.tick++;
    this.time += dt; this._pn = 0; this._fpn = 0;
    // developer mode (single player, the owner's account only; see ui _menuSetup): whole map visible, resources never run out
    if (this.cfg.dev) { this.reveal = true; const p = this.players[this.me]; if (p) for (const k in p.res) if (p.res[k] < 50000) p.res[k] = 99999; }
    if (this.time >= (this._expT || 0)) { this._expT = this.time + 0.7; for (const u of this.units) if (u.explore && !u.dead && !u.order && this.time >= (u.exploreT || 0)) this._exploreStep(u); }
    const hc = this._hc, cells = this._cells, units = this.units;
    for (let i = 0; i < cells.length; i++) cells[i].length = 0;
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.dead || u.aboard) continue; const c = Math.min(hc - 1, (u.z / CELL) | 0) * hc + Math.min(hc - 1, (u.x / CELL) | 0); cells[c].push(u); }
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.dead || u.aboard) continue; if (u.naval || (u.order && u.order.type === 'board')) this._navUpdateUnit(u, dt); else this._updateUnit(u, dt); }
    // separation for idle units. Each unit has a body radius (SEP_R by class): two units are pushed apart when they
    // are closer than the sum, so cannons and catapults no longer sit inside each other (2026-11-17 playtest: "the
    // cannons clump up and lock together"); siege engines are also spread while they fire (they stand still then).
    for (let i = 0; i < units.length; i++) {
      const u = units[i]; if (u.dead || u.train || u.aboard) continue;
      const ru = u.naval ? 0 : SEP_R[UNITS[u.type].cls] || SEP_R.other;
      if (u.order && u.state !== 'move' && !(u.state === 'attack' && ru === SEP_R.siege)) continue;
      const mv = !!u.order && u.state === 'move';   // (a walking unit keeps the old small gap: a bigger push stalls slow siege)
      let px = 0, pz = 0;
      this._near(u.x, u.z, u.naval ? 1.2 : mv ? 0.7 : ru + SEP_R.siege + 0.15, e => { if (e === u || e.dead || !e.naval !== !u.naval) return; let dx = u.x - e.x, dz = u.z - e.z; const d = Math.hypot(dx, dz), sr = u.naval || mv ? (u.order ? 0.42 : 0.55) : ru + (SEP_R[UNITS[e.type].cls] || SEP_R.other); if (d < sr) { if (d < 0.01) { const a = u.id * 2.39996; dx = Math.cos(a); dz = Math.sin(a); px += dx; pz += dz; } else { px += dx / d; pz += dz / d; } } });
      // a walking unit is nudged at most at half its own speed, whatever the crowd (2026-11-17: four cannons at a ford
      // pushed each other back as fast as they walk and never got through)
      if (mv && (px || pz)) { const L = Math.hypot(px, pz), c = Math.min(1.2, this._speed(u) * 0.5) / Math.max(1, L) / 1.2; px *= c; pz *= c; }
      if (px || pz) { const nx = u.x + px * dt * 1.2, nz = u.z + pz * dt * 1.2; this._navMode = !!u.naval; if (this._pass(nx | 0, nz | 0, u.owner)) { u.x = nx; u.z = nz; } this._navMode = false; }
    }
    const bs = this.buildings; for (let i = bs.length - 1; i >= 0; i--) { const b = bs[i]; if (b && !b.dead) this._updateBuilding(b, dt); }
    // projectiles
    const pr = this.projectiles;
    for (let i = pr.length - 1; i >= 0; i--) {
      const p = pr[i]; p.t += dt; const t = this.entities.get(p.targetId);
      if (t && !t.dead) { p.tx = t.x; p.tz = t.z; }
      const f = Math.min(1, p.t / p.dur);
      p.x = p.sx + (p.tx - p.sx) * f; p.z = p.sz + (p.tz - p.sz) * f; p.y = p.sy + (p.ty - p.sy) * f + (p.type === 'arrow' ? 4 * f * (1 - f) : Math.sin(f * Math.PI)) * p.arc;   // (arrows: a true parabola)
      if (f >= 1) {
        pr.splice(i, 1); const src = this.entities.get(p.srcId) || { owner: p.owner, dead: true, kind: 'unit', id: 0 };
        if (t && !t.dead) this._applyDamage(t, p.dmg, src, p.type);
        else this.events.emit('hit', { target: null, x: p.tx, y: p.ty, z: p.tz, dmg: 0, proj: p.type });
        if (p.type === 'stone' || p.type === 'cannonball') { const hit = []; this._near(p.tx, p.tz, 1.6, e => { if (!e.dead && this.isEnemy(p.owner, e.owner) && e !== t && Math.hypot(e.x - p.tx, e.z - p.tz) < 1.6) hit.push(e); }); for (const e of hit) this._applyDamage(e, Math.max(1, Math.round(p.dmg * 0.4)), src, p.type); }
      }
    }
    // deer wander
    for (const d of this.deer) {
      if (d.hunted || d.dead) continue;
      // flee briefly from an approaching hunter (once per 9 s so it can still be caught)
      if (!(this.time < d.fleeCd)) {
        let hx = 0, hz = 0, hit = false;
        this._near(d.x, d.z, 3.5, e => { if (hit || e.dead || !e.order || e.order.type !== 'gather' || e.order.targetId !== d.id) return; if ((e.x - d.x) ** 2 + (e.z - d.z) ** 2 < 12.25) { hit = true; hx = e.x; hz = e.z; } });
        if (hit) {
          d.fleeCd = this.time + 9; d.fleeT = this.time + 1.6; d.wt = this.time + 4;
          const ax = d.x - hx, az = d.z - hz, al = Math.hypot(ax, az) || 1, nx = d.x + ax / al * 4, nz = d.z + az / al * 4;
          if (this.map.isWalkable(nx | 0, nz | 0) && this.map.tiles[(nz | 0) * this.map.size + (nx | 0)] !== 3 && this._los(d.x, d.z, nx, nz, -1)) { d.wx = nx; d.wz = nz; } else d.fleeT = 0;
        }
      }
      if (this.time >= d.wt) { d.wt = this.time + 3 + this.rand() * 6; const nx = d.x + (this.rand() * 2 - 1) * 2.5, nz = d.z + (this.rand() * 2 - 1) * 2.5; if (this.map.isWalkable(nx | 0, nz | 0) && this.map.tiles[(nz | 0) * this.map.size + (nx | 0)] !== 3) { d.wx = nx; d.wz = nz; } }
      const dx = d.wx - d.x, dz = d.wz - d.z, L = Math.hypot(dx, dz);
      if (L > 0.05) { const s = Math.min(L, (this.time < d.fleeT ? 2.2 : 0.6) * dt); d.x += dx / L * s; d.z += dz / L * s; d.rot = Math.atan2(dx, dz); }
    }
    try { this._navTick(dt); } catch (err) { if (!this._navErr) { this._navErr = true; console.error('naval tick', err); } }
    // remove corpses
    let anyDead = false;
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.dead && this.time - u.deathTime > 4) { anyDead = true; this.entities.delete(u.id); u._rm = true; this.events.emit('remove', { e: u }); } }
    if (anyDead) this.units = units.filter(u => !u._rm);
    // banks: +1 gold per 3 s each (max 3 count), boosted by finance techs
    this._bankT = (this._bankT || 0) + dt;
    if (this._bankT >= 3) { this._bankT -= 3; for (const p of this.players) { if (p.defeated) continue; let n = 0; for (const b of this.buildings) if (b.owner === p.id && b.type === 'bank' && b.done) n++; if (!n) continue; p.bankAcc = (p.bankAcc || 0) + Math.min(3, n) * (1 + p.mods.bank); const gd = p.bankAcc | 0; if (gd > 0) { p.bankAcc -= gd; this._credit(p, 'gold', gd); } } }
    this._fogT -= dt; if (this._fogT <= 0) { this._fogT = 0.25; this._updateFog(); }
    for (const ai of this.ais) { if (this.players[ai.playerId !== undefined ? ai.playerId : -1] && this.players[ai.playerId].defeated) continue; try { ai.update(dt); } catch (err) { if (!this._aiErr) { this._aiErr = true; console.error('AI update', err); } } }
    try { this._railUpdate(dt); } catch (err) { if (!this._railErr) { this._railErr = true; console.error('Rail update', err); } }
    try { this.quests.update(dt); } catch (err) { if (!this._qErr) { this._qErr = true; console.error('Quest update', err); } }
    this._winT -= dt; if (this._winT <= 0) { this._winT = 1; this._checkWin(); }
  }
  // per-team vision grids (0 unexplored, 1 explored, 2 visible) live in the sim (this._tv, fixed cadence);
  // this.fog is only a COPY of the local player's team grid for the view (shared vision with allies)
  _updateFog() {
    const N = this.map.size, fog = this.fog;
    if (!this._tv) this._tv = new Map();
    const tv = this._tv;
    for (const p of this.players) if (!tv.has(p.team)) { const g = new Uint8Array(N * N); if (this.cfg.fog === 'explored') g.fill(1); if (this._fogSeed && p.team === this.teamOf(this.me)) g.set(this._fogSeed); tv.set(p.team, g); }
    this._fogSeed = null;
    for (const g of tv.values()) for (let i = 0; i < g.length; i++) if (g[i] === 2) g[i] = 1;
    let gr = null;
    // a disc of tile centres within r of (x, z), one row span at a time (the soldiers' long sight since 2026-11-14
    // made the per-tile test the cost of the fog update)
    const mark = (x, z, r) => { forDisc(N, x, z, r, (a, b) => gr.fill(2, a, b)); };
    for (const u of this.units) { if (u.dead || !(u.owner >= 0)) continue; gr = tv.get(this.teamOf(u.owner)); if (gr) mark(u.x, u.z, unitLos(u.type)); }
    // (an unfinished foundation gives no sight: one placed in the dark used to reveal the land round it)
    for (const b of this.buildings) { if (!(b.owner >= 0) || !b.done) continue; gr = tv.get(this.teamOf(b.owner)); if (gr) mark(b.x, b.z, buildingLos(b, this.players[b.owner])); }
    // explored map: a building is shown to a team only once it has been in that team's sight (bit per team in b.sv)
    if (this.cfg.fog === 'explored') for (const b of this.buildings) {
      if (b.dead) continue; const i = Math.min(N - 1, Math.max(0, b.z | 0)) * N + Math.min(N - 1, Math.max(0, b.x | 0));
      for (const [team, g] of tv) if (g[i] === 2) b.sv = (b.sv | 0) | (1 << (team & 31));
    }
    const mine = tv.get(this.teamOf(this.me));
    if (this.reveal) fog.fill(2); // view only: spectators (defeated or finished) see everything live
    else if (mine) fog.set(mine);
    this.fogVersion++;
  }
  _checkWin() {
    if (this.cfg.sandbox || this.players.length < 2) return;
    const myTeam = this.teamOf(this.me);
    for (const p of this.players) {
      if (p.defeated) continue;
      const tc = this.buildings.some(b => b.owner === p.id && b.type === 'towncenter');
      const vil = this.units.some(u => u.owner === p.id && !u.dead && u.type === 'villager');
      if (!tc && !vil) {
        p.defeated = true;
        if (p.id !== this.me) this.events.emit('notify', this.isAlly(p.id, this.me) ? { text: 'Bir müttefik uygarlık yıkıldı!', type: 'warn' } : { text: 'Bir rakip uygarlık yıkıldı!', type: 'good' });
        if (p.id === this.me) this.reveal = true;
        this.events.emit('playerDefeated', { id: p.id, team: p.team });
      }
    }
    // a team is out when none of its players has a town center or villagers; the match ends when one team remains
    const alive = new Set(); for (const p of this.players) if (!p.defeated) alive.add(p.team);
    if (alive.size <= 1) { const winnerTeam = alive.size ? [...alive][0] : -1; this.over = { won: winnerTeam === myTeam, winnerTeam }; }
    else if (!this.mp && this.players.every(p => p.isAI || p.defeated)) this.over = { won: false, winnerTeam: -1 }; // single player: the human lost
    if (this.over && !this._overSent) { this._overSent = true; this.reveal = true; this._updateFog(); this.events.emit('gameOver', { won: this.over.won, winnerTeam: this.over.winnerTeam }); }
  }

  // ---------- pasture (Ağıl) ----------
  _pasCmd(us, t, queue = false) {
    for (const u of us) { if (u.owner !== t.owner) continue; this._setOrder(u, t.done ? { type: 'gather', targetId: t.id, res: 'food', rt: 'pasture', x: t.x, z: t.z, acc: 0, tick: 0, dep: 0 } : { type: 'build', targetId: t.id }, queue); }
    return true;
  }
  // up to 6 herders work INSIDE the pen; steady food, diminishing returns, yield scales with sheep (3..8)
  // The big farm: 8 plots around the granary (FARM_CELLS, ring order), one farmer each. A farmer keeps his plot
  // (farm.w[slot] = unit id), tends it while it grows (green -> golden), harvests it when ripe and carries the
  // food to the granary in the middle. Each plot grows on its own.
  _plotFarm(u, o, dt, t, p, cap) {
    const f = t.farm, P = t.size / 3, half = t.size / 2;
    // from outside: the normal pathfinding up to the farm's edge; inside, the farmer walks freely (fields are open)
    if (Math.abs(u.x - t.x) > half + 0.3 || Math.abs(u.z - t.z) > half + 0.3) { if (!this._approach(u, t, dt, 1.0)) return; }
    let si = f.w.indexOf(u.id);
    if (si < 0) {
      for (let i = 0; i < FARM_SLOTS; i++) {
        const h = f.w[i] ? this.entities.get(f.w[i]) : null;
        if (!h || h.dead || !h.order || h.order.targetId !== t.id || h.order.rt !== 'farm') { si = i; break; }
      }
      if (si < 0) return this._next(u);   // all 8 plots have a farmer
      f.w[si] = u.id;
    }
    t.nw++;
    const cell = FARM_CELLS[si], cx = t.x + (cell[0] - 1) * P, cz = t.z + (cell[1] - 1) * P;
    const walk = (x, z) => {
      const dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
      if (d <= 0.25) return true;
      const st = Math.min(d, 1.6 * dt); u.x += dx / d * st; u.z += dz / d * st; u.rot = Math.atan2(dx, dz); u.anim = 'walk'; u.state = 'gather';
      return false;
    };
    // a full load goes to the granary (its door side facing the plot)
    if (o.haul) {
      const ax = cx - t.x, az = cz - t.z, al = Math.hypot(ax, az) || 1;
      if (!walk(t.x + ax / al * 1.7, t.z + az / al * 1.7)) return;
      const n = u.carry && u.carry.type === 'food' ? Math.floor(u.carry.amount) : 0;
      if (n > 0) { this._credit(p, 'food', n); this.events.emit('deposit', { unit: u, owner: u.owner, res: 'food', amount: n }); }
      u.carry = null; o.haul = false;
      return;
    }
    // tend the own plot: fixed work spots along the furrows (they run along z); he hoes on one spot for a few
    // seconds facing along the row, then walks slowly to the next. (The old drifting target flicked him between
    // the walk and the hoe pose about 3 times a second.)
    const slot = Math.floor((this.time + si * 2.3) / FARM_SPOT_S), k = slot % 6;
    const row = (k % 3) - 1, back = k >= 3 ? 1 : -1;
    const tx = cx + row * P * 0.26, tz = cz + back * P * 0.22;
    const dx = tx - u.x, dz = tz - u.z, d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const st = Math.min(d, (d > 1.5 ? 1.6 : 0.7) * dt);   // a slow stroll between spots, a normal walk from afar
      u.x += dx / d * st; u.z += dz / d * st; u.rot = Math.atan2(dx, dz); u.anim = 'walk'; u.state = 'gather';
      if (d > 1.5) return;   // (still on his way to the plot: nothing grows yet)
    } else { u.state = 'gather'; u.anim = 'farm'; u.rot = back > 0 ? 0 : Math.PI; }
    // (stepping along the rows is part of the work: the plot grows and is harvested the whole time he is on it)
    const pl = f.plots[si], prev = pl.s;
    pl.g += dt / 30; if (pl.g >= 1) pl.g -= 1;
    const g = pl.g; pl.s = g < 0.15 ? 1 : g < 0.3 ? 2 : g < 0.6 ? 3 : g < 0.7 ? 4 : 5;
    if (pl.s !== prev) this.events.emit('farmStage', { e: t, plot: si });
    if (pl.s === 5) {
      o.acc += dt * FARM_RATE * (1 + p.mods.farm);   // (no mill bonus since 2026-11-14)
      if (o.acc >= 1) {
        const n = o.acc | 0; o.acc -= n;
        if (!u.carry || u.carry.type !== 'food') u.carry = { type: 'food', amount: 0 };
        u.carry.amount += n;
        if (u.carry.amount >= cap) o.haul = true;
      }
    }
    o.tick += dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('gatherTick', { unit: u, res: 'food' }); }
  }
  _pasGather(u, o, dt, t, p) {
    if (!t || t.dead || t.type !== 'pasture') return this._next(u);
    if (!t.done) { u.order = { type: 'build', targetId: t.id }; return; }
    if (!t.pasture) t.pasture = { sheep: 3, g: 0 };
    if (!this._approach(u, t, dt, 1.0)) return;
    t.nw++; if (t.nw > 6) return this._next(u);
    const si = t.nw - 1, FO = [-0.9, -0.9, 0.9, 0.9, 0.9, -0.9, -0.9, 0.9, 0, -0.9, 0, 0.9];
    const sx = t.x + FO[si * 2] + Math.sin(this.time * 0.12 + si * 2.1) * 0.3, sz = t.z + FO[si * 2 + 1] + Math.cos(this.time * 0.1 + si * 1.7) * 0.3;
    const fdx = sx - u.x, fdz = sz - u.z, fd = Math.hypot(fdx, fdz);
    u.state = 'gather';
    if (fd > 0.25) { const st = Math.min(fd, 1.6 * dt); u.x += fdx / fd * st; u.z += fdz / fd * st; u.rot = Math.atan2(fdx, fdz); u.anim = 'walk'; return; }
    if (fd > 0.01) { const st = Math.min(fd, 0.3 * dt); u.x += fdx / fd * st; u.z += fdz / fd * st; }
    u.anim = 'farm'; u.rot = si * 1.3 + Math.sin(this.time * 0.2 + si) * 0.6;
    const ps = t.pasture;
    const c = [1, 0.7, 0.5, 0.4, 0.3, 0.25][si];
    // base 0.5 food/s at 5 sheep: 2 herders ~= a 2-farmer farm on average, but steady
    o.acc += dt * c * 0.5 * (ps.sheep / 5) * (1 + (p.mods.farm || 0) * 0.6 + (p.mods.pasture || 0));
    if (o.acc >= 1) { const n = o.acc | 0; o.acc -= n; this._credit(p, 'food', n); o.dep = (o.dep || 0) + n; if (o.dep >= 5) { this.events.emit('deposit', { unit: u, owner: u.owner, res: 'food', amount: o.dep }); o.dep = 0; } }
    o.tick += dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('gatherTick', { unit: u, res: 'food' }); }
  }

  // ---------- railway (İstasyon + Ray + Tren) ----------
  // connected station pairs per owner: [{a, b, owner, path:[[tx,tz],...]}]
  // in multiplayer only the sim itself may trigger a recalc (it re-paths/removes trains); the view gets the cached pairs
  railPairs() { if ((this._railDirty !== false || !this._railP) && (this._inSim || !this.mp)) this._railRecalc(); return this._railP || []; }
  _railAdj(s) { const out = []; for (let i = 0; i < s.size; i++) { out.push([s.tx + i, s.tz - 1], [s.tx + i, s.tz + s.size]); out.push([s.tx - 1, s.tz + i], [s.tx + s.size, s.tz + i]); } return out; }
  _railRecalc() {
    this._railDirty = false; const N = this.map.size, pairs = [];
    const owners = new Set(); for (const b of this.buildings) if (b.type === 'station' && b.done && !b.dead) owners.add(b.owner);
    for (const ow of owners) {
      const rails = new Map(); for (const b of this.buildings) if (b.type === 'rail' && b.done && !b.dead && b.owner === ow) rails.set(b.tz * N + b.tx, b);
      const sts = this.buildings.filter(b => b.type === 'station' && b.done && !b.dead && b.owner === ow).sort((x, y) => x.id - y.id);
      const used = new Set();
      for (const s of sts) {
        if (used.has(s.id)) continue;
        // BFS over finished own rail tiles from the tiles adjacent to s
        const par = new Map(), qu = [];
        for (const [x, z] of this._railAdj(s)) { const k = z * N + x; if (rails.has(k) && !par.has(k)) { par.set(k, -1); qu.push(k); } }
        const goal = new Map(); for (const o of sts) if (o !== s && !used.has(o.id)) for (const [x, z] of this._railAdj(o)) goal.set(z * N + x, o);
        let hit = -1, hs = null;
        for (let qi = 0; qi < qu.length; qi++) {
          const k = qu[qi]; if (goal.has(k)) { hit = k; hs = goal.get(k); break; }
          const x = k % N, z = (k / N) | 0;
          for (const nk of [k - 1, k + 1, k - N, k + N]) { if ((nk === k - 1 && x === 0) || (nk === k + 1 && x === N - 1)) continue; if (rails.has(nk) && !par.has(nk)) { par.set(nk, k); qu.push(nk); } }
        }
        if (hit < 0) continue;
        const path = []; for (let k = hit; k !== -1; k = par.get(k)) path.push([k % N, (k / N) | 0]);
        path.reverse(); used.add(s.id); used.add(hs.id);
        pairs.push({ a: s.id, b: hs.id, owner: ow, path });
      }
    }
    const old = this._railP || []; this._railP = pairs;
    // reconcile trains: keep (and re-path) trains of surviving pairs, remove the rest
    const key = (a, b) => a + '-' + b, pk = new Map(pairs.map(q => [key(q.a, q.b), q]));
    for (const q of pairs) { const o = old.find(x => x.a === q.a && x.b === q.b); if (o) { q.deadT = o.deadT; q.trainId = o.trainId; } }
    for (const u of this.units.slice()) {
      if (!u.train || u.dead) continue;
      const q = pk.get(key(u.train.a, u.train.b));
      if (!q) { this._railRemove(u); continue; }
      const tr = u.train, samePath = tr.path.length === q.path.length && tr.path.every((t, i) => t[0] === q.path[i][0] && t[1] === q.path[i][1]);
      if (!samePath) { tr.path = q.path; tr.s = Math.min(Math.max(0, tr.s || 0), q.path.length - 1); tr.i = Math.round(tr.s); }
      q.trainId = u.id;
    }
  }
  _railRemove(u) {
    u.dead = true; u._rm = true; u.state = 'dead';
    this.entities.delete(u.id); this.units = this.units.filter(x => x !== u);
    this.events.emit('remove', { e: u });
  }
  _railSpawn(q) {
    const [tx, tz] = q.path[0], u = this._addUnit('train', q.owner, tx + 0.5, tz + 0.5);
    u.train = { a: q.a, b: q.b, path: q.path, i: 0, dir: 1, s: 0, wait: 2 };
    if (q.path.length > 1) u.rot = Math.atan2(q.path[1][0] - tx, q.path[1][1] - tz);
    q.trainId = u.id; q.deadT = null; return u;
  }
  _railUpdate(dt) {
    this._railT = (this._railT || 0) - dt;
    if (this._railT <= 0) { this._railT = 5; this._railDirty = true; } // periodic safety recheck
    if (this._railDirty !== false || !this._railP) this._railRecalc();
    for (const q of this._railP) {
      let u = q.trainId != null ? this.entities.get(q.trainId) : null;
      if (!u || u.dead || !u.train) {
        if (q.deadT == null) q.deadT = q.trainId != null ? this.time + 30 : this.time; // first spawn now, respawn 30 s after a kill
        if (this.time < q.deadT) continue;
        u = this._railSpawn(q);
      }
      const tr = u.train, P = tr.path, L = P.length - 1;
      if (tr.s == null) tr.s = tr.i || 0;
      if (tr.wait > 0) { tr.wait -= dt; u.state = 'idle'; u.anim = 'idle'; }
      else if (L > 0) {
        tr.s += tr.dir * 4.5 * dt; u.state = 'move'; u.anim = 'walk';
        let arrive = null;
        if (tr.s >= L) { tr.s = L; tr.dir = -1; tr.wait = 2; arrive = tr.b; }
        else if (tr.s <= 0) { tr.s = 0; tr.dir = 1; tr.wait = 2; arrive = tr.a; }
        if (arrive != null) {
          const p = this.players[u.owner], amount = Math.round((25 + P.length * 1.2) * (1 + ((p.mods && p.mods.rail) || 0)));
          this._credit(p, 'gold', amount);
          const st = this.entities.get(arrive);
          this.events.emit('deposit', { unit: u, owner: u.owner, res: 'gold', amount });
          this.events.emit('trainArrive', { e: u, station: st || null, amount });
        }
      } else tr.wait = 2;
      const i0 = Math.max(0, Math.min(L, Math.floor(tr.s))), i1 = Math.min(L, i0 + 1), f = tr.s - i0;
      tr.i = Math.round(tr.s);
      u.x = P[i0][0] + 0.5 + (P[i1][0] - P[i0][0]) * f; u.z = P[i0][1] + 0.5 + (P[i1][1] - P[i0][1]) * f;
      if (L > 0) { const a = Math.min(L - 1, i0), dx = (P[a + 1][0] - P[a][0]) * tr.dir, dz = (P[a + 1][1] - P[a][1]) * tr.dir; if (dx || dz) u.rot = Math.atan2(dx, dz); }
    }
  }

  // ---------- naval (ships live on water tiles 3/4; land units keep using fords) ----------
  _navPass(tx, tz) { const m = this.map, N = m.size; if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false; const i = tz * N + tx; return this._navSailMask()[i] === 1 && m.blocked[i] === 0; }
  // sailable tiles: deep water always; shallow only next to deep water or inside a channel >= 2 wide (>= 5 water neighbours),
  // so ships never sit on 1-tile sandy fringes / narrow fords. Tiles never change after map gen, so this is cached per map.
  _navSailMask() {
    const m = this.map; if (this._navSailM && this._navSailMap === m) return this._navSailM;
    const N = m.size, T = m.tiles, s = new Uint8Array(N * N);
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const t = T[z * N + x]; if (t === 4) { s[z * N + x] = 1; continue; } if (t !== 3) continue;
      let w = 0, deep = false;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { if (!i && !j) continue; const ax = x + i, az = z + j; if (ax < 0 || az < 0 || ax >= N || az >= N) continue; const a = T[az * N + ax]; if (a === 4) deep = true; if (a === 3 || a === 4) w++; }
      if (deep || w >= 5) s[z * N + x] = 1;
    }
    this._navSailM = s; this._navSailMap = m; return s;
  }
  // spawn spot for a ship from dock b: nearest free sailable tile OUTSIDE the footprint (prefers deep / open water),
  // plus a rally point 2-3 tiles further out along the dock -> spawn direction
  _navSpawn(b) {
    const N = this.map.size, T = this.map.tiles, x0 = b.tx, z0 = b.tz, x1 = b.tx + b.size - 1, z1 = b.tz + b.size - 1;
    const open = (tx, tz) => { let n = 0; for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (this._navPass(tx + i, tz + j)) n++; return n; };
    let best = null, bs = 1e9;
    for (let pass = 0; pass < 2 && !best; pass++) for (let tz = z0 - 4; tz <= z1 + 4; tz++) for (let tx = x0 - 4; tx <= x1 + 4; tx++) {
      if (tx >= x0 && tx <= x1 && tz >= z0 && tz <= z1) continue;
      if (pass === 0 ? !this._navPass(tx, tz) : !(this._navWater(tx, tz) && this.map.blocked[tz * N + tx] === 0)) continue;
      const d = Math.max(x0 - tx, tx - x1, 0) + Math.max(z0 - tz, tz - z1, 0);
      const sc = d * 1.5 + (T[tz * N + tx] === 4 ? 0 : 1.5) - open(tx, tz) * 0.15 + (this.units.some(u => u.naval && !u.dead && (u.x | 0) === tx && (u.z | 0) === tz) ? 1 : 0);
      if (sc < bs) { bs = sc; best = { tx, tz }; }
    }
    if (!best) { const f = this._freeNear(b.x, b.z, b.owner); return { x: f.x, z: f.z, rx: f.x, rz: f.z }; }
    const x = best.tx + 0.5, z = best.tz + 0.5;
    let dx = x - b.x, dz = z - b.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    let rx = x, rz = z;
    const clear = (ux, uz, k) => { for (let s = 0.5; s <= k; s += 0.5) if (!this._navPass((x + ux * s) | 0, (z + uz * s) | 0)) return false; return true; };
    let alt = null; // first clear spot; a deep-water one wins
    outer: for (const k of [3, 2]) for (const a of [0, 0.4, -0.4, 0.8, -0.8]) {
      const ux = dx * Math.cos(a) - dz * Math.sin(a), uz = dx * Math.sin(a) + dz * Math.cos(a); if (!clear(ux, uz, k)) continue;
      const px = (x + ux * k) | 0, pz = (z + uz * k) | 0, c = { x: px + 0.5, z: pz + 0.5 };
      if (T[pz * N + px] === 4) { alt = c; break outer; } if (!alt) alt = c;
    }
    if (alt) { rx = alt.x; rz = alt.z; }
    return { x, z, rx, rz };
  }
  _navWater(tx, tz) { const m = this.map, N = m.size; if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false; const t = m.tiles[tz * N + tx]; return t === 3 || t === 4; }
  _navLandPass(tx, tz, owner) { const nm = this._navMode; this._navMode = false; const r = this._pass(tx, tz, owner); this._navMode = nm; return r; }
  // dock: only the land tiles of the 3x3 footprint get blocked, water stays sailable
  _navBlockDock(b, v, quiet) { const N = this.map.size; for (let j = 0; j < b.size; j++) for (let i = 0; i < b.size; i++) { const k = (b.tz + j) * N + b.tx + i, t = this.map.tiles[k]; if (t !== 3 && t !== 4) this.map.blocked[k] = v; } if (!quiet) this._blkMark(b.tx, b.tz, b.size, b.size); }
  _navCanPlaceDock(tx, tz) {
    const m = this.map, N = m.size; let w = 0, l = 0;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const k = (tz + j) * N + tx + i, t = m.tiles[k]; if (t === 5) return false; if (m.blocked[k] !== 0 || this.resAt[k]) return false; if (t === 3 || t === 4) w++; else l++; }
    if (w < 2 || l < 3) return false;
    // ships need a sailable tile just outside the footprint to spawn on
    for (let j = -2; j <= 4; j++) for (let i = -2; i <= 4; i++) { if (i >= 0 && i <= 2 && j >= 0 && j <= 2) continue; if (this._navPass(tx + i, tz + j)) return true; }
    return false;
  }
  _navShoals() { if (!this._navFishC) { this._navFishC = []; for (const e of this.entities.values()) if (e.kind === 'resource' && e.type === 'fish' && !e.dead) this._navFishC.push(e); } return this._navFishC; }
  _navNearestShoal(x, z, not) { let best = null, bd = 1e9; for (const s of this._navShoals()) { if (s === not || s.dead || s.amount < 5) continue; const d = (s.x - x) ** 2 + (s.z - z) ** 2; if (d < bd) { bd = d; best = s; } } return best; }
  _navCmdFish(ids, t) {
    const us = this._live(ids).filter(u => u.type === 'fishboat'); if (!us.length) return false;
    for (const u of us) this._setOrder(u, { type: 'fish', targetId: t.id, phase: 'go', acc: 0, tick: 0 });
    return true;
  }
  // nearest land tile (passable for owner) next to sailable water, around (x,z); returns {lx,lz,wx,wz}
  _navShore(x, z, owner, R = 14, fromWater = true) {
    const cx = Math.floor(x), cz = Math.floor(z); let best = null, bd = 1e9;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const tx = cx + i, tz = cz + j;
      if (fromWater ? !this._navPass(tx, tz) : !this._navLandPass(tx, tz, owner)) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue; const ax = tx + dx, az = tz + dz;
        const land = fromWater ? ax : tx, landz = fromWater ? az : tz, wat = fromWater ? tx : ax, watz = fromWater ? tz : az;
        if (!this._navLandPass(land, landz, owner) || this._navWater(land, landz) || !this._navPass(wat, watz)) continue;
        const d = (tx + 0.5 - x) ** 2 + (tz + 0.5 - z) ** 2 + ((dx && dz) ? 0.3 : 0);
        if (d < bd) { bd = d; best = { lx: land + 0.5, lz: landz + 0.5, wx: wat + 0.5, wz: watz + 0.5 }; }
      }
    }
    return best;
  }
  cmdBoard(unitIds, transportId) {
    const t = this.entities.get(transportId); if (!t || t.dead || t.type !== 'transport') return false;
    if (!t.cargo) t.cargo = [];
    const us = this._live(unitIds).filter(u => !u.naval && !u.train && u.owner === t.owner).slice(0, Math.max(0, 10 - t.cargo.length));
    if (!us.length) return false;
    const s = this._navShore(t.x, t.z, t.owner, 14, true); if (!s) return false;
    for (const u of us) this._setOrder(u, { type: 'board', targetId: t.id, x: s.lx, z: s.lz });
    this._setOrder(t, { type: 'move', x: s.wx, z: s.wz });
    return true;
  }
  cmdUnload(transportId, x, z) {
    const t = this.entities.get(transportId); if (!t || t.dead || t.type !== 'transport' || !t.cargo || !t.cargo.length) return false;
    const s = this._navShore(x, z, t.owner, 20, true); if (!s) return false;
    this._setOrder(t, { type: 'unload', wx: s.wx, wz: s.wz, x: s.wx, z: s.wz });
    return true;
  }
  // ships right-clicked on an own dock: loaded fishboats deliver there and resume fishing; others just park next to it
  cmdReturn(ids, dockId) {
    const b = this.entities.get(dockId); if (!b || b.dead || b.kind !== 'building' || b.type !== 'dock') return false;
    const us = this._live(ids).filter(u => u.naval && u.owner === b.owner); if (!us.length) return false;
    let park = null;
    for (const u of us) {
      if (u.type === 'fishboat' && b.done && u.carry && u.carry.amount > 0) {
        const o = u.order;
        if (o && o.type === 'fish') { o.phase = 'ret'; o.dropId = b.id; o.fail = 0; u.path = null; u.pk = null; u.queue.length = 0; u.explore = false; }
        else { const s = this._navNearestShoal(u.x, u.z); this._setOrder(u, { type: 'fish', targetId: s ? s.id : null, phase: 'ret', dropId: b.id, acc: 0, tick: 0 }); }
      } else {
        if (!park) { this._navMode = true; try { park = this._navSpawn(b); } finally { this._navMode = false; } }
        this.cmdMove([u.id], park.x, park.z);
      }
    }
    return true;
  }
  _navPt(u, x, z, dt, reach) { return this._approach(u, { id: 'pt', kind: 'pt', x, z }, dt, reach); }
  _navUpdateUnit(u, dt) {
    const o = u.order;
    if (!u.naval) { if (o && o.type === 'board') { if (u.cd > 0) u.cd -= dt; this._navBoardStep(u, o, dt); } else this._updateUnit(u, dt); return; }
    this._navMode = true;
    try {
      if (o && o.type === 'fish') { if (u.cd > 0) u.cd -= dt; this._navFish(u, o, dt); }
      else if (o && o.type === 'unload') { if (u.cd > 0) u.cd -= dt; this._navUnloadStep(u, o, dt); }
      else this._updateUnit(u, dt);
    } finally { this._navMode = false; }
    if (u.cargo && u.cargo.length) {
      for (let i = u.cargo.length - 1; i >= 0; i--) { const e = this.entities.get(u.cargo[i]); if (!e || e.dead || e.aboard !== u.id) { u.cargo.splice(i, 1); continue; } e.x = u.x; e.z = u.z; }
    }
  }
  _navFish(u, o, dt) {
    const p = this.players[u.owner], cap = 15;
    if (o.phase === 'ret') {
      if (!u.carry || u.carry.amount <= 0) { u.carry = null; o.phase = 'go'; return; }
      let b = this.entities.get(o.dropId);
      if (!b || b.dead || !b.done || b.owner !== u.owner) { b = this._nearestB(u, x => x.type === 'dock'); if (!b) { u.state = 'idle'; u.anim = 'idle'; return; } o.dropId = b.id; }
      if (this._approach(u, b, dt, 1.0)) {
        const n = u.carry.amount; this._credit(p, 'food', n);
        this.events.emit('deposit', { unit: u, owner: u.owner, res: 'food', amount: n });
        u.carry = null; o.phase = 'go'; o.fail = 0; u.path = null; u.pk = null;
      }
      return;
    }
    if (u.carry && u.carry.amount >= cap) { o.phase = 'ret'; o.fail = 0; u.path = null; u.pk = null; return; }
    let t = this.entities.get(o.targetId);
    if (!t || t.dead || t.amount < 1) {
      const n = this._navNearestShoal(u.x, u.z, t);
      if (n) { o.targetId = n.id; u.targetId = n.id; o.fail = 0; u.path = null; u.pk = null; return; }
      if (u.carry && u.carry.amount > 0) { o.phase = 'ret'; return; }
      return this._next(u);
    }
    if ((o.fail || 0) >= 5) { // unreachable shoal (other water body): try the next one
      const n = this._navNearestShoal(u.x, u.z, t); o.bad = (o.bad || 0) + 1;
      if (n && o.bad < 4) { o.targetId = n.id; u.targetId = n.id; o.fail = 0; u.path = null; u.pk = null; return; }
    }
    if (!this._approach(u, t, dt, 0.5)) return; // edge distance: stop within ~1 tile of the shoal centre
    o.fail = 0; o.bad = 0;
    u.state = 'gather'; u.anim = 'fish'; u.rot = Math.atan2(t.x - u.x, t.z - u.z) + 1.57;
    o.acc += 0.65 * (p.mods.gather.fish || 1) * dt;
    while (o.acc >= 1 && t.amount >= 1) { o.acc -= 1; t.amount--; if (!u.carry || u.carry.type !== 'food') u.carry = { type: 'food', amount: 0 }; u.carry.amount++; }
    o.tick += dt; if (o.tick >= 1) { o.tick = 0; this.events.emit('gatherTick', { unit: u, res: 'food' }); }
  }
  _navBoardStep(u, o, dt) {
    const t = this.entities.get(o.targetId);
    if (!t || t.dead || t.owner !== u.owner || t.type !== 'transport') return this._next(u);
    if (!t.cargo) t.cargo = [];
    if (t.cargo.length >= 10) return this._next(u);
    const d = Math.hypot(t.x - u.x, t.z - u.z), ds = Math.hypot(o.x - u.x, o.z - u.z);
    if (d <= 1.6 || (ds < 1.6 && d <= 2.6)) {
      u.aboard = t.id; t.cargo.push(u.id);
      u.order = null; u.queue.length = 0; u.path = null; u.pk = null; u.targetId = null; u.state = 'idle'; u.anim = 'idle'; u.x = t.x; u.z = t.z;
      this.events.emit('board', { unit: u, transport: t });
      return;
    }
    if (ds > 0.35) { this._navPt(u, o.x, o.z, dt, 0.3); }
    else { u.state = 'idle'; u.anim = 'idle'; }
  }
  _navUnloadStep(u, o, dt) {
    if (!u.cargo || !u.cargo.length) return this._next(u);
    const arrived = this._navPt(u, o.wx, o.wz, dt, 0.5);
    if (!arrived && Math.hypot(o.wx - u.x, o.wz - u.z) > 2.2) return;
    // free land tiles around the ship, nearest first
    const cx = Math.floor(u.x), cz = Math.floor(u.z), spots = [];
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const tx = cx + i, tz = cz + j; if (!this._navLandPass(tx, tz, u.owner)) continue; const w = this._navWater(tx, tz); spots.push({ x: tx + 0.5, z: tz + 0.5, d: Math.hypot(i, j) + (w ? 3 : 0) }); }
    if (!spots.length) { if (arrived) this._next(u); return; }
    spots.sort((a, b) => a.d - b.d);
    const n = Math.min(spots.length, 6), out = [];
    u.cargo.forEach((id, k) => {
      const e = this.entities.get(id); if (!e || e.dead) return;
      const s = spots[k % n], r = Math.floor(k / n) * 0.3;
      e.aboard = null; delete e.aboard; e.x = s.x + Math.cos(k * 2.4) * r; e.z = s.z + Math.sin(k * 2.4) * r;
      e.order = null; e.queue.length = 0; e.path = null; e.pk = null; e.targetId = null; e.state = 'idle'; e.anim = 'idle';
      out.push(e);
    });
    u.cargo = [];
    this.events.emit('unload', { transport: u, units: out });
    this._next(u);
  }
  _navSinkCargo(e, killer) { const ids = e.cargo.slice(); e.cargo = []; for (const id of ids) { const c = this.entities.get(id); if (c && !c.dead) { c.x = e.x; c.z = e.z; this._kill(c, killer); } } }
  _navTick(dt) {
    this._navT = (this._navT || 0) + dt; if (this._navT < 1) return; const k = this._navT; this._navT = 0;
    for (const s of this._navShoals()) if (!s.dead && s.amount < s.maxAmount) s.amount = Math.min(s.maxAmount, s.amount + 0.35 * k);
  }
  // fish shoals: deep water near shores (6-12 per map) + a couple near each start with water within 25 tiles
  _navGenFish() {
    const m = this.map, N = m.size, T = m.tiles;
    const shoreNear = (tx, tz, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const x = tx + i, z = tz + j; if (x < 0 || z < 0 || x >= N || z >= N) continue; const t = T[z * N + x]; if (t !== 3 && t !== 4) return true; } return false; };
    const free = (tx, tz) => tx >= 2 && tz >= 2 && tx < N - 2 && tz < N - 2 && m.blocked[tz * N + tx] === 0 && !this.resAt[tz * N + tx];
    const deep = [], shallow = [];
    for (let tz = 2; tz < N - 2; tz++) for (let tx = 2; tx < N - 2; tx++) {
      const t = T[tz * N + tx]; if ((t !== 3 && t !== 4) || !free(tx, tz) || !shoreNear(tx, tz, 3)) continue;
      // keep at least one water ring around so ships can circle it
      if (t === 4) deep.push([tx, tz]); else if (!shoreNear(tx, tz, 1)) shallow.push([tx, tz]);
    }
    const placed = [];
    const ok = (c, sp) => placed.every(p => Math.hypot(p[0] - c[0], p[1] - c[1]) >= sp);
    const put = c => { this._addRes('fish', c[0], c[1], 800); placed.push(c); };
    const pool = deep.length >= 6 ? deep : deep.concat(shallow);
    for (let i = pool.length - 1; i > 0; i--) { const j = (this.rand() * (i + 1)) | 0; const x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
    const want = Math.max(6, Math.min(12, Math.round(pool.length / 30)));
    for (const c of pool) { if (placed.length >= want) break; if (ok(c, 10)) put(c); }
    for (const p of this.players) {
      const all = deep.concat(shallow).filter(c => { const d = Math.hypot(c[0] + 0.5 - p.startX, c[1] + 0.5 - p.startZ); return d >= 7 && d <= 25 && free(c[0], c[1]); });
      if (!all.length) continue;
      all.sort((a, b) => (Math.hypot(a[0] - p.startX, a[1] - p.startZ) + (T[a[1] * N + a[0]] === 4 ? 0 : 4)) - (Math.hypot(b[0] - p.startX, b[1] - p.startZ) + (T[b[1] * N + b[0]] === 4 ? 0 : 4)));
      let n = placed.filter(c => Math.hypot(c[0] - p.startX, c[1] - p.startZ) <= 25).length;
      for (const c of all) { if (n >= 2) break; if (ok(c, 4)) { put(c); n++; } }
    }
    this._navFishC = null;
    return placed.length;
  }
  // opts.me: local player of THIS client (multiplayer continue: every client loads the same bytes with its own me)
  static deserialize(obj, opts = null) {
    const o = typeof obj === 'string' ? JSON.parse(obj) : obj;
    const cfg = Object.assign({}, o.cfg);
    if (opts && opts.me != null) cfg.me = opts.me | 0;
    return new Game(cfg, o);
  }
}

installMethods(Game.prototype, saveMethods, combatMethods);

// Building placement and completion, production queues, research and age progression.
import { AGES, BUILDINGS, TECHS, UNITS } from '../data.js';
import { QUEUE_TIME_MUL, TOWER_AGE_ATK, towerAgeBonus } from './game-shared.js';

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

export const productionMethods = {
  // ---------- entity creation ----------
  _mods(p) {
    const m = { gather: { food: 1, wood: 1, stone: 1, gold: 1 }, carry: 0, farm: 0, vspeed: 0, atk: {}, armor: {}, range: {}, speed: {}, atkMul: {}, bhp: 0, wallhp: 0, towerAtk: 0, towerRange: 0, vhp: 0, hp: {}, heal: 0, blos: 0, train: 0, factory: 0, trade: 0, cart: 0, bank: 0, pasture: 0, rail: 0 };
    for (const id of p.techs) { const fx = TECHS[id] && TECHS[id].fx; if (!fx) continue;
      for (const k in fx) { const v = fx[k]; if (typeof v === 'number') m[k] = (m[k] || 0) + v; else for (const c in v) (m[k] || (m[k] = {}))[c] = (m[k][c] || (k === 'gather' ? 1 : 0)) + v[c]; } }
    p.mods = m;
  },
  _bMaxHp(type, owner) { const d = BUILDINGS[type], p = this.players[owner]; let h = d.hp * (1 + 0.15 * p.age) * (1 + p.mods.bhp); if (type === 'wall' || type === 'gate') h *= 1 + p.mods.wallhp; return Math.round(h); },
  _rescaleBuildings(p) { for (const b of this.buildings) if (b.owner === p.id) { const n = this._bMaxHp(b.type, p.id); b.hp = n > b.maxHp ? Math.min(n, b.hp + (n - b.maxHp)) : Math.max(1, Math.round(b.hp * n / b.maxHp)); b.maxHp = n; b.ageLook = p.age; } },
  _uMaxHp(type, owner) { const d = UNITS[type], m = this.players[owner].mods; return Math.round(d.hp * (1 + (m.hp[d.cls] || 0) + (type === 'villager' ? m.vhp : 0))); },
  _rescaleUnits(p) { for (const u of this.units) if (u.owner === p.id && !u.dead) { const n = this._uMaxHp(u.type, p.id); if (n !== u.maxHp) { u.hp = n > u.maxHp ? u.hp + (n - u.maxHp) : Math.max(1, Math.min(n, u.hp)); u.maxHp = n; } } },
  isUnlocked(owner, kind, id) {
    const p = this.players[owner]; if (!p) return false;
    const d = kind === 'unit' ? UNITS[id] : kind === 'building' ? BUILDINGS[id] : TECHS[id];
    if (!d || d.age > p.age || d.legacy) return false;   // (legacy: the mill, kept for old saves only)
    if (kind === 'tech' && p.techs.has(id)) return false;
    return true;
  },

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
  },
  // building whose footprint covers tile (tx,tz), or null
  buildingAt(tx, tz) {
    for (const b of this.buildings) { if (b.dead) continue; if (tx >= b.tx && tx < b.tx + b.size && tz >= b.tz && tz < b.tz + b.size) return b; }
    return null;
  },
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
  },
  canOpenGate(owner, wallId) {
    const pl = this.gatePlan(wallId); if (!pl.ok) return pl;
    if (!this.canAfford(owner, BUILDINGS.gate.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
    return pl;
  },
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
  },
  _wallToGate(tx, tz, owner) { const b = this.buildingAt(tx, tz); return b && b.type === 'wall' && b.owner === owner && b.done ? b : null; },
  // silently remove a building (no stats, no death event): used when a gate replaces a wall
  _dropBuilding(b) {
    this._block(b, 0); b.dead = true;
    const i = this.buildings.indexOf(b); if (i >= 0) this.buildings.splice(i, 1);
    this.entities.delete(b.id); this.events.emit('remove', { e: b });
  },
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
  },
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
  },
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
  },
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
  },

  train(buildingId, unitType) {
    const b = this.entities.get(buildingId), d = UNITS[unitType];
    if (!b || b.dead || b.kind !== 'building' || !b.done || !d) return false;
    if (!BUILDINGS[b.type].trains.includes(unitType) || !this.isUnlocked(b.owner, 'unit', unitType) || b.queue.length >= TRAIN_QUEUE_MAX || !this.canAfford(b.owner, d.cost)) return false;
    this._pay(b.owner, d.cost); b.queue.push({ kind: 'unit', id: unitType, t: 0, total: d.time }); return true;
  },
  research(buildingId, techId) {
    const b = this.entities.get(buildingId), d = TECHS[techId];
    if (!b || b.dead || b.kind !== 'building' || !b.done || !d) return false;
    const p = this.players[b.owner];
    if (!BUILDINGS[b.type].researches.includes(techId) || !this.isUnlocked(b.owner, 'tech', techId) || p.pending.includes(techId) || !this.canAfford(b.owner, d.cost)) return false;
    this._pay(b.owner, d.cost); p.pending.push(techId); b.queue.push({ kind: 'tech', id: techId, t: 0, total: d.time }); return true;
  },
  // the named buildings the next age still needs (finished ones count)
  ageMissingTypes(owner) {
    const p = this.players[owner], a = p && AGES[p.age + 1]; if (!a || !a.reqTypes) return [];
    return a.reqTypes.filter(t => !this.buildings.some(b => b.owner === owner && b.type === t && b.done && !b.dead));
  },
  // seconds left before the next age-up may start (the minimum stay in the current age)
  ageWait(owner) {
    const p = this.players[owner], a = p && AGES[p.age + 1]; if (!a || !a.minStay) return 0;
    return Math.max(0, (p.ageAt || 0) + a.minStay - this.time);
  },
  _typesOwned(owner) { const s = new Set(); for (const b of this.buildings) if (b.owner === owner && b.done && !['house', 'wall', 'gate', 'towncenter'].includes(b.type)) s.add(b.type); return s.size; },
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
  },
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
  },
  ageUp(buildingId) {
    const b = this.entities.get(buildingId); if (!b || b.dead || b.type !== 'towncenter' || !b.done) return false;
    if (!this.canAgeUp(b.owner).ok) return false;
    const p = this.players[b.owner], a = AGES[p.age + 1];
    // (owner 2026-11-14: the age-up goes to the FRONT of the queue; a unit in training keeps its progress and goes on afterwards)
    this._pay(b.owner, a.cost); b.queue.unshift({ kind: 'age', id: a.id, t: 0, total: a.time }); p.ageProgress = 0;
    this.events.emit('ageUpStart', { owner: b.owner }); return true;
  },
  cancelQueue(buildingId, index) {
    const b = this.entities.get(buildingId); if (!b || b.kind !== 'building') return false;
    const q = b.queue[index]; if (!q) return false;
    b.queue.splice(index, 1); this._refundQ(b.owner, q); return true;
  },
  _refundQ(owner, q) {
    const p = this.players[owner];
    if (q.kind === 'unit') this._refund(owner, UNITS[q.id].cost);
    else if (q.kind === 'tech') { this._refund(owner, TECHS[q.id].cost); const i = p.pending.indexOf(q.id); if (i >= 0) p.pending.splice(i, 1); }
    else if (q.kind === 'age') { this._refund(owner, AGES[q.id].cost); p.ageProgress = 0; }
  },
  setRally(buildingId, x, z, targetId = null) { const b = this.entities.get(buildingId); if (!b || b.kind !== 'building' || !(BUILDINGS[b.type] && (BUILDINGS[b.type].trains || []).length)) return false; /* (only buildings that train units take a flag, owner 2026-11-15) */ const t = targetId != null ? this.entities.get(targetId) : null; b.rally = { x, z, tid: t ? t.id : null, rtype: t && t.kind === 'resource' ? t.type : null }; return true; },
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
  },
  deleteEntity(id) { const e = this.entities.get(id); if (!e || e.dead || e.owner < 0) return false; if (e.kind === 'building') for (const q of e.queue.slice()) this._refundQ(e.owner, q); this._kill(e, null); return true; },
  _complete(b) {
    b.progress = 1; b.done = true; const p = this.players[b.owner];
    // the foundation becomes solid now (flow fields go stale through _blkMark); units inside step out, routes across it are planned again
    const v = this._solidV(b);
    if (v !== 3) { if (b.type === 'dock') this._navBlockDock(b, v); else this._block(b, v); this._repathAround(b); this._pushOut(b); }
    p.stats.buildingsBuilt++; this._popCap(p);
    if (b.type === 'rail' || b.type === 'station') this._railDirty = true;
    this.events.emit('buildComplete', { e: b });
    if (b.owner === this.me) this.events.emit('notify', { text: BUILDINGS[b.type].name + ' tamamlandı', type: 'good', x: b.x, z: b.z });
  },

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
  },
};

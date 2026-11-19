// AI planning, spending priorities, production choices and construction placement.
import { AGES, BUILDINGS, FARM_SLOTS, TECHS, UNITS } from '../data.js';
import { costSum, d2, MIL_B, RK } from './ai-shared.js';
import { QUEUE_TIME_MUL } from './game-shared.js';

const TYPE_ROLE = { spearman: 'pike', swordsman: 'inf', heavyinf: 'inf', musketeer: 'gun', rifleman: 'gun', archer: 'bow', crossbow: 'bow', lightcav: 'cav', knight: 'cav', cuirassier: 'cav', ram: 'siege', catapult: 'siege', cannon: 'siege', artillery: 'siege' };
const ROLE_UNITS = { pike: ['spearman'], inf: ['heavyinf', 'swordsman'], gun: ['rifleman', 'musketeer'], bow: ['crossbow', 'archer'], cav: ['cuirassier', 'knight', 'lightcav'], siege: ['artillery', 'cannon', 'catapult', 'ram'] };
const ROLE_W = [
  { pike: 1 },
  { pike: 0.1, inf: 0.3, bow: 0.32, cav: 0.28 },
  { pike: 0.05, inf: 0.3, bow: 0.3, cav: 0.25, siege: 0.1 },
  { inf: 0.2, gun: 0.3, bow: 0.1, cav: 0.28, siege: 0.12 },
  { inf: 0.1, gun: 0.42, cav: 0.3, siege: 0.18 },
];
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

function addCost(acc, cost, m = 1) { if (cost) for (const k in cost) acc[k] = (acc[k] || 0) + (cost[k] || 0) * m; return acc; }
function qmul() { try { return QUEUE_TIME_MUL || 1.25; } catch (e) { return 1.25; } }
// a building of ours the enemy destroyed: no new foundation within LOST_R tiles of it for LOST_S seconds, nor while
// enemy soldiers are seen near it (owner: a razed farm was put back on the same spot at once)
const LOST_R = 8, LOST_S = 75, LOST_FOE_R = 14;

export const aiBuildOrderMethods = {
  // ---------- planning: phase, targets and the 2-minute shopping list ----------
  villTargetFor(age) { const a = Math.min(4, age); return Math.max(this.d.vill[a], a < 4 ? this.d.ageVill[a] + 3 : 0); },
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
  },

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
  },
  _avgUnitCost(c) {
    const out = {};
    for (const r in c.roleW) { const u = this._bestUnitOfRole(r, null); if (u) addCost(out, UNITS[u].cost, c.roleW[r]); }
    return out;
  },
  _bestUnitOfRole(role, b) {
    const list = ROLE_UNITS[role] || [];
    const def = b ? BUILDINGS[b.type] : null;
    for (const u of list) { if (def && !def.trains.includes(u)) continue; if (this.unlocked('unit', u)) return u; }
    return null;
  },

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
  },

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
  },

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
  },

  _tcTech(c, tc) {
    const me = c.me, vn = c.vills.length, has = t => me.techs.has(t) || (me.pending || []).includes(t);
    if (!has('basket') && vn >= 9 && this.unlocked('tech', 'basket')) return 'basket';
    if (!has('wheelbarrow') && vn >= 22 && this.unlocked('tech', 'wheelbarrow')) return 'wheelbarrow';
    if (!has('loom') && (this.lostVil >= 3 || c.age >= 2) && this.unlocked('tech', 'loom')) return 'loom';
    return null;
  },

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
  },

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
  },

  _ecoTechs(c) {
    const nt = this._nextEcoTech(c, false);
    if (nt && c.can(TECHS[nt.tech].cost)) this.game.research(nt.b.id, nt.tech);
  },
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  _shoalNear(shoals, at) { let best = null, bd = Infinity; for (const s of shoals) { if (s.dead || s.amount <= 0) continue; const dd = d2(s.x, s.z, at.x, at.z); if (dd < bd) { bd = dd; best = s; } } return best; },
};

// AI income estimates, worker allocation and local resource logistics.
import { AGES, BUILDINGS, FARM_SLOTS } from '../data.js';
import { d2, RK } from './ai-shared.js';

const RES_OF = { tree: 'wood', stone: 'stone', gold: 'gold', berries: 'food', deer: 'food' };
const NOMINAL = { food: 0.42, wood: 0.36, gold: 0.32, stone: 0.32 }; // per villager per second, before any history

// drop-off camps (owner 2026-11-14: the AI built hundreds of lumber camps): at most this many of each kind
// (lumber / mine), one more on the biggest maps; a lumber camp only beside a real forest, none within CAMP_GAP of another
const CAMP_GAP = 14, CAMP_TREES = 16, CAMP_MINES = 3;

export const aiEconomyMethods = {
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
  },

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
  },

  // how many more farm / pasture plots food needs
  _farmNeed(c) {
    // (a big farm feeds 8 farmers, a pasture 2; a farm of an older save counts as 2)
    const room = c.blds.reduce((n, b) => n + (b.type === 'farm' ? (b.farm && b.farm.plots ? FARM_SLOTS : 2) : b.type === 'pasture' ? 2 : 0), 0);
    const wild = this._wildFood(c);
    c.wildCap = wild.cap;
    const foodT = c.foodTarget != null ? c.foodTarget : Math.round(c.vills.length * 0.45);
    const short = foodT - wild.cap - room;
    return short > 0 ? Math.ceil(short / FARM_SLOTS) : 0;
  },
  _wildFood(c) {
    const g = this.game; let bushes = 0, amount = 0, deer = 0;
    const drops = c.blds.filter(b => b.done && BUILDINGS[b.type].dropoff && BUILDINGS[b.type].dropoff.includes('food'));
    const idx = this._resIndex(c);
    for (const e of idx.berries) { if (e.dead || e.amount < 15) continue; if (!drops.some(b => d2(b.x, b.z, e.x, e.z) < 12 * 12)) continue; bushes++; amount += e.amount; }
    for (const e of idx.deer) { if (e.dead || e.amount < 15) continue; if (d2(e.x, e.z, c.home.x, c.home.z) < 15 * 15) deer++; }
    const cap = Math.min(8, Math.round(bushes * 1.5)) + Math.min(3, deer);
    this._wildLeft = amount + deer * 100;
    return { cap: amount + deer * 100 < 120 ? 0 : cap, bushes, deer };
  },

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
  },
  _unsafe(x, z) {
    const now = this.game.time;
    for (const dz of this.danger) if (now - dz.t < 70 && d2(dz.x, dz.z, x, z) < 8 * 8) return true;
    for (const m of this.mem.values()) {
      if (m.kind === 'building') { if ((m.type === 'tower' || m.type === 'castle' || m.type === 'towncenter') && d2(m.x, m.z, x, z) < 12 * 12) return true; if (d2(m.x, m.z, x, z) < 7 * 7) return true; }
    }
    return false;
  },

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
  },
  // a resource tile with at least one walkable side neighbour
  _openSide(e) { const g = this.game, x = e.x | 0, z = e.z | 0; return g._pass(x + 1, z, this.pid) || g._pass(x - 1, z, this.pid) || g._pass(x, z + 1, this.pid) || g._pass(x, z - 1, this.pid); },
  _release(work, v) { for (const r of RK) { const i = work.list[r].indexOf(v); if (i >= 0) { work.list[r].splice(i, 1); work.cnt[r]--; } } const j = work.idle.indexOf(v); if (j >= 0) work.idle.splice(j, 1); },
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
  },

  _assign(c, v, r, work) {
    const g = this.game, t = this._pickRes(c, v, r, work.users);
    if (!t) return false;
    if (!g.cmdGather([v.id], t.id)) return false;
    work.users.set(t.id, (work.users.get(t.id) || 0) + 1);
    this.assignT.set(v.id, g.time);
    return true;
  },
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
  },

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
  },
  _campCap() { return this.game.map.size >= 448 ? 4 : 3; },
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
  },
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
  },

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
  },
};

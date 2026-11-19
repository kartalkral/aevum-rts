// Resource accounting, gathering, farms, herding and market trades.
import { BUILDINGS, FARM_SLOTS } from '../data.js';

// big farm: cells (x, z) of its 3x3 grid, ring order around the granary (1, 1); food / s of a farmer while his plot is ripe
export const FARM_CELLS = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
const FARM_RATE = 16 / 9 * 0.85;
const FARM_SPOT_S = 5;   // seconds a farmer hoes on one spot of his plot before moving on along the row

const RATE = { tree: 0.42, stone: 0.36, gold: 0.36, berries: 0.4, deer: 0.5 };
// stand spots per resource tile (deer move: none) and their offsets from the tile centre (sides, then corners)
const SPOTS = { stone: 4, gold: 4, tree: 3, berries: 3 }, SPOT_R = 6, SPOT_BOX = 8, SPOT_O = [0, 1.3, 1.3, 0, 0, -1.3, -1.3, 0, 1.12, 1.12, 1.12, -1.12, -1.12, -1.12, -1.12, 1.12];
const ANIM_OF = { tree: 'chop', stone: 'mine', gold: 'mine', berries: 'forage', deer: 'forage' };

const TRADE_VAL = { food: 1, wood: 1, stone: 1.3, gold: 2 };
const BARTER_BONUS = 1.15;   // resource for resource at the market: one step, a bit better than selling then buying
const TRIBUTE_RES = ['food', 'wood', 'stone', 'gold'];

export const economyMethods = {
  canAfford(owner, cost) { const p = this.players[owner]; if (!p) return false; for (const k in cost) if ((p.res[k] || 0) < cost[k]) return false; return true; },
  _pay(owner, cost) { const p = this.players[owner]; for (const k in cost) p.res[k] -= cost[k]; },
  _refund(owner, cost) { const p = this.players[owner]; for (const k in cost) p.res[k] += cost[k]; },
  tradeRate(sell, buy, owner = 0) {
    if (!TRADE_VAL[sell] || !TRADE_VAL[buy] || sell === buy) return 0; const p = this.players[owner], k = 0.7 * (1 + (p ? p.mods.trade : 0));
    // barter (neither side gold, owner playtest 2026-11-14): priced like selling for gold and buying back, as one
    // step 15 % better (100 wood -> 56 food; was 70, cheaper than going through gold)
    if (sell !== 'gold' && buy !== 'gold') return Math.round(100 * TRADE_VAL[sell] / TRADE_VAL[buy] * k * k * BARTER_BONUS);
    return Math.round(100 * TRADE_VAL[sell] / TRADE_VAL[buy] * k);
  },
  trade(owner, sell, buy) {
    const p = this.players[owner]; if (!p) return false;
    if (!this.buildings.some(b => b.owner === owner && b.type === 'market' && b.done)) return false;
    const amt = this.tradeRate(sell, buy, owner); if (!amt || p.res[sell] < 100) return false;
    p.res[sell] -= 100; p.res[buy] += amt; return true;
  },
  // ---- tribute (owner playtest 2026-11-14: his ally ran out of wood): send resources to an ally, no fee.
  // amount is capped at what the sender has; refused for enemies, oneself, defeated / gone players.
  canTribute(from, to, res, amount) {
    const a = this.players[from], b = this.players[to];
    if (!a || !b || from === to || !this.isAlly(from, to)) return { ok: false, reason: 'Yalnızca müttefike gönderilebilir' };
    if (a.defeated || b.defeated || b.left) return { ok: false, reason: 'Bu oyuncu oyunda değil' };
    if (!TRIBUTE_RES.includes(res) || !(typeof amount === 'number' && amount >= 1 && Number.isFinite(amount))) return { ok: false, reason: 'Geçersiz miktar' };
    if (Math.floor(a.res[res] || 0) < 1) return { ok: false, reason: 'Yetersiz kaynak' };
    return { ok: true, amount: Math.min(Math.floor(amount), Math.floor(a.res[res] || 0)) };
  },
  cmdTribute(from, to, res, amount) {
    to = to | 0; const c = this.canTribute(from, to, res, amount); if (!c.ok) return false;
    const a = this.players[from], b = this.players[to];
    a.res[res] -= c.amount; b.res[res] = (b.res[res] || 0) + c.amount;
    const st = a.stats || (a.stats = {}); st.tribute = (st.tribute || 0) + c.amount;
    this.events.emit('tribute', { from, to, res, amount: c.amount });
    return true;
  },
  _credit(p, res, n) { p.res[res] += n; p.stats.gathered[res] += n; },
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
  },
  // center-line walkability between two close points (local moves to a stand spot)
  _losC(x0, z0, x1, z1, owner) { const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 0.2); for (let i = 1; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n; if (!this._pass(x | 0, z | 0, owner)) return false; } return true; },
  // stand spots around a resource tile: 4 sides then 4 corners, only on tiles this owner can walk
  _spotCands(t, owner) { const out = []; for (let i = 0; i < 16; i += 2) { const x = t.x + SPOT_O[i], z = t.z + SPOT_O[i + 1]; if (this._pass(x | 0, z | 0, owner)) out.push(x, z); } return out; },
  // spots claimed by other gatherers near (x, z): derived from their orders every time, nothing stored besides the order itself
  _spotClaims(u, x, z) { const cl = []; this._near(x, z, 2.6, e => { if (e === u || e.dead) return; const q = e.order; if (q && q.type === 'gather' && q.sp && Math.abs(q.sx - x) < 2.6 && Math.abs(q.sz - z) < 2.6) cl.push(q.sx, q.sz, q.sp); }); return cl; },
  _spotFree(cl, x, z) { for (let k = 0; k < cl.length; k += 3) if (Math.hypot(cl[k] - x, cl[k + 1] - z) < 0.55) return false; return true; },
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
  },
  _bfsAt(bf, x, z) { const i = (x | 0) - bf.ox, j = (z | 0) - bf.oz; return i < 0 || j < 0 || i >= bf.W || j >= bf.W ? -1 : bf.dist[j * bf.W + i]; },
  // waypoints (tile centres, then the spot itself) for a short walk around the resource to a stand spot
  _spotPath(u, t, x, z) {
    const bf = this._spotBfs(u, t); if (this._bfsAt(bf, x, z) < 0) return null;
    const out = []; let c = ((z | 0) - bf.oz) * bf.W + ((x | 0) - bf.ox); c = bf.par[c];
    while (c >= 0 && bf.dist[c] > 0) { out.push(c % bf.W + bf.ox + 0.5, ((c / bf.W) | 0) + bf.oz + 0.5); c = bf.par[c]; }
    const p = []; for (let i = out.length - 2; i >= 0; i -= 2) p.push(out[i], out[i + 1]); p.push(x, z); return p;
  },
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
  },
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
  },
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
  },

  // ---------- pasture (Ağıl) ----------
  _pasCmd(us, t, queue = false) {
    for (const u of us) { if (u.owner !== t.owner) continue; this._setOrder(u, t.done ? { type: 'gather', targetId: t.id, res: 'food', rt: 'pasture', x: t.x, z: t.z, acc: 0, tick: 0, dep: 0 } : { type: 'build', targetId: t.id }, queue); }
    return true;
  },
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
  },
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
  },
};

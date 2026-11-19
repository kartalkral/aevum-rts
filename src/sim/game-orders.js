// Unit orders, control groups, movement and pathfinding.
import { UNITS } from '../data.js';

const RES_OF = { tree: 'wood', stone: 'stone', gold: 'gold', berries: 'food', deer: 'food', fish: 'food' };
// unit stances (owner 2026-11-15: a catapult behind the wall walked out of the gate and died): aggressive chases as
// before; defensive chases at most DEF_LEASH tiles from where it stood and walks back; hold never moves for an auto
// fight (only what is in weapon reach). A player's own order is always obeyed.
export const STANCES = ['aggressive', 'defensive', 'hold'];

const FF_GAP = 15;   // ticks between two rebuilds of one group's stale flow field (see _flowField)
const FF_WALK = 1500;   // flow-field route cells walked per tick (300 units starting a long trip spread over a few ticks)
const FF_MARGIN = 32;   // a group's field reaches this many steps beyond its furthest unit (see _ffSweep)
const FF_SEG = 64;   // cells of one flow-field route; a unit asks for the next stretch at its end (cheap: the field stays)

export const orderMethods = {
  // ---- control groups 1-9 (Ctrl+number): kept per player in the save (p.cg) so a loaded game has them back.
  // Not part of any decision or the hash; the local UI keeps its own copy and sends changes through the lockstep
  // like any command, so every client's save (and a continued multiplayer match) carries every player's groups.
  cmdGroup(owner, n, ids) {
    const p = this.players[owner]; n = n | 0; if (!p || n < 1 || n > 9) return false;
    const list = (Array.isArray(ids) ? ids : []).filter(id => { const e = this.entities.get(id); return !!e && !e.dead && e.owner === owner && (e.kind === 'unit' || e.kind === 'building'); }).slice(0, 1000);
    const cg = p.cg && typeof p.cg === 'object' ? p.cg : (p.cg = {});
    if (list.length) cg[n] = list; else delete cg[n];
    return true;
  },
  // a player's saved control groups with the dead / lost entities dropped: {n: [ids]}
  controlGroups(owner) {
    const p = this.players[owner], out = {}; if (!p || !p.cg) return out;
    for (const k in p.cg) { const n = k | 0; if (n < 1 || n > 9 || !Array.isArray(p.cg[k])) continue; const ids = p.cg[k].filter(id => { const e = this.entities.get(id); return !!e && !e.dead && e.owner === owner; }); if (ids.length) out[n] = ids; }
    return out;
  },
  _live(ids) { const out = []; for (const id of ids || []) { const u = this.entities.get(id); if (u && u.kind === 'unit' && !u.dead && !u.aboard && !u.train) out.push(u); } return out; },
  // Explore: units wander toward unexplored tiles until they get any other order.
  cmdExplore(ids) { let n = 0; for (const u of this._live(ids)) { if (this._exploreStep(u)) n++; } return n > 0; },
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
  },
  // Shift-queue (playtest 2026-11-14): an open-ended order (gathering: trees, farms, endless mines...; trade runs;
  // fishing) never finishes on its own, so nothing queued behind it would ever run. Queuing behind one ends it now
  // (queued open-ended orders are dropped the same way); a villager walking to drop off a load delivers it first.
  _setOrder(u, o, queue) { u.explore = false; if (queue && u.order && !u.order.auto) { const open = q => !!q && (q.type === 'gather' || q.type === 'trade' || q.type === 'fish'); for (let i = u.queue.length - 1; i >= 0; i--) if (open(u.queue[i])) u.queue.splice(i, 1); u.queue.push(o); if (open(u.order)) this._next(u); else if (u.order.type === 'return') u.order.resume = null; return; } if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.queue.length = 0; u.order = o; u.targetId = o.targetId || null; u.path = null; u.pk = null; u.rpT = 0; },
  _unhunt(o) { const t = this.entities.get(o.targetId); if (t && t.type === 'deer') t.hunted = false; },
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
  },
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
  },
  cmdAttack(ids, targetId, queue = false) {
    const t = this.entities.get(targetId); if (!t || t.dead || t.kind === 'resource') return false;
    const us = this._live(ids); let ok = false;
    for (const u of us) { if (!this.isEnemy(u.owner, t.owner) || UNITS[u.type].atk <= 0) continue; if (u.type === 'ram' && t.kind !== 'building') continue; if (t.naval && !(UNITS[u.type].range > 0)) continue; this._setOrder(u, { type: 'attack', targetId }, queue); ok = true; }
    return ok;
  },
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
  },
  cmdBuild(ids, buildingId, queue = false) {
    const b = this.entities.get(buildingId); if (!b || b.dead || b.kind !== 'building') return false;
    const us = this._live(ids).filter(u => u.type === 'villager' && u.owner === b.owner); if (!us.length) return false;
    for (const u of us) this._setOrder(u, { type: 'build', targetId: buildingId, line: b.line || null }, queue);   // (a wall piece: the builder knows its line)
    return true;
  },
  cmdStance(ids, stance) {
    if (!STANCES.includes(stance)) return false;
    let n = 0; for (const u of this._live(ids)) { const d = UNITS[u.type]; if (d.cls === 'civil' || !(d.atk > 0)) continue; u.stance = stance === 'aggressive' ? undefined : stance; n++; }
    return n > 0;
  },
  cmdStop(ids) { for (const u of this._live(ids)) { if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.order = null; u.queue.length = 0; u.path = null; u.pk = null; u.targetId = null; u.state = 'idle'; u.anim = 'idle'; } return true; },

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
  },
  // straight-line walkability (centre + two side samples so corners are not clipped)
  _los(x0, z0, x1, z1, owner) {
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 0.01) return true;
    const n = Math.ceil(L / 0.25), ox = -dz / L * 0.3, oz = dx / L * 0.3;
    for (let i = 0; i <= n; i++) {
      const x = x0 + dx * i / n, z = z0 + dz * i / n;
      if (!this._pass(x | 0, z | 0, owner) || !this._pass((x + ox) | 0, (z + oz) | 0, owner) || !this._pass((x - ox) | 0, (z - oz) | 0, owner)) return false;
    }
    return true;
  },
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
  },
  // budgeted path request: null when this tick's A* budget is spent (caller steers straight and retries)
  _reqPath(u, gx, gz, half) {
    if ((this._pn || 0) > 5000) return null;
    return this._smooth(this._findPath(u.x, u.z, gx, gz, half, u.owner), u.x, u.z, u.owner);
  },
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
  },
  _ffKeep(grp, d) {
    Object.defineProperty(grp, 'ff', { value: d, writable: true, enumerable: false, configurable: true });
    return d;
  },
  // where owner can walk, one byte per cell; kept up to date cell by cell (_blkMark), fully rebuilt when the teams change
  _passMap(owner) {
    const N = this.map.size, c = this._pmc || (this._pmc = new Map()), key = this._tm ? this._tm.join(',') : '';
    const e = c.get(owner);
    if (e && e.k === key && e.P.length === N * N) return e.P;
    const P = e && e.P.length === N * N ? e.P : new Uint8Array(N * N), nm = this._navMode; this._navMode = false;
    for (let z = 0, k = 0; z < N; z++) for (let x = 0; x < N; x++, k++) P[k] = this._pass(x, z, owner) ? 1 : 0;
    this._navMode = nm;
    c.set(owner, { k: key, P }); return P;
  },
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
  },
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
  },
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
  },
  _steer(u, x, z, dt) {
    const dx = x - u.x, dz = z - u.z, L = Math.hypot(dx, dz); if (L < 0.05) return;
    const s = Math.min(L, this._speed(u) * dt), nx = u.x + dx / L * s, nz = u.z + dz / L * s;
    if (this._pass(nx | 0, nz | 0, u.owner)) { u.x = nx; u.z = nz; u.rot = Math.atan2(dx, dz); }
  },
  _speed(u) { const d = UNITS[u.type], m = this.players[u.owner].mods; let s = d.speed * (1 + (m.speed[d.cls] || 0)); if (u.type === 'villager') s *= 1 + m.vspeed; const t = this.map.tiles[(u.z | 0) * this.map.size + (u.x | 0)]; if (t === 3 && !u.naval) s *= 0.6; return s; },
  _step(u, dt) {
    if (!u.path || u.pi >= u.path.length) return true;
    let d = this._speed(u) * dt;
    while (d > 0 && u.pi < u.path.length) {
      const px = u.path[u.pi], pz = u.path[u.pi + 1], dx = px - u.x, dz = pz - u.z, L = Math.hypot(dx, dz);
      if (L <= d) { u.x = px; u.z = pz; d -= L; u.pi += 2; }
      else { u.x += dx / L * d; u.z += dz / L * d; u.rot = Math.atan2(dx, dz); d = 0; }
    }
    return u.pi >= u.path.length;
  },
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
  },
  _edge(u, t) {
    const half = t.kind === 'building' ? t.size / 2 : (t.kind === 'resource' && t.type !== 'deer') ? 0.5 : 0;
    const dx = Math.max(Math.abs(u.x - t.x) - half, 0), dz = Math.max(Math.abs(u.z - t.z) - half, 0);
    return Math.hypot(dx, dz);
  },
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
  },
  _next(u) { if (u.order && u.order.type === 'gather') this._unhunt(u.order); u.order = u.queue.shift() || null; u.path = null; u.pk = null; u.rpT = 0; u.targetId = u.order ? (u.order.targetId || null) : null; if (!u.order) { u.state = 'idle'; u.anim = 'idle'; u.scanT = 0; } },   // (scanT 0: a soldier whose foe just fell looks for the next one at once - 2026-11-17 playtest)
};

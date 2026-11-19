// AI town walls: layout, flood checks, gates, towers and construction assistance.
import { BUILDINGS } from '../data.js';

export const aiFortificationMethods = {
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
};

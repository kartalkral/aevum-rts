// Damage, projectiles, targeting and combat orders.
import { BUILDINGS, UNITS } from '../data.js';

const PSPEED = { arrow: 14, bullet: 30, stone: 9, cannonball: 14 };
// lobbed arrows / crossbow bolts: [arc height base, arc height per tile, flight time base s, tiles per s] (see _fire)
// (2026-11-17 playtest, owner: "the arrows don't fly, they drop": about twice as fast and flatter than the old
// [0.8, 0.3, 0.25, 11] / [0.45, 0.17, 0.18, 14]; a shot over a wall still lobs high enough to clear it)
const ARROW_ARC = [0.35, 0.11, 0.1, 22], BOLT_ARC = [0.15, 0.05, 0.06, 30];
const WALL_CLEAR = 3.4, LOB_MAX = 7, LOB_T = 0.42;   // lob over a wall: height to clear above the ground (walls are drawn ~2.7 high), cap, flight time per sqrt(height)

const DEF_LEASH = 5;

const WALL_TRY = 4;   // out-of-range targets a shooter tests for a wall in the way per scan (see _acquire)

export const combatMethods = {
  // ---------- combat ----------
  _dmg(atk, bonus, isSiege, target) {
    let mult, armor = 0;
    if (target.kind === 'building') { mult = bonus.building || (isSiege ? 1 : 0.4); }
    else { const d = UNITS[target.type]; mult = bonus[d.cls] || 1; armor = d.armor + (this.players[target.owner].mods.armor[d.cls] || 0); }
    return Math.max(1, Math.round(atk * mult - armor));
  },
  // Arrows are lobbed (2026-11-15, owner: "Empire Earth archers shoot up over the wall and the arrows drop on the
  // enemy"): a parabola whose height grows with the distance (ARROW_ARC: base + per tile), crossbow bolts flatter and
  // quicker (bolt flag, also read by the view); a shot from a unit across a wall goes at least high enough to clear it
  // (_lobOver: steep when the foe hugs the wall). Flight time = base + distance / speed, or LOB_T x sqrt(height) for a
  // high lob, whichever is longer. The damage lands when the flight ends.
  _fire(src, target, dmg, proj) {
    const m = this.map, d = Math.hypot(target.x - src.x, target.z - src.z), sy = m.heightAt(src.x, src.z) + (src.kind === 'building' ? 2.5 : 1.0);
    const bolt = proj === 'arrow' && src.kind === 'unit' && src.type === 'crossbow', A = bolt ? BOLT_ARC : ARROW_ARC, ty = m.heightAt(target.x, target.z) + 0.7;
    let arc = proj === 'bullet' ? 0 : proj === 'arrow' ? A[0] + d * A[1] : d * 0.22, dur = Math.max(0.08, d / PSPEED[proj]);
    if (proj === 'arrow') { if (src.kind === 'unit') arc = Math.max(arc, this._lobOver(src.x, src.z, sy, target.x, target.z, ty)); dur = Math.max(A[2] + d / A[3], arc > A[0] + d * A[1] + 0.01 ? LOB_T * Math.sqrt(arc) : 0); }   // (the slow high lob only over a wall)
    const p = { id: this.nextId++, type: proj, x: src.x, y: sy, z: src.z, sx: src.x, sy, sz: src.z, tx: target.x, ty, tz: target.z, t: 0, dur, targetId: target.id, dmg, owner: src.owner, srcId: src.id, arc };
    if (bolt) p.bolt = 1;
    this.projectiles.push(p);
  },
  _applyDamage(target, dmg, killer, proj) {
    if (!target || target.dead) return;
    target.hp -= dmg; target.hitT = this.time;
    // view only: the attacker shows through the victim team's fog for a few seconds (read by isEntityVisible, never by the sim)
    if (killer && !killer.dead && killer.id && killer.owner >= 0 && killer.kind !== 'resource') { killer.revT = this.time; killer.revO = target.owner; }
    // call for help: idle soldiers of the victim's side close by come to fight the attacker (at most once a second per victim)
    if (killer && !killer.dead && killer.id && killer.owner >= 0 && target.owner >= 0 && !(this.time < (target.helpT || 0))) { target.helpT = this.time + 1; this._callHelp(target, killer); }
    this.events.emit('hit', { target, x: target.x, y: this.map.heightAt(target.x, target.z) + 0.8, z: target.z, dmg, proj: proj || null });
    // under attack (view only, never read by the sim): once per fight (2026-11-17 playtest: "the constant 'you are under
    // attack' is annoying, once is enough") - again only after 30 s without any hit on us, or for a fight more than
    // 30 tiles from the last alert (at most every 15 s)
    if (target.owner === this.me) {
      const far = this._uaX == null || Math.hypot(target.x - this._uaX, target.z - this._uaZ) > 30;
      if (this.time - this._uaLast > 30 || (far && this.time > this._uaT)) { this._uaT = this.time + 15; this._uaX = target.x; this._uaZ = target.z; this.events.emit('underAttack', { x: target.x, z: target.z }); this.events.emit('notify', { text: 'Saldırı altındasın!', type: 'warn', x: target.x, z: target.z }); }
      this._uaLast = this.time;
    }
    if (target.hp <= 0) { this._kill(target, killer); return; }
    if (target.kind === 'unit' && target.type === 'villager' && killer && !killer.dead && killer.kind === 'unit' && target.order && (target.order.type === 'gather' || target.order.type === 'return')) {
      // gathering villager under attack with no friendly military nearby: run to the town center, resume afterwards
      let guard = false;
      this._near(target.x, target.z, 7, e => { if (!guard && !e.dead && e.owner === target.owner && !e.naval && UNITS[e.type].cls !== 'civil' && UNITS[e.type].atk > 0) guard = true; });
      const tc = guard ? null : this._nearestB(target, b => b.type === 'towncenter');
      if (tc && Math.hypot(tc.x - target.x, tc.z - target.z) > 5) { const old = target.order; this.cmdMove([target.id], tc.x, tc.z + tc.size / 2 + 1); if (target.order && target.order.type === 'move') { old.fail = 0; target.queue.push(old); } }
      return;
    }
    if (target.kind === 'unit' && killer && !killer.dead && (!target.order || target.order.auto)) {
      const d = UNITS[target.type];
      if (d.cls === 'civil') { if (!target.order && !target.naval) { const tc = this._nearestB(target, b => b.type === 'towncenter'); if (tc && Math.hypot(tc.x - target.x, tc.z - target.z) > 4) this.cmdMove([target.id], tc.x, tc.z + tc.size / 2 + 1); } }
      else if (d.atk > 0 && !(target.type === 'ram' && killer.kind !== 'building') && !(killer.naval && !(d.range > 0)) && !target.order) this._engage(target, killer);
    } else if (target.kind === 'unit' && killer && !killer.dead && killer.id && target.order && target.order.type === 'move' && this._canEngage(target, killer)) this._engage(target, killer);
  },
  // At most HELP_N of the nearest idle soldiers answer; a foe marked out of reach for their side (_giveUp) is skipped.
  _callHelp(victim, foe) {
    const HELP_R = 16, HELP_N = 10, cand = [];
    this._near(victim.x, victim.z, HELP_R, v => {
      if (v.dead || v.kind !== 'unit' || v.aboard || v.order || (v.owner !== victim.owner && !this.isAlly(v.owner, victim.owner))) return;
      if (!this._canEngage(v, foe) || this.time < (foe['nh' + v.owner] || 0)) return;
      const d = Math.hypot(v.x - victim.x, v.z - victim.z); if (d <= HELP_R) cand.push([d, v.id, v]);
    });
    cand.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 0, n = 0; i < cand.length && n < HELP_N; i++) {
      const v = cand[i][2], fd = Math.hypot(v.x - foe.x, v.z - foe.z);
      if (UNITS[v.type].range > 0 && fd > this._wRange(v) && this._walled(v.x, v.z, foe.x, foe.z, foe.kind === 'building' ? foe : null)) continue;   // a shooter behind its wall stays there
      this._engage(v, foe, fd + 4); n++;   // (the leash reaches the attacker)
    }
  },
  // an auto attack that cannot get to its target gives up and marks it out of reach for its side for 12 s, so idle
  // scans and calls for help do not send units at it again and again (a foe behind walls, offshore, across water)
  _giveUp(u) { const o = u.order; if (o && o.auto && o.type === 'attack') { const t = this.entities.get(o.targetId); if (t && !t.dead) t['nh' + u.owner] = this.time + 12; } this._next(u); },
  _canEngage(u, t) { const d = UNITS[u.type]; return d.cls !== 'civil' && d.atk > 0 && u.type !== 'ram' && !u.naval && !(t.naval && !(d.range > 0)); },
  // Auto attack that leaves any move order waiting at the front of the queue, so the unit resumes its trip after the fight.
  // The leash reaches past the attacker's own range so long-range shooters can be chased down.
  _engage(u, t, reach) {
    if (u.stance === 'hold' && this._edge(u, t) > (UNITS[u.type].range > 0 ? this._wRange(u) : 1.0)) return;
    if (u.stance === 'defensive' && Math.hypot(u.x - t.x, u.z - t.z) > Math.max(DEF_LEASH + 3, UNITS[u.type].range > 0 ? this._wRange(u) : 0)) return;
    const o = u.order;
    if (o && o.type === 'move') u.queue.unshift(o.grp ? { type: 'move', x: o.x, z: o.z, grp: o.grp } : { type: 'move', x: o.x, z: o.z });
    const d = UNITS[u.type], tr = t.kind === 'unit' ? UNITS[t.type].range || 0 : t.kind === 'building' ? BUILDINGS[t.type].range || 0 : 0;
    u.order = { type: 'attack', targetId: t.id, auto: true, ox: u.x, oz: u.z, lr: Math.max(d.los, tr + 4, reach || 0) }; u.targetId = t.id; u.path = null; u.pk = null;
  },
  _kill(e, killer) {
    if (e.dead) return; e.dead = true; e.hp = 0;
    const p = this.players[e.owner], kp = killer && killer.owner >= 0 && killer.owner !== e.owner ? this.players[killer.owner] : null;
    if (e.kind === 'unit') {
      if (e.order && e.order.type === 'gather') this._unhunt(e.order);
      e.state = 'dead'; e.anim = 'die'; e.deathTime = this.time; e.order = null; e.queue.length = 0; e.path = null;
      if (e.cargo && e.cargo.length) this._navSinkCargo(e, killer);
      p.pop -= UNITS[e.type].pop; p.stats.unitsLost++; if (kp) kp.stats.kills++;
      this.events.emit('death', { e, killer: killer || null });
    } else if (e.kind === 'building') {
      this._block(e, 0);
      const i = this.buildings.indexOf(e); if (i >= 0) this.buildings.splice(i, 1);
      for (const q of e.queue) if (q.kind === 'tech') { const k = p.pending.indexOf(q.id); if (k >= 0) p.pending.splice(k, 1); }
      p.stats.buildingsLost++; if (kp) kp.stats.razed++;
      this.events.emit('death', { e, killer: killer || null });
      this.entities.delete(e.id); this.events.emit('remove', { e }); this._popCap(p); if (e.type === 'rail' || e.type === 'station') this._railDirty = true;
    } else {
      const N = this.map.size;
      if (e.type === 'deer') { const i = this.deer.indexOf(e); if (i >= 0) this.deer.splice(i, 1); }
      else { const k = (e.z | 0) * N + (e.x | 0); this.resAt[k] = 0; this.map.blocked[k] = 0; this._blkMark(e.x | 0, e.z | 0, 1, 1); }
      if (e.type === 'tree') this.events.emit('treeFelled', { e });
      this.entities.delete(e.id); this.events.emit('remove', { e });
    }
  },
  // Ranged land units (archers behind their wall, 2026-11-15): a foe already within weapon range comes first (even one
  // marked out of reach: they shoot from where they stand); one out of range across a wall / gate / tower is skipped,
  // so idle shooters do not walk out through a gate or round the wall to get at it (only the nearest WALL_TRY are tried).
  // Targets of an attacking building (tower / castle): up to n enemy units within R measured from the building's edge
  // (2026-11-17 playtest: "the archer hits the tower, the tower can't hit the archer" - the old centre distance cost a
  // diagonal attacker ~0.6 tiles), nearest first (ties by id, deterministic).
  _bTargets(b, R, n) {
    const h = b.size / 2, out = [];
    this._near(b.x, b.z, R + h + 1, e => {
      if (e.dead || e.kind !== 'unit' || e.aboard || !this.isEnemy(b.owner, e.owner)) return;
      const dx = Math.max(Math.abs(e.x - b.x) - h, 0), dz = Math.max(Math.abs(e.z - b.z) - h, 0), d = dx * dx + dz * dz;
      if (d <= R * R) out.push([d, e.id, e]);
    });
    out.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
    return out.slice(0, n).map(x => x[2]);
  },
  _acquire(src, r, unitsOnly, noUnits) {
    let best = null, bd = r * r;
    const melee = src.kind === 'unit' && !(UNITS[src.type].range > 0);
    const nk = src.kind === 'unit' ? 'nh' + src.owner : null;
    const wr = src.kind === 'unit' && !melee && !src.naval ? this._wRange(src) : 0, wr2 = wr * wr, far = wr ? [] : null;
    let near = null, nd = wr2;
    if (!noUnits) this._near(src.x, src.z, r, e => {
      if (e.dead || !this.isEnemy(src.owner, e.owner) || (melee && e.naval)) return;
      const d = (e.x - src.x) ** 2 + (e.z - src.z) ** 2;
      if (wr && d <= wr2) { if (d < nd || (d === nd && near && e.id < near.id) || !near) { nd = d; near = e; } return; }
      if (nk && this.time < (e[nk] || 0)) return;
      if (melee && d < 9 && d < bd && this._walled(src.x, src.z, e.x, e.z, null)) return;   // (just across a wall / gate: no blow lands there, owner 2026-11-15)
      if (d < bd) { if (far) far.push([d, e]); else { bd = d; best = e; } }
    });
    if (near) return near;
    if (far && far.length) { far.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id); for (let i = 0; i < far.length && i < WALL_TRY; i++) if (!this._walled(src.x, src.z, far[i][1].x, far[i][1].z, null)) { best = far[i][1]; break; } }
    if (best || unitsOnly) return best;
    let be = r;
    for (const b of this.buildings) { if (!this.isEnemy(src.owner, b.owner) || b.dead) continue; if (Math.abs(b.x - src.x) > r + 3 || Math.abs(b.z - src.z) > r + 3) continue; const d = this._edge(src, b); if (d < be && (!wr || d <= wr || !this._walled(src.x, src.z, b.x, b.z, b))) { be = d; best = b; } }
    return best;
  },
  // the arc height a lob from (x0, sy, z0) to (x1, ty, z1) needs to pass WALL_CLEAR over every wall / gate tile on the
  // way (0 when none; at most LOB_MAX)
  _lobOver(x0, z0, sy, x1, z1, ty) {
    const dx = x1 - x0, dz = z1 - z0, n = Math.ceil(Math.hypot(dx, dz) / 0.25), N = this.map.size, bl = this.map.blocked;
    let last = -1, lw = false, need = 0;
    for (let i = 1; i < n; i++) {
      const x = (x0 + dx * i / n) | 0, z = (z0 + dz * i / n) | 0; if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const k = z * N + x;   // (every sample inside a wall tile counts: past the apex its far side is the lowest point)
      if (k !== last) { last = k; const v = bl[k], w = (v === 1 || v >= 10) && !this.resAt[k] ? this.buildingAt(x, z) : null; lw = !!w && (w.type === 'wall' || w.type === 'gate'); }
      if (!lw) continue;
      const f = Math.min(0.88, Math.max(0.12, i / n)), h = (this.map.heightAt(x + 0.5, z + 0.5) + WALL_CLEAR - (sy + (ty - sy) * f)) / (4 * f * (1 - f));
      if (h > need) need = h;
    }
    return Math.min(LOB_MAX, need);
  },
  _wRange(u) { const d = UNITS[u.type]; return d.range + (this.players[u.owner].mods.range[d.cls] || 0); },
  // a finished wall, gate or tower (other than ign) on the straight line between two points: shooters stand behind it
  _walled(x0, z0, x1, z1, ign) {
    const dx = x1 - x0, dz = z1 - z0, n = Math.ceil(Math.hypot(dx, dz) / 0.25), N = this.map.size, bl = this.map.blocked;
    let last = -1;
    for (let i = 1; i < n; i++) {
      const x = (x0 + dx * i / n) | 0, z = (z0 + dz * i / n) | 0; if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const k = z * N + x; if (k === last) continue; last = k;
      const v = bl[k]; if (!(v === 1 || v >= 10) || this.resAt[k]) continue;
      const b = this.buildingAt(x, z); if (b && b !== ign && b.done && (b.type === 'wall' || b.type === 'gate' || b.type === 'tower')) return true;
    }
    return false;
  },
  _uAttack(u, o, dt) {
    const t = this.entities.get(o.targetId), d = UNITS[u.type];
    if (!t || t.dead || !this.isEnemy(u.owner, t.owner) || t.kind === 'resource') return this._autoEnd(u, o);
    const m = this.players[u.owner].mods;
    const leash = o.auto && u.stance === 'defensive' ? DEF_LEASH : (o.lr || d.los) + 5;
    if (o.auto && Math.hypot(u.x - o.ox, u.z - o.oz) > leash) return this._autoEnd(u, o);
    const range = d.range > 0 ? d.range + (m.range[d.cls] || 0) : 1.0;
    if (o.auto && u.stance === 'hold' && this._edge(u, t) > range + 0.05) return this._autoEnd(u, o);   // (holds its ground)
    // a shooter on an auto attack does not leave its wall: a target out of range on the far side is dropped (checked
    // twice a second; an attack the player ordered still walks round)
    if (o.auto && d.range > 0 && !u.naval && this.time >= (o.wt || 0) && this._edge(u, t) > range) { o.wt = this.time + 0.5; if (this._walled(u.x, u.z, t.x, t.z, t.kind === 'building' ? t : null)) return this._next(u); }
    // melee does not reach across a wall, gate or tower (owner 2026-11-15: both sides hit each other through a closed
    // gate): an auto target there is dropped, an ordered one is walked round to (the reach shrinks to touching)
    let reach = range;
    if (!(d.range > 0) && !u.naval && this._edge(u, t) <= range + 0.6 && this._walled(u.x, u.z, t.x, t.z, t.kind === 'building' ? t : null)) {
      if (o.auto) return this._next(u);
      reach = 0.05;
    }
    if (this._approach(u, t, dt, reach)) {
      u.state = 'attack'; u.anim = 'attack'; u.rot = Math.atan2(t.x - u.x, t.z - u.z);
      if (u.cd <= 0) {
        u.cd = d.rof; u.attackT = this.time;
        const atk = (d.atk + (m.atk[d.cls] || 0)) * (1 + (m.atkMul[d.cls] || 0));
        const dmg = this._dmg(atk, d.bonus, d.cls === 'siege', t);
        this.events.emit('attack', { attacker: u, target: t, ranged: !!d.proj });
        if (d.proj) this._fire(u, t, dmg, d.proj); else this._applyDamage(t, dmg, u, null);
      }
    }
  },
  // an auto fight is over: a defensive or holding unit walks back to where it stood (if it moved and nothing is queued)
  _autoEnd(u, o) {
    if (o && o.auto && (u.stance === 'defensive' || u.stance === 'hold') && !u.queue.length && o.ox != null && Math.hypot(u.x - o.ox, u.z - o.oz) > 0.8) {
      u.order = { type: 'move', x: o.ox, z: o.oz }; u.targetId = null; u.path = null; u.pk = null; u.rpT = 0; return;
    }
    this._next(u);
  },
};

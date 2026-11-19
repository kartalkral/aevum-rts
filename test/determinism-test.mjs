// Lockstep determinism: node test/determinism-test.mjs [minutes]
// Two clients (cfg.me 0 and 1) + a replay run get the same scripted command stream through execCommand.
import { Game, CMD_METHODS } from '../src/sim/game.js';
import { traceState } from './replay-trace.mjs';

const MIN = +(process.argv[2] || 20);
const TICKS = Math.round(MIN * 60 * 30), DT = 1 / 30;
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? '  ok ' : '  FAIL ') + m); return !!c; };
const cfg = me => ({ mapSize: 96, seed: 3, mp: true, me, startRes: 'normal', startAge: 0,
  players: [{ kind: 'human', team: 1, name: 'A' }, { kind: 'human', team: 1, name: 'B' }, { kind: 'ai', team: 2, difficulty: 'hard' }, { kind: 'ai', team: 2, difficulty: 'hard' }] });

// scripted commands, derived from the leading game's state (identical on every client if in sync)
function script(g, t) {
  const out = [];
  for (const pid of [0, 1]) {
    const p = g.players[pid], us = g.unitsOf(pid), vil = us.filter(u => u.type === 'villager'), tc = g.buildingsOf(pid).find(b => b.type === 'towncenter');
    const spot = (type, r0) => { for (let r = r0; r < r0 + 14; r++) for (let k = 0; k < 16; k++) { const a = k / 16 * 6.283, tx = Math.round(p.startX + Math.cos(a) * r), tz = Math.round(p.startZ + Math.sin(a) * r); if (g.canPlace(type, tx, tz, pid)) return [tx, tz]; } return null; };
    if (t === 30 + pid) {
      const tree = g.resourceNear(p.startX, p.startZ, 20, 'tree'), ber = g.resourceNear(p.startX, p.startZ, 20, 'berries');
      if (tree) out.push([pid, 'cmdGather', [vil.slice(0, 2).map(u => u.id), tree.id]]);
      if (ber) out.push([pid, 'cmdGather', [vil.slice(2).map(u => u.id), ber.id]]);
    }
    if (t === 90 + pid) { const s = spot('barracks', 7); if (s) out.push([pid, 'placeBuilding', [pid, 'barracks', s[0], s[1], [vil[0] && vil[0].id], false]]); }
    if (t === 200 + pid) { const s = spot('market', 9); if (s) out.push([pid, 'placeBuilding', [1 - pid /* forged owner: must be forced to pid */, 'market', s[0], s[1], [], false]]); }
    if (tc && t % 450 === 10 + pid && vil.length < 18) out.push([pid, 'train', [tc.id, 'villager']]);
    if (tc && t === 20 + pid) out.push([pid, 'setRally', [tc.id, p.startX + 3, p.startZ + 5, null]]);
    const bar = g.buildingsOf(pid).find(b => b.type === 'barracks' && b.done);
    if (bar && t % 300 === 40 + pid) out.push([pid, 'train', [bar.id, 'spearman']]);
    if (t % 900 === 500 + pid) { // idle villagers back to work
      const idle = vil.filter(u => !u.order); const r = g.resourceNear(p.startX, p.startZ, 25, t % 1800 < 900 ? 'tree' : 'gold') || g.resourceNear(p.startX, p.startZ, 25, 'stone');
      if (idle.length && r) out.push([pid, 'cmdGather', [idle.map(u => u.id), r.id]]);
    }
    if (t === 6000 + pid) { const tiles = []; for (let i = 0; i < 6; i++) tiles.push([Math.round(p.startX) - 3 + i, Math.round(p.startZ) - 9]); out.push([pid, 'placeLine', [pid, 'wall', tiles, [], false]]); }
    if (t % 1500 === 700 + pid) out.push([pid, 'trade', [pid, 'wood', 'gold']]);
    if (t === 3000 + pid) { const s = us.find(u => u.type === 'spearman'); if (s) out.push([pid, 'cmdExplore', [[s.id]]]); }
    if (t >= 18000 && t % 1200 === 0) {
      const mil = us.filter(u => u.type !== 'villager' && !u.naval).map(u => u.id);
      const etc = g.buildings.find(b => b.type === 'towncenter' && g.isEnemy(pid, b.owner));
      if (mil.length && etc) out.push([pid, 'cmdAttack', [mil, etc.id]]);
    }
    // illegal: try to move the ally's / an enemy's units (must be ignored)
    if (t % 777 === 5) { const other = g.unitsOf(pid === 0 ? 2 : 0).slice(0, 3).map(u => u.id); if (other.length) out.push([pid, 'cmdMove', [other, 10, 10, false]]); }
  }
  return out;
}

function wrapLikeApp(g) { // what main.js does in multiplayer: instance wrappers that only queue
  const q = []; for (const m of CMD_METHODS) g[m] = (...a) => { q.push([m, a]); return true; }; return q;
}

const A = new Game(cfg(0)), B = new Game(cfg(1)), C = new Game(cfg(0));
const queued = wrapLikeApp(B);
ok(A.players.length === 4 && A.ais.length === 2, '4 players, 2 AIs');
ok(A.me === 0 && B.me === 1 && A.mp && A.quests.list.length === 0, 'me / mp / quests off');
ok(A.teamOf(0) === 1 && A.teamOf(1) === 1 && A.teamOf(2) === 2 && A.isAlly(0, 1) && A.isEnemy(1, 3) && !A.isEnemy(2, 3), 'teams');
ok(A.hash() === B.hash() && A.hash() === C.hash(), 'initial hash equal ' + A.hash());
let firstBad = -1, nCmd = 0, nOk = 0, forgedOwnerOk = true;
const t0 = Date.now();
traceState(A);
for (let t = 1; t <= TICKS; t++) {
  const cmds = script(A, t);
  for (const [pid, m, a] of cmds) {
    const j = JSON.parse(JSON.stringify(a));
    const ra = A.execCommand(pid, m, j), rb = B.execCommand(pid, m, JSON.parse(JSON.stringify(a))); C.execCommand(pid, m, JSON.parse(JSON.stringify(a)));
    nCmd++; if (ra) nOk++;
    if (JSON.stringify(ra) !== JSON.stringify(rb) && firstBad < 0) firstBad = t;
    if (m === 'placeBuilding' && ra) { const b = A.getEntity(ra); if (!b || b.owner !== pid) forgedOwnerOk = false; }
  }
  A.update(DT); B.update(DT); C.update(DT);
  if (t % 300 === 0) {
    traceState(A);
    const ha = A.hash(), hb = B.hash();
    if (ha !== hb && firstBad < 0) { firstBad = t; console.log('  desync at tick', t, ha, hb); }
  }
  if (A.over) break;
}
const secs = (Date.now() - t0) / 1000;
ok(firstBad < 0, 'A (me 0) and B (me 1) hashes equal every 300 ticks' + (firstBad >= 0 ? ' — first mismatch tick ' + firstBad : ''));
ok(A.hash() === B.hash(), 'final hash equal A/B ' + A.hash() + ' / ' + B.hash());
ok(A.hash() === C.hash(), 'run-to-run: replay C reproduces final hash ' + C.hash());
ok(A.tick === B.tick && A.tick > 0, 'tick counters ' + A.tick);
ok(queued.length === 0, 'sim/AI never called the app wrappers on B (' + queued.length + ')');
ok(forgedOwnerOk, 'placeBuilding owner forced to the sender');
ok(nOk > 10, 'commands executed ' + nOk + '/' + nCmd);
const st = A.players.map(p => p.id + ':' + p.stats.unitsTrained + 'u/' + p.stats.buildingsBuilt + 'b' + (p.defeated ? '†' : ''));
console.log('  sim', (A.tick / 1800).toFixed(1), 'min x3 in', secs.toFixed(1), 's; players', st.join(' '), 'over', JSON.stringify(A.over));
// cfg.me alone never changes the hash: same game, flip me + fog recompute
const h0 = A.hash(); A.me = 1; A._updateFog(); A.isEntityVisible(A.units[0]); ok(A.hash() === h0, 'changing me / recomputing fog leaves hash unchanged'); A.me = 0;
console.log(fails.length ? 'FAILED: ' + fails.length : 'ALL OK');
process.exit(fails.length ? 1 : 0);

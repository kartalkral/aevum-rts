// Multiplayer save / continue determinism: node test/mp-save-test.mjs [minutesBefore] [minutesAfter]
// 4-player mp game (2 humans team 1, 2 AI team 2) runs with scripted commands, is serialized, JSON round-tripped
// and deserialized twice with different `me`. Both copies (and the original, which never stopped) then get the
// same command stream; their hashes must stay equal every 300 ticks.
import { Game } from '../src/sim/game.js';
import { traceState } from './replay-trace.mjs';

const MIN_A = +(process.argv[2] || 6), MIN_B = +(process.argv[3] || 6);
const DT = 1 / 30;
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? '  ok   ' : '  FAIL ') + m); return !!c; };
const cfg = me => ({ mapSize: 96, seed: 77, mp: true, me, startRes: 'normal', startAge: 0,
  players: [{ kind: 'human', team: 1, name: 'Kerem' }, { kind: 'human', team: 1, name: 'Arkadas' }, { kind: 'ai', team: 2, difficulty: 'hard' }, { kind: 'ai', team: 2, difficulty: 'normal' }] });

// scripted human commands derived from the leading game's state (identical on all copies while in sync)
function script(g, t) {
  const out = [];
  for (const pid of [0, 1]) {
    const p = g.players[pid], us = g.unitsOf(pid), vil = us.filter(u => u.type === 'villager'), tc = g.buildingsOf(pid).find(b => b.type === 'towncenter');
    const spot = (type, r0) => { for (let r = r0; r < r0 + 14; r++) for (let k = 0; k < 16; k++) { const a = k / 16 * 6.283, tx = Math.round(p.startX + Math.cos(a) * r), tz = Math.round(p.startZ + Math.sin(a) * r); if (g.canPlace(type, tx, tz, pid)) return [tx, tz]; } return null; };
    const lt = t % 10800; // the same pattern repeats after the load
    if (lt === 30 + pid) {
      const tree = g.resourceNear(p.startX, p.startZ, 20, 'tree'), ber = g.resourceNear(p.startX, p.startZ, 20, 'berries');
      if (tree) out.push([pid, 'cmdGather', [vil.slice(0, 2).map(u => u.id), tree.id]]);
      if (ber) out.push([pid, 'cmdGather', [vil.slice(2).map(u => u.id), ber.id]]);
    }
    if (lt === 90 + pid) { const s = spot('barracks', 7); if (s) out.push([pid, 'placeBuilding', [pid, 'barracks', s[0], s[1], [vil[0] && vil[0].id], false]]); }
    if (lt === 200 + pid) { const s = spot('house', 6); if (s) out.push([pid, 'placeBuilding', [pid, 'house', s[0], s[1], [vil[1] && vil[1].id], false]]); }
    if (tc && t % 450 === 10 + pid && vil.length < 22) out.push([pid, 'train', [tc.id, 'villager']]);
    if (tc && lt === 20 + pid) out.push([pid, 'setRally', [tc.id, p.startX + 3, p.startZ + 5, null]]);
    const bar = g.buildingsOf(pid).find(b => b.type === 'barracks' && b.done);
    if (bar && t % 300 === 40 + pid) out.push([pid, 'train', [bar.id, 'spearman']]);
    if (t % 900 === 500 + pid) {
      const idle = vil.filter(u => !u.order); const r = g.resourceNear(p.startX, p.startZ, 25, t % 1800 < 900 ? 'tree' : 'gold') || g.resourceNear(p.startX, p.startZ, 25, 'stone');
      if (idle.length && r) out.push([pid, 'cmdGather', [idle.map(u => u.id), r.id]]);
    }
    if (lt === 5000 + pid) { const tiles = []; for (let i = 0; i < 6; i++) tiles.push([Math.round(p.startX) - 3 + i, Math.round(p.startZ) - 9 - pid]); out.push([pid, 'placeLine', [pid, 'wall', tiles, vil.slice(0, 2).map(u => u.id), false]]); }
    if (t % 1500 === 700 + pid) out.push([pid, 'trade', [pid, 'wood', 'gold']]);
    if (t % 3000 === 2000 + pid) { const s = us.filter(u => u.type === 'spearman').slice(0, 2); if (s.length) out.push([pid, 'cmdExplore', [s.map(u => u.id)]]); }
    // queued move orders (shift) to exercise order queues across the save
    if (t % 2400 === 1200 + pid) { const s = us.filter(u => u.type === 'spearman').slice(2, 6).map(u => u.id); if (s.length) { out.push([pid, 'cmdMove', [s, p.startX + 8, p.startZ + 8, false]]); out.push([pid, 'cmdMove', [s, p.startX - 8, p.startZ + 8, true]]); out.push([pid, 'cmdMove', [s, p.startX, p.startZ - 8, true]]); } }
  }
  return out;
}

const exec = (games, cmds) => { for (const [pid, m, a] of cmds) for (const g of games) g.execCommand(pid, m, JSON.parse(JSON.stringify(a))); };
const snapshot = g => ({ res: g.players.map(p => Object.values(p.res).reduce((s, v) => s + v, 0)), units: g.players.map(p => g.unitsOf(p.id).length), blds: g.players.map(p => g.buildingsOf(p.id).length), aiRs: g.ais.map(a => a.rs) });

console.log(`Phase 1: ${MIN_A} min mp match`);
const O = new Game(cfg(0));
ok(O.players.length === 4 && O.ais.length === 2 && O.mp, '4 players, 2 AIs, mp');
const T1 = Math.round(MIN_A * 60 * 30), T2 = Math.round(MIN_B * 60 * 30);
const t0 = Date.now();
traceState(O);
for (let t = 1; t <= T1; t++) {
  exec([O], script(O, t)); O.update(DT);
  if (t % 300 === 0) traceState(O);
}
const json = JSON.stringify(O.serialize());
console.log('  save size', (json.length / 1024).toFixed(0), 'KB, tick', O.tick);
const A = Game.deserialize(JSON.parse(json), { me: 0 }), B = Game.deserialize(JSON.parse(json), { me: 1 });
ok(A.me === 0 && B.me === 1 && A.mp && B.mp, 'loaded copies keep mp, get their own me (0 / 1)');
ok(A.tick === O.tick && B.tick === O.tick, 'tick counter restored (' + A.tick + ')');
ok(A.quests.list.length === 0 && B.quests.list.length === 0, 'quests stay off after load');
ok(A.ais.length === 2 && B.ais.length === 2, 'AI controllers restored');
ok(A.hash() === O.hash() && B.hash() === O.hash(), 'hash right after load equals the saved game: ' + O.hash() + ' / ' + A.hash() + ' / ' + B.hash());
{ const strip = s => { const o = JSON.parse(s); o.cfg.me = 0; o.fog = null; o.fogR = null; for (const a of o.ais) if (a) a.stats.ms = 0; return JSON.stringify(o); };
  // key order may differ (fields restored in another order); compare leaf by leaf
  const diffs = [];
  const diff = (x, y, p) => { if (JSON.stringify(x) === JSON.stringify(y)) return; if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) diff(x[k], y[k], p + '.' + k); return; } diffs.push(p + ' ' + String(JSON.stringify(x)).slice(0, 60) + ' | ' + String(JSON.stringify(y)).slice(0, 60)); };
  const r0 = JSON.parse(strip(json));
  diff(r0, JSON.parse(strip(JSON.stringify(A.serialize()))), 'A'); diff(r0, JSON.parse(strip(JSON.stringify(B.serialize()))), 'B');
  ok(!diffs.length, 're-serializing a loaded copy gives the same save (apart from me / view fog)' + (diffs.length ? ': ' + diffs.slice(0, 4).join('; ') : '')); }
const before = snapshot(A);
console.log(`Phase 2: continue ${MIN_B} min on the original and both loaded copies`);
let badAB = -1, badOA = -1, checks = 0;
for (let t = T1 + 1; t <= T1 + T2; t++) {
  const cmds = script(A, t);
  exec([O, A, B], cmds);
  O.update(DT); A.update(DT); B.update(DT);
  if (t % 300 === 0) {
    traceState(O);
    checks++;
    const ha = A.hash(), hb = B.hash(), ho = O.hash();
    if (ha !== hb && badAB < 0) { badAB = t; console.log('  A/B mismatch at tick', t, ha, hb); }
    if (ha !== ho && badOA < 0) { badOA = t; console.log('  original/loaded mismatch at tick', t, ho, ha); }
  }
  if (A.over) break;
}
const after = snapshot(A);
ok(badAB < 0, `loaded copies (me 0 / me 1) equal at all ${checks} checks every 300 ticks` + (badAB >= 0 ? ' — first mismatch tick ' + badAB : ''));
ok(badOA < 0, 'loaded copy equals the original that never stopped' + (badOA >= 0 ? ' — first mismatch tick ' + badOA : ''));
ok(A.hash() === B.hash() && A.tick === B.tick, 'final hash A/B ' + A.hash() + ' / ' + B.hash() + ' at tick ' + A.tick);
ok(after.aiRs.every((r, i) => r !== before.aiRs[i]), 'AIs keep thinking after the load (rng advanced)');
ok(after.units[2] + after.blds[2] !== before.units[2] + before.blds[2] || after.res[2] !== before.res[2], 'AI 2 economy/army changed (units ' + before.units[2] + '->' + after.units[2] + ', bld ' + before.blds[2] + '->' + after.blds[2] + ')');
ok(after.res[3] !== before.res[3], 'AI 3 resources changed (' + Math.round(before.res[3]) + '->' + Math.round(after.res[3]) + ')');
ok(after.res[0] !== before.res[0] && after.res[1] !== before.res[1], 'human resources changed');
console.log('  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s wall; units', after.units.join('/'), 'buildings', after.blds.join('/'));
// a single-player save still round-trips (no mp, quests on)
const S = new Game({ mapSize: 96, seed: 5, enemies: 1 });
for (let t = 0; t < 900; t++) S.update(DT);
traceState(S);
const S2 = Game.deserialize(JSON.parse(JSON.stringify(S.serialize())));
ok(!S2.mp && S2.quests.list.length === S.quests.list.length && S2.hash() === S.hash(), 'single-player save still loads (quests ' + S2.quests.list.length + ', hash equal)');
console.log(fails.length ? 'FAILED: ' + fails.length : 'ALL OK');
process.exit(fails.length ? 1 : 0);

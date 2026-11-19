// Focused simulation/input save round-trip. Run: node test/save-load-test.mjs
import assert from 'node:assert/strict';
import { Input } from '../src/input.js';
import { Game } from '../src/sim/game.js';

const dt = 1 / 30;
function run(game, seconds) {
  for (let i = 0; i < seconds * 30; i++) game.update(dt);
}
const g = new Game({ mapSize: 96, seed: 9, enemies: 1, difficulty: 'easy', startRes: 'high', mapType: 'plains' });
const tc = g.buildingsOf(0).find(b => b.type === 'towncenter');

// Build up real production, research and quest state before taking the snapshot.
assert.equal(g.research(tc.id, 'basket'), true);
for (let i = 0; i < 5; i++) assert.equal(g.train(tc.id, 'villager'), true);
for (let i = 0; i < 5000; i++) {
  if (!tc.queue.length && g.quests.list.find(q => q.id === 'vill10')?.done) break;
  g.update(dt);
}
assert.equal(g.quests.list.find(q => q.id === 'vill10')?.done, true, 'fixture completed a quest');
assert.equal(g.quests.s.techs, 1, 'fixture counted the completed research');
assert.equal(g.train(tc.id, 'villager'), true);
assert.equal(g.research(tc.id, 'loom'), true);
run(g, 1);
assert.ok(tc.queue[0].t > 0 && tc.queue[0].t < tc.queue[0].total);
assert.deepEqual(tc.queue.map(q => q.kind), ['unit', 'tech']);

const ids = g.unitsOf(0).slice(0, 7).map(u => u.id);
assert.equal(ids.length, 7);
assert.equal(g.cmdMove(ids, tc.x + 9, tc.z + 9), true);
assert.equal(g.cmdMove(ids, tc.x - 9, tc.z + 9, true), true);
const [a, b] = ids.map(id => g.getEntity(id));
assert.ok(a.order.grp && a.queue[0]?.grp, 'fixture has current and queued group moves');

// Use actual Input methods without DOM listeners/WebGL. Existing tests cover the sim's
// controlGroups() API; this also checks reset → restore → recall, as used after loading.
const app = { game: g, selection: [...ids, tc.id], select(newIds) { this.selection = newIds; } };
const input = Object.assign(Object.create(Input.prototype), { app, groups: {}, box: { style: {} }, keys: new Set() });
assert.equal(input.setGroup(3), 8);
g.deleteEntity(ids.at(-1));
const wantedGroup = [...ids.slice(0, -1), tc.id];

const ai = g.ais[0].serialize();
assert.equal(ai.v, 2);
assert.ok(ai.exp?.length && ai.x && ai.bound, 'fixture has initialized AI state');
const json = JSON.stringify(g.serialize());
const loaded = Game.deserialize(json);
app.game = loaded; app.selection = [];
input.reset();
input.restoreGroups(loaded);
assert.deepEqual(app.selection, [], 'restoring groups does not restore the active selection');
assert.equal(input.recallGroup(3, false), true);
assert.deepEqual(app.selection, wantedGroup, 'loaded shortcut recalls surviving units and buildings');

const la = loaded.getEntity(a.id), lb = loaded.getEntity(b.id);
assert.deepEqual(la.order, a.order);
assert.deepEqual(la.queue, a.queue);
assert.equal(la.order.grp, lb.order.grp, 'active orders rejoin their shared movement group');
assert.equal(la.queue[0].grp, lb.queue[0].grp, 'queued orders rejoin their shared movement group');
assert.notEqual(la.order.grp, la.queue[0].grp, 'different commands remain different groups');

const ltc = loaded.getEntity(tc.id), player = loaded.players[0];
assert.deepEqual(ltc.queue, tc.queue, 'queue order and partial production progress survive');
assert.deepEqual(player.pending, ['loom']);
assert.deepEqual([...player.techs], ['basket']);
assert.equal(player.mods.carry, 5, 'completed tech modifier is recomputed');
assert.deepEqual(loaded.quests.serialize(), g.quests.serialize());
assert.deepEqual(loaded.quests.list.filter(q => q.active).map(q => q.id), g.quests.list.filter(q => q.active).map(q => q.id));
const lai = loaded.ais[0].serialize();
for (const key of ['rs', 'groups', 'mem', 'exp', 'scoutPts', 'nextScout', 'nextRaid', 'nextPush']) assert.deepEqual(lai[key], ai[key], `AI ${key} round-trips`);

// Verify that the restored queues can finish, not just that their fields deserialize.
for (let i = 0; i < 4000 && ltc.queue.length; i++) loaded.update(dt);
assert.deepEqual(ltc.queue, []);
assert.deepEqual(player.pending, []);
assert.equal(player.techs.has('loom'), true);
assert.equal(loaded.quests.s.techs, 2);

// Synthetic old-format fixture: older fields, not a claim about every historical release.
const legacy = JSON.parse(json);
legacy.map = { size: g.map.size, heights: [...g.map.heights], tiles: [...g.map.tiles], blocked: [...g.map.blocked] };
legacy.fog = [...g.fog];
delete legacy.fogR;
delete legacy.tv;
for (const p of legacy.players) delete p.cg;
legacy.ais[0] = { v: 1, waveCount: 7, nextWave: g.time + 1500, wave: { ids: [g.unitsOf(1)[0].id] }, scoutId: g.unitsOf(1)[0].id };
const legacyGame = Game.deserialize(JSON.stringify(legacy));
assert.deepEqual(legacyGame.map.heights, g.map.heights);
assert.deepEqual(legacyGame.map.tiles, g.map.tiles);
assert.equal(legacyGame.ais[0].pushN, 7);
assert.equal(legacyGame.ais[0].nextPush, g.time + 1500);
assert.deepEqual(legacyGame.ais[0].groups[0].ids, legacy.ais[0].wave.ids);
assert.equal(legacyGame.ais[0].scoutId, null, 'old scout route starts fresh');
app.game = legacyGame; input.reset(); input.restoreGroups(legacyGame);
assert.equal(input.recallGroup(3, false), false, 'legacy records without groups do not restore stale shortcuts');

console.log('OK: input group restore, active/queued orders, production, research, quests, AI and legacy save fields');

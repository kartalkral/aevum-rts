import { createHash } from 'node:crypto';

// Opt-in cross-version comparison. Clone before normalizing diagnostic timings:
// serialize() can return references to live objects.
export function traceState(game) {
  if (process.env.AEVUM_TRACE !== '1') return;
  const save = JSON.parse(JSON.stringify(game.serialize()));
  for (const ai of save.ais) {
    if (ai?.stats) ai.stats.ms = 0;
    if (ai?.x?.stats) ai.x.stats.ms = 0;
  }
  const digest = createHash('sha256').update(JSON.stringify(save)).digest('hex');
  console.log('TRACE', game.tick, game.hash(), game.rs, digest);
}

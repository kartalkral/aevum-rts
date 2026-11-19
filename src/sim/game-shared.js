// Pure rules and geometry shared by the simulation, AI and presentation.
import { BUILDINGS, TECHS, UNITS } from '../data.js';

// pacing: construction takes 1.6x and every production/research/age queue 1.5x longer (all players alike);
// since 2026-11-14 (owner meeting) everything is produced 20 % faster: both divided by 1.2
export const BUILD_TIME_MUL = 1.6 / 1.2;
export const QUEUE_TIME_MUL = 1.5 / 1.2;

// Line of sight (owner 2026-11-14: "always see who shoots at you"): soldiers, warships, towers and castles see at
// least 20 % further than the longest weapon range in the game (units with their best range techs, towers in the
// last age with every tower tech), so no shooter stands outside their sight. Villagers and other buildings keep theirs.
export const MAX_WEAPON_RANGE = (() => {
  let m = 0; const tr = {};
  for (const t of Object.values(TECHS)) if (t.fx && t.fx.range) for (const c in t.fx.range) tr[c] = (tr[c] || 0) + t.fx.range[c];
  for (const u of Object.values(UNITS)) if (u.atk > 0 && u.range > 0) m = Math.max(m, u.range + (tr[u.cls] || 0));
  let tw = 0; for (const t of Object.values(TECHS)) if (t.fx && t.fx.towerRange) tw += t.fx.towerRange;
  for (const b of Object.values(BUILDINGS)) if (b.atk > 0 && (b.id === 'tower' || b.id === 'castle')) m = Math.max(m, b.range + tw + (b.id === 'tower' ? 3 : 0));   // (tower: +1 per age from the Middle Age, see towerAgeBonus)
  return m;
})();
export const COMBAT_LOS = Math.ceil(MAX_WEAPON_RANGE * 1.2 * 10) / 10;
const LOS_U = {}; for (const [k, u] of Object.entries(UNITS)) LOS_U[k] = u.cls !== 'civil' && u.cls !== 'train' && u.atk > 0 ? Math.max(u.los, COMBAT_LOS) : u.los;
// sight radius of a unit type (shared by the fog, the AI's vision and the view)
export const unitLos = (type) => LOS_U[type] || 0;
// sight radius of a finished building from its centre (an unfinished one sees nothing)
export const buildingLos = (b, p) => { const d = BUILDINGS[b.type]; const r = d.los + (p && p.mods ? p.mods.blos : 0) + towerAgeBonus(b.type, p ? p.age : 0) + b.size / 2; return b.type === 'tower' || b.type === 'castle' ? Math.max(r, COMBAT_LOS + b.size / 2) : r; };
// towers hit harder every age (+5 attack per age since playtest 2 (was +3); other attacking buildings +1)
export const TOWER_AGE_ATK = 5;

// towers see and shoot farther every age after the Bronze Age (+1 tile per age: 7 -> 10 in the Industrial Age)
export const TOWER_AGE_RANGE = 1;
export const towerAgeBonus = (type, age) => (type === 'tower' ? Math.max(0, (age | 0) - 1) * TOWER_AGE_RANGE : 0);

// calls f(start, end) for every row span (flat indices, end exclusive) of the tiles whose centres lie within r of (x, z)
export function forDisc(N, x, z, r, f) {
  const r2 = r * r, z0 = Math.max(0, Math.ceil(z - 0.5 - r)), z1 = Math.min(N - 1, Math.floor(z - 0.5 + r));
  for (let tz = z0; tz <= z1; tz++) {
    const dz = tz + 0.5 - z, h2 = r2 - dz * dz; if (h2 < 0) continue;
    const h = Math.sqrt(h2), a = Math.max(0, Math.ceil(x - 0.5 - h)), b = Math.min(N - 1, Math.floor(x - 0.5 + h));
    if (a <= b) f(tz * N + a, tz * N + b + 1);
  }
}

export function makeMap(size, heights, tiles, blocked) {
  const N = size, V = N + 1;
  return {
    size: N, heights, tiles, blocked,
    heightAt(x, z) {
      x = Math.min(Math.max(x, 0), N - 0.0001); z = Math.min(Math.max(z, 0), N - 0.0001);
      const x0 = x | 0, z0 = z | 0, fx = x - x0, fz = z - z0, i = z0 * V + x0;
      const a = heights[i], b = heights[i + 1], c = heights[i + V], d = heights[i + V + 1];
      return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
    },
    isWalkable(tx, tz) {
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false;
      const i = tz * N + tx, t = tiles[i];
      if (t === 4 || t === 5) return false;
      const b = blocked[i];
      return b === 0 || b === 2 || b === 3;
    },
  };
}

// Shared AI units, resource order and pure calculations.
export const MIN = 60;
export const RK = ['food', 'wood', 'gold', 'stone'];
export const MIL_B = ['barracks', 'archery', 'stable', 'siege', 'factory'];
export function d2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
export function costSum(c) { let s = 0; if (c) for (const k in c) s += c[k] || 0; return s; }

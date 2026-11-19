// Shared presentation data, formatting and DOM helpers.
import { RES_ICONS } from '../icons.js';

export const RES_LIST = ['food', 'wood', 'stone', 'gold'];
export const RES_ICON = RES_ICONS;
export const RES_NAME = { food: 'Yiyecek', wood: 'Odun', stone: 'Taş', gold: 'Altın' };
export const MM = 220;
// map climates (view only, src/render/renderer.js CLIMATES); 'random' is picked from the map seed
export const CLIMATE_OPTS = [['random', 'Rastgele'], ['temperate', 'Ilıman'], ['spring', 'İlkbahar'], ['autumn', 'Sonbahar'], ['winter', 'Kış'], ['arid', 'Kurak']];
// map types (must match the generator's cfg.mapType values; 'random' is resolved by the simulation)
export const MAP_TYPES = [['random', 'Rastgele'], ['river', 'Nehir Vadisi'], ['continent', 'Kıta'], ['highlands', 'Yaylalar'], ['plains', 'Ovalar'], ['inlandsea', 'İç Deniz'], ['islands', 'Adalar']];
export const MAP_TYPE_TR = Object.fromEntries(MAP_TYPES);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
export const safe = (fn, def) => { try { return fn(); } catch (err) { return def; } };
export const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return (m < 10 ? '0' : '') + m + ':' + String(s % 60).padStart(2, '0'); };
export const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');

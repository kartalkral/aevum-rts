// Aevum audio manager. Web Audio API, real recorded samples only (see assets/sfx/LICENSES.md).
// Never throws: missing files / missing AudioContext simply result in silence.

const BASE = 'assets/sfx/';

// Logical sound -> { files, vol, cat, minGap (s), pitch (+- fraction), range (world tiles, 0 = non positional) }
const SOUNDS = {
  // gathering
  // (chop2 / chop3 were dropped 2026-11-13: hissy recordings, most of their energy above 4 kHz - the owner's "gırç gırç")
  chop:      { files: ['chop1'], vol: 0.34, minGap: 0.3, range: 34, pitch: 0.1 },
  pick:      { files: ['thud1', 'thud2', 'thud3'], vol: 0.2, minGap: 0.5, range: 30, rate: 0.85 },
  rustle:    { files: ['rustle1', 'rustle2', 'rustle3'], vol: 0.3, minGap: 0.3, range: 28 },
  deposit:   { files: ['coins1', 'coins2'], vol: 0.05, minGap: 1.5, range: 26 },
  // building
  // (2026-11-13: solid wooden knocks; hammer1-3 were creaky door-close recordings, the owner's "gırç" while building)
  hammer:    { files: ['tool_hit1', 'arrow_wood1', 'arrow_wood2', 'bld_hit2'], vol: 0.66, minGap: 0.12, range: 36, pitch: 0.08 },
  buildDone: { files: ['hammer4', 'bld_hit2'], vol: 0.72, minGap: 0.3, range: 60 },   // (latch: a hissy metal latch, dropped)
  treeFall:  { files: ['creak1', 'creak2'], vol: 0.6, minGap: 0.3, range: 40 },
  // combat (real recordings, see LICENSES.md). combat: 1 = shares the MAX_COMBAT voice cap, 2 = big one-shot (counted, never dropped by the cap)
  // melee contact, picked by attacker / target in attach()
  swordClash:  { files: ['sword_clash1', 'sword_clash2', 'sword_clash3', 'sword_clash4', 'sword_clash5', 'sword_clash6'], vol: 0.6, minGap: 0.09, range: 40, pitch: 0.05, combat: 1 },
  heavyClang:  { files: ['heavy_clang1', 'heavy_clang2', 'heavy_clang3'], vol: 0.62, minGap: 0.09, range: 42, pitch: 0.05, combat: 1 },
  spearHit:    { files: ['spear_hit1', 'spear_hit2', 'spear_hit3'], vol: 0.58, minGap: 0.09, range: 40, pitch: 0.05, combat: 1 },
  armorHit:    { files: ['armor_hit1', 'armor_hit2', 'armor_hit3'], vol: 0.45, minGap: 0.09, range: 40, pitch: 0.05, combat: 1 },
  fleshHit:    { files: ['flesh_hit1', 'flesh_hit2', 'flesh_hit3'], vol: 0.55, minGap: 0.09, range: 38, pitch: 0.05, combat: 1 },
  cavHit:      { files: ['cav_hit1', 'cav_hit2'], vol: 0.6, minGap: 0.09, range: 42, pitch: 0.05, combat: 1 },
  toolHit:     { files: ['tool_hit1', 'tool_hit2', 'tool_hit3'], vol: 0.5, minGap: 0.09, range: 36, pitch: 0.05, combat: 1 },
  bldHit:      { files: ['bld_hit1', 'bld_hit2'], vol: 0.5, minGap: 0.09, range: 40, pitch: 0.05, combat: 1 },
  ram:         { files: ['ram_hit1', 'ram_hit2'], vol: 0.75, minGap: 0.15, range: 48, pitch: 0.05, rate: 0.92, combat: 1 },
  // ranged release
  bow:         { files: ['bow_shot1', 'bow_shot2', 'bow_shot3'], vol: 0.42, minGap: 0.06, range: 38, pitch: 0.05, combat: 1 },
  crossbow:    { files: ['xbow_shot1'], vol: 0.45, minGap: 0.06, range: 40, pitch: 0.05, combat: 1 },
  musket:      { files: ['musket1', 'musket2', 'musket3'], vol: 0.5, minGap: 0.08, range: 58, pitch: 0.05, combat: 1 },
  rifle:       { files: ['rifle1', 'rifle2', 'rifle3'], vol: 0.45, minGap: 0.08, range: 58, pitch: 0.05, combat: 1 },
  cannon:      { files: ['cannon_shot1'], vol: 0.75, minGap: 0.15, range: 75, pitch: 0.05, combat: 2 },
  catapult:    { files: ['catapult1', 'catapult2'], vol: 0.6, minGap: 0.15, range: 50, pitch: 0.05, combat: 1 },
  // projectile impacts
  arrowWood:   { files: ['arrow_wood1', 'arrow_wood2'], vol: 0.4, minGap: 0.06, range: 34, pitch: 0.05, combat: 1 },
  arrowFlesh:  { files: ['arrow_flesh1', 'arrow_flesh2'], vol: 0.45, minGap: 0.06, range: 34, pitch: 0.05, combat: 1 },
  stoneCrash:  { files: ['stone_crash1', 'stone_crash2'], vol: 0.65, minGap: 0.12, range: 60, pitch: 0.05, combat: 2 },
  explosion:   { files: ['explode1', 'explode2', 'explode3'], vol: 0.75, minGap: 0.15, range: 75, pitch: 0.05, combat: 2 },
  // deaths
  death:       { files: ['death_grunt1', 'death_grunt2', 'death_grunt3', 'death_grunt4'], vol: 0.45, minGap: 0.15, range: 36, pitch: 0.05, combat: 1 },
  shipSink:    { files: ['ship_sink1', 'ship_sink2'], vol: 0.7, minGap: 0.5, range: 70, pitch: 0.05, combat: 2 },
  collapseSmall: { files: ['collapse_small'], vol: 0.7, minGap: 0.3, range: 65, pitch: 0.05, combat: 2 },
  collapseLarge: { files: ['collapse_large'], vol: 0.8, minGap: 0.4, range: 75, pitch: 0.05, combat: 2 },
  fire:      { files: ['fire1'], vol: 0.4, minGap: 1.0, range: 40 },
  // production / progress
  trained:   { files: ['equip1', 'equip2'], vol: 0.45, minGap: 0.3, range: 50 },
  researched:{ files: ['k_bell'], vol: 0.5, minGap: 0.5, range: 0 },
  quest:     { files: ['k_cash'], vol: 0.55, minGap: 0.5, range: 0 },
  questBell: { files: ['bells'], vol: 0.4, minGap: 0.5, range: 0 },
  ageHorn:   { files: ['horn_age'], vol: 0.9, minGap: 2, range: 0, pitch: 0 },
  ageRiser:  { files: ['k_riser'], vol: 0.5, minGap: 2, range: 0, pitch: 0 },
  ageBoom:   { files: ['impact_big', 'k_boom'], vol: 0.8, minGap: 2, range: 0, pitch: 0 },
  enemyAge:  { files: ['horn_alarm'], vol: 0.3, minGap: 5, range: 0, rate: 0.85 },
  // under attack (owner 2026-11-14: not noticed): the low horn blown twice at full level over a deep drum boom
  alarm:     { files: ['horn_alarm'], vol: 1.0, minGap: 8, range: 0, pitch: 0 },
  alarm2:    { files: ['horn_alarm'], vol: 0.85, minGap: 8, range: 0, pitch: 0, rate: 0.94 },
  alarmDrum: { files: ['k_boom'], vol: 0.6, minGap: 8, range: 0, pitch: 0 },
  gameWon:   { files: ['horn_end'], vol: 0.9, minGap: 5, range: 0, pitch: 0 },
  gameLost:  { files: ['horn_end'], vol: 0.9, minGap: 5, range: 0, pitch: 0, rate: 0.8 },
  notify:    { files: ['k_hud'], vol: 0.3, minGap: 0.6, range: 0 },
  trade:     { files: ['k_coin', 'coins1'], vol: 0.5, minGap: 0.15, range: 0 },
  birds:     { files: ['birds_takeoff'], vol: 0.25, minGap: 8, range: 0 },
  step:      { files: ['step1', 'step2', 'step3'], vol: 0.2, minGap: 0.12, range: 22 },
  // ships / railway (existing files only, quiet and rate limited)
  board:     { files: ['step1', 'step2', 'step3'], vol: 0.14, minGap: 0.35, range: 24 },
  trainCoin: { files: ['coins2'], vol: 0.12, minGap: 5, range: 40 },
  // interface
  ui_click:  { files: ['k_dclick', 'dclick7', 'k_dclick', 'dclick8', 'k_dclick', 'dclick1'], vol: 0.5, minGap: 0.04, range: 0, cat: 'ui', rotate: true, pitch: 0.02 },
  ui_select: { files: ['k_tick'], vol: 0.2, minGap: 0.15, range: 0, cat: 'ui' },
  ui_command:{ files: ['k_dclick', 'dclick7', 'k_dclick', 'dclick8', 'k_dclick', 'dclick1'], vol: 0.2, minGap: 0.18, rotate: true, pitch: 0.02, range: 0, cat: 'ui' },
  ui_error:  { files: ['mclick'], vol: 0.6, minGap: 0.15, range: 0, cat: 'ui', rate: 0.75 },
  // laying a foundation (owner 2026-11-13: "güzel bir ses"): a deep thud, then earth and gravel settling (see ui())
  ui_place:  { files: ['k_hit'], vol: 0.62, minGap: 0.1, range: 0, cat: 'ui', pitch: 0.04 },
  ui_placeGravel: { files: ['stone_crash2'], vol: 0.3, minGap: 0.1, range: 0, cat: 'ui', rate: 0.82, pitch: 0.05 },
  ui_chat:   { files: ['dclick7'], vol: 0.8, minGap: 0.25, range: 0, cat: 'ui', rate: 1.12 },   // incoming chat line
};

// (wind removed 2026-11-13: the owner did not want the constant wind bed - its crackle was the "gırç" too)
const AMBIENT = { water: 'amb_water' };
const CATS = ['master', 'sfx', 'ambient', 'ui'];
const DEFAULT_VOL = { master: 0.8, sfx: 0.9, ambient: 0.5, ui: 0.7 };
const LS_KEY = 'aevum.volume';
const MAX_VOICES = 14;
const MAX_COMBAT = 6;   // simultaneous small combat voices (combat: 1); a big fight reads as a battle, not noise

const CANNON_UNITS = { cannon: 1, artillery: 1, galleon: 1, ironclad: 1 };
const CAV_UNITS = { lightcav: 1, knight: 1, cuirassier: 1 };
const SIEGE_UNITS = { ram: 1, catapult: 1, cannon: 1, artillery: 1, train: 1 };
// unarmoured / lightly armoured targets: melee on them sounds like a body hit, not steel on steel
const SOFT_UNITS = { villager: 1, archer: 1, crossbow: 1, tradecart: 1, musketeer: 1 };
// the only sounds played while the tab is hidden (the game keeps running there): alerts, not the battle itself
const BACKGROUND_SOUNDS = { alarm: 1, alarm2: 1, alarmDrum: 1, notify: 1, gameWon: 1, gameLost: 1 };

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.gains = {};
    this.volumes = Object.assign({}, DEFAULT_VOL);
    this.listener = { x: 0, z: 0, dist: 40 };
    this.lastPlay = {};
    this.rot = {};
    this.voices = 0;
    this.cVoices = 0;
    this.lastFile = {};
    this.game = null;
    this._subs = [];
    this._amb = {};
    this._ambStarted = false;
    this._ambTimer = null;
    this._ready = false;
    this.background = false;
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(LS_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        for (const c of CATS) if (typeof o[c] === 'number') this.volumes[c] = Math.min(1, Math.max(0, o[c]));
      }
    } catch (e) { /* ignore */ }
  }

  async init() {
    try {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.gains.master = ctx.createGain();
      // Gentle limiter so big moments (age up, explosions) do not clip.
      let out = ctx.destination;
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -10; comp.knee.value = 12; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.2;
        comp.connect(ctx.destination);
        out = comp;
      } catch (e) { /* ignore */ }
      this.gains.master.connect(out);
      for (const c of ['sfx', 'ambient', 'ui']) {
        this.gains[c] = ctx.createGain();
        this.gains[c].connect(this.gains.master);
      }
      for (const c of CATS) this.gains[c].gain.value = this.volumes[c];

      const names = new Set();
      for (const k in SOUNDS) for (const f of SOUNDS[k].files) names.add(f);
      for (const k in AMBIENT) names.add(AMBIENT[k]);
      await Promise.all([...names].map((n) => this._load(n)));
      this._ready = true;
      if (this._wantAmbient) this._startAmbient();
    } catch (e) {
      // never throw
    }
  }

  async _load(name) {
    try {
      const res = await fetch(BASE + name + '.mp3');
      if (!res.ok) return;
      const arr = await res.arrayBuffer();
      const buf = await new Promise((ok, fail) => {
        try {
          const p = this.ctx.decodeAudioData(arr, ok, fail);
          if (p && p.then) p.then(ok, fail);
        } catch (e) { fail(e); }
      });
      if (buf) this.buffers.set(name, buf);
    } catch (e) { /* missing file: silent */ }
  }

  resume() {
    try {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
      this._wantAmbient = true;
      if (this._ready) this._startAmbient();
    } catch (e) { /* ignore */ }
  }

  setVolume(cat, v) {
    try {
      if (!CATS.includes(cat)) return;
      v = Math.min(1, Math.max(0, +v || 0));
      this.volumes[cat] = v;
      if (this.gains[cat] && this.ctx) this.gains[cat].gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.volumes)); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  getVolume(cat) { return CATS.includes(cat) ? this.volumes[cat] : 0; }

  setListener(x, z, dist) {
    this.listener.x = +x || 0;
    this.listener.z = +z || 0;
    if (dist > 0) this.listener.dist = dist;
    this._updateAmbient();
  }

  ui(name) {
    this.play('ui_' + name);
    if (name === 'place') setTimeout(() => this.play('ui_placeGravel'), 70);   // (the gravel layer of the foundation sound)
  }

  // tab hidden: only BACKGROUND_SOUNDS play (a battle running in a background tab must not spam the speakers)
  setBackground(b) { this.background = !!b; }

  // play(name, {x, z, vol, rate}) ; positional when x/z given and the sound has a range.
  play(name, opts) {
    try {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return false;
      const def = SOUNDS[name];
      if (!def) return false;
      if (this.background && !BACKGROUND_SOUNDS[name]) return false;
      const now = ctx.currentTime;
      const last = this.lastPlay[name];
      if (last !== undefined && now - last < (def.minGap || 0.08)) return false;

      let vol = def.vol * (opts && opts.vol !== undefined ? opts.vol : 1);
      let pan = 0;
      const cat = def.cat || 'sfx';
      const positional = def.range > 0 && opts && typeof opts.x === 'number' && typeof opts.z === 'number';
      if (positional) {
        const L = this.listener;
        const dx = opts.x - L.x, dz = opts.z - L.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        // Zoomed out -> the audible radius grows a little but everything gets quieter.
        const range = def.range + L.dist * 0.5;
        if (d > range) return false;
        const fall = 1 - d / range;
        const zoom = Math.min(1.15, Math.max(0.3, 34 / (L.dist + 10)));
        vol *= fall * fall * zoom;
        pan = Math.max(-0.85, Math.min(0.85, dx / Math.max(12, L.dist * 0.9)));
        if (vol < 0.012) return false;
      }
      if (cat === 'sfx' && this.voices >= MAX_VOICES && vol < 0.5) return false;
      if (def.combat === 1 && this.cVoices >= MAX_COMBAT) return false;

      let file;
      if (def.rotate) {
        const i = this.rot[name] || 0;
        file = def.files[i % def.files.length];
        this.rot[name] = i + 1;
      } else {
        // random pick among the loaded variants (combat: never the same variant twice in a row)
        let avail = def.files.filter((f) => this.buffers.has(f));
        if (!avail.length) return false;
        if (def.combat && avail.length > 1) avail = avail.filter((f) => f !== this.lastFile[name]);
        file = avail[(Math.random() * avail.length) | 0];
        this.lastFile[name] = file;
      }
      const buf = this.buffers.get(file);
      if (!buf) return false;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      const p = def.pitch !== undefined ? def.pitch : 0.06;
      src.playbackRate.value = (def.rate || 1) * (opts && opts.rate ? opts.rate : 1) * (1 + (Math.random() * 2 - 1) * p);
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g);
      let tail = g;
      if (pan !== 0 && ctx.createStereoPanner) {
        const pn = ctx.createStereoPanner();
        pn.pan.value = pan;
        g.connect(pn);
        tail = pn;
      }
      tail.connect(this.gains[cat]);
      this.voices++;
      const cv = !!def.combat;
      if (cv) this.cVoices++;
      src.onended = () => { this.voices = Math.max(0, this.voices - 1); if (cv) this.cVoices = Math.max(0, this.cVoices - 1); try { tail.disconnect(); } catch (e) { /* */ } };
      src.start(opts && opts.delay ? now + opts.delay : now);
      this.lastPlay[name] = now;
      return true;
    } catch (e) { return false; }
  }

  // ---------- ambient bed ----------
  _startAmbient() {
    try {
      if (this._ambStarted || !this.ctx) return;
      this._ambStarted = true;
      const mk = (key, vol) => {
        const buf = this.buffers.get(AMBIENT[key]);
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(vol, this.ctx.currentTime, 1.5);
        src.connect(g); g.connect(this.gains.ambient);
        src.start();
        this._amb[key] = { src, g, vol };
      };
      // (no wind bed: owner decision 2026-11-13)
      mk('water', 0);
      // occasional real bird recording
      const birdLoop = () => {
        try {
          if (this.game && !this.game.over && this._waterFrac < 0.6) this.play('birds', { vol: 0.6 + Math.random() * 0.4 });
        } catch (e) { /* */ }
        this._ambTimer = setTimeout(birdLoop, 14000 + Math.random() * 22000);
      };
      this._ambTimer = setTimeout(birdLoop, 6000);
    } catch (e) { /* ignore */ }
  }

  _updateAmbient() {
    try {
      if (!this.ctx || !this._ambStarted) return;
      const now = this.ctx.currentTime;
      if (this._ambT !== undefined && now - this._ambT < 0.4) return;
      this._ambT = now;
      let frac = 0;
      const map = this.game && this.game.map;
      if (map && map.tiles) {
        const N = map.size, L = this.listener;
        let n = 0, w = 0;
        const r = 8;
        for (let dz = -r; dz <= r; dz += 2) for (let dx = -r; dx <= r; dx += 2) {
          const tx = Math.floor(L.x) + dx, tz = Math.floor(L.z) + dz;
          if (tx < 0 || tz < 0 || tx >= N || tz >= N) continue;
          n++;
          const t = map.tiles[tz * N + tx];
          if (t === 3 || t === 4) w++;
        }
        frac = n ? w / n : 0;
      }
      this._waterFrac = frac;
      const zoom = Math.min(1, Math.max(0.25, 40 / (this.listener.dist + 10)));
      const wa = this._amb.water, wi = this._amb.wind;
      if (wa) wa.g.gain.setTargetAtTime(Math.min(0.8, frac * 1.6) * zoom, now, 0.6);
      // more wind when zoomed far out
      if (wi) wi.g.gain.setTargetAtTime(0.3 + 0.4 * (1 - zoom), now, 0.8);
    } catch (e) { /* ignore */ }
  }

  // ---------- game binding ----------
  _audible(x, z, e) {
    try {
      const g = this.game;
      if (!g) return false;
      if (e && this._isAllyOwner(e.owner)) return true;
      if (e && e.kind === 'unit' && typeof g.isEntityVisible === 'function') return !!g.isEntityVisible(e);
      const map = g.map, fog = g.fog;
      if (!map || !fog) return true;
      const N = map.size;
      const tx = Math.floor(x), tz = Math.floor(z);
      if (tx < 0 || tz < 0 || tx >= N || tz >= N) return false;
      return fog[tz * N + tx] >= 1;
    } catch (err) { return true; }
  }

  // local player id (multiplayer: game.me; single-player: 0)
  _me() { const g = this.game; return g && g.me != null ? g.me : 0; }
  _isMine(owner) { return owner === this._me(); }
  // own or allied (same team) owner; falls back to own-only when the game has no team API
  _isAllyOwner(owner) {
    const g = this.game, me = this._me();
    if (owner === me) return true;
    if (owner == null || owner < 0) return false;
    try { if (g && typeof g.isAlly === 'function') return !!g.isAlly(me, owner); } catch (err) { /* */ }
    return false;
  }

  _at(name, e, vol) {
    if (!e || typeof e.x !== 'number') return;
    if (!this._audible(e.x, e.z, e)) return;
    this.play(name, { x: e.x, z: e.z, vol: vol === undefined ? 1 : vol });
  }

  // melee contact sound group for attacker -> target
  _meleeGroup(attacker, target) {
    const at = attacker.type;
    if (target && target.kind === 'building') return 'bldHit';
    const soft = !target || SOFT_UNITS[target.type];
    const r = Math.random();
    if (CAV_UNITS[at]) {
      if (soft || r < 0.45) return 'cavHit';
      return at === 'lightcav' ? 'swordClash' : 'heavyClang';
    }
    if (soft && r < 0.7) return 'fleshHit';
    if (!soft && r < 0.2) return 'armorHit';   // shield / armour block
    if (at === 'spearman') return 'spearHit';
    if (at === 'heavyinf') return 'heavyClang';
    return 'swordClash';
  }

  attach(game) {
    try {
      // unsubscribe from the previous game
      if (this.game && this.game.events && this.game.events.off) {
        for (const [n, fn] of this._subs) { try { this.game.events.off(n, fn); } catch (e) { /* */ } }
      }
      this._subs = [];
      this.game = game;
      if (!game || !game.events || !game.events.on) return;
      const on = (name, fn) => {
        const safe = (p) => { try { fn(p || {}); } catch (e) { /* never break the sim */ } };
        game.events.on(name, safe);
        this._subs.push([name, safe]);
      };

      on('gatherTick', ({ unit, res }) => {
        if (res === 'fish' || unit?.type === 'fishboat' || unit?.naval) return; // no short water sound in assets/sfx
        // food (farms, berries, hunting) is silent: the 'rustle' cloth swish on every farmer's tick was the endless "gırç gırç" (2026-11-13)
        if (res !== 'wood' && res !== 'stone' && res !== 'gold') return;
        const n = res === 'wood' ? 'chop' : 'pick';
        this._at(n, unit);
      });
      on('deposit', ({ unit, owner, res }) => {
        if (!this._isMine(owner)) return;
        this._at('deposit', unit, res === 'gold' ? 1.3 : 1);
      });
      on('board', ({ unit, transport }) => { this._at('board', unit || transport); });
      on('unload', ({ transport }) => { if (transport) this._at('board', transport, 0.9); });
      on('trainArrive', ({ e, station }) => { if (this._isMine((e || station)?.owner)) this._at('trainCoin', station || e); });
      on('buildStart', ({ e }) => { this._at('hammer', e, 1.2); });
      on('buildTick', ({ unit }) => { this._at('hammer', unit); }); // every second per working builder (construction and repair)
      on('buildComplete', ({ e }) => { this._at('buildDone', e); });
      on('treeFelled', ({ e }) => { this._at('treeFall', e); });
      // (farm harvest: silent too, see gatherTick)

      on('attack', ({ attacker, target, ranged }) => {
        if (!attacker) return;
        if (attacker.kind === 'unit' && attacker.anim === 'build') { this._at('hammer', attacker); return; }
        const t = attacker.type;
        if (ranged) {
          let n = 'bow';
          if (attacker.kind === 'building') {   // castles shoot bolts; towers arrows, cannonballs from the Gunpowder Age on
            const age = this.game && this.game.players && this.game.players[attacker.owner] ? this.game.players[attacker.owner].age | 0 : 0;
            n = t === 'castle' ? 'crossbow' : t === 'tower' && age >= 3 ? 'cannon' : 'bow';
          }
          else if (CANNON_UNITS[t]) n = 'cannon';
          else if (t === 'musketeer') n = 'musket';
          else if (t === 'rifleman') n = 'rifle';
          else if (t === 'catapult') n = 'catapult';
          else if (t === 'crossbow') n = 'crossbow';
          this._at(n, attacker);
        } else if (t === 'ram') {
          this._at('ram', target || attacker);
        } else if (t === 'villager') {
          this._at('toolHit', target || attacker, 0.85);
        } else {
          // melee weapon contact: the sim applies the damage right after this event, so play it here (attacker type is known)
          this._at(this._meleeGroup(attacker, target), target || attacker);
        }
      });
      on('hit', ({ target, x, z, proj }) => {
        if (!proj) return;   // melee contact already played on 'attack'
        const px = typeof x === 'number' ? x : target && target.x;
        const pz = typeof z === 'number' ? z : target && target.z;
        if (typeof px !== 'number' || typeof pz !== 'number') return;
        if (!this._audible(px, pz, target && target.kind === 'unit' ? target : null)) return;
        const unitHit = target && target.kind === 'unit' && !target.naval;
        let n, vol = 1;
        if (proj === 'arrow') { n = unitHit ? 'arrowFlesh' : 'arrowWood'; if (!target) vol = 0.6; }
        else if (proj === 'bullet') { n = unitHit ? 'arrowFlesh' : 'arrowWood'; vol = 0.6; }
        else if (proj === 'stone') n = 'stoneCrash';
        else if (proj === 'cannonball') n = 'explosion';
        else return;
        this.play(n, { x: px, z: pz, vol });
      });
      on('death', ({ e }) => {
        if (!e) return;
        if (e.kind === 'building') { this._at((e.size || 2) >= 3 ? 'collapseLarge' : 'collapseSmall', e); return; }
        if (e.kind === 'unit') {
          if (e.naval) this._at('shipSink', e);
          else if (SIEGE_UNITS[e.type]) this._at('collapseSmall', e, 0.7);
          else this._at('death', e);   // no CC0 horse recording: cavalry riders use the human grunts
        }
      });

      on('trained', ({ e, building }) => { if (e && this._isMine(e.owner)) this._at('trained', building || e); });
      on('researched', ({ owner }) => { if (this._isMine(owner)) this.play('researched'); });
      on('ageUpStart', ({ owner }) => { if (this._isMine(owner)) this.play('ageRiser', { vol: 0.7 }); });
      on('ageUp', ({ owner, dev }) => {
        if (this._isMine(owner) && !dev) {
          this.play('ageRiser');
          this.play('ageHorn', { delay: 0.5 });
          this.play('ageBoom', { delay: 1.9 });
        } else if (this._isAllyOwner(owner)) {
          // ally aged up: soft positive cue (existing 'bells' mapping, quiet)
          this.play('questBell', { vol: 0.5 });
        } else {
          this.play('enemyAge');
        }
      });
      on('questDone', () => { this.play('quest'); this.play('questBell', { delay: 0.25 }); });
      on('underAttack', () => { this.play('alarm'); });   // (one horn, 2026-11-17: the three-part alarm was too much)
      on('notify', ({ type, text }) => { if (type === 'warn' && text !== 'Saldırı altındasın!') this.play('notify'); });   // (the attack has its own alarm)
      on('gameOver', ({ won }) => { this.play(won ? 'gameWon' : 'gameLost'); });
    } catch (e) { /* never throw */ }
  }
}

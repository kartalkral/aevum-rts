// Aevum UI: main menu, HUD, minimap, tooltips, overlays. DOM only, no three.js.
import { menuMethods } from './ui-menus.js';
import { installMethods } from '../method-table.js';
import { RES_LIST, RES_ICON, RES_NAME, MM, MAP_TYPE_TR, esc, el, safe, fmtTime, hex } from './ui-shared.js';
import { AGES, UNITS, BUILDINGS, TECHS, PLAYER_COLORS } from '../data.js';
import { BUILD_TIME_MUL, QUEUE_TIME_MUL, TOWER_AGE_ATK, towerAgeBonus } from '../sim/game.js';
import { ico, applyIcons, keepIcons, stripIcons, CAT_ICONS, NATURE_ICONS } from '../icons.js';

// developer mode (a sandbox game: no TP, no match history): offered on a local dev server, or with ?dev=1 in the URL
applyIcons();

const BARTER_RES = ['food', 'wood', 'stone'];   // (gold has the Sat / Al buttons)
const STATE_TR = { idle: 'Boşta', move: 'Yürüyor', gather: 'Topluyor', return: 'Taşıyor', build: 'İnşa ediyor', attack: 'Saldırıyor', dead: 'Öldü' };
const CLS_TR = { civil: 'Sivil', infantry: 'Piyade', ranged: 'Menzilli', cavalry: 'Süvari', siege: 'Kuşatma', ship: 'Gemi', train: 'Tren' };
const NATURE = {
  tree: { name: 'Ağaç', icon: NATURE_ICONS.tree, res: 'wood' }, stone: { name: 'Taş Ocağı', icon: NATURE_ICONS.stone, res: 'stone' },
  gold: { name: 'Altın Madeni', icon: NATURE_ICONS.gold, res: 'gold' }, berries: { name: 'Böğürtlen Çalısı', icon: NATURE_ICONS.berries, res: 'food' },
  deer: { name: 'Geyik', icon: NATURE_ICONS.deer, res: 'food' },
  fish: { name: 'Balık Sürüsü', icon: NATURE_ICONS.fish, res: 'food' },
};
const HOTKEYS = 'QERTYFGHJKZXCVB'; // W/A/S/D are camera-only (never a card slot)
const BUILD_CATS = {
  eco: { name: 'Ekonomi', icon: CAT_ICONS.eco, desc: 'Ekonomi binaları: tarla, depo, pazar...', list: ['towncenter', 'farm', 'lumbercamp', 'minecamp', 'storage', 'market', 'temple', 'university', 'bank', 'factory', 'dock', 'pasture'] },
  mil: { name: 'Askeri', icon: CAT_ICONS.mil, desc: 'Askeri binalar: kışla, okçuluk, ahır...', list: ['barracks', 'archery', 'stable', 'blacksmith', 'siege', 'castle', 'academy'] },
  def: { name: 'Savunma', icon: CAT_ICONS.def, desc: 'Savunma yapıları: kule ve sur. Kapı, sur seçilince "Kapı Aç" ile açılır.', list: ['tower', 'wall'] },
  tra: { name: 'Ulaşım', icon: CAT_ICONS.tra, desc: 'Ulaşım: istasyon ve demir yolu (Sanayi Çağı).', list: ['station', 'rail'] },
};
const CAT_TR = { eco: 'Ekonomi', mil: 'Askeri', def: 'Savunma', tra: 'Ulaşım' };
const CAT_ICON = CAT_ICONS;
const TILE_COL = [[79, 125, 58], [91, 74, 46], [201, 183, 122], [74, 163, 199], [31, 95, 150], [119, 115, 108], [47, 90, 44]];
const FLARE_MS = 7000;
const CARD_GUARD_MS = 350;   // after the command card switches page, clicks / hover on it wait this long
const ATTACK_TEXT = 'Saldırı altındasın!';   // the sim's notify text for underAttack (the attack banner shows it instead of a toast)
const ATTACK_MS = 4000;  // how long the attack banner stays
const DIR_TR = ['doğusunda', 'güneydoğusunda', 'güneyinde', 'güneybatısında', 'batısında', 'kuzeybatısında', 'kuzeyinde', 'kuzeydoğusunda'];   // how long a map flare stays on the minimap


export class UI {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('ui');
    this.sel = [];
    this.page = 'root';
    this.cardSig = null;
    this.selSig = null;
    this.questSig = null;
    this.buttons = [];
    this.acc = 0; this.mmAcc = 0;
    this.frames = 0; this.fpsT = 0;
    this.lastRes = {};
    this.pings = [];
    this.questDoneAt = new Map();
    this.qdir = new WeakMap();
    this.lastAttackToast = -99;
    this.mode = 'menu';
    this.gameOverShown = false;
    this.settings = this._loadSettings();
    this.setup = { mapSize: 320, mapType: 'random', climate: 'random', enemies: 1, difficulty: 'normal', startRes: 'normal', startAge: 0, fog: 'explored' };
    this._build();
    this._applySettings();
  }

  get game() { return this.app.game; }
  _me() { return this.app.game?.me ?? 0; }
  _ally(a, b) { const g = this.app.game; if (a == null || b == null || a < 0 || b < 0) return false; const r = safe(() => g?.isAlly?.(a, b), undefined); return r === undefined ? a === b : !!r; }
  _pname(pid) { const g = this.app.game, p = g?.players?.[pid]; if (!p) return 'Oyuncu ' + pid; if (p.name) return p.name; if (pid === this._me()) return 'Sen'; return (p.kind === 'human' ? 'Oyuncu ' : 'Yapay Zekâ ') + (pid + 1); }
  _teamOf(pid) { const g = this.app.game; return safe(() => g?.teamOf?.(pid), undefined) ?? g?.players?.[pid]?.team ?? (pid === 0 ? 1 : 2); }

  // ------------------------------------------------------------------ DOM
  _build() {
    this.root.innerHTML = '';
    this.menuEl = el('div', 'menu hidden');
    this.hudEl = el('div', 'hud hidden');
    this.root.append(this.hudEl, this.menuEl);

    // top bar
    const top = el('div', 'topbar panel');
    this.resEls = {};
    for (const r of RES_LIST) {
      const d = el('div', 'res', `<span class="i">${RES_ICON[r]}</span><b>0</b><small class="rate"></small>`);
      this._tip(d, () => ({ name: RES_NAME[r], desc: 'Mevcut ' + RES_NAME[r].toLowerCase() + ' stoğu. Küçük sayı: son 30 saniyeye göre dakikalık gelir.' }));
      this.resEls[r] = d; top.append(d);
    }
    this.popEl = el('div', 'res', `<span class="i">${ico('x-pop')}</span><b>0/0</b>`);
    this._tip(this.popEl, () => ({ name: 'Nüfus', desc: 'Mevcut / azami nüfus. Sınır sabit: 1000.' }));
    this.idleEl = el('button', 'tbtn idlebtn', ico('u-villager') + '<b>0</b>');
    this.idleEl.onclick = () => { this._click(); safe(() => this.app.input?.nextIdleVillager()); };
    this._tip(this.idleEl, () => ({ name: 'Boşta köylüler', desc: 'Sıradaki boşta köylüyü seç ve ona git. Kısayol: nokta (.)' }));
    top.append(el('div', 'sep'), this.popEl, this.idleEl, el('div', 'sep'));
    this.ageEl = el('div', 'agebox', '<span class="n"></span><div class="agebar"><i></i></div>');
    this.clockEl = el('div', 'clock', '00:00');
    top.append(this.ageEl, el('div', 'sep'), this.clockEl, el('div', 'sep'));
    const tb = (icon, name, desc, fn) => {
      const b = el('button', 'tbtn', icon);
      b.onclick = () => { this._click(); fn(); };
      this._tip(b, () => ({ name, desc }));
      top.append(b); return b;
    };
    tb(ico('x-quests'), 'Görevler', 'Görev listesini göster / gizle.', () => this.questsEl.classList.toggle('hidden'));
    tb(ico('x-tech'), 'Teknoloji', 'Teknoloji ağacı: tüm çağların araştırmaları. Uygun olanı tıklayıp araştır.', () => this.showTech());
    tb(ico('x-stats'), 'İstatistik', 'Oyun istatistikleri ve skor.', () => this.showStats());
    this.flareBtn = tb(ico('x-flare'), 'İşaret Ver', 'Haritaya işaret bırak: takım arkadaşın mini haritada ve oyunda görür. Butona bas, sonra haritaya ya da mini haritaya tıkla. Kısayol: Alt + tık', () => this.app.input?.armFlare());
    this.tribBtn = tb(ico('x-ally'), 'Müttefike Kaynak Gönder', 'Takım arkadaşına yiyecek, odun, taş ya da altın gönder (kesinti yok).', () => this.showTribute());
    this.tribBtn.style.display = 'none';
    this.chatBtn = tb(ico('x-chat'), 'Sohbet', 'Takım arkadaşlarına mesaj yaz. Kısayol: Enter', () => this.openChat());
    this.saveBtn = tb(ico('x-save'), 'Kaydet', 'Oyunu kaydet.', () => this._save());
    this.pauseBtn = tb(ico('x-pause'), 'Menü / Duraklat', 'Oyun menüsünü aç (Esc). Tek oyunculuda oyun durur; çok oyunculuda menüden herkes için duraklatabilirsin (P).', () => this.toggleGameMenu(true));
    this._buildFullscreenBtn(top);
    this.hudEl.append(top);
    this.objEl = el('div', 'objective panel hidden', '<div class="osteps"></div><div class="oage"><span class="ot"></span><div class="obar"><i></i></div><span class="om"></span></div>');
    this.hudEl.append(this.objEl);
    this.hintAt = {}; this.rateSamples = []; this.rateT = -99; this.slowT = -99; this.orphanSince = new Map(); this.objSig = null;

    this.fpsEl = el('div', 'fps', '');
    this.hudEl.append(this.fpsEl);
    this.fpsEl.onclick = () => { this.fpsMore = !this.fpsMore; };

    // minimap
    const mmWrap = el('div', 'minimap panel');
    this.mm = el('canvas');
    this.mm.width = MM; this.mm.height = MM;
    mmWrap.append(this.mm);
    this.hudEl.append(mmWrap);
    this._bindMinimap();

    // bottom
    const bottom = el('div', 'bottom');
    this.selEl = el('div', 'selpanel panel empty');
    this.cardEl = el('div', 'card panel');
    bottom.append(this.selEl, this.cardEl);
    this.hudEl.append(bottom);
    // shortcut bar: control groups 1-9 (same as Ctrl+1..9 / 1..9)
    this.grpEl = el('div', 'groupbar');
    this.hudEl.append(this.grpEl);
    this._grpBtns = null; this._grpState = [];

    this.placeEl = el('div', 'placehint panel hidden');
    this.toastsEl = el('div', 'toasts');
    this.questsEl = el('div', 'quests panel');
    this.tipEl = el('div', 'tooltip panel hidden');
    this.pauseEl = el('div', 'overlay hidden');
    this.modalEl = el('div', 'overlay hidden');
    this.hudEl.append(this.placeEl, this.toastsEl, this.questsEl, this.pauseEl, this.modalEl);
    this.root.append(this.tipEl);
    this.modalEl.addEventListener('mousedown', (e) => { if (e.target === this.modalEl && !this.modalLocked) this._closeModal(); });
    this._buildPause();
    this._renderCard();
  }

  _click() { safe(() => this.app.audio?.ui('click')); }
  _error() { safe(() => this.app.audio?.ui('error')); }

  // ------------------------------------------------------------------ tooltip
  _tip(node, specFn) {
    node.addEventListener('mouseenter', () => { if (performance.now() < (this._cardGuardT || 0) && this.cardEl.contains(node)) return; this._showTip(node, specFn()); });
    node.addEventListener('mouseleave', () => this.tipEl.classList.add('hidden'));
  }
  _costHtml(cost) {
    if (!cost) return '';
    const p = this.game?.players?.[this._me()];
    let h = '';
    for (const r of RES_LIST) {
      const v = cost[r]; if (!v) continue;
      const no = p && (p.res[r] || 0) < v;
      h += `<span class="${no ? 'no' : ''}">${RES_ICON[r]} ${v}</span>`;
    }
    return h;
  }
  _showTip(node, s) {
    if (!s) return;
    let h = `<div class="tn"><span>${keepIcons(esc(s.name))}</span>${s.hotkey ? `<kbd>${s.hotkey}</kbd>` : ''}</div>`;
    const c = this._costHtml(s.cost);
    if (c || s.time) h += `<div class="tc">${c}${s.time ? `<span>⏱ ${Math.round(s.time)}sn</span>` : ''}</div>`;
    if (s.desc) h += `<div class="td">${keepIcons(esc(s.desc))}</div>`;
    const chk = s.check ? safe(s.check, { ok: true }) : null;
    if (chk && !chk.ok && chk.reason) h += `<div class="tr">${esc(chk.reason)}</div>`;
    const t = this.tipEl;
    t.innerHTML = h; t.classList.remove('hidden');
    const r = node.getBoundingClientRect(), tr = t.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2, y = r.top - tr.height - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(window.innerWidth - tr.width - 6, x));
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  showHUD() {
    this.mode = 'hud';
    this.menuOpen = false; this._pauseKey = null;
    this.menuEl.classList.add('hidden');
    this.hudEl.classList.remove('hidden');
    this.cardSig = null; this.selSig = null; this.questSig = null;
  }

  // ------------------------------------------------------------------ game binding
  onNewGame(game) {
    this.sel = []; this.page = 'root'; this.cardSig = null; this.selSig = null; this.questSig = null;
    this._ageCls = null;
    this.lastRes = {}; this.pings = []; this.questDoneAt = new Map(); this.gameOverShown = false;
    this.hintAt = {}; this.rateSamples = []; this.slowT = -99; this.orphanSince = new Map(); this.objSig = null;
    this.mmTerrain = null; this.mmFog = null; this.mmFogVer = -1;
    this.toastsEl.innerHTML = ''; this._closeModal(true);
    this._applySettings();
    const ev = game?.events; if (!ev) return;
    const on = (n, fn) => safe(() => ev.on(n, (p) => { if (this.app.game === game) safe(() => fn(p || {})); }));
    const railDone = () => (BUILDINGS.rail?.name || 'Ray') + ' tamamlandı';
    on('notify', (p) => { if (p.text === railDone() || p.text === ATTACK_TEXT) return; this.toast(p.text, p.type || 'info', p.x, p.z); });
    this._trainsSeen = new Set(); this._unloadT = -99;
    on('trainArrive', (p) => {
      const tr = p.e; if (!tr || tr.owner !== this._me() || this._trainsSeen.has(tr.id)) return;
      this._trainsSeen.add(tr.id); this.toast(ico('u-train') + ' Demir yolu bağlandı!', 'good', tr.x, tr.z); this.cardSig = null; this.selSig = null;
    });
    on('board', (p) => { if (p.transport?.owner === this._me()) { this.cardSig = null; this.selSig = null; } });
    on('unload', (p) => {
      if (p.transport?.owner === this._me()) { this.cardSig = null; this.selSig = null; }
      const t = p.transport; if (!t || t.owner !== this._me() || game.time - this._unloadT < 3) return;
      this._unloadT = game.time; this.toast(`${ico('x-unload')} ${(p.units || []).length || ''} birim karaya çıktı`.replace('  ', ' '), 'info', t.x, t.z);
    });
    on('trained', (p) => { if (p.e?.owner === this._me()) this.toast(`${UNITS[p.e.type]?.icon || ''} ${UNITS[p.e.type]?.name || p.e.type} hazır`, 'info', p.e.x, p.e.z); });
    on('researched', (p) => { if (p.owner === this._me()) { const t = typeof p.tech === 'string' ? TECHS[p.tech] : p.tech; this.toast(`${t?.icon || ico('x-tech')} Araştırma tamamlandı: ${t?.name || p.tech}`, 'good'); this.cardSig = null; } });
    on('buildComplete', (p) => { if (p.e?.owner === this._me() && p.e.type !== 'rail') this.toast(`${BUILDINGS[p.e.type]?.icon || ico('b-house')} ${BUILDINGS[p.e.type]?.name || p.e.type} tamamlandı`, 'good', p.e.x, p.e.z); });
    on('questDone', (p) => {
      const q = p.quest || {}; this.questDoneAt.set(q.id, performance.now()); this.questSig = null;
      this.toast(`✔ Görev tamamlandı: ${q.title || ''}${q.reward ? ' (' + this._rewardText(q.reward) + ')' : ''}`, 'good');
    });
    on('underAttack', (p) => {
      this.pings.push({ x: p.x, z: p.z, t: performance.now(), big: true });
      if (game.time - this.lastAttackToast > 8) { this.lastAttackToast = game.time; this._attackAlert(p.x, p.z); }
    });
    on('ageUp', (p) => {
      if (p.owner === this._me()) { if (!p.dev) this.showAgeUp(p.age); }   // (developer mode switches skip the cinematic)
      else if (this.game?.mp && this._ally(this._me(), p.owner)) this.toast(`${ico('x-ally')} ${this._pname(p.owner)} ${AGES[p.age]?.name || 'yeni çağ'}'na ulaştı`, 'info');
      else this.toast(`Bir rakip ${AGES[p.age]?.name || 'yeni çağ'}'na ulaştı`, 'warn');
      this.cardSig = null;
    });
    on('gameOver', (p) => this.showGameOver(!!p.won));
    on('tribute', (p) => {
      const me = this._me(), t = `${p.amount} ${RES_ICON[p.res] || ''} ${RES_NAME[p.res] || p.res}`;
      if (p.to === me) this.toast(`${ico('x-ally')} ${esc(this._pname(p.from))} sana ${t} gönderdi`, 'good');
      else if (p.from === me) this.toast(`${ico('x-ally')} ${esc(this._pname(p.to))} oyuncusuna ${t} gönderildi`, 'info');
      if (this._tribOpen && this.modalEl.querySelector('.tribute')) safe(() => this._renderTribute());
    });
    if (this.tribBtn) this.tribBtn.style.display = this._allies().length ? '' : 'none';
    const mp = !!this.app.net;
    for (const b of [this.pauseBtn]) if (b) b.style.display = mp ? 'none' : '';
    if (this.saveBtn) { this.saveBtn.style.display = ''; this.saveBtn.title = mp ? 'Maçı kaydet: herkes aynı anda kaydeder (Çok Oyunculu → Kayıtlı Maça Devam Et)' : this.saveBtn.title; }
    if (this.chatBtn) this.chatBtn.style.display = mp ? '' : 'none';
    if (mp || game.mp) { this.questsEl.classList.add('hidden'); this._mpHidQuests = true; }
    else if (this._mpHidQuests) { this.questsEl.classList.remove('hidden'); this._mpHidQuests = false; }
    if (this.netEl) { this.netEl.remove(); this.netEl = null; }
    this.scoreSig = null;
    if (this.mode !== 'hud') this.showHUD();
  }
  // Under attack (owner 2026-11-14: nobody noticed it): red edge flash + a banner that says what and where (click /
  // Space: go there) + a big minimap ping. The sim throttles 'underAttack' to once per 10 s; the alarm is in audio.js.
  _attackAlert(x, z) {
    const g = this.game, me = this._me();
    let what = null, best = 9;
    for (const e of g.entities.values()) {   // (once per 10 s at most)
      if (e.owner !== me || e.dead) continue;
      const d = Math.hypot(e.x - x, e.z - z) - (e.kind === 'building' ? (e.size || 1) / 2 : 0);
      if (d < best) { best = d; what = e; }
    }
    const nm = what ? stripIcons(this._def(what)?.name || '') : '';
    const tc = safe(() => g.buildingsOf(me).find((b) => b.type === 'towncenter' && b.done), null);
    let where = '';
    if (tc && tc !== what) {
      const dx = x - tc.x, dz = z - tc.z, d = Math.hypot(dx, dz);
      where = d < 12 ? 'Şehir Merkezi yakınında' : "Şehir Merkezi'nin " + DIR_TR[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8] + ' (' + Math.round(d) + ' kare)';
    }
    if (!this.attackEl) {
      this.attackEl = el('div', 'attackbanner hidden');
      this.attackEl.onclick = () => { const a = this.attackEl._at; if (a) { this._click(); this.app.focus?.(a.x, a.z); } };
      this.flashEl = el('div', 'attackflash');
      this.hudEl.append(this.flashEl, this.attackEl);
    }
    const b = this.attackEl;
    b._at = { x, z };
    b.innerHTML = `<b>${ico('x-atk')} Saldırı altındasın!</b><span>${esc([nm, where].filter(Boolean).join(' · ') || 'Mini haritadaki kırmızı işarete bak.')}</span><small>Tıkla ya da Boşluk: oraya git</small>`;
    b.classList.remove('hidden', 'show'); void b.offsetWidth; b.classList.add('show');
    // (no red screen-edge flash any more, 2026-11-17: "make it plainer" - the banner, the minimap ping and one horn)
    clearTimeout(this._attackT);
    this._attackT = setTimeout(() => { b.classList.remove('show'); b.classList.add('hidden'); this.flashEl.classList.remove('on'); }, ATTACK_MS);
  }

  // Fullscreen (Fullscreen API, with the webkit prefix for Safari)
  _buildFullscreenBtn(top) {
    const d = document, r = d.documentElement;
    const can = !!(d.fullscreenEnabled || d.webkitFullscreenEnabled || r.requestFullscreen || r.webkitRequestFullscreen);
    const fsEl = () => d.fullscreenElement || d.webkitFullscreenElement || null;
    const b = el('button', 'tbtn fsbtn', ico('x-fullscreen'));
    if (!can) b.style.display = 'none';
    const fail = () => this.hint('fs', 'Tam ekran açılamadı.', 'warn', 3);
    b.onclick = () => {
      this._click();
      this.tipEl.classList.add('hidden');
      try {
        if (fsEl()) { const ex = d.exitFullscreen || d.webkitExitFullscreen; if (ex) { const p = ex.call(d); if (p && p.catch) p.catch(() => {}); } }
        else if (r.requestFullscreen) { const p = r.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(fail); }
        else if (r.webkitRequestFullscreen) r.webkitRequestFullscreen();
      } catch (err) { fail(); }
    };
    const sync = () => { const on = !!fsEl(); b.innerHTML = ico(on ? 'x-fullscreen-exit' : 'x-fullscreen'); b.classList.toggle('on', on); };
    d.addEventListener('fullscreenchange', sync); d.addEventListener('webkitfullscreenchange', sync);
    this._tip(b, () => (fsEl() ? { name: 'Tam Ekrandan Çık', desc: 'Pencere görünümüne dön. Esc de çıkarır.' } : { name: 'Tam Ekran', desc: 'Oyunu tam ekranda oyna. Çıkmak için tekrar tıkla ya da Esc.' }));
    top.append(b); this.fsBtn = b;
    return b;
  }

  _rewardText(rw) { return RES_LIST.filter((r) => rw[r]).map((r) => `${RES_ICON[r]}+${rw[r]}`).join(' '); }

  onSelectionChanged(ids) {
    this.sel = (ids || []).slice();
    this.page = 'root';
    this.cardSig = null; this.selSig = null;
    this.tipEl.classList.add('hidden');
    if (this.mode === 'hud' && this.game) { this._refreshSel(); this._refreshCard(); }
  }

  setPlacement(type) {
    if (!type) { this.placeEl.classList.add('hidden'); return; }
    const b = BUILDINGS[type]; if (!b) return;
    this.placeEl.innerHTML = `<span>${b.icon || ico('x-build')} <b>${esc(b.name)}</b> yerleştir</span><span class="tooltip-inline tc" style="display:flex;gap:8px">${this._costHtml(b.cost)}</span><span style="color:var(--dim)">${type === 'wall' ? 'Basılı tutup sürükle: sur hattı · Bırak: yerleştir' : type === 'rail' ? 'Basılı tutup sürükle: ray hattı · Bırak: yerleştir' : type === 'dock' ? 'Kıyıya yerleştir: bir kısmı suda olmalı · Sol tık: yerleştir' : 'Sol tık: yerleştir · Shift+tık: birden çok, köylüler sırayla yapar'} · Sağ tık / Esc: iptal</span>`;
    this.placeEl.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ toasts
  toast(text, type = 'info', x, z) {
    if (!text) return;
    // dedupe: the same message (ignoring leading icons / a trailing reward) within 1.5 s shows once
    const now = performance.now(), key = String(text).replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    this._recentToasts = (this._recentToasts || []).filter((r) => now - r.t < 1500);
    if (this._recentToasts.some((r) => r.key === key)) return;
    this._recentToasts.push({ key, t: now });
    if (this.app.net && /kaydedildi|Senkron bozuldu|ayrıldı|düştü|koptu/i.test(text)) this._chatSys(String(text));   // system line in the chat feed
    const t = el('div', 'toast ' + type, keepIcons(esc(text)));
    if (x != null && z != null) t.onclick = () => this.app.focus?.(x, z);
    this.toastsEl.prepend(t);
    while (this.toastsEl.children.length > 6) this.toastsEl.lastChild.remove();
    setTimeout(() => t.classList.add('out'), 5200);
    setTimeout(() => t.remove(), 5700);
  }

  // Rate limited toast: the same key is shown at most once per `gap` seconds.
  hint(key, text, type = 'warn', gap = 6, x, z) {
    const now = performance.now(), last = this.hintAt[key];
    if (last !== undefined && now - last < gap * 1000) return false;
    this.hintAt[key] = now;
    this.toast(text, type, x, z);
    return true;
  }

  // Income per minute from players[this._me()].stats.gathered over the last 30 s of game time.
  _refreshRates(g, p) {
    const ga = p.stats?.gathered; if (!ga) return;
    const t = g.time || 0, S = this.rateSamples;
    if (S.length && t < S[S.length - 1].t) S.length = 0;
    if (S.length && t - S[S.length - 1].t < 1) return;
    S.push({ t, food: ga.food || 0, wood: ga.wood || 0, stone: ga.stone || 0, gold: ga.gold || 0 });
    while (S.length > 2 && t - S[1].t >= 30) S.shift();
    const a = S[0], span = t - a.t;
    for (const r of RES_LIST) {
      const n = this.resEls[r].querySelector('.rate'); if (!n) continue;
      const v = span >= 3 ? Math.round(((ga[r] || 0) - a[r]) / span * 60) : 0;
      const s = v > 0 ? '+' + v : '';
      if (n.textContent !== s) n.textContent = s;
    }
  }

  // Idle villager button, population / orphan foundation hints, objective line. Runs about once a second.
  _refreshSlow(g, p) {
    const now = performance.now();
    if (now - this.slowT < 900) return;
    this.slowT = now;
    const units = safe(() => g.unitsOf(this._me()), []) || [], blds = safe(() => g.buildingsOf(this._me()), []) || [];
    let idle = 0; const building = new Set();
    for (const u of units) {
      if (u.dead || u.type !== 'villager') continue;
      if (u.state === 'idle') idle++;
      if (u.order && u.order.type === 'build') building.add(u.order.targetId);
      if (u.state === 'build' && u.order && u.order.targetId != null) building.add(u.order.targetId);
    }
    const ib = this.idleEl.querySelector('b'); if (ib.textContent !== String(idle)) ib.textContent = idle;
    this.idleEl.classList.toggle('has', idle > 0);
    const demo = !!this.app.demo;
    // hints
    if (!demo && !g.over) {
      if (p.pop >= p.popCap && p.popCap > 0) this.hint('popcap', ico('x-pop') + ' Nüfus sınırına ulaştın (1000)', 'warn', 60);
      const seen = new Set();
      for (const b of blds) {
        if (b.dead || b.done || b.type === 'wall' || b.type === 'gate') continue;
        seen.add(b.id);
        if (building.has(b.id)) { this.orphanSince.delete(b.id); continue; }
        const t0 = this.orphanSince.get(b.id);
        if (t0 === undefined) { this.orphanSince.set(b.id, now); continue; }
        if (now - t0 > 6000) this.hint('orphan', `${ico('x-build')} ${BUILDINGS[b.type]?.name || 'İnşaat'} temelinde işçi yok — köylü seçip temele sağ tıkla`, 'warn', 30, b.x, b.z);
      }
      for (const id of this.orphanSince.keys()) if (!seen.has(id)) this.orphanSince.delete(id);
    }
    // objective line
    const next = AGES[p.age + 1];
    if (demo || !next) { this.objEl.classList.add('hidden'); return; }
    this.objEl.classList.remove('hidden');
    const has = (t) => blds.some((b) => b.type === t && !b.dead);
    const ga = p.stats?.gathered || {};
    const steps = [
      ['Yiyecek ve odun topla', (ga.food || 0) + (ga.wood || 0) >= 150],

      ['Tarla kur', has('farm')],
      ['Kışla kur', has('barracks')],
      [next.name + "'ne geç", false],
    ];
    if (p.age > 0) steps.length = 0;
    let cur = steps.findIndex((s) => !s[1]);
    if (p.age === 0 && cur === steps.length - 1 && (g.time || 0) > 600) steps.length = 0;
    const types = new Set();
    for (const b of blds) if (b.done && !b.dead && !['house', 'wall', 'gate', 'towncenter'].includes(b.type)) types.add(b.type);
    let aging = null;
    for (const b of blds) { const q = b.queue?.[0]; if (q && q.kind === 'age') { aging = q; break; } }
    const parts = [], miss = [];
    for (const r in next.cost) {
      const need = next.cost[r], have = Math.floor(p.res[r] || 0);
      parts.push(Math.min(1, have / need));
      if (have < need) miss.push(`${RES_ICON[r] || r} ${need - have}`);
    }
    if (next.reqBuildings > 0) {
      parts.push(Math.min(1, types.size / next.reqBuildings));
      if (types.size < next.reqBuildings) miss.push(`${ico('x-buildings')} ${next.reqBuildings - types.size} farklı bina türü`);
    }
    // named buildings the next age needs, and the minimum stay in this age (game.ageMissingTypes / ageWait)
    const needT = (next.reqTypes || []).filter((t) => !blds.some((b) => b.type === t && b.done && !b.dead));
    if (next.reqTypes) parts.push(1 - needT.length / next.reqTypes.length);
    for (const t of needT) miss.push(`${ico('x-buildings')} ${BUILDINGS[t] ? BUILDINGS[t].name : t}`);
    const wait = g.ageWait ? g.ageWait(p.id) : 0;
    if (wait > 0) miss.push(`⏳ ${Math.floor(wait / 60)}:${String(Math.floor(wait % 60)).padStart(2, '0')}`);
    const frac = aging ? this._qprog(aging) : (parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1);
    const costTxt = RES_LIST.filter((r) => next.cost[r]).map((r) => `${RES_ICON[r]} ${next.cost[r]}`).join(' ');
    const mtxt = aging ? 'Çağ atlanıyor…' : miss.length ? 'Eksik: ' + miss.join(' · ') : 'Hazır! Şehir Merkezi\'nden çağ atla';
    const sig = steps.map((s) => (s[1] ? 1 : 0)).join('') + '|' + p.age + '|' + mtxt;
    this.objEl.querySelector('.obar i').style.width = (frac * 100).toFixed(1) + '%';
    if (sig === this.objSig) return;
    this.objSig = sig;
    this.objEl.querySelector('.osteps').innerHTML = steps.map((s, i) => `<span class="${s[1] ? 'done' : i === cur ? 'cur' : ''}">${s[1] ? '✔ ' : ''}${esc(s[0])}</span>`).join('<em>→</em>');
    this.objEl.querySelector('.ot').innerHTML = keepIcons(esc(`${next.name} (${costTxt}${next.reqBuildings ? ' · ' + next.reqBuildings + ' bina türü' : ''})`));
    const om = this.objEl.querySelector('.om'); om.innerHTML = keepIcons(esc(mtxt)); om.classList.toggle('ready', !aging && !miss.length);
  }

  // ------------------------------------------------------------------ update loop
  // shortcut bar: 9 slots. Empty slot: click = put the selection there. Filled slot: click = select, double
  // click = select + go there, Ctrl+click = replace with the selection, right click = empty it.
  _refreshGroups() {
    const inp = this.app.input; if (!inp || !this.grpEl) return;
    const sel = this.app.selection || [];
    const slots = [];
    for (let n = 1; n <= 9; n++) {
      const ids = inp.groupIds(n);
      const by = new Map();
      for (const id of ids) { const x = this.game.getEntity(id); if (x) by.set(x.type, (by.get(x.type) || 0) + 1); }
      let top = null, best = 0; for (const [t, c] of by) if (c > best) { best = c; top = t; }
      const active = ids.length > 0 && ids.length === sel.length && ids.every((id) => sel.includes(id));
      slots.push({ n, count: ids.length, top, kinds: by.size, active });
    }
    this._grpState = slots;
    // the 9 buttons are made once (a rebuilt button would lose its double click); only their content changes
    if (!this._grpBtns || !this._grpBtns[0].isConnected) {
      this.grpEl.innerHTML = '';
      this._grpBtns = [];
      for (let i = 0; i < 9; i++) {
        const b = el('button', 'grp');
        const cur = () => this._grpState[i];
        b.onclick = (ev) => {
          const s = cur(); this._click();
          if (!s.count || ev.ctrlKey) { if (!inp.setGroup(s.n)) this.toast('Önce birlik ya da bina seç, sonra buraya tıkla.', 'info'); }
          else inp.recallGroup(s.n, false);
          this._refreshGroups();
        };
        b.ondblclick = () => { const s = cur(); if (s.count) inp.recallGroup(s.n, true); };
        b.oncontextmenu = (ev) => { ev.preventDefault(); const s = cur(); if (s.count) { this._click(); inp.clearGroup(s.n); this._refreshGroups(); } };
        this._tip(b, () => {
          const s = cur(), d = UNITS[s.top] || BUILDINGS[s.top];
          return s.count
            ? { name: 'Grup ' + s.n + ' · ' + s.count + ' ' + (s.kinds > 1 ? 'seçili' : (d?.name || '')), desc: 'Tıkla: seç · Çift tıkla: oraya git · Ctrl+tık: seçimle değiştir · Sağ tık: boşalt. Kısayol: ' + s.n + ' (Ctrl+' + s.n + ' kaydeder)' }
            : { name: 'Boş grup ' + s.n, desc: 'Birlik ya da bina seç, sonra buraya tıkla (ya da Ctrl+' + s.n + '). Sonra ' + s.n + ' tuşu ile hep geri seçersin.' };
        });
        this.grpEl.append(b); this._grpBtns.push(b);
      }
    }
    slots.forEach((s, i) => {
      const b = this._grpBtns[i], d = UNITS[s.top] || BUILDINGS[s.top];
      const html = `<i>${s.n}</i>` + (s.count ? `<span class="gic">${d?.icon || ico('x-unknown')}</span><b>${s.count}</b>` : '<span class="gplus">+</span>');
      if (b._h !== html) { b._h = html; b.innerHTML = html; }
      b.className = 'grp' + (s.count ? ' on' : '') + (s.active ? ' act' : '');
    });
  }

  // developer mode panel: jump between ages (only in a dev game)
  _devPanel() {
    const g = this.game, on = !!(g && g.cfg && g.cfg.dev && this.mode === 'hud');
    if (!on) { if (this.devEl) this.devEl.classList.add('hidden'); return; }
    if (!this.devEl) {
      this.devEl = el('div', 'devpanel', '<b>Geliştirici</b>');
      for (let i = 0; i < AGES.length; i++) {
        const b = el('button', '', AGES[i].name.split(' ')[0]); b.dataset.age = i;
        b.onclick = () => { this._click(); safe(() => this.game.devSetAge(i)); };
        this.devEl.append(b);
      }
      this.hudEl.append(this.devEl);
    }
    this.devEl.classList.remove('hidden');
    const age = g.players[this._me()]?.age | 0;
    this.devEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.age === age));
  }
  update(dt) {
    this.frames++; this.fpsT += dt;
    if (this.fpsT + dt >= 0.5) this._devPanel();
    if (this.fpsT >= 0.5) {
      // multiplayer: the worst peer's round trip next to the FPS (is a hitch the network or the screen?)
      const ni = this.app.net && typeof this.app.net.netInfo === 'function' ? safe(() => this.app.net.netInfo(), null) : null;
      let more = '';
      if (this.fpsMore) {   // clicked: frame cost details (CPU time per frame, render resolution, triangles drawn)
        const R = this.app.renderer, rr = R && R.renderer;
        if (rr) more = ' · CPU ' + (this.app.cpuMs || 0).toFixed(1) + ' ms · ' + rr.getPixelRatio().toFixed(2) + 'x ' +
          Math.round(R._w * rr.getPixelRatio()) + '×' + Math.round(R._h * rr.getPixelRatio()) + ' · ' + Math.round(rr.info.render.triangles / 1000) + 'k üçgen · ' + rr.info.render.calls + ' çizim';
      }
      this.fpsEl.textContent = Math.round(this.frames / this.fpsT) + ' FPS' + (ni && ni.ping != null ? ' · Ping ' + ni.ping + ' ms' : '') + more;
      this.frames = 0; this.fpsT = 0;
    }
    if (this.mode !== 'hud' || !this.game) return;
    this.acc += dt; this.mmAcc += dt;
    if (this.acc >= 0.125) {
      this.acc = 0;
      safe(() => this._refreshTop());
      safe(() => this._refreshSel());
      safe(() => this._refreshCard());
      safe(() => this._refreshQuests());
      safe(() => this._refreshGroups());
      if (this.techTiles && (this.techT = (this.techT || 0) + 1) % 2 === 0) safe(() => this._refreshTech());
      const paused = this.gameMenuVisible();
      safe(() => this._refreshScore());
      safe(() => this._chatTick());
      if (paused && this.pauseInfoEl) { const mt = this.game.cfg?.mapType; this.pauseInfoEl.textContent = (mt && MAP_TYPE_TR[mt] ? 'Harita: ' + MAP_TYPE_TR[mt] : '') + (this.app.renderer?.climate ? ' · İklim: ' + this.app.renderer.climate.name : ''); }
      safe(() => this._syncPauseMenu());
      if (this.game.over && !this.gameOverShown) this.showGameOver(!!this.game.over.won);
    }
    if (this.mmAcc >= 0.1) { this.mmAcc = 0; safe(() => this._drawMinimap()); }
  }

  _qprog(q) {
    if (!q || !q.total) return 0;
    let d = this.qdir.get(q);
    if (!d) { d = { t0: q.t, up: q.t <= q.total / 2 }; this.qdir.set(q, d); }
    else if (q.t > d.t0 + 1e-6) d.up = true; else if (q.t < d.t0 - 1e-6) d.up = false;
    const f = d.up ? q.t / q.total : 1 - q.t / q.total;
    return Math.max(0, Math.min(1, f));
  }

  _refreshTop() {
    const g = this.game, p = g.players[this._me()]; if (!p) return;
    for (const r of RES_LIST) {
      const v = Math.floor(p.res[r] || 0), d = this.resEls[r];
      if (this.lastRes[r] !== v) {
        d.querySelector('b').textContent = v;
        if (this.lastRes[r] != null && v > this.lastRes[r]) { d.classList.remove('pulse'); void d.offsetWidth; d.classList.add('pulse'); }
        this.lastRes[r] = v;
      }
    }
    const ps = `${p.pop | 0}/${p.popCap | 0}`;
    if (this.lastPop !== ps) { this.lastPop = ps; this.popEl.querySelector('b').textContent = ps; this.popEl.classList.toggle('capped', p.pop >= p.popCap); }
    if (this._ageCls !== p.age) {
      const had = this._ageCls != null;
      for (const n of [this.hudEl, this.tipEl]) { for (let i = 0; i < AGES.length; i++) n.classList.remove('age-' + i); n.classList.add('age-' + (p.age | 0)); }
      this._ageCls = p.age;
      if (had) { const tbEl = this.hudEl.querySelector('.topbar'); if (tbEl) { tbEl.classList.remove('ageflash'); void tbEl.offsetWidth; tbEl.classList.add('ageflash'); } }
    }
    const an = AGES[p.age]?.name || '';
    const n = this.ageEl.querySelector('.n'); if (n.textContent !== an) n.textContent = an;
    let prog = 0;
    for (const b of safe(() => g.buildingsOf(this._me()), [])) { const q = b.queue?.[0]; if (q && q.kind === 'age') { prog = this._qprog(q); break; } }
    this.ageEl.querySelector('i').style.width = (prog * 100).toFixed(1) + '%';
    this.clockEl.textContent = fmtTime(g.time || 0);
    safe(() => this._refreshRates(g, p));
    safe(() => this._refreshSlow(g, p));
  }

  // ------------------------------------------------------------------ selection panel
  _ents() {
    const g = this.game, out = [];
    for (const id of this.sel) { const e = safe(() => g.getEntity(id), null); if (e && !e.dead) out.push(e); }
    return out;
  }
  _def(e) {
    if (e.kind === 'unit') return UNITS[e.type] || { name: e.type, icon: ico('x-unknown') };
    if (e.kind === 'building') return BUILDINGS[e.type] || { name: e.type, icon: ico('b-house') };
    return NATURE[e.type] || { name: e.type, icon: ico('x-unknown') };
  }
  _refreshSel() {
    const ents = this._ents();
    const sig = ents.map((e) => e.id).join(',') + '|' + (ents.length === 1 ? (ents[0].queue?.map((q) => q.kind + q.id).join(';') ?? '') + (ents[0].done ? 'd' : 'u') : ents.map((x) => (x.kind === 'building' ? (x.queue?.map((q) => q.kind + q.id).join(';') ?? '') + (x.done ? 'd' : 'u') : '')).join(','));
    if (sig !== this.selSig) { this.selSig = sig; this._buildSel(ents); }
    if (!ents.length) return;
    if (ents.length === 1) {
      const e = ents[0], f = Math.max(0, Math.min(1, e.kind === 'resource' ? (e.amount / (e.maxAmount || 1)) : e.hp / (e.maxHp || 1)));
      const bar = this.selEl.querySelector('.hpbar');
      if (bar) { bar.firstChild.style.width = f * 100 + '%'; bar.className = 'hpbar' + (e.kind !== 'resource' && f < 0.3 ? ' low' : e.kind !== 'resource' && f < 0.6 ? ' mid' : ''); }
      const ht = this.selEl.querySelector('.hptxt');
      // stone and gold mines never run out (src/sim/game.js): no misleading "350 / 350"
      const endless = e.kind === 'resource' && (e.type === 'stone' || e.type === 'gold');
      if (ht) ht.textContent = endless ? `∞ Sınırsız ${RES_NAME[NATURE[e.type]?.res] || ''}` : e.kind === 'resource' ? `${Math.ceil(e.amount)} /${Math.ceil(e.maxAmount || e.amount)} ${RES_NAME[NATURE[e.type]?.res] || ''}` : `${Math.ceil(e.hp)} / ${Math.ceil(e.maxHp)} can`;
      const st = this.selEl.querySelector('.stats');
      if (st) { const h = this._statsHtml(e); if (st._h !== h) { st._h = h; st.innerHTML = h; } }
      const qs = this.selEl.querySelectorAll('.qi i');
      qs.forEach((bar2, i) => { const q = e.queue?.[i]; bar2.style.width = (i === 0 && q ? this._qprog(q) * 100 : 0) + '%'; });
    } else {
      const bars = this.selEl.querySelectorAll('.mu i');
      bars.forEach((b, i) => { const e = ents[i]; if (e) b.style.transform = `scaleX(${Math.max(0, e.hp / (e.maxHp || 1))})`; });
      const qb = this.selEl.querySelector('.mbqbar');
      if (qb) { // multi-building: progress of the nearest completion
        let best = 0; for (const e of ents) { const q = e.queue?.[0]; if (q) best = Math.max(best, this._qprog(q)); }
        qb.firstChild.style.width = (best * 100).toFixed(1) + '%';
        const t = this.selEl.querySelector('.mbq b'); if (t) t.textContent = '%' + Math.floor(best * 100);
      }
    }
  }
  _statsHtml(e) {
    const d = this._def(e), s = [];
    if (e.kind === 'unit') {
      s.push(`<span>${ico('x-atk')} <b>${d.atk ?? 0}</b></span>`, `<span>${ico('x-armor')} <b>${d.armor ?? 0}</b></span>`);
      if (d.range) s.push(`<span>${ico('x-range')} <b>${d.range}</b></span>`);
      s.push(`<span>${ico('x-speed')} <b>${d.speed ?? '-'}</b></span>`);
      if (e.type === 'transport' || Array.isArray(e.cargo)) s.push(`<span>${ico('u-transport')} <b>${(e.cargo || []).length}/10</b></span>`);
      if (e.carry && e.carry.amount > 0) s.push(`<span>${RES_ICON[e.carry.type] || ico('x-cargo')} <b>${Math.floor(e.carry.amount)}</b></span>`);
      s.push(`<span>Durum: <b>${STATE_TR[e.state] || e.state || '-'}</b></span>`);
    } else if (e.kind === 'building') {
      if (!e.done) s.push(`<span>İnşaat: <b>%${Math.floor((e.progress || 0) * 100)}</b></span>`);
      if (d.atk) {
        // what it really hits for (the same formula as Game._updateBuilding: research + age)
        const op = this.game?.players?.[e.owner], m = op?.mods || {};
        const atk = d.atk + (m.towerAtk || 0) + (op?.age | 0) * (e.type === 'tower' ? TOWER_AGE_ATK : 1);
        s.push(`<span>${ico('x-atk')} <b>${atk}</b></span>`, `<span>${ico('x-range')} <b>${(d.range || 0) + (m.towerRange || 0) + towerAgeBonus(e.type, op?.age)}</b></span>`);
      }
      if (d.popCap) s.push(`<span>${ico('x-pop')} <b>+${d.popCap}</b></span>`);
      if (e.type === 'farm' && e.farm && Array.isArray(e.farm.plots)) s.push(`<span>Ekili parsel: <b>${e.farm.plots.filter((q) => q.s > 0).length}/8</b></span>`, `<span>Olgun: <b>${e.farm.plots.filter((q) => q.s === 5).length}</b></span>`);
      else if (e.type === 'farm' && e.farm) s.push(`<span>Tarla: <b>${['Boş', 'Sürülü', 'Ekili', 'Büyüyor', 'Olgun', 'Hasat'][e.farm.stage] || '-'}</b></span>`);
      if (e.done) s.push(...safe(() => this._extraStats(e), []));
      if (e.queue?.length) s.push(`<span>Kuyruk: <b>${e.queue.length}</b></span>`);
    }
    return s.join('');
  }
  // new-content lines for the selection panel (pasture, farm workers, station, dock)
  _extraStats(e) {
    const g = this.game, out = [];
    if (!g?.entities) return out;
    const all = [...g.entities.values()];
    const workers = () => all.filter((u) => u.kind === 'unit' && !u.dead && u.owner === e.owner && u.order && u.order.type === 'gather' && u.order.targetId === e.id).length;
    if (e.type === 'farm') out.push(`<span>${ico('u-villager')} <b>${Math.min(8, workers())}/8</b> işçi</span>`);
    if (e.type === 'pasture') out.push(`<span>${ico('b-pasture')} <b>${e.pasture?.sheep ?? 3}</b> koyun · <b>${Math.min(6, workers())}/6</b> işçi</span>`);
    if (e.type === 'station') {
      const tr = all.find((t) => t.train && !t.dead && (t.train.a === e.id || t.train.b === e.id));
      if (tr) out.push(`<span style="color:var(--good,#9be37a)">Bağlı: tren çalışıyor (+${Math.round(25 + (tr.train.path?.length || 0) * 1.2)} altın/sefer)</span>`);
      else out.push(`<span style="color:var(--dim)">Bağlı değil: başka bir istasyona ray döşe</span>`);
    }
    if (e.type === 'dock') out.push(`<span>${ico('u-fishboat')} <b>${all.filter((u) => u.kind === 'unit' && !u.dead && u.owner === e.owner && u.type === 'fishboat').length}</b> balıkçı teknesi</span>`);
    return out;
  }
  _buildSel(ents) {
    const p = this.selEl;
    p.innerHTML = '';
    p.classList.toggle('empty', !ents.length);
    if (!ents.length) return;
    if (ents.length === 1) {
      const e = ents[0], d = this._def(e);
      const owner = e.owner === this._me() ? '' : e.owner >= 0 && this._ally(this._me(), e.owner) ? `<small class="allytag" style="color:${hex(PLAYER_COLORS[e.owner] ?? 0xffffff)}">Müttefik: ${esc(this._pname(e.owner))}</small>` : e.owner >= 0 ? `<small style="color:${hex(PLAYER_COLORS[e.owner] ?? 0xffffff)}">Düşman${this.game?.mp ? ': ' + esc(this._pname(e.owner)) : ''}</small>` : '<small>Doğa</small>';
      const sub = e.kind === 'unit' ? CLS_TR[d.cls] || '' : e.kind === 'building' ? 'Bina' : 'Kaynak';
      p.append(el('div', 'portrait', d.icon || ico('x-unknown')));
      const info = el('div', 'selinfo', `<div class="selname">${esc(d.name)}<small>${sub}</small>${owner}</div><div class="hpbar"><i></i></div><div class="hptxt"></div><div class="stats"></div><div class="seldesc${e.kind === 'building' && d.desc ? ' bfx' : ''}">${esc(d.desc || '')}</div>`);
      if (e.kind === 'building' && e.owner === this._me() && e.queue?.length) {
        const q = el('div', 'queue');
        e.queue.slice(0, 8).forEach((it, i) => {
          const qd = it.kind === 'unit' ? UNITS[it.id] : it.kind === 'tech' ? TECHS[it.id] : { icon: ico('x-ageup'), name: 'Çağ Atlama' };
          const b = el('div', 'qi', `${qd?.icon || ico('x-unknown')}<i></i>`);
          this._tip(b, () => ({ name: qd?.name || it.id, desc: 'İptal etmek için tıkla (iade edilir).' }));
          b.onclick = () => { if (safe(() => this.game.cancelQueue(e.id, i), false)) this._click(); else this._error(); this.selSig = null; this.cardSig = null; this.tipEl.classList.add('hidden'); };
          q.append(b);
        });
        if (e.queue.length > 8) q.append(el('div', 'qi qmore', `+${e.queue.length - 8}`));   // (the rest of a long queue)
        info.append(q);
      }
      p.append(info);
    } else {
      let host = p;
      if (ents.every((x) => x.kind === 'building')) {
        // several buildings: "N × name" (same type) or "N bina seçili" (mixed) + combined queue summary
        const same = ents.every((x) => x.type === ents[0].type), d0 = this._def(ents[0]);
        const cnt = {}; let tot = 0;
        for (const x of ents) for (const q of x.queue || []) { const k = q.kind === 'unit' ? q.id : q.kind === 'tech' ? 't:' + q.id : 'age'; cnt[k] = (cnt[k] || 0) + 1; tot++; }
        const parts = Object.keys(cnt).map((k) => { const qd = k === 'age' ? { icon: ico('x-ageup') } : k.startsWith('t:') ? TECHS[k.slice(2)] : UNITS[k]; return `<span>${qd?.icon || '❔'} <b>${cnt[k]}</b></span>`; });
        host = el('div', 'selinfo', `<div class="selname">${same ? `${ents.length} × ${esc(d0.name)}` : `${ents.length} bina seçili`}</div>` +
          (same && tot ? `<div class="stats">Kuyruk: ${parts.join(' ')} <span class="mbq">· sıradaki: <b>%0</b></span></div><div class="hpbar mbqbar"><i></i></div>` : ''));
        p.append(host);
      }
      const grid = el('div', 'multi');
      ents.slice(0, 40).forEach((e) => {
        const d = this._def(e);
        const m = el('div', 'mu', `${d.icon || ico('x-unknown')}<i></i>`);
        this._tip(m, () => ({ name: d.name, desc: 'Tıkla: yalnızca bunu seç. Shift + tık ya da sağ tık: seçimden çıkar.' }));
        const drop = () => { this._click(); this.tipEl.classList.add('hidden'); this.app.select?.((this.app.selection || this.sel).filter((id) => id !== e.id)); };
        m.onclick = (ev) => { if (ev.shiftKey) { drop(); return; } this._click(); this.app.select?.([e.id]); };
        m.oncontextmenu = (ev) => { ev.preventDefault(); drop(); };
        grid.append(m);
      });
      host.append(grid);
    }
  }

  // ------------------------------------------------------------------ command card
  _refreshCard() {
    const g = this.game, p = g.players[this._me()], ents = this._ents();
    let sig = this.page + '|' + (p?.age ?? 0) + '|' + (p?.techs?.size ?? 0) + '|' + ents.length + '|';
    if (ents.length) {
      const e = ents[0];
      sig += e.id + e.type + (e.done ? 'd' : 'u') + (e.queue ? e.queue.map((q) => q.kind + q.id).join(';') : '') + ents.some((x) => x.type === 'villager') + (ents.length > 1 ? ents.map((x) => x.type + (x.done ? 'd' : 'u')).join(',') : '');
    }
    if (sig !== this.cardSig) { this.cardSig = sig; this._renderCard(ents); }
    for (const b of this.buttons) {
      if (!b) continue;
      const c = b.spec.check ? safe(b.spec.check, { ok: true }) : { ok: true };
      b.ok = !!c.ok;
      b.node.classList.toggle('off', !c.ok);
      b.node.classList.toggle('locked', !!c.locked);
      if (b.spec.active) b.node.classList.toggle('active', !!safe(b.spec.active, false));   // (the stance in use, owner 2026-11-15)
    }
  }
  _specs(ents) {
    const g = this.game, slots = new Array(15).fill(null);
    const put = (spec, slot) => { if (slot == null) slot = slots.indexOf(null); if (slot >= 0 && slot < 15) slots[slot] = spec; };
    // not reached yet by age: hidden until the player gets there, but its slot stays reserved (hotkeys do not move)
    const later = (age) => (age | 0) > (g.players[this._me()]?.age | 0);
    if (!g || !ents || !ents.length) return slots;
    const first = ents[0];
    if (first.owner !== this._me()) return slots;
    const p = g.players[this._me()], ids = ents.map((e) => e.id);
    const afford = (cost) => safe(() => g.canAfford(this._me(), cost), true);
    const sb = g.cfg?.sandbox ? 2 : 1; // sandbox: player 0 builds/trains/researches 2x faster (sim)
    const del = {
      icon: ico('x-delete'), name: 'Sil', desc: 'Seçili birimleri / binayı yok et.',
      run: () => { for (const id of ids) safe(() => g.deleteEntity(id)); return true; },
    };
    if (ents.every((e) => e.kind === 'unit')) {
      const hasVil = ents.some((e) => e.type === 'villager');
      if (this.page !== 'root' && hasVil && BUILD_CATS[this.page]) {
        for (const bid of BUILD_CATS[this.page].list) {
          const b = BUILDINGS[bid]; if (!b) continue;
          if (later(b.age)) { put(false); continue; }
          put({
            icon: b.icon || ico('b-house'), name: b.name, cost: b.cost, time: b.time * BUILD_TIME_MUL / sb, desc: b.desc,
            check: () => {
              if (!safe(() => g.isUnlocked(this._me(), 'building', bid), true)) return { ok: false, locked: true, reason: 'Gerekli çağ: ' + (AGES[b.age]?.name || b.age) };
              if (!afford(b.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
              return { ok: true };
            },
            run: () => { this.app.startPlacement?.(bid); this.page = 'root'; return true; },
          });
        }
        put({ icon: ico('x-back'), name: 'Geri', desc: 'Önceki menüye dön. (Sağ tık ya da Esc de döner.)', run: () => { this.page = 'root'; return true; } }, 14);
        return slots;
      }
      if (hasVil) {
        for (const k of Object.keys(BUILD_CATS)) {
          const c = BUILD_CATS[k];
          if (!c.list.some((bid) => BUILDINGS[bid])) continue; // page whose buildings are not defined yet
          if (!c.list.some((bid) => BUILDINGS[bid] && !later(BUILDINGS[bid].age))) { put(false); continue; }   // (a later age's page)
          put({ icon: c.icon, name: 'İnşa: ' + c.name, desc: c.desc, run: () => { this.page = k; return true; } });
        }
      }
      // stances for soldiers (owner 2026-11-15): aggressive / defensive / hold ground; the active one is marked
      const fighters = ents.filter((e) => e.kind === 'unit' && UNITS[e.type] && UNITS[e.type].cls !== 'civil' && UNITS[e.type].atk > 0);
      if (fighters.length) {
        const cur = (st) => fighters.every((e) => (e.stance || 'aggressive') === st);
        const ST = [
          ['aggressive', 'x-stance-aggr', 'Saldırgan', 'Gördüğü düşmanı kovalar (varsayılan).'],
          ['defensive', 'x-stance-def', 'Savunma', 'Yakına gelen düşmanla dövüşür, en fazla birkaç kare kovalar, sonra yerine döner.'],
          ['hold', 'x-stance-hold', 'Mevzi Koru', 'Hiç yerinden ayrılmaz; yalnızca menziline gireni vurur. Duvar arkasındaki okçu ve mancınıklar için.'],
        ];
        ST.forEach(([st, em, nm, ds], i) => put({ icon: ico(em), name: nm, desc: ds + ' Seçili mod altın çerçeveyle gösterilir.', active: () => cur(st), run: () => safe(() => g.cmdStance(fighters.map((e) => e.id), st), false) !== false }, 5 + i));
      }
      put({ icon: ico('x-stop'), name: 'Dur', desc: 'Seçili birimler mevcut işini bırakır.', run: () => safe(() => g.cmdStop(ids), false) !== false }, 10);
      put({ icon: ico('x-explore'), name: 'Keşfet', desc: 'Seçili birimler haritada kendi kendine dolaşıp keşfedilmemiş bölgeleri açar. Başka bir emir verene kadar sürer.', run: () => safe(() => g.cmdExplore(ids), false) !== false }, 11);
      const tr = ents.find((u) => u.type === 'transport');
      if (tr) {
        put({
          icon: ico('x-unload'), name: 'Boşalt', desc: 'Nakliye gemisindeki birimleri kıyıya indir: ardından kıyıda bir noktaya sol tıkla (Esc: iptal).',
          check: () => ((tr.cargo || []).length ? { ok: true } : { ok: false, reason: 'Gemi boş' }),
          run: () => !!safe(() => this.app.input?.startUnload?.(tr.id), false),
        }, 12);
      }
      put(del, 14);
      return slots;
    }
    if (first.kind !== 'building') return slots;
    // several own buildings: same type -> one shared card (train runs in EACH), mixed types -> no train buttons
    if (ents.length > 1 && !ents.every((x) => x.kind === 'building' && x.owner === this._me() && x.type === first.type)) { put(del, 14); return slots; }
    const pool = ents.length > 1 ? ents.filter((x) => x.done) : [first];
    const e = pool[0] || first, bd = BUILDINGS[e.type] || {};
    const many = () => (this.app.input?.shift ? 5 : 1); // Shift+click / Shift+hotkey: 5 per building
    if (!e.done) { put({ ...del, name: 'İnşaatı İptal Et', desc: 'Temeli kaldır.' }, 14); return slots; }
    if (e.type === 'market' && this.page === 'barter') {
      // one row per resource given: food, wood, stone -> the other two (Shift: 5 times)
      for (const a of BARTER_RES) {
        for (const b of BARTER_RES) {
          if (a === b) continue;
          put({
            icon: `<span class="bart"><span class="b1">${RES_ICON[a]}</span><em>➜</em><span class="b2">${RES_ICON[b]}</span></span>`, lbl: RES_NAME[b] + ' al',
            name: `${RES_NAME[a]} ver, ${RES_NAME[b]} al`,
            get desc() { return `100 ${RES_NAME[a]} karşılığında ${Math.floor(safe(() => g.tradeRate(a, b, p.id ?? 0), 0))} ${RES_NAME[b]} al. Shift: 5 kez (500).`; },
            check: () => ((p.res[a] || 0) >= 100 ? { ok: true } : { ok: false, reason: 'Yetersiz ' + RES_NAME[a].toLowerCase() }),
            run: () => { let ok = false; for (let i = many(); i > 0; i--) if (safe(() => g.trade(this._me(), a, b), false)) ok = true; return ok; },
          });
        }
        put(false);   // (one row per resource given: two pairs, then gaps)
        put(false);
        put(false);
      }
      put({ icon: ico('x-back'), name: 'Geri', desc: 'Pazar menüsüne dön. (Sağ tık ya da Esc de döner.)', run: () => { this.page = 'root'; return true; } }, 14);
      return slots;
    }
    if (e.type === 'wall' && ents.length === 1) {
      const gd = BUILDINGS.gate;
      put({
        icon: gd.icon || ico('b-gate'), name: 'Kapı Aç', cost: gd.cost,
        desc: 'Bu sur parçasını ve iki yanını 3 kare genişliğinde bir kapıya çevirir, hemen açılır. Kapıdan yalnızca senin ve müttefiklerinin birlikleri geçer.',
        check: () => { const c = safe(() => g.canOpenGate(this._me(), e.id), { ok: true }); return c.ok ? { ok: true } : { ok: false, reason: c.reason }; },
        run: () => !!safe(() => g.cmdOpenGate(e.id), false),
      }, 0);
    }
    for (const uid of bd.trains || []) {
      const u = UNITS[uid]; if (!u) continue;
      if (later(u.age)) { put(false); continue; }
      put({
        icon: u.icon || ico('x-unknown'), name: u.name, cost: u.cost, time: u.time * QUEUE_TIME_MUL / (sb * (1 + (p.mods?.train || 0) + (e.type === 'factory' ? (p.mods?.factory || 0) : 0))),
        desc: (u.desc || '') + ` — ${ico('x-atk')}${u.atk} ${ico('x-armor')}${u.armor} ${ico('x-hp')}${u.hp}${u.range ? ' ' + ico('x-range') + u.range : ''} ${ico('x-pop')}${u.pop ?? 1}` + (pool.length > 1 ? ` · ${pool.length} binada aynı anda` : '') + ' · Shift: 5 adet',
        check: () => {
          if (!safe(() => g.isUnlocked(this._me(), 'unit', uid), true)) return { ok: false, locked: true, reason: 'Gerekli çağ: ' + (AGES[u.age]?.name || u.age) };
          if (!afford(u.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
          if (p.pop + (u.pop ?? 1) > p.popCap) return { ok: false, reason: 'Nüfus sınırı dolu (1000)' };
          return { ok: true };
        },
        run: () => { let ok = false; for (let i = many(); i > 0; i--) for (const b of pool) if (safe(() => g.train(b.id, uid), false)) ok = true; return ok; },
      });
    }
    const queuedTech = new Set();
    for (const b of safe(() => g.buildingsOf(this._me()), [])) for (const q of b.queue || []) if (q.kind === 'tech') queuedTech.add(q.id);
    for (const tid of bd.researches || []) {
      // a researched / queued tech leaves its slot empty, so the others keep their place and hotkey (2026-11-17
      // playtest: "the blacksmith's upgrades shift when one disappears")
      const t = TECHS[tid]; if (!t) continue;
      if (p.techs?.has(tid) || queuedTech.has(tid)) { put(false); continue; }
      if (later(t.age)) { put(false); continue; }
      put({
        icon: t.icon || ico('x-tech'), name: t.name, cost: t.cost, time: t.time * QUEUE_TIME_MUL / sb, desc: t.desc,
        check: () => {
          if (!safe(() => g.isUnlocked(this._me(), 'tech', tid), true)) return { ok: false, locked: true, reason: 'Gerekli çağ: ' + (AGES[t.age]?.name || t.age) };
          if (!afford(t.cost)) return { ok: false, reason: 'Yetersiz kaynak' };
          return { ok: true };
        },
        run: () => pool.some((b) => safe(() => g.research(b.id, tid), false)),
      });
    }
    if (e.type === 'towncenter' && p.age < AGES.length - 1 && !pool.some((b) => (b.queue || []).some((q) => q.kind === 'age'))) {
      const na = AGES[p.age + 1];
      put({
        icon: ico('x-ageup'), name: 'Çağ Atla: ' + na.name, cost: na.cost, time: na.time * QUEUE_TIME_MUL / sb,
        desc: (na.unlockText || []).join(' · ') || 'Sonraki çağa geç.',
        check: () => { const r = safe(() => g.canAgeUp(this._me()), { ok: false, reason: '' }) || { ok: false }; return { ok: !!r.ok, reason: r.reason }; },
        run: () => pool.some((b) => safe(() => g.ageUp(b.id), false)),
      }, 9);
    }
    if (e.type === 'market') {
      for (const r of ['food', 'wood', 'stone']) {
        put({
          icon: RES_ICON[r], lbl: 'Sat', name: `${RES_NAME[r]} Sat`,
          get desc() { return `100 ${RES_NAME[r]} karşılığında ${Math.floor(safe(() => g.tradeRate(r, 'gold', p.id ?? 0), 0))} Altın al.`; },
          check: () => ((p.res[r] || 0) >= 100 ? { ok: true } : { ok: false, reason: 'Yetersiz ' + RES_NAME[r].toLowerCase() }),
          run: () => safe(() => g.trade(this._me(), r, 'gold'), false),
        });
      }
      for (const r of ['food', 'wood', 'stone']) {
        put({
          icon: RES_ICON[r], lbl: 'Al', name: `${RES_NAME[r]} Al`,
          get desc() { return `100 Altın karşılığında ${Math.floor(safe(() => g.tradeRate('gold', r, p.id ?? 0), 0))} ${RES_NAME[r]} al.`; },
          check: () => ((p.res.gold || 0) >= 100 ? { ok: true } : { ok: false, reason: 'Yetersiz altın' }),
          run: () => safe(() => g.trade(this._me(), 'gold', r), false),
        });
      }
      // barter (owner playtest 2026-11-14): resource for resource on its own page
      put({
        icon: ico('x-trade'), lbl: 'Takas', name: 'Takas: Kaynak ver, kaynak al',
        desc: 'Altına çevirmeden doğrudan takas: örneğin odun verip yiyecek al. Tek adımda, sat-al yapmaktan biraz daha kârlı.',
        run: () => { this.page = 'barter'; return true; },
      });
    }
    put(del, 14);
    return slots;
  }
  // (Geri / a build page swaps the whole card under the cursor: Geri sits in slot 14, where the root card has "Sil".
  // A double click or a second quick press used to hit "Sil" and delete the villagers, and the tooltip jumped to
  // "Sil". After a page switch the card ignores clicks and hover for a moment.)
  _renderCard(ents) {
    if (this._cardPage !== this.page) { if (this._cardPage != null) this._cardGuardT = performance.now() + CARD_GUARD_MS; this._cardPage = this.page; }
    const specs = this._specs(ents);
    this.cardEl.classList.toggle('empty', !specs.some(Boolean)); // no commands -> hide the whole card
    this.cardEl.innerHTML = '';
    this.buttons = [];
    specs.forEach((s, i) => {
      if (!s) { this.cardEl.append(el('div', 'cmd-empty')); this.buttons.push(null); return; }
      s.hotkey = HOTKEYS[i];
      const node = el('button', 'cmd', `<span>${s.icon}</span><span class="hk">${s.hotkey}</span>${s.lbl ? `<span class="lbl">${s.lbl}</span>` : ''}`);
      const b = { node, spec: s, ok: true };
      node.onclick = () => { if (performance.now() < (this._cardGuardT || 0)) return; this._press(b); };
      node.oncontextmenu = (ev) => { ev.preventDefault(); if (this.page !== 'root') this.cardBack(); };   // right click: back to the main card
      this._tip(node, () => s);
      this.cardEl.append(node); this.buttons.push(b);
    });
  }
  _press(b) {
    const c = b.spec.check ? safe(b.spec.check, { ok: true }) : { ok: true };
    if (!c.ok) {
      this._error();
      let why = c.reason || '';
      if (why === 'Yetersiz kaynak' && b.spec.cost) {
        const res = this.game?.players?.[0]?.res || {};
        const miss = RES_LIST.filter((r) => (b.spec.cost[r] || 0) > (res[r] || 0)).map((r) => `${RES_ICON[r]} ${Math.ceil(b.spec.cost[r] - (res[r] || 0))}`);
        if (miss.length) why = 'Yetersiz kaynak — eksik: ' + miss.join(' · ');
      }
      if (why) this.hint('press:' + (c.reason || ''), '⛔ ' + why, 'warn', 2.5);
      return;
    }
    const r = safe(() => b.spec.run(), false);
    if (r === false || r == null) this._error(); else this._click();
    this.cardSig = null; this.selSig = null;
    this.tipEl.classList.add('hidden');
    safe(() => { this._refreshSel(); this._refreshCard(); });
  }
  // Called by input: triggers the visible command button bound to the key. Returns true if handled.
  hotkey(key) {
    if (this.mode !== 'hud' || !this.game || this.app.paused) return false;
    const i = HOTKEYS.indexOf(String(key || '').toUpperCase());
    if (i < 0) return false;
    const b = this.buttons[i];
    if (!b) return false;
    if (performance.now() < (this._cardGuardT || 0)) return true;   // (B twice: Geri, then not "Sil")
    this._press(b);
    return true;
  }
  // a build page is open: back to the main card (Geri, right click on the card, Esc). Returns true if it went back.
  cardBack() {
    if (this.page === 'root') return false;
    this.page = 'root'; this.cardSig = null;
    this.tipEl.classList.add('hidden');
    safe(() => this._refreshCard());
    return true;
  }

  // ------------------------------------------------------------------ quests
  _refreshQuests() {
    const list = this.game.quests?.list || [], now = performance.now();
    const show = list.filter((q) => !q.done || (this.questDoneAt.has(q.id) && now - this.questDoneAt.get(q.id) < 4500)).slice(0, 4);
    const sig = show.map((q) => q.id + (q.done ? 1 : 0) + (q.progress || '')).join('|');
    if (sig === this.questSig) return;
    this.questSig = sig;
    let h = '<h4>Görevler</h4>';
    if (!show.length) h += '<div class="quest"><div class="qd">Tüm görevler tamamlandı.</div></div>';
    for (const q of show) {
      h += `<div class="quest${q.done ? ' done' : ''}"><div class="qt">${esc(q.title)}</div><div class="qd">${esc(q.desc || '')}</div>${q.progress ? `<div class="qp">${esc(q.progress)}</div>` : ''}${q.reward ? `<div class="qr">Ödül: ${this._rewardText(q.reward)}</div>` : ''}</div>`;
    }
    this.questsEl.innerHTML = h;
  }

  // ------------------------------------------------------------------ minimap
  _bindMinimap() {
    const pos = (ev) => {
      const r = this.mm.getBoundingClientRect(), N = this.game?.map?.size || 1;
      return { x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * N, z: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)) * N };
    };
    let drag = false;
    this.mm.addEventListener('mousedown', (ev) => {
      if (!this.game) return;
      const p = pos(ev);
      // flare: Alt + click, or the 📍 button armed
      if (ev.button === 0 && (ev.altKey || this.app.input?.flareArmed)) { this.app.input?.disarmFlare(); this.app.flare?.(p.x, p.z); ev.preventDefault(); return; }
      if (ev.button === 0) { drag = true; this.app.focus?.(p.x, p.z); }
      else if (ev.button === 2) this.app.commandGround?.(p.x, p.z);
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => { if (drag && this.game) { const p = pos(ev); this.app.focus?.(p.x, p.z); } });
    window.addEventListener('mouseup', () => { drag = false; });
    this.mm.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }
  _drawMinimap() {
    const g = this.game, map = g.map; if (!map) return;
    const N = map.size, ctx = this.mm.getContext('2d'), k = MM / N;
    const clim = this.app.renderer && this.app.renderer.climate, ckey = (this.app.renderer && this.app.renderer.climateKey) || '';
    if (!this.mmTerrain || this.mmTerrain.width !== N || this._mmClimate !== ckey || this._mmGame !== g) {
      this._mmClimate = ckey; this._mmGame = g;
      const tcol = TILE_COL.slice(); if (clim && clim.mm) { tcol[0] = clim.mm[0]; tcol[6] = clim.mm[1]; }   // (grass and forest floor in the climate's colours)
      const c = document.createElement('canvas'); c.width = N; c.height = N;
      const cx = c.getContext('2d'), img = cx.createImageData(N, N);
      for (let i = 0; i < N * N; i++) {
        const col = tcol[map.tiles[i]] || tcol[0];
        const sh = 0.9 + ((i * 2654435761 >>> 0) % 100) / 500;
        img.data[i * 4] = col[0] * sh; img.data[i * 4 + 1] = col[1] * sh; img.data[i * 4 + 2] = col[2] * sh; img.data[i * 4 + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      this.mmTerrain = c;
      this.mmFog = document.createElement('canvas'); this.mmFog.width = N; this.mmFog.height = N; this.mmFogVer = -1; this._mmFogImg = null;
    }
    if (g.fog && this.mmFogVer !== g.fogVersion) {
      this.mmFogVer = g.fogVersion;
      // (speed 2026-11-15: one pixel buffer kept for the game, only changed cells rewritten; it was a fresh 4*N*N
      //  buffer four times a second)
      const fx = this.mmFog.getContext('2d');
      if (!this._mmFogImg || this._mmFogImg.width !== N) { this._mmFogImg = fx.createImageData(N, N); this._mmFogPrev = new Uint8Array(N * N).fill(255); }
      const img = this._mmFogImg, d = img.data, prev = this._mmFogPrev, fog = g.fog;
      for (let i = 0; i < N * N; i++) { const f = fog[i]; if (f === prev[i]) continue; prev[i] = f; d[i * 4 + 3] = f === 0 ? 255 : f === 1 ? 120 : 0; }
      fx.putImageData(img, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mmTerrain, 0, 0, MM, MM);
    // resources (drawn under fog so unexplored ones stay hidden)
    if (!this._mmRes || this._mmResG !== g || g.time - this._mmResT > 2 || g.time < this._mmResT) { this._mmResG = g; this._mmResT = g.time; this._mmRes = []; for (const e of g.entities.values()) if (e.kind === 'resource' && e.type !== 'tree' && e.type !== 'deer') this._mmRes.push(e); }
    for (const e of this._mmRes) {
      if (e.dead || e.kind !== 'resource' || e.type === 'tree' || e.type === 'deer') continue;
      if (e.type === 'fish') { ctx.fillStyle = '#9fe4ff'; ctx.beginPath(); ctx.arc(e.x * k, e.z * k, 1.6, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.fillStyle = e.type === 'gold' ? '#ffd84a' : e.type === 'stone' ? '#c9cdd4' : '#d86aa0';
      ctx.fillRect(e.x * k - 1.5, e.z * k - 1.5, 3, 3);
    }
    if (g.fog) { ctx.imageSmoothingEnabled = true; ctx.drawImage(this.mmFog, 0, 0, MM, MM); }
    // rail: thin dark lines between neighbouring rail tiles
    const rails = new Map();
    for (const e of g.buildings) if (!e.dead && e.kind === 'building' && e.type === 'rail' && (e.owner === this._me() || safe(() => g.isEntityVisible(e), true))) rails.set(Math.floor(e.x) + ',' + Math.floor(e.z), e);
    if (rails.size) {
      ctx.strokeStyle = 'rgba(30,24,20,.95)'; ctx.lineWidth = 1.2; ctx.beginPath();
      for (const e of rails.values()) {
        const tx = Math.floor(e.x), tz = Math.floor(e.z), cx = (tx + 0.5) * k, cz = (tz + 0.5) * k;
        let lone = true;
        if (rails.has((tx + 1) + ',' + tz)) { ctx.moveTo(cx, cz); ctx.lineTo(cx + k, cz); lone = false; }
        if (rails.has(tx + ',' + (tz + 1))) { ctx.moveTo(cx, cz); ctx.lineTo(cx, cz + k); lone = false; }
        if (lone && !rails.has((tx - 1) + ',' + tz) && !rails.has(tx + ',' + (tz - 1))) { ctx.moveTo(cx - 0.8, cz); ctx.lineTo(cx + 0.8, cz); }
      }
      ctx.stroke();
    }
    // units and buildings in the same (id) order the entity map gives, without walking the map's trees
    const mmE = g.units.concat(g.buildings).sort((x, y) => x.id - y.id);
    for (const e of mmE) {
      if (e.dead || e.kind === 'resource' || e.aboard != null || (e.kind === 'building' && e.type === 'rail')) continue;
      if (e.owner !== this._me() && !safe(() => g.isEntityVisible(e), true)) continue;
      ctx.fillStyle = hex(PLAYER_COLORS[e.owner] ?? 0xffffff);
      if (e.train) { ctx.fillStyle = '#fff6a8'; ctx.beginPath(); ctx.arc(e.x * k, e.z * k, 2.2, 0, Math.PI * 2); ctx.fill(); continue; }
      if (e.naval || UNITS[e.type]?.naval) { const r = 2.4; ctx.beginPath(); ctx.moveTo(e.x * k, e.z * k - r); ctx.lineTo(e.x * k + r, e.z * k); ctx.lineTo(e.x * k, e.z * k + r); ctx.lineTo(e.x * k - r, e.z * k); ctx.closePath(); ctx.fill(); continue; }
      if (e.kind === 'building') { const s = Math.max(3, (e.size || 1) * k); ctx.fillRect(e.x * k - s / 2, e.z * k - s / 2, s, s); if (g.mp && e.owner !== this._me() && this._ally(this._me(), e.owner)) { ctx.strokeStyle = 'rgba(140,200,255,.95)'; ctx.lineWidth = 1; ctx.strokeRect(e.x * k - s / 2 - 0.5, e.z * k - s / 2 - 0.5, s + 1, s + 1); } }
      else ctx.fillRect(e.x * k - 1.25, e.z * k - 1.25, 2.5, 2.5);
    }
    // selection highlight
    ctx.fillStyle = '#fff';
    for (const e of this._ents()) if (e.owner === this._me() && e.kind === 'unit') ctx.fillRect(e.x * k - 1, e.z * k - 1, 2, 2);
    // camera marker
    const cam = this.app.renderer?.cam;
    if (cam) {
      const w = Math.max(6, (cam.dist || 30) * 1.5 * k), h = w * 0.62;
      ctx.save(); ctx.translate(cam.tx * k, cam.tz * k); ctx.rotate(-(cam.yaw || 0));
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.3; ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    // pings
    const now = performance.now();
    this.pings = this.pings.filter((p) => now - p.t < 5000);
    for (const p of this.pings) {
      const rings = p.big ? 3 : 1, R = p.big ? 30 : 14;
      for (let i = 0; i < rings; i++) {
        const a = Math.max(0, (now - p.t + i * 300) % 900) / 900;
        ctx.strokeStyle = `rgba(255,70,70,${1 - a})`; ctx.lineWidth = p.big ? 2.6 : 2;
        ctx.beginPath(); ctx.arc(p.x * k, p.z * k, 3 + a * R, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#ff4646'; ctx.fillRect(p.x * k - 3, p.z * k - 3, 6, 6);
    }
    // map flares (ours and our teammates'): the player's colour, three expanding rings and a pin
    this.flares = (this.flares || []).filter((f) => now - f.t < FLARE_MS);
    for (const f of this.flares) {
      const age = now - f.t, col = f.col;
      for (let i = 0; i < 3; i++) {
        const a = ((age + i * 400) % 1200) / 1200;
        ctx.strokeStyle = col; ctx.globalAlpha = (1 - a) * (age > FLARE_MS - 1000 ? (FLARE_MS - age) / 1000 : 1); ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.arc(f.x * k, f.z * k, 4 + a * 22, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(f.x * k, f.z * k, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(f.x * k, f.z * k, 2.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // a map flare {pid, name, x, z, mine}: minimap rings, markers on the ground, a sound and a clickable toast
  showFlare(f) {
    if (!f || !this.game) return;
    const col = hex(PLAYER_COLORS[f.pid] ?? 0xffd84a);
    (this.flares || (this.flares = [])).push({ x: f.x, z: f.z, t: performance.now(), col });
    const r = this.app.renderer, c = PLAYER_COLORS[f.pid] ?? 0xffd84a;
    // a few pulses on the ground where it points
    for (let i = 0; i < 4; i++) setTimeout(() => safe(() => r.addMarker(f.x, f.z, c)), i * 700);
    safe(() => this.app.audio?.ui('chat'));
    if (!f.mine) this.toast(ico('x-flare') + ' ' + (f.name || 'Takım arkadaşın') + ' haritada işaret verdi (git: tıkla)', 'info', f.x, f.z);
  }
  _closeModal(force) { if (this.modalLocked && !force) return; this._tribOpen = false; this.modalLocked = false; this.techTiles = null; this.modalEl.classList.add('hidden'); this.modalEl.innerHTML = ''; }
  _score(p) {
    const s = p.stats || {}, ga = s.gathered || {};
    const techs = typeof s.techs === 'number' ? s.techs : (p.techs?.size || 0);
    return Math.round(RES_LIST.reduce((a, r) => a + (ga[r] || 0), 0) / 10 + (s.kills || 0) * 20 + (s.buildingsBuilt || 0) * 15 + (s.razed || 0) * 40 + techs * 30 + (p.age || 0) * 200 + (s.unitsTrained || 0) * 5);
  }
  _statsTable(showAll) {
    const g = this.game, ps = g.players.filter((p) => showAll || p.id === this._me() || this._ally(this._me(), p.id) || g.over || this._enemyKnown(p));
    const row = (label, fn) => `<tr><td>${label}</td>${ps.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`;
    const st = (p) => p.stats || {};
    let h = '<table class="st"><tr><th></th>' + ps.map((p) => `<th><span class="dot" style="background:${hex(PLAYER_COLORS[p.id] ?? 0xffffff)}"></span>${p.id === this._me() ? 'Sen' : this.game?.mp ? esc(this._pname(p.id)) + ` <small>T${this._teamOf(p.id)}</small>` : 'Rakip ' + p.id}${p.defeated ? ' ☠' : ''}</th>`).join('') + '</tr>';
    h += row('Skor', (p) => `<b style="color:var(--gold)">${this._score(p)}</b>`);
    h += row('Çağ', (p) => AGES[p.age]?.name || p.age);
    for (const r of RES_LIST) h += row(`${RES_ICON[r]} Toplanan ${RES_NAME[r]}`, (p) => Math.floor(st(p).gathered?.[r] || 0));
    h += row('Eğitilen Birim', (p) => st(p).unitsTrained || 0);
    h += row('Kaybedilen Birim', (p) => st(p).unitsLost || 0);
    h += row('Öldürülen Düşman', (p) => st(p).kills || 0);
    h += row('İnşa Edilen Bina', (p) => st(p).buildingsBuilt || 0);
    h += row('Kaybedilen Bina', (p) => st(p).buildingsLost || 0);
    h += row('Yıkılan Düşman Binası', (p) => st(p).razed || 0);
    h += row('Araştırma', (p) => (typeof st(p).techs === 'number' ? st(p).techs : p.techs?.size || 0));
    return h + '</table>';
  }
  _enemyKnown(p) {
    const g = this.game;
    for (const e of g.entities.values()) if (e.owner === p.id && !e.dead && safe(() => g.isEntityVisible(e), false)) return true;
    return false;
  }
  // ------------------------------------------------------------------ tribute: send resources to an ally
  _allies() {
    const g = this.game, me = this._me(); if (!g || !g.players) return [];
    return g.players.filter((p) => p.id !== me && this._ally(me, p.id) && !p.defeated && !p.left).map((p) => p.id);
  }
  showTribute() {
    if (!this.game || !this._allies().length) return;
    this.modalLocked = false; this.techTiles = null;
    this._tribOpen = true;
    if (!this._trib || !this._allies().includes(this._trib.to)) this._trib = { to: this._allies()[0], res: (this._trib && this._trib.res) || 'wood' };
    this._renderTribute();
    this.modalEl.classList.remove('hidden');
  }
  _renderTribute() {
    const g = this.game, me = this._me(), p = g?.players?.[me], st = this._trib;
    if (!p || !st || this.modalEl.classList.contains('hidden') && !this._tribOpen) return;
    const allies = this._allies();
    if (!allies.includes(st.to)) st.to = allies[0];
    this.modalEl.innerHTML = '';
    const m = el('div', 'modal panel tribute');
    m.append(el('h2', '', 'Müttefike Kaynak Gönder'), el('div', 'tsub', 'Gönderdiğin kaynak kesintisiz takım arkadaşına geçer.'));
    const row = (label) => { const r = el('div', 'trow'); r.append(el('div', 'tlbl', label)); m.append(r); return r; };
    const ar = row('Kime');
    for (const id of allies) {
      const q = g.players[id];
      const b = el('button', 'tchip' + (id === st.to ? ' on' : ''), `<span class="dot" style="background:${hex(PLAYER_COLORS[id] ?? 0xffffff)}"></span>${esc(this._pname(id))}<small>${RES_LIST.map((r) => `${RES_ICON[r]}${Math.floor(q.res?.[r] || 0)}`).join(' ')}</small>`);
      b.onclick = () => { this._click(); st.to = id; this._renderTribute(); };
      ar.append(b);
    }
    const rr = row('Kaynak');
    for (const r of RES_LIST) {
      const b = el('button', 'tchip' + (r === st.res ? ' on' : ''), `${RES_ICON[r]} ${RES_NAME[r]} <small>${Math.floor(p.res[r] || 0)}</small>`);
      b.onclick = () => { this._click(); st.res = r; this._renderTribute(); };
      rr.append(b);
    }
    const nr = row('Gönder');
    const have = Math.floor(p.res[st.res] || 0);
    for (const [label, amt] of [['100', 100], ['500', 500], ['Tümü', have]]) {
      const b = el('button', 'mbtn small' + (label === '500' ? ' primary' : ''), `${label === 'Tümü' ? 'Tümü (' + have + ')' : label} ${RES_ICON[st.res]}`);
      b.disabled = have < 1 || (amt !== have && have < amt);
      b.onclick = () => {
        const c = safe(() => g.canTribute(me, st.to, st.res, amt), { ok: false, reason: '' });
        if (!c.ok) { this._error(); if (c.reason) this.toast('⛔ ' + c.reason, 'warn'); return; }
        this._click();
        safe(() => g.cmdTribute(me, st.to, st.res, amt));   // (multiplayer: through the lockstep; the toast comes when it runs)
        setTimeout(() => { if (this._tribOpen && this.modalEl.querySelector('.tribute')) safe(() => this._renderTribute()); }, 60);
      };
      nr.append(b);
    }
    const close = el('button', 'mbtn small', 'Kapat'); close.onclick = () => { this._click(); this._tribOpen = false; this._closeModal(); };
    m.append(close);
    this.modalEl.append(m);
  }
  showStats() {
    if (!this.game) return;
    this.modalLocked = false; this.techTiles = null;
    this.modalEl.innerHTML = '';
    const m = el('div', 'modal panel', `<h2>İstatistikler</h2><div style="color:var(--dim)">Süre: ${fmtTime(this.game.time || 0)} · Rakipler yalnızca keşfedildiğinde listelenir</div>${this._statsTable(false)}`);
    const b = el('button', 'mbtn small', 'Kapat'); b.onclick = () => { this._click(); this._closeModal(); };
    m.append(b); this.modalEl.append(m); this.modalEl.classList.remove('hidden');
  }
  showGameOver(won) {
    if (this.gameOverShown || !this.game) return;
    this.gameOverShown = true; this.modalLocked = true; this.techTiles = null;
    this.pauseEl.classList.add('hidden');
    this.modalEl.innerHTML = '';
    if (this.game.mp) won = this._mpWon(won);
    const wt = this.game.mp ? this._winTeam() : null, wtxt = wt != null ? `Takım ${wt} kazandı! ` : '';
    const m = el('div', 'modal panel', `<h1 class="${won ? 'win' : 'lose'}">${won ? 'ZAFER' : 'YENİLGİ'}</h1><div style="color:var(--dim)">${wtxt}${won ? (this.game.mp ? 'Takımın tüm rakipleri alt etti.' : 'Tüm rakiplerini alt ettin. Uygarlığın çağlara damga vurdu.') : 'Uygarlığın tarihe karıştı.'} · Süre: ${fmtTime(this.game.time || 0)}</div>${this._statsTable(true)}`);
    const btn = (t, fn, cls = '') => { const b = el('button', 'mbtn small ' + cls, t); b.onclick = () => { this._click(); fn(); }; m.append(b); };
    const cfg = this.game.cfg;
    if (!this.app.net) btn('Yeniden Oyna', () => { this._closeModal(true); this.app.newGame({ ...cfg, seed: (Math.random() * 1e9) | 0 }); }, 'primary');
    btn('Haritayı İzle', () => { this._closeModal(true); if (!this.app.net) { this.game.spectate = true; safe(() => this.app.setPaused?.(false)); } this.toast?.('👁 Tüm harita açıldı — izleme modu', 'info'); });
    btn('Ana Menü', () => { this._closeModal(true); if (this.app.net) safe(() => this.app.leaveMultiplayer ? this.app.leaveMultiplayer() : this.app.net.close?.()); safe(() => this.app.toMenu?.()); this.showMenu(); });
    this.modalEl.append(m); this.modalEl.classList.remove('hidden');
  }
  // ------------------------------------------------------------------ technology tree
  _techBuildings() {
    const m = {};
    for (const bid of Object.keys(BUILDINGS)) for (const tid of BUILDINGS[bid].researches || []) (m[tid] = m[tid] || []).push(bid);
    return m;
  }
  // state of one tech for player 0: done | prog | lockAge | noBld | orphan | ok
  _techState(tid, owners) {
    const g = this.game, p = g.players[this._me()], t = TECHS[tid];
    if (p.techs?.has(tid)) return { k: 'done', txt: '✓ Araştırıldı' };
    const mine = safe(() => g.buildingsOf(this._me()), []);
    for (const b of mine) {
      const qi = (b.queue || []).findIndex((q) => q.kind === 'tech' && q.id === tid);
      if (qi === 0) return { k: 'prog', txt: 'Araştırılıyor %' + Math.floor(this._qprog(b.queue[0]) * 100) };
      if (qi > 0) return { k: 'prog', txt: 'Sırada' };
    }
    if (!safe(() => g.isUnlocked(this._me(), 'tech', tid), (p.age ?? 0) >= (t.age ?? 0))) return { k: 'lockAge', txt: ico('x-lock') + ' ' + (AGES[t.age]?.name || 'Çağ ' + t.age) };
    if (!owners || !owners.length) return { k: 'orphan', txt: '—' };
    if (!mine.some((b) => b.done && owners.includes(b.type))) return { k: 'noBld', txt: ico('x-lock') + ' ' + owners.map((o) => BUILDINGS[o]?.name || o).join(' / ') + ' gerekli' };
    return { k: 'ok', txt: safe(() => g.canAfford(this._me(), t.cost), true) ? 'Araştırılabilir' : 'Yetersiz kaynak' };
  }
  _techClick(tid, owners) {
    const g = this.game, t = TECHS[tid], st = this._techState(tid, owners);
    if (st.k === 'done' || st.k === 'prog') { this._error(); return; }
    if (st.k === 'lockAge') { this._error(); this.toast('⛔ Gerekli çağ: ' + (AGES[t.age]?.name || t.age), 'warn'); return; }
    if (st.k !== 'ok') { this._error(); this.toast('⛔ Önce inşa et: ' + ((owners || []).map((o) => BUILDINGS[o]?.name || o).join(' / ') || 'araştıran bina yok'), 'warn'); return; }
    if (!safe(() => g.canAfford(this._me(), t.cost), true)) { this._error(); this.toast('⛔ Yetersiz kaynak: ' + t.name, 'warn'); return; }
    const cands = safe(() => g.buildingsOf(this._me()), []).filter((b) => b.done && owners.includes(b.type)).sort((a, b) => (a.queue?.length || 0) - (b.queue?.length || 0));
    let ok = false;
    for (const b of cands) { const r = safe(() => g.research(b.id, tid), false); if (r !== false && r != null) { ok = true; break; } }
    if (ok) { this._click(); this.toast(`${t.icon || ico('x-tech')} Araştırma başladı: ${t.name}`, 'info'); this.cardSig = null; this.selSig = null; }
    else { this._error(); this.toast('⛔ Araştırma başlatılamadı: ' + t.name, 'warn'); }
    this._refreshTech();
  }
  showTech() {
    if (!this.game || this.modalLocked) return;
    this.modalEl.innerHTML = '';
    const owners = this._techBuildings();
    const m = el('div', 'modal panel techmodal', `<h2>${ico('x-tech')} Teknoloji Ağacı</h2><div class="techhead"></div>`);
    const ids = Object.keys(TECHS);
    const cats = []; for (const id of ids) { const c = TECHS[id].cat || 'other'; if (!cats.includes(c)) cats.push(c); }
    cats.sort((a, b) => { const o = ['eco', 'mil', 'def']; const ia = o.indexOf(a), ib = o.indexOf(b); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib); });
    const grid = el('div', 'techgrid');
    grid.style.gridTemplateColumns = `84px repeat(${AGES.length}, minmax(0, 1fr))`;
    grid.append(el('div', 'tgc'));
    this.techAgeEls = AGES.map((a, i) => { const h = el('div', 'tga', `<small>${i + 1}. Çağ</small>${esc(a.name)}`); grid.append(h); return h; });
    this.techTiles = [];
    for (const c of cats) {
      grid.append(el('div', 'tgl', `<span>${CAT_ICON[c] || ico('x-tech')}</span>${esc(CAT_TR[c] || (c === 'other' ? 'Diğer' : c))}`));
      for (let a = 0; a < AGES.length; a++) {
        const cell = el('div', 'tgcell');
        for (const id of ids) {
          const t = TECHS[id]; if ((t.cat || 'other') !== c || Math.max(0, Math.min(AGES.length - 1, t.age ?? 0)) !== a) continue;
          const ow = owners[id] || [];
          const node = el('button', 'tech', `<span class="ti">${t.icon || ico('x-tech')}</span><span class="tb"><span class="tnm">${esc(t.name)}</span><span class="tcs"></span><span class="tst"></span></span>`);
          this._tip(node, () => ({ name: t.name, cost: t.cost, time: t.time * QUEUE_TIME_MUL / (this.game?.cfg?.sandbox ? 2 : 1), desc: (t.desc || '') + (ow.length ? ' — Araştıran: ' + ow.map((o) => (BUILDINGS[o]?.icon || '') + ' ' + (BUILDINGS[o]?.name || o)).join(', ') : ''), check: () => { const s2 = this._techState(id, ow); return s2.k === 'ok' || s2.k === 'done' || s2.k === 'prog' ? { ok: true } : { ok: false, reason: 'Gerekli: ' + stripIcons(s2.txt).replace(' gerekli', '') }; } }));
          node.onclick = () => this._techClick(id, ow);
          cell.append(node);
          this.techTiles.push({ id, ow, node, cs: node.querySelector('.tcs'), st: node.querySelector('.tst') });
        }
        grid.append(cell);
      }
    }
    m.append(grid);
    m.append(el('div', 'techlegend', `<span class="lg done">✓ Araştırıldı</span><span class="lg ok">Araştırılabilir</span><span class="lg prog">Araştırılıyor</span><span class="lg lock">${ico('x-lock')} Önce binası gerekli</span><span class="lg">Sonraki çağların teknolojileri çağ atlayınca görünür</span>`));
    const b = el('button', 'mbtn small', 'Kapat'); b.onclick = () => { this._click(); this._closeModal(); };
    m.append(b); this.modalEl.append(m); this.modalEl.classList.remove('hidden');
    this.techHeadEl = m.querySelector('.techhead');
    this._refreshTech();
  }
  _refreshTech() {
    const tiles = this.techTiles; if (!tiles || !this.game) return;
    if (!tiles.length || !tiles[0].node.isConnected) { this.techTiles = null; return; }
    const p = this.game.players[this._me()]; let done = 0, prog = 0, shown = 0;
    const age = p.age | 0;
    // techs of later ages are not shown at all: each age up reveals its column
    (this.techAgeEls || []).forEach((h, i) => { const fut = i > age; if (h._fut !== fut) { h._fut = fut; h.innerHTML = fut ? `<small>${i + 1}. Çağ</small>${ico('x-lock')} ?` : `<small>${i + 1}. Çağ</small>${esc(AGES[i].name)}`; } });
    for (const t of tiles) {
      const later = (TECHS[t.id].age | 0) > age;
      if (t.node.hidden !== later) t.node.hidden = later;
      if (later) continue;
      shown++;
      const s2 = this._techState(t.id, t.ow);
      if (s2.k === 'done') done++; else if (s2.k === 'prog') prog++;
      const cls = 'tech ' + s2.k + (s2.k === 'ok' && s2.txt !== 'Araştırılabilir' ? ' poor' : '');
      if (t.node.className !== cls) t.node.className = cls;
      if (t.st._txt !== s2.txt) { t.st._txt = s2.txt; t.st.innerHTML = keepIcons(esc(s2.txt)); }
      const ch = s2.k === 'done' ? '' : this._costHtml(TECHS[t.id].cost);
      if (t._ch !== ch) { t._ch = ch; t.cs.innerHTML = ch; }
    }
    const hd = `<b>${done} / ${shown}</b> araştırıldı${prog ? ` · ${prog} sürüyor` : ''} · Çağın: <b>${esc(AGES[p.age]?.name || '')}</b>`;
    if (this.techHeadEl && this.techHeadEl._h !== hd) { this.techHeadEl._h = hd; this.techHeadEl.innerHTML = hd; }
    (this.techAgeEls || []).forEach((h, i) => { const c = 'tga' + (i === p.age ? ' cur' : i > p.age ? ' fut' : ''); if (h.className !== c) h.className = c; });
  }

  // ------------------------------------------------------------------ age up cinematic
  showAgeUp(age) {
    const a = AGES[age]; if (!a) return;
    this.ageUpEl?.remove();
    const offered = new Set(); for (const k of Object.keys(BUILD_CATS)) for (const id of BUILD_CATS[k].list) offered.add(id);
    const pick = (defs, flt) => Object.keys(defs).filter((id) => (defs[id].age ?? 0) === age && (!flt || flt(id))).map((id) => defs[id]);
    const rows = [['Yeni Binalar', pick(BUILDINGS, (id) => offered.has(id))], ['Yeni Birlikler', pick(UNITS)], ['Yeni Teknolojiler', pick(TECHS)]].filter((r) => r[1].length);
    let body = '';
    if (rows.length) {
      body = '<div class="aurows">' + rows.map(([lab, list], ri) => `<div class="aurow" style="animation-delay:${(1.0 + ri * 0.35).toFixed(2)}s"><div class="aul">${lab}</div><div class="aui">${list.slice(0, 14).map((d, di) => `<span class="auit" style="animation-delay:${(1.15 + ri * 0.35 + di * 0.05).toFixed(2)}s"><i>${d.icon || '✦'}</i><em>${esc(d.name)}</em></span>`).join('')}${list.length > 14 ? `<span class="aumore">+${list.length - 14}</span>` : ''}</div></div>`).join('') + '</div>';
    } else {
      body = `<ul>${(a.unlockText || []).map((t, i) => `<li style="animation-delay:${1.1 + i * 0.25}s">${esc(t)}</li>`).join('')}</ul>`;
    }
    const o = el('div', 'ageup long age-' + age, `<div class="rays"></div><div class="lab">Yeni bir çağ başlıyor</div><div class="big">${esc(a.name.toLocaleUpperCase('tr-TR'))}</div>${body}<div class="auskip">Geçmek için tıkla</div>`);
    for (let i = 0; i < 36; i++) {
      const s = el('span', 'spark');
      s.style.left = Math.random() * 100 + '%';
      s.style.animationDuration = 2 + Math.random() * 2.5 + 's';
      s.style.animationDelay = Math.random() * 3.5 + 's';
      o.append(s);
    }
    const close = () => { if (o._gone) return; o._gone = true; o.classList.add('out'); setTimeout(() => { o.remove(); if (this.ageUpEl === o) this.ageUpEl = null; }, 320); };
    o.addEventListener('mousedown', (ev) => { ev.stopPropagation(); close(); });
    this.root.append(o); this.ageUpEl = o;
    setTimeout(close, 6400);
  }

  // ------------------------------------------------------------------ multiplayer
  _myTeamPlayers() { const g = this.game, me = this._me(); return (g?.players || []).map((p, i) => (p.id ?? i)).filter((id) => this._ally(me, id)); }
  _winTeam() {
    const g = this.game; if (!g) return null;
    const ov = g.over || {}; const t = ov.winnerTeam ?? ov.winningTeam ?? ov.team;
    if (t != null) return t;
    const alive = new Set((g.players || []).map((p, i) => (p.defeated || p.left ? null : this._teamOf(p.id ?? i))).filter((x) => x != null));
    return alive.size === 1 ? [...alive][0] : null;
  }
  _mpWon(fallback) {
    const wt = this._winTeam();
    if (wt != null) return wt === this._teamOf(this._me());
    return !!fallback;
  }
  netStatus(st) {
    st = st || {};
    if (st.type === 'resume') { if (this.netEl) { this.netEl.remove(); this.netEl = null; } return; }
    if (st.type === 'chat') return;   // chat is toasted by the lobby session's 'chat' handler
    if (st.type === 'peerLeft' || st.type === 'desync') { this.toast((st.type === 'desync' ? '⚠ ' : '👋 ') + (st.text || ''), 'warn'); if (st.type === 'peerLeft') return; }
    if (!this.netEl) { this.netEl = el('div', 'netbanner panel'); this.root.append(this.netEl); }
    this.netEl.className = 'netbanner panel ' + (st.type || '');
    this.netEl.textContent = st.text || 'Bekleniyor…';
    if (st.type === 'desync') { const n = this.netEl; setTimeout(() => { if (this.netEl === n) { n.remove(); this.netEl = null; } }, 6000); }
  }
  // ------------------------------------------------------------------ in-game chat (multiplayer only)
  // Docked at the left edge between the scoreboard and the minimap. Closed: the last <=6 lines float
  // there and fade ~12 s after arriving. Open (Enter / 💬): glass panel with the whole match history + input.
  _chatEnsure() {
    if (!this.app.net) return null;
    if (!this.chatDock) {
      const d = el('div', 'chatdock hidden');
      const head = el('div', 'chathead');
      const tg = el('button', 'chattoggle', '💬<span class="chatbadge hidden"></span>');
      tg.title = 'Sohbet (Enter)';
      tg.onmousedown = (ev) => ev.preventDefault();   // keep focus in the input while open
      tg.onclick = () => { this._click(); if (this.chatOpen) this.closeChat(); else this.openChat(); };
      head.append(tg, el('span', 'chattitle', 'Sohbet · Enter: gönder · Esc: kapat'));
      const feed = el('div', 'chatfeed', '<div class="cspacer"></div>');
      const row = el('div', 'chatin');
      const i = el('input', 'mpinput'); i.maxLength = 200; i.placeholder = 'Mesaj yaz…'; i.autocomplete = 'off'; i.spellcheck = false;
      row.append(i);
      d.append(head, feed, row);
      const stop = (ev) => ev.stopPropagation();
      i.addEventListener('keyup', stop); i.addEventListener('keypress', stop);
      i.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const t = i.value.trim().slice(0, 200), s = this.app.net;
          if (!t) { this.closeChat(); return; }
          if (s) safe(() => (s.chat || s.sendChat || s.say)?.call(s, t));
          i.value = '';
        } else if (ev.key === 'Escape') { ev.preventDefault(); this.closeChat(); }
      };
      i.onblur = () => setTimeout(() => { if (this.chatOpen && document.activeElement !== i && !this._chatHover) this.closeChat(); }, 150);
      d.onmouseenter = () => { this._chatHover = true; };
      d.onmouseleave = () => { this._chatHover = false; if (this.chatOpen && document.activeElement !== i) this.closeChat(); };
      d.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
      window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && this.chatOpen && document.activeElement !== i) this.closeChat(); }, true);
      this.hudEl.append(d);
      Object.assign(this, { chatDock: d, chatFeed: feed, chatInput: i, chatBadge: tg.querySelector('.chatbadge') });
      this.chatOpen = false; this.chatUnread = 0;
    }
    if (this._chatSess !== this.app.net) this._chatReset();
    return this.chatDock;
  }
  _chatReset() {
    this._chatSess = this.app.net; this.chatLog = []; this.chatUnread = 0;
    if (this.chatFeed) this.chatFeed.innerHTML = '<div class="cspacer"></div>';
    this._chatBadge();
  }
  _chatBadge() {
    const b = this.chatBadge; if (!b) return;
    b.textContent = this.chatUnread > 9 ? '9+' : String(this.chatUnread || '');
    b.classList.toggle('hidden', !this.chatUnread);
  }
  // m: { from, name, text } from the session's 'chat' event, or { sys: true, text }
  _chatPush(m) {
    if (!m || !this._chatEnsure()) return;
    const s = this.app.net, g = this.game;
    const mine = !m.sys && m.from != null && m.from === safe(() => s.id);
    let pid = mine ? this._me() : safe(() => s.pidOf?.get(m.from));
    const p = pid != null ? g?.players?.[pid] : null;
    const line = el('div', 'cl' + (m.sys ? ' sys' : '') + (mine ? ' mine' : '') + ' new live');
    line.append(el('span', 'ct'));
    line.firstChild.textContent = fmtTime(g?.time || 0);
    if (!m.sys) {
      const n = el('b', 'cn'); n.textContent = (mine ? 'Sen' : (m.name || (pid != null ? this._pname(pid) : '?'))) + ':';
      const col = p?.color ?? (pid != null ? PLAYER_COLORS[pid] : null);
      if (col != null) n.style.color = typeof col === 'number' ? hex(col) : String(col);
      line.append(n);
    }
    const tx = el('span', 'cx'); tx.textContent = String(m.text || '').slice(0, 200); line.append(tx);
    const f = this.chatFeed, nearBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
    f.append(line);
    const item = { at: performance.now(), el: line };
    this.chatLog.push(item);
    while (this.chatLog.length > 250) { const o = this.chatLog.shift(); o.el.remove(); }
    setTimeout(() => line.classList.remove('new'), 1400);
    if (!this.chatOpen || nearBottom) f.scrollTop = f.scrollHeight;
    if (!mine && !m.sys) {
      safe(() => this.app.audio?.ui('chat'));
      if (!this.chatOpen) { this.chatUnread++; this._chatBadge(); }
    }
    this._chatTick();
  }
  _chatSys(text) { if (this.app.net && text) safe(() => this._chatPush({ sys: true, text })); }
  _chatTick() {
    const d = this.chatDock; if (!d) return;
    const on = !!this.app.net && this.mode === 'hud';
    d.classList.toggle('hidden', !on);
    if (!on) { if (this.chatOpen) this.closeChat(); return; }
    if (this._chatSess !== this.app.net) this._chatReset();
    // start right below the multiplayer scoreboard (top-left), never under it
    const sb = this.scoreEl && !this.scoreEl.classList.contains('hidden') ? this.scoreEl.getBoundingClientRect() : null;
    const top = Math.round((sb && sb.height ? sb.bottom : 48) + 10);
    if (top !== this._chatTop) { this._chatTop = top; d.style.setProperty('--chat-top', top + 'px'); }
    const now = performance.now(), L = this.chatLog || [];
    let shown = 0;
    for (let k = L.length - 1; k >= 0; k--) {
      const it = L[k], age = now - it.at, vis = shown < 6 && age < 12000;
      if (vis) shown++;
      it.el.classList.toggle('live', vis); it.el.classList.toggle('fading', vis && age > 10800);
      if (age >= 12000) break;   // everything older has already aged out
    }
  }
  openChat() {
    if (!this.app.net || this.mode !== 'hud' || !this._chatEnsure()) return false;
    const d = this.chatDock;
    d.classList.remove('hidden');
    if (!this.chatOpen) {
      this.chatOpen = true; d.classList.add('open');
      this.chatUnread = 0; this._chatBadge();
      this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
    }
    this.chatInput?.focus();   // synchronously: keys typed right after Enter must land in the input, not the game
    this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
    return true;
  }
  closeChat() {
    if (!this.chatDock) return;
    this.chatOpen = false; this.chatDock.classList.remove('open');
    if (document.activeElement === this.chatInput) this.chatInput.blur();
    this._chatTick();
  }
  _refreshScore() {
    const g = this.game;
    if (!this.app.net || !g?.mp) { if (this.scoreEl) this.scoreEl.classList.add('hidden'); return; }
    if (!this.scoreEl) { this.scoreEl = el('div', 'scoreboard panel'); this.hudEl.append(this.scoreEl); }
    this.scoreEl.classList.remove('hidden');
    const me = this._me();
    const rows = (g.players || []).map((p, i) => ({ p, id: p.id ?? i })).sort((a, b) => this._teamOf(a.id) - this._teamOf(b.id) || a.id - b.id);
    let h = '';
    for (const { p, id } of rows) {
      const ally = this._ally(me, id), you = id === me;
      const res = ally && !you ? `<span class="sbres">${RES_LIST.map((r) => `${RES_ICON[r]}${Math.floor(p.res?.[r] || 0)}`).join(' ')}</span>` : '';
      h += `<div class="sbrow${you ? ' you' : ally ? ' ally' : ''}${p.defeated || p.left ? ' out' : ''}"><span class="dot" style="background:${hex(PLAYER_COLORS[id] ?? 0xffffff)}"></span><span class="sbn">${esc(this._pname(id))}${p.kind === 'ai' ? ' 🤖' : ''}${p.defeated ? ' ☠' : p.left ? ' ⏏' : ''}</span><span class="sbt team${this._teamOf(id)}">T${this._teamOf(id)}</span><span class="sba">${esc((AGES[p.age]?.name || '').split(' ')[0])}</span>${res}</div>`;
    }
    if (h !== this.scoreSig) { this.scoreSig = h; this.scoreEl.innerHTML = h; }
  }
}

installMethods(UI.prototype, menuMethods);

// HUD construction, frame refresh, status, notifications, minimap and flares.
import { AGES, BUILDINGS, PLAYER_COLORS, TECHS, UNITS } from '../data.js';
import { ico, keepIcons, stripIcons } from '../icons.js';
import { el, esc, fmtTime, hex, MAP_TYPE_TR, MM, RES_ICON, RES_LIST, RES_NAME, safe } from './ui-shared.js';

const TILE_COL = [[79, 125, 58], [91, 74, 46], [201, 183, 122], [74, 163, 199], [31, 95, 150], [119, 115, 108], [47, 90, 44]];
const FLARE_MS = 7000;

const ATTACK_TEXT = 'Saldırı altındasın!';   // the sim's notify text for underAttack (the attack banner shows it instead of a toast)
const ATTACK_MS = 4000;  // how long the attack banner stays
const DIR_TR = ['doğusunda', 'güneydoğusunda', 'güneyinde', 'güneybatısında', 'batısında', 'kuzeybatısında', 'kuzeyinde', 'kuzeydoğusunda'];   // how long a map flare stays on the minimap

export const hudMethods = {
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
  },
  showHUD() {
    this.mode = 'hud';
    this.menuOpen = false; this._pauseKey = null;
    this.menuEl.classList.add('hidden');
    this.hudEl.classList.remove('hidden');
    this.cardSig = null; this.selSig = null; this.questSig = null;
  },

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
  },
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
  },

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
  },

  _rewardText(rw) { return RES_LIST.filter((r) => rw[r]).map((r) => `${RES_ICON[r]}+${rw[r]}`).join(' '); },

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
  },

  // Rate limited toast: the same key is shown at most once per `gap` seconds.
  hint(key, text, type = 'warn', gap = 6, x, z) {
    const now = performance.now(), last = this.hintAt[key];
    if (last !== undefined && now - last < gap * 1000) return false;
    this.hintAt[key] = now;
    this.toast(text, type, x, z);
    return true;
  },

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
  },

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
  },

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
  },

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
  },
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
  },

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
  },

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
  },

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
  },
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
  },

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
  },
  netStatus(st) {
    st = st || {};
    if (st.type === 'resume') { if (this.netEl) { this.netEl.remove(); this.netEl = null; } return; }
    if (st.type === 'chat') return;   // chat is toasted by the lobby session's 'chat' handler
    if (st.type === 'peerLeft' || st.type === 'desync') { this.toast((st.type === 'desync' ? '⚠ ' : '👋 ') + (st.text || ''), 'warn'); if (st.type === 'peerLeft') return; }
    if (!this.netEl) { this.netEl = el('div', 'netbanner panel'); this.root.append(this.netEl); }
    this.netEl.className = 'netbanner panel ' + (st.type || '');
    this.netEl.textContent = st.text || 'Bekleniyor…';
    if (st.type === 'desync') { const n = this.netEl; setTimeout(() => { if (this.netEl === n) { n.remove(); this.netEl = null; } }, 6000); }
  },
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
  },
};

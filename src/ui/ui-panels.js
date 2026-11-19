// Selection and command card, tooltips, statistics, tribute and technology overlays.
import { AGES, BUILDINGS, PLAYER_COLORS, TECHS, UNITS } from '../data.js';
import { CAT_ICONS, ico, keepIcons, NATURE_ICONS, stripIcons } from '../icons.js';
import { BUILD_TIME_MUL, QUEUE_TIME_MUL, TOWER_AGE_ATK, towerAgeBonus } from '../sim/game.js';
import { el, esc, fmtTime, hex, RES_ICON, RES_LIST, RES_NAME, safe } from './ui-shared.js';

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
const CARD_GUARD_MS = 350;   // after the command card switches page, clicks / hover on it wait this long

export const panelMethods = {
  // ------------------------------------------------------------------ tooltip
  _tip(node, specFn) {
    node.addEventListener('mouseenter', () => { if (performance.now() < (this._cardGuardT || 0) && this.cardEl.contains(node)) return; this._showTip(node, specFn()); });
    node.addEventListener('mouseleave', () => this.tipEl.classList.add('hidden'));
  },
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
  },
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
  },

  onSelectionChanged(ids) {
    this.sel = (ids || []).slice();
    this.page = 'root';
    this.cardSig = null; this.selSig = null;
    this.tipEl.classList.add('hidden');
    if (this.mode === 'hud' && this.game) { this._refreshSel(); this._refreshCard(); }
  },

  setPlacement(type) {
    if (!type) { this.placeEl.classList.add('hidden'); return; }
    const b = BUILDINGS[type]; if (!b) return;
    this.placeEl.innerHTML = `<span>${b.icon || ico('x-build')} <b>${esc(b.name)}</b> yerleştir</span><span class="tooltip-inline tc" style="display:flex;gap:8px">${this._costHtml(b.cost)}</span><span style="color:var(--dim)">${type === 'wall' ? 'Basılı tutup sürükle: sur hattı · Bırak: yerleştir' : type === 'rail' ? 'Basılı tutup sürükle: ray hattı · Bırak: yerleştir' : type === 'dock' ? 'Kıyıya yerleştir: bir kısmı suda olmalı · Sol tık: yerleştir' : 'Sol tık: yerleştir · Shift+tık: birden çok, köylüler sırayla yapar'} · Sağ tık / Esc: iptal</span>`;
    this.placeEl.classList.remove('hidden');
  },

  _qprog(q) {
    if (!q || !q.total) return 0;
    let d = this.qdir.get(q);
    if (!d) { d = { t0: q.t, up: q.t <= q.total / 2 }; this.qdir.set(q, d); }
    else if (q.t > d.t0 + 1e-6) d.up = true; else if (q.t < d.t0 - 1e-6) d.up = false;
    const f = d.up ? q.t / q.total : 1 - q.t / q.total;
    return Math.max(0, Math.min(1, f));
  },

  // ------------------------------------------------------------------ selection panel
  _ents() {
    const g = this.game, out = [];
    for (const id of this.sel) { const e = safe(() => g.getEntity(id), null); if (e && !e.dead) out.push(e); }
    return out;
  },
  _def(e) {
    if (e.kind === 'unit') return UNITS[e.type] || { name: e.type, icon: ico('x-unknown') };
    if (e.kind === 'building') return BUILDINGS[e.type] || { name: e.type, icon: ico('b-house') };
    return NATURE[e.type] || { name: e.type, icon: ico('x-unknown') };
  },
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
  },
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
  },
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
  },
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
  },

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
  },
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
  },
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
  },
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
  },
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
  },
  // a build page is open: back to the main card (Geri, right click on the card, Esc). Returns true if it went back.
  cardBack() {
    if (this.page === 'root') return false;
    this.page = 'root'; this.cardSig = null;
    this.tipEl.classList.add('hidden');
    safe(() => this._refreshCard());
    return true;
  },
  _closeModal(force) { if (this.modalLocked && !force) return; this._tribOpen = false; this.modalLocked = false; this.techTiles = null; this.modalEl.classList.add('hidden'); this.modalEl.innerHTML = ''; },
  _score(p) {
    const s = p.stats || {}, ga = s.gathered || {};
    const techs = typeof s.techs === 'number' ? s.techs : (p.techs?.size || 0);
    return Math.round(RES_LIST.reduce((a, r) => a + (ga[r] || 0), 0) / 10 + (s.kills || 0) * 20 + (s.buildingsBuilt || 0) * 15 + (s.razed || 0) * 40 + techs * 30 + (p.age || 0) * 200 + (s.unitsTrained || 0) * 5);
  },
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
  },
  _enemyKnown(p) {
    const g = this.game;
    for (const e of g.entities.values()) if (e.owner === p.id && !e.dead && safe(() => g.isEntityVisible(e), false)) return true;
    return false;
  },
  // ------------------------------------------------------------------ tribute: send resources to an ally
  _allies() {
    const g = this.game, me = this._me(); if (!g || !g.players) return [];
    return g.players.filter((p) => p.id !== me && this._ally(me, p.id) && !p.defeated && !p.left).map((p) => p.id);
  },
  showTribute() {
    if (!this.game || !this._allies().length) return;
    this.modalLocked = false; this.techTiles = null;
    this._tribOpen = true;
    if (!this._trib || !this._allies().includes(this._trib.to)) this._trib = { to: this._allies()[0], res: (this._trib && this._trib.res) || 'wood' };
    this._renderTribute();
    this.modalEl.classList.remove('hidden');
  },
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
  },
  showStats() {
    if (!this.game) return;
    this.modalLocked = false; this.techTiles = null;
    this.modalEl.innerHTML = '';
    const m = el('div', 'modal panel', `<h2>İstatistikler</h2><div style="color:var(--dim)">Süre: ${fmtTime(this.game.time || 0)} · Rakipler yalnızca keşfedildiğinde listelenir</div>${this._statsTable(false)}`);
    const b = el('button', 'mbtn small', 'Kapat'); b.onclick = () => { this._click(); this._closeModal(); };
    m.append(b); this.modalEl.append(m); this.modalEl.classList.remove('hidden');
  },
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
  },
  // ------------------------------------------------------------------ technology tree
  _techBuildings() {
    const m = {};
    for (const bid of Object.keys(BUILDINGS)) for (const tid of BUILDINGS[bid].researches || []) (m[tid] = m[tid] || []).push(bid);
    return m;
  },
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
  },
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
  },
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
  },
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
  },

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
  },

  // ------------------------------------------------------------------ multiplayer
  _myTeamPlayers() { const g = this.game, me = this._me(); return (g?.players || []).map((p, i) => (p.id ?? i)).filter((id) => this._ally(me, id)); },
  _winTeam() {
    const g = this.game; if (!g) return null;
    const ov = g.over || {}; const t = ov.winnerTeam ?? ov.winningTeam ?? ov.team;
    if (t != null) return t;
    const alive = new Set((g.players || []).map((p, i) => (p.defeated || p.left ? null : this._teamOf(p.id ?? i))).filter((x) => x != null));
    return alive.size === 1 ? [...alive][0] : null;
  },
  _mpWon(fallback) {
    const wt = this._winTeam();
    if (wt != null) return wt === this._teamOf(this._me());
    return !!fallback;
  },
};

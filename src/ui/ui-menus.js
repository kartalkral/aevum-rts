// Main and multiplayer menus, saved games, settings, and the pause menu.
import { AGES, PLAYER_COLORS } from '../data.js';
import { ico } from '../icons.js';
import { levelOf } from '../rank.js';
import { avatarEl, confirmDeleteSave, loginScreen, menuHud, saveBadge, saveBadgeTitle, tpText } from './cloud-ui.js';
import { firstLaunch } from './profile-ui.js';
import { CLIMATE_OPTS, el, esc, hex, MAP_TYPE_TR, MAP_TYPES, safe } from './ui-shared.js';

function devModeOffered() {
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')) return true;
    if (/[?&]dev=1/.test(location.search)) { try { localStorage.setItem('aevum.dev', '1'); } catch { /* no storage */ } return true; }
    if (/[?&]dev=0/.test(location.search)) { try { localStorage.removeItem('aevum.dev'); } catch { /* no storage */ } return false; }
    return localStorage.getItem('aevum.dev') === '1';
  } catch { return false; }
}

export const menuMethods = {
  // ------------------------------------------------------------------ menu
  showMenu() {
    this.mode = 'menu';
    this.menuEl.classList.remove('hidden');
    this.hudEl.classList.add('hidden');
    this.tipEl.classList.add('hidden');
    this._menuMain();
  },
  _menuBox(html) {
    this.menuEl.innerHTML = ''; this.menuEl.classList.remove('with-hud');
    const box = el('div', 'menu-box panel', html);
    this.menuEl.append(box);
    return box;
  },
  _mbtn(parent, text, fn, cls = '') {
    const b = el('button', 'mbtn ' + cls, text);
    b.onclick = () => { this._click(); safe(() => this.app.audio?.resume()); fn(); };
    parent.append(b); return b;
  },
  // signed in with Google (required to play) and the account's profile is here
  _signedIn() { return !!safe(() => this.app.cloud && this.app.cloud.loggedIn && this.app.getProfile(), false); },
  _menuMain(note) {
    // nothing is playable before signing in with Google (one account = one player)
    if (!this._signedIn()) { loginScreen(this); if (note) this._menuNote(note); return; }
    const box = this._menuBox('<div class="logo">AEVUM</div><div class="tagline">Çağları aş · Uygarlığını kur</div>');
    if (note) this._menuNote(note);
    this._mbtn(box, 'Yeni Oyun', () => this._menuSetup(), 'primary');
    this._mbtn(box, 'Çok Oyunculu', () => this._menuMulti());
    this._mbtn(box, 'Arkadaşlar', () => import('./friends-ui.js').then((m) => m.menuFriends(this)));
    this._mbtn(box, 'Sandbox', () => this.app.newGame({ mapSize: 256, enemies: 1, difficulty: 'normal', startRes: 'high', startAge: 0, sandbox: true, seed: (Math.random() * 1e9) | 0 }));
    const cont = this._mbtn(box, 'Devam Et', () => Promise.resolve(safe(() => this.app.continueLast(), false)).then((ok) => { if (!ok && this.app.lastLoadError && this.mode === 'menu') this._menuSaves(this.app.lastLoadError); }).catch(() => {}));
    const saves = this._mbtn(box, 'Kayıtlı Oyunlar', () => this._menuSaves());
    cont.disabled = true;
    Promise.resolve(safe(() => this.app.listSaves(), [])).then((l) => { cont.disabled = !(l && l.length); }).catch(() => {});
    this._mbtn(box, 'Nasıl Oynanır', () => this._menuHowto());
    this._mbtn(box, 'Ayarlar', () => this._menuSettings());
    // the game's owner: player statistics (the server says who that is)
    Promise.resolve(safe(() => this.app.cloud.isOwner(), false)).then((own) => {
      if (!own || !box.isConnected) return;
      const b = this._mbtn(box, 'İstatistikler', () => import('./stats-ui.js').then((m) => m.menuStats(this)));
      const set = [...box.querySelectorAll('.mbtn')].find((x) => x.textContent === 'Ayarlar');
      if (set) set.after(b);
    }).catch(() => {});
    if (this.game && !this.game.over && !this.app.demo && !this.app.net) this._mbtn(box, 'Oyuna Dön', () => { this.showHUD(); this.app.setPaused?.(false); });
    safe(() => menuHud(this));   // the player plate (avatar, name, level, TP) and account chips around the menu
    void saves; void firstLaunch;
  },
  // a short message at the top of the current menu box (green)
  _menuNote(text) {
    const box = this.menuEl.querySelector('.menu-box'); if (!box || !text) return;
    const n = el('div', 'mperr prof-ok menu-note'); n.textContent = String(text); n.setAttribute('role', 'status');
    const logo = box.querySelector('.tagline') || box.querySelector('.logo');
    if (logo) logo.after(n); else box.prepend(n);
  },
  _seg(parent, label, key, opts, cls = '') {
    const row = el('div', 'frow', `<label>${label}</label>`);
    const seg = el('div', 'seg' + (cls ? ' ' + cls : ''));
    for (const [val, text] of opts) {
      const b = el('button', this.setup[key] === val ? 'on' : '', text);
      b.onclick = () => { this._click(); this.setup[key] = val; seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
      seg.append(b);
    }
    row.append(seg); parent.append(row);
  },
  _menuSetup() {
    const box = this._menuBox('<h2>Yeni Oyun</h2>');
    this._seg(box, 'Harita Boyutu', 'mapSize', [[256, 'Küçük'], [320, 'Orta'], [384, 'Büyük'], [448, 'Çok Büyük'], [512, 'Dev']]);
    this._seg(box, 'Harita Türü', 'mapType', MAP_TYPES, 'wrap');
    this._seg(box, 'İklim', 'climate', CLIMATE_OPTS, 'wrap');
    this._seg(box, 'Düşman Sayısı', 'enemies', [[1, '1'], [2, '2'], [3, '3']]);
    this._seg(box, 'Zorluk', 'difficulty', [['easy', 'Kolay'], ['normal', 'Normal'], ['hard', 'Zor']]);
    this._seg(box, 'Başlangıç Kaynakları', 'startRes', [['low', 'Düşük'], ['normal', 'Normal'], ['high', 'Yüksek']]);
    this._seg(box, 'Başlangıç Çağı', 'startAge', AGES.map((a, i) => [i, a.name.split(' ')[0]]));
    this._seg(box, 'Harita', 'fog', [['explored', 'Keşfedilmiş'], ['dark', 'Karanlık']]);   // (Empire Earth's explored map: land shaded, nothing seen until scouted)
    // developer mode (devModeOffered): a sandbox game (no TP, no match history) with the map open and endless resources
    const dev = el('label', 'frow devrow hidden', '<input type="checkbox"> <span>Geliştirici modu</span> <small>tüm harita açık, sınırsız kaynak, çağ değiştirme</small>');
    const devBox = dev.querySelector('input'); devBox.checked = !!this.devOn;
    devBox.onchange = () => { this._click(); this.devOn = devBox.checked; };
    box.append(dev);
    if (devModeOffered()) dev.classList.remove('hidden'); else this.devOn = false;
    this._mbtn(box, 'Başla', () => {
      const d = !!this.devOn && !dev.classList.contains('hidden');
      this.app.newGame({ ...this.setup, sandbox: d, dev: d, seed: (Math.random() * 1e9) | 0 });
    }, 'primary');
    this._mbtn(box, 'Geri', () => this._menuMain());
  },
  _menuSaves(errText) {
    const box = this._menuBox('<h2>Kayıtlı Oyunlar</h2><div class="mperr hidden"></div><div class="savelist">Yükleniyor...</div>');
    const list = box.querySelector('.savelist'), err = box.querySelector('.mperr');
    const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); };
    if (errText) fail(errText);
    const cloudOn = !!safe(() => this.app.cloud?.loggedIn, false);
    let busy = false;
    Promise.resolve(safe(() => this.app.listSaves(), [])).then((l) => {
      list.innerHTML = '';
      if (!l || !l.length) { list.innerHTML = '<div style="color:var(--dim);text-align:center;padding:20px">Kayıt bulunamadı.</div>'; return; }
      for (const s of l) {
        // (cloud: ☁ = only in the cloud / ☁↓ = newer in the cloud; downloaded when opened)
        const d = el('div', 'saveitem', `<span>${esc(saveBadge(s) + (s.name || s.key))}</span><small>${s.time ? new Date(s.time).toLocaleString('tr-TR') : ''}</small>`);
        if (s.cloud) d.title = saveBadgeTitle(s);
        if (s.cloud === 'only' || s.cloud === 'newer') d.classList.add('cloud-only');
        d.onclick = async () => {
          if (busy) return; busy = true; this._click();
          err.classList.add('hidden');
          if (s.cloud === 'only' || s.cloud === 'newer') { d.style.opacity = '0.6'; d.querySelector('small').textContent = '☁ İndiriliyor...'; }
          const ok = await Promise.resolve(safe(() => this.app.loadGame(s.key), false)).catch(() => false);
          busy = false;
          if (!ok && this.mode === 'menu') this._menuSaves(this.app.lastLoadError || 'Kayıt açılamadı.');
        };
        if (cloudOn) {
          // (guests keep the old list without a delete button)
          const del = el('button', 'lb-x', '✕'); del.title = 'Kaydı sil';
          del.onclick = (ev) => {
            ev.stopPropagation();
            const c = confirmDeleteSave(s); if (!c) return;
            Promise.resolve(safe(() => this.app.deleteSave(s.key, c), null)).then((r) => this._menuSaves(r && r.ok === false ? r.error : '')).catch(() => this._menuSaves('Kayıt silinemedi.'));
          };
          d.append(del);
        }
        list.append(d);
      }
    }).catch(() => { list.textContent = 'Kayıtlar okunamadı.'; });
    this._mbtn(box, 'Geri', () => this._menuMain());
  },
  _menuHowto() {
    const box = this._menuBox(`<h2>Nasıl Oynanır</h2><div class="howto">
      <b>Seçim:</b> Sol tık ile seç, sürükleyerek çoklu seç.<br>
      <b>Komut:</b> Sağ tık — yürü, topla, saldır, inşa et / onar. <kbd>Shift</kbd> basılıyken verilen emirler sıraya eklenir (köylü önce mevcut işini bitirir).<br>
      <b>Kamera:</b> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / ok tuşları veya ekran kenarı ile kaydır (WASD yalnızca kamerayı oynatır), tekerlek ile yakınlaş, orta tuş ya da <kbd>Boşluk</kbd> basılıyken fareyle döndür, <kbd>Home</kbd> / <kbd>Backspace</kbd> Şehir Merkezine dön.<br>
      <b>Komut kartı:</b> Sağ alttaki düğmeler; kısayollar <kbd>Q</kbd><kbd>E</kbd><kbd>R</kbd><kbd>T</kbd><kbd>Y</kbd> / <kbd>F</kbd><kbd>G</kbd><kbd>H</kbd><kbd>J</kbd><kbd>K</kbd> / <kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd><kbd>V</kbd><kbd>B</kbd> ızgara sırasıyla.<br>
      <b>Binalar:</b> <kbd>Shift</kbd>+tık ile aynı türden birden çok bina seç, çift tık ekrandaki tümünü seçer; üretim her binada aynı anda başlar. <kbd>Shift</kbd>+üret: 5 adet sıraya ekler. <kbd>Shift</kbd> basılıyken bina yerleştirmek araç açık kalır, birden çok temel atarsın.<br>
      <b>Ekonomi:</b> Köylülerle yiyecek, odun, taş ve altın topla; tarla ek (nüfus sınırı sabit 1000, ev gerekmez).<br>
      <b>Çağ atlama:</b> Şehir Merkezinden yeterli kaynak ve bina ile sonraki çağa geç; yeni birimler ve binalar açılır.<br>
      <b>Zafer:</b> Tüm düşmanların binalarını yok et.<br>
      <b>Diğer:</b> <kbd>Esc</kbd> iptal / duraklat, mini haritaya tıklayarak kamerayı taşı, sağ tıkla birimleri gönder.
      </div>`);
    this._mbtn(box, 'Geri', () => this._menuMain());
  },
  _settingsBody(parent) {
    const vols = [['master', 'Ana Ses'], ['sfx', 'Efektler'], ['ambient', 'Ortam'], ['ui', 'Arayüz']];
    for (const [cat, label] of vols) {
      const cur = Math.round((this.settings.vol[cat] ?? 0.8) * 100);
      const row = el('div', 'frow', `<label>${label}</label><input type="range" min="0" max="100" value="${cur}"><span class="val">${cur}</span>`);
      const inp = row.querySelector('input'), val = row.querySelector('.val');
      inp.oninput = () => {
        val.textContent = inp.value; this.settings.vol[cat] = inp.value / 100;
        safe(() => this.app.audio?.setVolume(cat, inp.value / 100)); this._saveSettings();
      };
      inp.onchange = () => { if (cat === 'ui') this._click(); };
      parent.append(row);
    }
    const row = el('div', 'frow', '<label>Grafik Kalitesi</label>');
    const seg = el('div', 'seg');
    for (const [v, t] of [['low', 'Düşük'], ['high', 'Yüksek']]) {
      const b = el('button', this.settings.quality === v ? 'on' : '', t);
      b.onclick = () => {
        this._click(); this.settings.quality = v; seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
        safe(() => this.app.renderer?.setQuality(v)); this._saveSettings();
      };
      seg.append(b);
    }
    row.append(seg); parent.append(row);
  },
  _menuSettings() {
    const box = this._menuBox('<h2>Ayarlar</h2>');
    this._settingsBody(box);
    this._mbtn(box, 'Geri', () => this._menuMain());
  },
  _loadSettings() {
    const def = { vol: { master: 0.8, sfx: 0.8, ambient: 0.5, ui: 0.6 }, quality: 'high' };
    try { const o = JSON.parse(localStorage.getItem('aevum.settings')); if (o && o.vol) return { ...def, ...o, vol: { ...def.vol, ...o.vol } }; } catch (e) { /* ignore */ }
    return def;
  },
  _saveSettings() { try { localStorage.setItem('aevum.settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ } },
  _applySettings() {
    for (const k in this.settings.vol) safe(() => this.app.audio?.setVolume(k, this.settings.vol[k]));
    safe(() => this.app.renderer?.setQuality(this.settings.quality));
  },

  // ------------------------------------------------------------------ overlays
  // The in-game menu (Esc / the ⏸ button). Single player: it pauses the game. Multiplayer: the match goes on
  // while it is open; "Oyunu Duraklat" pauses it for everybody (a lockstep command, see NetSession.requestPause).
  _buildPause() {
    this.pauseEl.innerHTML = '';
    const net = this.app.net, mpPaused = !!(net && net.paused);
    const title = !net ? 'Duraklatıldı' : mpPaused ? 'Oyun Duraklatıldı' : 'Menü';
    const m = el('div', 'modal panel', `<h2>${title}</h2>`);
    m.style.width = 'min(420px, 92vw)';
    if (net) m.append(el('div', 'pause-info', esc(mpPaused ? (net.pausedBy || 'Bir oyuncu') + ' oyunu herkes için duraklattı.' : 'Çok oyunculu maç sürüyor; duraklatırsan herkes için durur.')));
    this.pauseInfoEl = el('div', 'pause-info'); m.append(this.pauseInfoEl);
    const btn = (t, fn, cls = '') => { const b = el('button', 'mbtn ' + cls, t); b.onclick = () => { this._click(); fn(); }; m.append(b); };
    if (!net) btn('Devam Et', () => this.app.setPaused?.(false), 'primary');
    else if (mpPaused) btn('Oyunu Devam Ettir (herkes için)', () => { net.requestPause(false); }, 'primary');
    else {
      btn('Oyuna Dön', () => this.toggleGameMenu(false), 'primary');
      btn('Oyunu Duraklat (herkes için)', () => { net.requestPause(true); });
    }
    btn('Kaydet', () => this._save());
    btn('İstatistik', () => this.showStats());
    const sbox = el('div'); sbox.style.margin = '14px 0';
    this._settingsBody(sbox); m.append(sbox);
    if (net) btn('Maçtan Ayrıl', () => { if (confirm('Maçtan ayrılmak istediğine emin misin? (Maç diğerleri için sürer.)')) { this.menuOpen = false; safe(() => this.app.leaveMultiplayer?.()); } });
    else btn('Ana Menü', () => { safe(() => this.app.toMenu?.()); this.showMenu(); });
    this.pauseEl.append(m);
  },
  // is the in-game menu showing? (single player: paused; multiplayer: opened, or the match is paused)
  gameMenuVisible() {
    if (this.mode !== 'hud' || !this.game || this.gameOverShown) return false;
    const net = this.app.net;
    return net ? !!(this.menuOpen || net.paused) : !!this.app.paused;
  },
  toggleGameMenu(open) {
    if (this.mode !== 'hud' || !this.game || this.app.demo) return;
    const net = this.app.net;
    if (!net) { this.app.setPaused?.(open == null ? !this.app.paused : !!open); return; }
    this.menuOpen = open == null ? !this.menuOpen : !!open;
    this._pauseKey = null;
    this._syncPauseMenu();
  },
  _syncPauseMenu() {
    const show = this.gameMenuVisible(), net = this.app.net;
    const key = show ? [!!net, !!(net && net.paused), net && net.pausedBy].join('|') : null;
    if (show && key !== this._pauseKey) { this._pauseKey = key; this._buildPause(); }
    if (!show) this._pauseKey = null;
    this.pauseEl.classList.toggle('hidden', !show);
  },
  _save() {
    // multiplayer: a lockstep save request; "Oyun kaydedildi (çok oyunculu)" comes when every client has saved
    if (this.app.game?.mp) { Promise.resolve(safe(() => this.app.saveGame(), false)).then((ok) => { if (!ok) this.toast('Kayıt başarısız', 'warn'); }).catch(() => this.toast('Kayıt başarısız', 'warn')); return; }
    // (saveGame itself reports "Oyun kaydedildi." / "Oyun kaydedilemedi!" through the game's notify toast: one message)
    Promise.resolve(safe(() => this.app.saveGame(), null)).catch(() => this.toast('Kayıt başarısız', 'warn'));
  },
  // the multiplayer name IS the profile name (src/profile.js keeps 'aevum.mpName' in sync)
  _mpName() { return safe(() => this.app.getProfile()?.name, '') || safe(() => localStorage.getItem('aevum.mpName'), '') || ''; },
  _mpUid() { return safe(() => this.app.getProfile()?.uid, null) || null; },
  // -> the stored name, or null (invalid: toasts why and keeps the old one)
  _setMpName(v) {
    const r = safe(() => this.app.renameProfile(v), null);
    if (r && r.ok) return r.profile.name;
    this.toast((r && r.error) || 'Ad kaydedilemedi', 'warn');
    return null;
  },
  // a NetSession under this account's verified identity (the relay checks the Google session: srv/identity.mjs)
  async _mpSession() {
    const cloud = this.app.cloud;
    if (!cloud || !cloud.loggedIn) throw new Error('Çok oyunculu için Google ile giriş gerekli.');
    let t;
    try { t = await cloud.relayTicket(); } catch (e) { throw new Error('Kimliğin oyun sunucusunda doğrulanamadı: ' + (e?.message || e)); }
    const { NetSession } = await import('../net/session.js');
    return NetSession.create('auto', { name: t.ident.name, uid: t.ident.uid, ident: t.ident, ticket: (fresh) => cloud.relayTicket(fresh).then((x) => x.ticket) });
  },
  _menuMulti(errText) {
    if (!this._signedIn()) { this._menuMain(); return; }
    const box = this._menuBox('<h2>Çok Oyunculu</h2><div class="mpnote">Arkadaşınla aynı takımda ya da karşı takımlarda oyna. Yapay zekâ rakipleri istediğin takıma ekle.</div>');
    const p = safe(() => this.app.getProfile(), null);
    const who = el('div', 'mp-who');
    who.append(avatarEl(p?.avatar, p?.uid, 'av-sm'));
    const wn = el('span', 'mp-who-name'); wn.textContent = p?.name || ''; who.append(wn);
    const wt = el('span', 'acc-tp'); wt.textContent = tpText(safe(() => this.app.cloud.tp.tp, 0)); who.append(wt);
    const wh = el('small', 'prof-dim'); wh.textContent = 'Lobide bu adla görünürsün (Profil ekranından değiştirilir).'; who.append(wh);
    box.append(who);
    const err = el('div', 'mperr' + (errText ? '' : ' hidden'), esc(errText || '')); box.append(err);
    const fail = (e) => { err.textContent = 'Bağlantı hatası: ' + (e?.message || e || 'bilinmiyor'); err.classList.remove('hidden'); busy(false); };
    const btns = [];
    const busy = (b) => btns.forEach((x) => { x.disabled = b; });
    const go = async (code) => {
      err.classList.add('hidden'); busy(true);
      try {
        const s = await this._mpSession();
        if (code) await s.join(code); else await s.host();
        this.showLobby(s);
      } catch (e) { fail(e); }
    };
    btns.push(this._mbtn(box, 'Oda Kur', () => go(null), 'primary'));
    this._mbtn(box, 'Arkadaşlar · Davet Et', () => import('./friends-ui.js').then((m) => m.menuFriends(this)));
    const jr = el('div', 'frow mpjoin', '<label>Oda Kodu</label>');
    const code = el('input', 'mpinput mpcode'); code.maxLength = 5; code.placeholder = 'ABCDE'; code.autocomplete = 'off';
    code.oninput = () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); };
    jr.append(code); box.append(jr);
    btns.push(this._mbtn(box, 'Odaya Katıl', () => { if (code.value.length !== 5) { fail(new Error('5 karakterlik oda kodunu gir')); return; } go(code.value); }));
    code.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') btns[1].click(); };
    // continue a saved multiplayer match (src/ui/mp-resume.js)
    btns.push(this._mbtn(box, 'Kayıtlı Maça Devam Et', () => {
      import('./mp-resume.js').then((m) => m.menuResume(this)).catch((e) => fail(e));
    }));
    this._mbtn(box, 'Geri', () => this._menuMain());
  },
  showLobby(session) {
    // a continued (saved) match has its own lobby
    if (session?.state?.resume) { this.lobbySession = session; import('./mp-resume.js').then((m) => m.showResumeLobby(this, session)).catch((e) => this._menuMulti(String(e?.message || e))); return; }
    this.mode = 'menu';
    this.menuEl.classList.remove('hidden'); this.hudEl.classList.add('hidden');
    this.lobbySession = session;
    const box = this._menuBox('');
    box.classList.add('lobby');
    const myPeer = () => session.transport?.id ?? session.peerId ?? session.id;
    let state = session.state || session.lobby || null, left = false;
    const chatLog = [];
    const head = el('div', 'lb-head');
    const body = el('div', 'lb-body');
    const chat = el('div', 'lb-chat', '<div class="lb-log"></div>');
    const ci = el('input', 'mpinput'); ci.placeholder = 'Mesaj yaz, Enter'; ci.maxLength = 160;
    chat.append(ci);
    const foot = el('div', 'lb-foot');
    // online friends with "Davet Et" (the code below works as before)
    const inv = el('div', 'lb-invite-slot');
    import('./friends-ui.js').then((m) => { if (this.lobbySession === session) inv.append(m.lobbyInvites(this, session)); }).catch(() => {});
    this._lobbyNoteEl = el('div', 'mperr prof-ok hidden');
    box.append(head, this._lobbyNoteEl, body, inv, chat, foot);
    const sendChat = (t) => { t = String(t || '').trim(); if (!t) return; safe(() => (session.chat || session.sendChat || session.say)?.call(session, t)); };
    ci.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { sendChat(ci.value); ci.value = ''; } };
    const drawLog = () => { const l = chat.querySelector('.lb-log'); l.innerHTML = chatLog.slice(-40).map((m) => `<div><b>${esc(m.name || '?')}:</b> ${esc(m.text)}</div>`).join(''); l.scrollTop = l.scrollHeight; };
    const call = (fn, ...a) => { this._click(); safe(() => { const r = session[fn]?.(...a); if (r?.catch) r.catch(() => {}); }); };
    const sel = (opts, val, onch, cls = '') => {
      const s = el('select', 'mpsel ' + cls);
      for (const [v, t] of opts) { const o = el('option', '', esc(t)); o.value = String(v); if (String(v) === String(val)) o.selected = true; s.append(o); }
      s.onchange = () => onch(s.value); s.onkeydown = (ev) => ev.stopPropagation(); return s;
    };
    const TEAMS = [1, 2, 3, 4].map((t) => [t, 'Takım ' + t]);
    const DIFF = [['easy', 'Kolay'], ['normal', 'Normal'], ['hard', 'Zor']];
    // the host re-broadcasts the lobby every 2 s: only rebuild when it changed, and keep the
    // "add AI" picks and a half-typed name across rebuilds
    let aTeam = 2, aDiff = 'normal', lastKey = null, nameDraft = null;
    const render = () => {
      if (left || this.lobbySession !== session) return;
      const st = state || {}, slots = st.slots || [], me = myPeer();
      let key = null; try { key = JSON.stringify([st, me, session.isHost]); } catch (e) { /* ignore */ }
      if (key != null && key === lastKey) return;
      lastKey = key;
      const nmFocused = !!(document.activeElement && document.activeElement.classList?.contains('lb-myname'));
      const host = session.isHost ?? (st.hostPeer != null && st.hostPeer === me);
      head.innerHTML = `<h2>Lobi</h2><div class="lb-code"><span>Oda kodu</span><b class="lb-codetxt">${esc(st.code || session.code || '-----')}</b></div><div class="lb-hint">Aynı sayfayı açıp bu kodu girsin: Çok Oyunculu → Odaya Katıl</div>`;
      const cp = el('button', 'mbtn small', 'Kodu kopyala');
      cp.onclick = () => {
        const txt = st.code || session.code || ''; const codeEl = head.querySelector('.lb-codetxt');
        const selTxt = () => { try { const r = document.createRange(); r.selectNodeContents(codeEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { /* ignore */ } };
        try { navigator.clipboard.writeText(txt).then(() => { cp.textContent = 'Kopyalandı ✔'; }, () => { selTxt(); cp.textContent = 'Seçildi, Ctrl+C'; }); } catch (e) { selTxt(); cp.textContent = 'Seçildi, Ctrl+C'; }
      };
      head.querySelector('.lb-code').append(cp);
      body.innerHTML = '';
      const list = el('div', 'lb-slots');
      slots.forEach((s, i) => {
        const mine = s.kind === 'human' && s.peer != null && s.peer === me;
        const row = el('div', 'lb-slot team' + (s.team || 1) + (mine ? ' mine' : ''));
        row.append(el('span', 'lb-sw', ''));
        row.lastChild.style.background = hex(PLAYER_COLORS[i] ?? 0xffffff);
        if (s.kind === 'human') row.append(avatarEl(s.av, s.uid, 'av-sm'));
        row.append(el('span', 'lb-name', esc(s.name || (s.kind === 'ai' ? 'Yapay Zekâ' : 'Oyuncu')) + (s.peer && s.peer === st.hostPeer ? ' <small>' + ico('x-crown') + '</small>' : '') + (mine ? ' <small>(sen)</small>' : '')));
        if (s.kind === 'human' && s.tp != null) row.append(el('span', 'lb-tp', 'Sv ' + levelOf(s.tp).level + ' · ' + esc(tpText(s.tp))));
        row.append(el('span', 'lb-kind ' + s.kind, s.kind === 'ai' ? 'Yapay Zekâ' : 'İnsan'));
        const canTeam = mine || (host && s.kind === 'ai');
        if (canTeam) row.append(sel(TEAMS, s.team || 1, (v) => (mine ? call('setTeam', +v) : call('setSlot', i, { team: +v })), 'lb-team'));
        else row.append(el('span', 'lb-teamtag', 'Takım ' + (s.team || 1)));
        if (s.kind === 'ai') {
          if (host) row.append(sel(DIFF, s.difficulty || 'normal', (v) => call('setSlot', i, { difficulty: v })));
          else row.append(el('span', 'lb-teamtag', (DIFF.find((d) => d[0] === s.difficulty) || DIFF[1])[1]));
          if (host) { const rm = el('button', 'lb-x', '✕'); rm.title = 'Kaldır'; rm.onclick = () => call('removeSlot', i); row.append(rm); }
        } else {
          row.append(el('span', 'lb-ready' + (s.ready ? ' on' : ''), s.ready ? '✔ Hazır' : 'Bekliyor'));
        }
        list.append(row);
      });
      body.append(list);
      if (host) {
        const add = el('div', 'lb-add');
        add.append(el('span', '', 'Yapay zekâ ekle:'), sel(TEAMS, aTeam, (v) => { aTeam = +v; }), sel(DIFF, aDiff, (v) => { aDiff = v; }));
        const ab = el('button', 'mbtn small', '+ Ekle'); ab.disabled = slots.length >= 8;
        ab.onclick = () => call('addAI', aTeam, aDiff); add.append(ab); body.append(add);
        const sets = st.settings || {}, sg = el('div', 'lb-settings');
        const srow = (lab, node) => { const r = el('div', 'frow', `<label>${lab}</label>`); r.append(node); sg.append(r); };
        srow('Harita Boyutu', sel([[256, 'Küçük'], [320, 'Orta'], [384, 'Büyük'], [448, 'Çok Büyük'], [512, 'Dev']], sets.mapSize ?? 320, (v) => call('setSettings', { mapSize: +v })));
        srow('Harita Türü', sel(MAP_TYPES, sets.mapType ?? 'river', (v) => call('setSettings', { mapType: v })));
        srow('İklim', sel(CLIMATE_OPTS, sets.climate ?? 'random', (v) => call('setSettings', { climate: v })));
        srow('Başlangıç Kaynakları', sel([['low', 'Düşük'], ['normal', 'Normal'], ['high', 'Yüksek']], sets.startRes ?? 'normal', (v) => call('setSettings', { startRes: v })));
        srow('Başlangıç Çağı', sel(AGES.map((a, j) => [j, a.name]), sets.startAge ?? 0, (v) => call('setSettings', { startAge: +v })));
        srow('Harita', sel([['explored', 'Keşfedilmiş'], ['dark', 'Karanlık']], sets.fog ?? 'explored', (v) => call('setSettings', { fog: v })));
        body.append(sg);
      } else {
        const sets = st.settings || {};
        body.append(el('div', 'lb-hint', `Harita: ${({ 256: 'Küçük', 320: 'Orta', 384: 'Büyük', 448: 'Çok Büyük', 512: 'Dev' })[sets.mapSize] || sets.mapSize || '-'} · Tür: ${MAP_TYPE_TR[sets.mapType || 'river'] || '-'} · İklim: ${(CLIMATE_OPTS.find((c) => c[0] === (sets.climate || 'random')) || CLIMATE_OPTS[0])[1]} · Kaynak: ${({ low: 'Düşük', normal: 'Normal', high: 'Yüksek' })[sets.startRes] || '-'} · Çağ: ${AGES[sets.startAge ?? 0]?.name || '-'}`));
      }
      foot.innerHTML = '';
      const mySlot = slots.find((s) => s.kind === 'human' && s.peer === me);
      if (!session.verified) {
        // (only an unverified transport lets the name be typed here; with the relay the account's name is used)
        const nm = el('input', 'mpinput lb-myname'); nm.maxLength = 20; nm.value = mySlot?.name || this._mpName();
        nm.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') nm.blur(); };
        nm.oninput = () => { nameDraft = nm.value; };
        nm.onchange = () => { nameDraft = null; const v = nm.value.trim(); if (!v || v === mySlot?.name) return; const n = this._setMpName(v); if (!n) { nm.value = mySlot?.name || this._mpName(); return; } nm.value = n; call('setName', n); };
        foot.append(nm);
        if (nmFocused) { if (nameDraft != null) nm.value = nameDraft; nm.focus(); }
      }
      const rd = el('button', 'mbtn small' + (mySlot?.ready ? ' on' : ''), mySlot?.ready ? '✔ Hazırım' : 'Hazırım');
      rd.onclick = () => call('setReady', !mySlot?.ready); foot.append(rd);
      if (host) {
        const humans = slots.filter((s) => s.kind === 'human'), teams = new Set(slots.map((s) => s.team || 1));
        const okStart = humans.length > 0 && humans.every((s) => s.ready) && teams.size >= 2;
        const sb = el('button', 'mbtn small primary', 'Başlat'); sb.disabled = !okStart;
        sb.title = okStart ? '' : 'Herkes hazır olmalı ve en az iki farklı takım bulunmalı';
        sb.onclick = () => call('start'); foot.append(sb);
      }
      const lv = el('button', 'mbtn small', 'Ayrıl');
      lv.onclick = () => { this._click(); left = true; this.lobbySession = null; safe(() => session.close?.()); this._menuMulti(); };
      foot.append(lv);
    };
    const on = (n, fn) => safe(() => session.on?.(n, (p) => { if (!left) safe(() => fn(p || {})); }));
    on('lobby', (s) => { state = s; if (this.lobbySession === session && this.mode === 'menu') render(); });
    on('chat', (m) => { chatLog.push(m); if (this.lobbySession === session && this.mode === 'menu') drawLog(); else if (this.app.net === session) this._chatPush(m); });
    on('start', (p) => { if (this.lobbySession !== session) return; this.lobbySession = null; safe(() => this.app.startMultiplayer?.(session, p.cfg)); });
    // in-game stall / resume / desync / peerLeft banners are routed by app.startMultiplayer (main.js)
    on('closed', () => { if (this.lobbySession === session) { this.lobbySession = null; this._menuMulti('Bağlantı kapandı.'); } else if (this.app.net === session) this.toast('⚠ Ağ bağlantısı kapandı', 'warn'); });
    render(); drawLog();
  },
  // a green line at the top of the lobby (e.g. "X davet edildi")
  _lobbyNote(text) { const n = this._lobbyNoteEl; if (!n || !n.isConnected) return; n.textContent = String(text || ''); n.classList.toggle('hidden', !text); },
  // a friend invited us into his room: a card with Katıl / Reddet (src/ui/friends-ui.js)
  showInvite(m) { import('./friends-ui.js').then((x) => x.showInvite(this, m)).catch((e) => console.warn(e)); },
};

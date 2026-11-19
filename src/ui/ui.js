// Aevum UI: main menu, HUD, minimap, tooltips, overlays. DOM only, no three.js.
import { panelMethods } from './ui-panels.js';
import { hudMethods } from './ui-hud.js';
import { menuMethods } from './ui-menus.js';
import { installMethods } from '../method-table.js';
import { el, safe, fmtTime, hex } from './ui-shared.js';
import { PLAYER_COLORS } from '../data.js';
import { applyIcons } from '../icons.js';

applyIcons();

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

  _click() { safe(() => this.app.audio?.ui('click')); }
  _error() { safe(() => this.app.audio?.ui('error')); }
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
}

installMethods(UI.prototype, menuMethods, hudMethods, panelMethods);

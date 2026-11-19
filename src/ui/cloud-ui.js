import { chatPrivacyNotice } from './chat-privacy-ui.js';
// Aevum - account UI: the sign-in window (Google is the only way in, and signing in is required to play), the
// account card of the main menu, avatars, the account part of the Profil screen, save badges and the delete-save
// question. All user-controlled text (e-mail, names, server messages) goes in via textContent only; avatar markup
// is constant SVG from src/avatars.js.
import { avatarById, avatarOf, AVATARS } from '../avatars.js';
import { TP_RULES } from '../cloud/sync.js';
import { levelOf } from '../rank.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const safe = (fn, fb) => { try { return fn(); } catch (e) { console.warn(e); return fb; } };
const STATUS_ICON = { synced: '✔', pending: '⏳', offline: '⚠', expired: '⚠', busy: '⏳', guest: '' };
// the multicolour Google "G" (constant markup, no user data)
const G_SVG = '<svg class="gbtn-g" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

// ---------- avatars ----------
// a round avatar (id from the profile; unknown / missing -> the automatic one of uid)
export function avatarEl(id, uid, cls = '') {
  const a = avatarById(avatarOf(id, uid));
  const s = h('span', 'av' + (cls ? ' ' + cls : ''));
  if (a) { s.innerHTML = a.svg; s.title = a.name; }
  return s;
}
// a grid of all avatars; onPick(id). current: the selected one
export function avatarPicker(current, onPick) {
  const g = h('div', 'av-grid');
  for (const a of AVATARS) {
    const b = h('button', 'av-pick' + (a.id === current ? ' on' : ''));
    b.type = 'button'; b.title = a.name; b.setAttribute('aria-label', a.name);
    b.innerHTML = a.svg;
    b.onclick = () => onPick(a.id, b);
    g.append(b);
  }
  return g;
}
export const tpText = (n) => (n | 0).toLocaleString('tr-TR') + ' TP';
export const TP_RULE_TEXT = `Zafer +${TP_RULES.won} TP · Yenilgi +${TP_RULES.lost} TP · Yarıda bırakılan ya da 5 dakikadan kısa maç ${TP_RULES.abandoned} TP. Puanlar oyun sunucusunda doğrulanır.`;

// ---------- sign in ----------
const mergeQuestion = (n) => `Bu bilgisayarda giriş yapılmadan oynanmış ${n} maç var.\n\nBu maçlar hesabına eklensin mi?\n\nTamam: hesabıma ekle\nİptal: ekleme`;
function loginNote(r, email) {
  if (r.newAccount) return 'Hoş geldin! Hesabın oluşturuldu (' + email + '). Kullanıcı adını Profil ekranından değiştirebilirsin.';
  const parts = ['Giriş yapıldı: ' + email + '.'];
  if (r.merged) parts.push(r.merged + ' maç hesabına eklendi.');
  return parts.join(' ');
}
// a game in progress (paused behind the menu) would be lost by a redirect: then a blocked popup is only reported
const gameRunning = (ui) => !!safe(() => ui.game && !ui.game.over && !ui.app.demo, false);

let carriedError = '';   // an error to show on the screen that is rebuilt after a failed sign in
// the Google sign-in flow. opts: {back() (rebuild the screen the button was on), done(note), say(text, good)}
export async function googleLogin(ui, opts = {}) {
  const cloud = ui.app.cloud;
  const say = opts.say || (() => {});
  if (!cloud) { say('Hesap sistemi bu tarayıcıda başlatılamadı.', false); return null; }
  // (no user name question: a new account gets one from its e-mail, changeable in Profil)
  const r = await cloud.loginGoogle({ allowRedirect: !gameRunning(ui), askMerge: async (n) => confirm(mergeQuestion(n)) });
  return finish(ui, r, opts);
}
function finish(ui, r, opts) {
  const cloud = ui.app.cloud, say = opts.say || (() => {});
  if (!r) return r;
  if (r.redirecting) { say('Google sayfasına yönlendiriliyor...', true); return r; }
  if (!r.ok) {
    if (!r.silent) safe(() => ui._error());
    say(r.error || '', false);
    return r;
  }
  const email = safe(() => cloud.user.email, '') || '';
  (opts.done || ((note) => ui._menuMain(note)))(loginNote(r, email));
  return r;
}
// back from signInWithRedirect (main.js boot): finish the sign in, then the main menu
export async function resumeGoogleRedirect(ui) {
  const cloud = ui.app.cloud;
  if (!cloud) return;
  const box = ui._menuBox('');
  box.classList.add('acc-gate');
  box.append(h('div', 'logo', 'AEVUM'), h('div', 'mpnote', 'Google ile giriş tamamlanıyor...'));
  const r = await cloud.finishGoogleRedirect({ askMerge: async (n) => confirm(mergeQuestion(n)) });
  if (!r) { ui._menuMain(); return; }
  if (!r.ok) { carriedError = r.silent ? '' : (r.error || ''); ui._menuMain(); return; }
  finish(ui, r, {});
}

// a "Google ile Giriş Yap" button + its message line. opts: {done, label, small, wide}
export function googleBlock(ui, opts = {}) {
  const cloud = ui.app.cloud;
  const wrap = h('div', 'acc-google');
  const btn = h('button', 'gbtn' + (opts.small ? ' small' : '') + (opts.wide ? ' wide' : ''));
  btn.type = 'button';
  btn.innerHTML = G_SVG;
  btn.append(h('span', 'gbtn-t', opts.label || 'Google ile Giriş Yap'));
  btn.setAttribute('aria-label', opts.label || 'Google ile Giriş Yap');
  const msg = h('div', 'mperr hidden');
  msg.setAttribute('role', 'status');
  const say = (t, good) => { msg.textContent = t || ''; msg.className = t ? 'mperr' + (good ? ' prof-ok' : '') : 'mperr hidden'; };
  wrap.append(btn, msg);
  if (carriedError) { say(carriedError, false); carriedError = ''; }
  // the SDK starts loading when the pointer / focus reaches the button: the popup then opens right on the click
  const warm = () => safe(() => cloud && cloud.google && cloud.google.warm());
  btn.addEventListener('pointerenter', warm, { once: true });
  btn.addEventListener('pointerdown', warm, { once: true });
  btn.addEventListener('focus', warm, { once: true });
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    safe(() => ui._click()); safe(() => ui.app.audio?.resume());
    if (!cloud) { say('Hesap sistemi bu tarayıcıda başlatılamadı.', false); return; }
    busy = true; btn.disabled = true; say('Google penceresi açılıyor...', true);
    try { await googleLogin(ui, { done: opts.done, say }); } catch (e) { console.warn('[cloud]', e); say('Google ile giriş başarısız.', false); } finally {
      busy = false; btn.disabled = false;
      if (msg.textContent === 'Google penceresi açılıyor...') say('', false);
    }
  };
  return wrap;
}

// the first window: nothing is playable before signing in with Google
export function loginScreen(ui) {
  const box = ui._menuBox('');
  box.classList.add('acc-gate');
  box.append(h('div', 'logo', 'AEVUM'), h('div', 'tagline', 'Çağları aş · Uygarlığını kur'));
  const card = h('div', 'gate-card');
  card.append(h('h2', '', 'Hoş Geldin, Komutan'),
    h('p', 'gate-text', 'Oynamak için Google hesabınla giriş yap. Her hesap tek bir oyuncudur: adın, avatarın, TP puanın, maç geçmişin ve kayıtların hesabına bağlı kalır ve her bilgisayarda seninle gelir.'));
  if (!ui.app.cloud) card.append(h('div', 'mperr', 'Hesap sistemi bu tarayıcıda başlatılamadı (çerezler / site verileri engellenmiş olabilir). Oynamak için giriş gerekli.'));
  else card.append(googleBlock(ui, { wide: true }));
  card.append(chatPrivacyNotice());
  card.append(h('p', 'gate-small', 'Kullanıcı adın e-posta adresinden otomatik oluşur; Profil ekranından değiştirebilirsin. E-posta adresin diğer oyunculara gösterilmez.'));
  box.append(card);
  const links = h('div', 'gate-links');
  const how = h('button', 'acc-link', 'Nasıl Oynanır');
  how.type = 'button';
  how.onclick = () => { safe(() => ui._click()); ui._menuHowto(); };
  links.append(how);
  box.append(links);
}

// ---------- status ----------
// a small live "Senkronize / Bekliyor / Çevrimdışı" pill; updates itself while it is in the document
export function statusPill(cloud) {
  const s = h('span', 'acc-status');
  const draw = () => {
    const st = cloud.status;
    s.className = 'acc-status st-' + st;
    s.textContent = (STATUS_ICON[st] ? STATUS_ICON[st] + ' ' : '') + cloud.statusText;
    s.title = cloud.lastError || '';
  };
  draw();
  const off = cloud.onChange(() => { if (!s.isConnected) { off(); return; } draw(); });
  return s;
}

// ---------- main menu ----------
// the online-game style frame around the main menu: a player plate top left (avatar, name, level + rank, TP bar),
// account chips top right (sync status, Profil). Lives in the menu layer (cleared with the next menu screen).
export function menuHud(ui) {
  const cloud = ui.app.cloud;
  const p = safe(() => ui.app.getProfile(), null);
  if (!cloud || !cloud.loggedIn || !p) return;
  const layer = ui.menuEl;
  layer.classList.add('with-hud');
  const plate = h('button', 'mh-plate');
  plate.type = 'button'; plate.title = 'Profil';
  const avw = h('span', 'mh-avwrap');
  avw.append(avatarEl(p.avatar, p.uid, 'av-hud'));
  const lvBadge = h('span', 'mh-lv');
  avw.append(lvBadge);
  const txt = h('span', 'mh-txt');
  const name = h('span', 'mh-name', p.name);
  const rank = h('span', 'mh-rank');
  const bar = h('span', 'mh-bar'); const fill = h('i'); bar.append(fill);
  const nums = h('span', 'mh-nums');
  txt.append(name, rank, bar, nums);
  plate.append(avw, txt);
  const draw = () => {
    const L = levelOf(cloud.tp.tp);
    lvBadge.textContent = String(L.level);
    rank.textContent = 'Seviye ' + L.level + ' · ' + L.rank;
    fill.style.width = Math.round(L.frac * 100) + '%';
    nums.textContent = tpText(L.tp) + ' · sonraki seviye ' + L.next + ' TP';
  };
  draw();
  plate.onclick = () => { safe(() => ui._click()); import('./profile-ui.js').then((m) => m.menuProfile(ui)); };
  const right = h('div', 'mh-right');
  right.append(statusPill(cloud));
  const pb = h('button', 'mh-chip', 'Profil'); pb.type = 'button';
  pb.onclick = plate.onclick;
  const out = h('button', 'mh-chip', 'Çıkış'); out.type = 'button'; out.title = 'Çıkış yap';
  out.onclick = () => {
    safe(() => ui._click());
    if (!confirm('Çıkış yapılsın mı?\n\nProfilin, maç geçmişin ve kayıtların hesabında kalır.')) return;
    if (ui.app.game && !ui.app.demo) safe(() => ui.app.toMenu());
    cloud.logout(); ui._menuMain('Çıkış yapıldı.');
  };
  right.append(pb, out);
  const hud = h('div', 'menu-hud');
  hud.append(plate, right);
  layer.prepend(hud);
  const off = cloud.onChange(() => { if (!hud.isConnected) { off(); return; } draw(); });
  if (cloud.status === 'expired') {
    const box = layer.querySelector('.menu-box');
    const wrap = h('div', 'acc-expired');
    wrap.append(h('div', 'mperr', 'Oturumun sona erdi: aynı Google hesabıyla tekrar giriş yap.'), googleBlock(ui, { small: true }));
    if (box) box.append(wrap);
  }
}
// (older layout: the account card under the menu buttons)
export function accountLine(ui, box) {
  const cloud = ui.app.cloud;
  const p = safe(() => ui.app.getProfile(), null);
  if (!cloud || !cloud.loggedIn || !p) return;
  const d = h('button', 'acc-card');
  d.type = 'button';
  d.title = 'Profil';
  d.append(avatarEl(p.avatar, p.uid, 'av-md'));
  const txt = h('span', 'acc-card-txt');
  const top = h('span', 'acc-card-name', p.name);
  const sub = h('span', 'acc-card-sub');
  const tp = h('b', 'acc-tp', tpText(cloud.tp.tp));
  sub.append(tp, statusPill(cloud));
  txt.append(top, sub);
  d.append(txt, h('span', 'acc-card-go', 'Profil ›'));
  d.onclick = () => { safe(() => ui._click()); import('./profile-ui.js').then((m) => m.menuProfile(ui)); };
  const off = cloud.onChange(() => { if (!d.isConnected) { off(); return; } tp.textContent = tpText(cloud.tp.tp); });
  if (cloud.status === 'expired') {
    const wrap = h('div', 'acc-expired');
    wrap.append(h('div', 'mperr', 'Oturumun sona erdi: aynı Google hesabıyla tekrar giriş yap.'), googleBlock(ui, { small: true }));
    box.append(d, wrap);
    return;
  }
  box.append(d);
}

// ---------- saves ----------
// marker for the save lists: every save of a signed-in account can be in the cloud
export function saveBadge(s) {
  if (!s || !s.cloud || s.cloud === 'none') return '';
  if (s.cloud === 'newer') return '☁↓ ';
  return '☁ ';
}
export function saveBadgeTitle(s) {
  if (!s || !s.cloud) return '';
  return { only: 'Yalnızca bulutta: açınca bu bilgisayara indirilir', newer: 'Buluttaki kopyası daha yeni: açınca indirilir', synced: 'Bu bilgisayarda ve bulutta (yedekli)', none: 'Yalnızca bu bilgisayarda (bulut yedeği bekliyor)' }[s.cloud] || '';
}
// -> null (cancelled) or {cloud: bool}
export function confirmDeleteSave(s) {
  if (s && s.cloud === 'only') return confirm('Bu kayıt yalnızca bulutta. Buluttan silinsin mi? Geri alınamaz.') ? { cloud: true } : null;
  if (!confirm('Bu kayıt silinsin mi? Geri alınamaz.')) return null;
  if (s && (s.cloud === 'synced' || s.cloud === 'newer')) return { cloud: confirm('Bu kaydın buluttaki kopyası da silinsin mi?\n\nTamam: bu bilgisayardan ve buluttan sil\nİptal: yalnızca bu bilgisayardan sil') };
  return { cloud: false };
}

export default { googleBlock, googleLogin, resumeGoogleRedirect, loginScreen, accountLine, statusPill, saveBadge, saveBadgeTitle, confirmDeleteSave, avatarEl, avatarPicker, tpText };

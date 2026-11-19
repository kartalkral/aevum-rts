// Aevum - the "Profil" screen: the account (avatar, user name, TP, sync, sign out, delete), stats, head-to-head,
// match history, export / import. Signing in with Google is required to play (cloud-ui.js loginScreen), so the
// profile always belongs to an account; the local copy (localStorage + IndexedDB) is its cache.
// Every user-controlled string (own / other players' names, imported files) goes in via textContent only.
import { AGES } from '../data.js';
import * as P from '../profile.js';
import { loginScreen, statusPill, avatarEl, avatarPicker, tpText, TP_RULE_TEXT } from './cloud-ui.js';
import { avatarOf } from '../avatars.js';
import { accountDeleteButton, menuChatHistory } from './chat-privacy-ui.js';
import { levelOf } from '../rank.js';
import { RES_ICONS, keepIcons } from '../icons.js';

const MAP_TR = { random: 'Rastgele', river: 'Nehir Vadisi', continent: 'Kıta', highlands: 'Yaylalar', plains: 'Ovalar', inlandsea: 'İç Deniz', islands: 'Adalar' };
const SIZE_TR = { 96: 'Eski Küçük', 128: 'Eski Orta', 160: 'Eski Büyük', 192: 'Eski Çok Büyük', 256: 'Küçük', 320: 'Orta', 384: 'Büyük', 448: 'Çok Büyük', 512: 'Dev' };
const DIFF_TR = { easy: 'Kolay', normal: 'Normal', hard: 'Zor' };
const RES_TR = { won: 'Zafer', lost: 'Yenilgi', abandoned: 'Yarıda' };
const RES_ICON = RES_ICONS;
const RES_NAME = { food: 'Yiyecek', wood: 'Odun', stone: 'Taş', gold: 'Altın' };
const STAT_TR = [['unitsTrained', 'Eğitilen Birim'], ['unitsLost', 'Kaybedilen Birim'], ['kills', 'Öldürülen Düşman'], ['buildingsBuilt', 'İnşa Edilen Bina'],
  ['buildingsLost', 'Kaybedilen Bina'], ['razed', 'Yıkılan Düşman Binası'], ['techs', 'Araştırma']];
const PAGE = 20;
const MAX_FILE = 8 * 1024 * 1024;

// text-only element (never innerHTML)
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const safe = (fn, fb) => { try { return fn(); } catch (e) { console.warn(e); return fb; } };
const mapName = (m) => (Object.hasOwn(MAP_TR, m) ? MAP_TR[m] : String(m || '-'));
const fmtClock = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return (m < 10 ? '0' : '') + m + ':' + String(s % 60).padStart(2, '0'); };
const fmtDur = (s) => { s = Math.max(0, Math.floor(s || 0)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh ? `${hh} sa ${mm} dk` : `${mm} dk ${s % 60} sn`; };
const fmtDate = (t) => safe(() => new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), '');
const fmtNum = (n) => safe(() => Math.floor(n || 0).toLocaleString('tr-TR'), String(Math.floor(n || 0)));
const pct = (x) => Math.round((x || 0) * 100) + '%';
const ageName = (a) => (AGES[a] && AGES[a].name) || String(a);

// (kept for old call sites: the first window is the sign-in window now)
export function firstLaunch(ui) { loginScreen(ui); }

// ---------- profile screen ----------
// note: a message shown on top (green; red when bad)
export function menuProfile(ui, note, bad) {
  const app = ui.app;
  const prof = app.getProfile();
  const cloud = safe(() => app.cloud, null);
  if (!prof || !cloud || !cloud.loggedIn) { loginScreen(ui); return; }
  const online = true;   // (an account is required: the profile is always the signed-in account's)
  const box = ui._menuBox('');
  box.classList.add('profile');
  box.append(h('h2', '', 'Profil'));

  // ---- account header: avatar | name, e-mail + status, TP ----
  const head = h('div', 'prof-head');
  const avCol = h('div', 'prof-avcol');
  const av = avatarEl(prof.avatar, prof.uid, 'av-lg');
  const avBtn = h('button', 'mbtn small', 'Avatarı Değiştir'); avBtn.type = 'button';
  avCol.append(av, avBtn);
  const idCol = h('div', 'prof-idcol');
  const form = h('form', 'prof-nameform');
  form.append(h('label', '', 'Kullanıcı Adı'));
  const nrow = h('div', 'prof-namerow');
  const inp = h('input', 'mpinput prof-name'); inp.maxLength = P.NAME_MAX; inp.value = prof.name; inp.autocomplete = 'nickname';
  inp.setAttribute('aria-label', 'Kullanıcı adı');
  const sv = h('button', 'mbtn small', 'Kaydet'); sv.type = 'submit';
  nrow.append(inp, sv); form.append(nrow);
  const acc = h('div', 'prof-acc');
  acc.append(h('span', 'acc-who', cloud.user.email), statusPill(cloud));
  const t = cloud.tp;
  const tpBox = h('div', 'prof-tp');
  const L = levelOf(t.tp);
  tpBox.append(h('span', 'prof-lv', 'Seviye ' + L.level + ' · ' + L.rank + ' — sonraki seviye ' + L.next + ' TP'), h('b', '', tpText(t.tp)), h('span', '', t.n ? `${t.w} zafer · ${t.l} yenilgi sayıldı` : 'Henüz puanlı maç yok'));
  idCol.append(form, acc, tpBox);
  head.append(avCol, idCol);
  box.append(head);
  box.append(h('div', 'prof-tprule', TP_RULE_TEXT));
  const msg = h('div', 'mperr' + (note ? (bad ? '' : ' prof-ok') : ' hidden'), note || ''); msg.setAttribute('role', 'status'); box.append(msg);
  const say = (tx, good) => { msg.textContent = tx; msg.className = 'mperr' + (good ? ' prof-ok' : ''); };

  // avatar picker (opens under the header)
  const pickWrap = h('div', 'prof-avpick hidden');
  box.append(pickWrap);
  avBtn.onclick = () => {
    safe(() => ui._click());
    if (!pickWrap.classList.contains('hidden')) { pickWrap.classList.add('hidden'); pickWrap.textContent = ''; return; }
    pickWrap.classList.remove('hidden');
    const cur = avatarOf(app.getProfile().avatar, prof.uid);
    pickWrap.append(avatarPicker(cur, async (id, btn) => {
      safe(() => ui._click());
      for (const x of pickWrap.querySelectorAll('.av-pick')) x.classList.remove('on');
      btn.classList.add('on');
      say('Avatar kaydediliyor...', true);
      const r = await cloud.setAvatar(id);
      if (!r.ok) { say(r.error, false); safe(() => ui._error()); return; }
      menuProfile(ui, 'Avatar değiştirildi.');
    }));
  };

  let renaming = false;
  const rename = async () => {
    if (renaming) return;
    if (P.checkName(inp.value).name === app.getProfile().name) { say('Ad değişmedi.', true); return; }
    renaming = true; sv.disabled = true; say('Ad kontrol ediliyor...', true);
    const r = await cloud.rename(inp.value);
    renaming = false; sv.disabled = false;
    if (!r.ok) { say(r.error, false); safe(() => ui._error()); return; }
    inp.value = r.profile.name; say('Ad kaydedildi: ' + r.profile.name, true);
  };
  form.onsubmit = (ev) => { ev.preventDefault(); safe(() => ui._click()); rename(); };
  inp.onkeydown = (ev) => ev.stopPropagation();   // the game's hotkeys must not see the typing (Enter submits the form)

  // ---- account actions ----
  const acts = h('div', 'prof-actions');
  if (cloud.status === 'expired') {
    acts.append(h('div', 'prof-dim', 'Oturumun sona erdi: aynı Google hesabıyla tekrar giriş yap.'));
    import('./cloud-ui.js').then((m) => acts.prepend(m.googleBlock(ui, { small: true, done: (n) => menuProfile(ui, n) })));
  }
  // (sync runs by itself: after every match / save, on start, every few minutes and when the connection comes back)
  const out = h('button', 'mbtn small', 'Çıkış Yap');
  out.onclick = () => {
    safe(() => ui._click());
    const pend = cloud.status === 'pending' || cloud.status === 'offline';
    if (!confirm('Çıkış yapılsın mı?\n\nProfilin, maç geçmişin ve kayıtların hesabında kalır; tekrar giriş yapınca geri gelir.' +
      (pend ? '\n\nUyarı: henüz gönderilemeyen veriler var; tekrar giriş yaptığında gönderilir.' : ''))) return;
    if (app.game && !app.demo) safe(() => app.toMenu());
    cloud.logout();
    ui._menuMain('Çıkış yapıldı.');
  };
  const chat = h('button', 'mbtn small', 'Sohbet Geçmişi');
  chat.onclick = () => menuChatHistory(ui, () => menuProfile(ui));
  acts.append(chat, accountDeleteButton(ui, say), out);
  box.append(acts);
  box.append(h('div', 'prof-meta', 'Oyuncu kimliği: ' + prof.uid.slice(0, 8) + '… · Oluşturuldu: ' + fmtDate(prof.created)));

  const body = h('div', 'prof-body', 'Yükleniyor...'); box.append(body);

  // export / import
  const tools = h('div', 'prof-tools');
  const file = h('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.style.display = 'none';
  const bExp = h('button', 'mbtn small', 'Dışa Aktar'), bImp = h('button', 'mbtn small', 'İçe Aktar');
  bExp.title = 'Profilini ve maç geçmişini bir JSON dosyası olarak indir';
  bImp.title = 'Daha önce dışa aktarılmış bir profil dosyasını yükle';
  tools.append(bExp, bImp, file); box.append(tools);
  ui._mbtn(box, 'Geri', () => ui._menuMain());

  let history = [];
  bExp.onclick = () => {
    safe(() => ui._click());
    const p = app.getProfile(); if (!p) return;
    try {
      const blob = new Blob([JSON.stringify(P.exportData(p, history), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      const fname = (p.name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'oyuncu');
      a.href = URL.createObjectURL(blob);
      a.download = 'aevum-profil-' + fname + '-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      say('Profil dosyası indirildi (' + history.length + ' maç).', true);
    } catch (e) { say('Dışa aktarılamadı: ' + ((e && e.message) || e), false); }
  };
  bImp.onclick = () => { safe(() => ui._click()); file.value = ''; file.click(); };
  file.onchange = async () => {
    const f = file.files && file.files[0]; if (!f) return;
    if (f.size > MAX_FILE) { say('Dosya çok büyük.', false); return; }
    let text;
    try { text = await f.text(); } catch (e) { say('Dosya okunamadı.', false); return; }
    const v = P.validateImport(text);
    if (!v.ok) { say('İçe aktarılamadı: ' + v.error, false); return; }
    const mine = app.getProfile();
    let replaced = false;
    // the identity belongs to the account; an import only adds history
    if (mine && v.profile.uid !== mine.uid && !online) {
      replaced = confirm('Dosyadaki profil ("' + v.profile.name + '") senin profilinden farklı.\n\n' +
        'Tamam: profilimi değiştir (dosyadaki kimlik ve ad kullanılır)\nİptal: profilim kalsın, yalnızca maç geçmişi birleştirilsin');
      if (replaced) app.replaceProfile(v.profile);
    }
    // only the records of the profile I keep: another player's view of the same match would count it twice
    const owner = replaced || !mine ? v.profile.uid : mine.uid;
    const { keep, skipped } = P.ownRecords(v.history, owner);
    const before = await app.listHistory();
    const ids = new Set(before.map((r) => r.id));
    const merged = P.mergeHistory(before, keep);
    const fresh = keep.filter((r) => !ids.has(r.id)).length;
    const ok = await app.putHistory(merged);
    if (!ok) { say('Maç geçmişi kaydedilemedi.', false); return; }
    menuProfile(ui, (replaced ? 'Profil değiştirildi. ' : '') + v.history.length + ' maç okundu, ' + fresh + ' yeni maç eklendi.' +
      (skipped ? ' Başka bir oyuncuya ait ' + skipped + ' maç atlandı (aynı maç iki kez sayılmasın diye).' : ''));
  };


  const load = () => Promise.resolve(safe(() => app.listHistory(), [])).then((l) => {
    if (!body.isConnected && history.length) return;
    history = Array.isArray(l) ? l : [];
    renderBody(body, history, prof);
  }).catch(() => { body.textContent = 'Maç geçmişi okunamadı.'; });
  load();
  // logged in: fetch the matches played on other PCs (incremental; the local cache shows first)
  if (online) cloud.flush({ pull: true }).then((r) => { if (r && r.added && body.isConnected) load(); }).catch(() => {});
}

function card(label, value, sub) {
  const c = h('div', 'prof-card'); c.append(h('b', '', value), h('span', '', label));
  if (sub) c.append(h('small', '', sub));
  return c;
}
function section(parent, title) { parent.append(h('h3', 'prof-h', title)); }

function renderBody(body, history, prof) {
  body.textContent = '';
  const t = P.summarize(history);
  const cards = h('div', 'prof-cards');
  cards.append(card('Maç', fmtNum(t.games), t.sp + ' tek · ' + t.mp + ' çok oyunculu' + (t.abandoned ? ' · ' + t.abandoned + ' yarıda bırakıldı' : '')), card('Galibiyet', fmtNum(t.wins)), card('Mağlubiyet', fmtNum(t.losses)),
    card('Kazanma Oranı', t.wins + t.losses ? pct(t.winRate) : '-'), card('Toplam Süre', fmtDur(t.totalTime)), card('En Çok Oynanan', t.topMap ? mapName(t.topMap) : '-', t.topMap ? t.mapCounts[t.topMap] + ' maç' : ''));
  body.append(cards);
  if (!history.length) { body.append(h('div', 'prof-empty', 'Henüz kayıtlı maç yok. Bir maç bitirdiğinde (ya da 30 saniyeden uzun bir maçtan çıktığında) burada görünür.')); return; }

  // head-to-head (humans with a profile)
  const hh = P.headToHead(history, prof.uid);
  section(body, 'Arkadaşlarınla');
  if (!hh.length) body.append(h('div', 'prof-empty', 'Henüz başka bir oyuncuyla çok oyunculu maç yok.'));
  else {
    const tb = h('table', 'st prof-h2h');
    const hr = h('tr'); for (const x of ['Oyuncu', 'Karşı karşıya', 'Aynı takımda', 'Son maç']) hr.append(h('th', '', x)); tb.append(hr);
    for (const o of hh) {
      const tr = h('tr');
      const wl = (b) => (b.games ? `${b.wins} G - ${b.losses} M${b.abandoned ? ' · ' + b.abandoned + ' yarıda' : ''}` : '-');
      tr.append(h('td', 'prof-pn', o.name), h('td', o.vs.wins > o.vs.losses ? 'prof-w' : o.vs.losses > o.vs.wins ? 'prof-l' : '', wl(o.vs)), h('td', '', wl(o.with)), h('td', 'prof-dim', fmtDate(o.lastAt)));
      tb.append(tr);
    }
    const wrap = h('div', 'prof-scroll'); wrap.append(tb); body.append(wrap);
  }

  // summed stats
  section(body, 'Toplam İstatistikler');
  const sg = h('div', 'prof-stats');
  for (const r of P.RES_KEYS) sg.append(statRow(RES_ICON[r] + ' Toplanan ' + RES_NAME[r], fmtNum(t.stats.gathered[r])));
  for (const [k, n] of STAT_TR) sg.append(statRow(n, fmtNum(t.stats[k])));
  sg.append(statRow('En yüksek çağ', ageName(t.maxAge)));
  body.append(sg);

  // recent matches
  section(body, 'Son Maçlar');
  const list = h('div', 'prof-list'); body.append(list);
  let shown = 0;
  const more = h('button', 'mbtn small', 'Daha fazla göster');
  const page = () => {
    for (const r of history.slice(shown, shown + PAGE)) list.append(matchItem(r));
    shown = Math.min(history.length, shown + PAGE);
    more.style.display = shown < history.length ? '' : 'none';
    more.textContent = 'Daha fazla göster (' + (history.length - shown) + ')';
  };
  more.onclick = page;
  body.append(more);
  page();
}
// (the label may hold sprite icons: text is escaped, only our icon markup stays markup)
function statRow(label, value) { const d = h('div', 'prof-stat'), l = h('span', ''); l.innerHTML = keepIcons(String(label).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))); d.append(l, h('b', '', value)); return d; }

function matchItem(r) {
  const ps = Array.isArray(r.players) ? r.players : [];
  const mine = ps[r.me | 0] || {};
  const opp = ps.filter((p, i) => i !== (r.me | 0) && p.team !== mine.team);
  const ally = ps.filter((p, i) => i !== (r.me | 0) && p.team === mine.team);
  const who = (p) => (p.ai ? '🤖 ' + (p.name || 'Yapay Zekâ') + (p.difficulty ? ' (' + (DIFF_TR[p.difficulty] || p.difficulty) + ')' : '') : '👤 ' + (p.name || 'Oyuncu'));
  const d = h('div', 'saveitem prof-item res-' + r.result);
  const top = h('div', 'prof-row');
  const left = h('span', 'prof-main');
  left.append(h('b', 'prof-res', RES_TR[r.result] || r.result), h('span', '', ' · ' + mapName(r.mapType) + ' (' + (SIZE_TR[r.mapSize] || r.mapSize) + ') · ' + (r.mode === 'mp' ? 'Çok oyunculu' : 'Tek oyunculu' + (r.difficulty ? ', ' + (DIFF_TR[r.difficulty] || r.difficulty) : ''))));
  left.append(h('br'), h('small', '', 'Rakipler: ' + (opp.length ? opp.map(who).join(', ') : '-') + (ally.length ? ' · Takım arkadaşı: ' + ally.map(who).join(', ') : '')));
  const right = h('small', 'prof-when'); right.append(h('span', '', fmtDate(r.endedAt)), h('br'), h('span', '', 'Süre ' + fmtClock(r.gameTime)));
  top.append(left, right); d.append(top);
  let det = null;
  d.onclick = () => {
    if (det) { det.remove(); det = null; d.classList.remove('open'); return; }
    d.classList.add('open');
    det = h('div', 'prof-det');
    const s = r.stats || {}, g = s.gathered || {};
    const grid = h('div', 'prof-stats');
    grid.append(statRow('Ulaşılan çağ', ageName(r.myAge)));
    for (const k of P.RES_KEYS) grid.append(statRow(RES_ICON[k] + ' ' + RES_NAME[k], fmtNum(g[k])));
    for (const [k, n] of STAT_TR) grid.append(statRow(n, fmtNum(s[k])));
    det.append(grid);
    const pl = h('div', 'prof-players');
    ps.forEach((p, i) => {
      const line = h('div', '');
      line.append(h('span', 'prof-team', 'T' + p.team), h('span', p.won ? 'prof-w' : p.won === false ? 'prof-l' : '', ' ' + who(p) + (i === (r.me | 0) ? ' (sen)' : '') + (p.won ? ' — kazandı' : '')));
      pl.append(line);
    });
    det.append(pl);
    d.append(det);
  };
  return d;
}

export default { firstLaunch, menuProfile };

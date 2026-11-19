import { clearLocalChatHistory, localChatHistory, MAX_CHAT_LIMIT, removeLocalChatAccount, setLocalChatLimit } from '../chatlog.js';
import { authMessage } from '../cloud/auth.js';
import { CHAT_RETENTION_DAYS } from '../cloud/sync.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (text, fn) => { const b = h('button', 'mbtn small', text); b.type = 'button'; b.onclick = fn; return b; };

export function chatPrivacyNotice() {
  const d = h('details', 'prof-dim');
  d.append(h('summary', '', 'Sohbet gizliliği'),
    h('p', '', 'Gönderilen ve alınan mesajlar bu tarayıcıda hesabına göre saklanır. Süre sınırı yoktur; satır sınırı aşılınca eski mesajlar kaldırılır. Sınırı 0 yaparak yerel kaydı kapatabilirsin.'),
    h('p', '', `Bulut kaydı varsayılan olarak kapalıdır. Açarsan yalnızca bundan sonra gönderdiğin mesajlar Google Firestore’da saklanır. Yeni kayıtlar ${CHAT_RETENTION_DAYS} gün sonra sona erer; otomatik silme TTL politikasına bağlıdır ve gecikebilir. Eski kayıtların süre bilgisi olmayabilir. Kaydı kapatmak mevcut kayıtları silmez.`),
    h('p', '', 'Profil → Sohbet Geçmişi bölümünde kayıtları görebilir, JSON indirebilir ve yerel/bulut kopyalarını ayrı ayrı silebilirsin. Hesap silme buluttaki sohbetleri ve bu tarayıcıdaki hesap kopyasını kaldırır; diğer cihazlardaki, diğer oyunculardaki veya indirilmiş kopyaları kaldırmaz. Oyun sunucusu mesajları iletir, kalıcı sohbet arşivi tutmaz. Yetkili proje operatörleri bakım ve inceleme için bulut kayıtlarına erişebilir.'));
  return d;
}

export function accountDeleteButton(ui, say) {
  const { app } = ui, cloud = app.cloud, uid = cloud.user.uid;
  const b = button('Hesabı Sil', async () => {
    if (b.disabled || cloud.user?.uid !== uid) return;
    if (!confirm('Aevum hesabın ve buluttaki sohbetlerin kalıcı olarak silinsin mi? Bu tarayıcıdaki hesabına ait sohbet geçmişi de silinir. Diğer cihazlardaki ve indirilmiş kopyalar kalır. Bu işlem geri alınamaz.')) return;
    b.disabled = true;
    say('Hesap siliniyor…', false);
    try {
      const r = await cloud.deleteAccount({ localChat: removeLocalChatAccount, local: (id) => app.forgetLocalData(id) });
      if (!r.ok) { say(r.error || 'Hesap silinmedi. Yeniden dene.', false); return; }
      ui._menuMain('Aevum hesabı silindi.');
    } catch (e) { say('Hesap silme doğrulanamadı. Yeniden dene. ' + authMessage(e), false); }
    finally { b.disabled = false; }
  });
  return b;
}

function download(rows, source) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ source, messages: rows }, null, 2)], { type: 'application/json' }));
  const a = h('a'); a.href = url;
  a.download = `aevum-sohbet-${source}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function menuChatHistory(ui, back) {
  const cloud = ui.app.cloud, uid = cloud?.user?.uid;
  if (!uid) { ui._menuMain(); return; }
  const box = ui._menuBox(''); box.classList.add('profile');
  box.append(h('h2', '', 'Sohbet Geçmişi'), chatPrivacyNotice());
  const status = h('div', 'prof-dim'); status.setAttribute('role', 'status'); box.append(status);
  const say = (text, bad = false) => { status.textContent = text; status.className = bad ? 'mperr' : 'prof-dim'; };
  const active = () => box.isConnected && cloud.user?.uid === uid;
  const local = h('div', 'prof-actions'), remote = h('div', 'prof-actions');
  const output = h('div', 'chat-history-output'); output.hidden = true;
  const view = (rows, source) => {
    let offset = 0;
    const header = h('h3', '', `${source} · ${rows.length} mesaj`), list = h('ul');
    const more = button('Daha Fazla Göster', () => {
      if (!active()) return;
      for (const r of rows.slice(offset, offset + 50)) list.append(h('li', '', `${r.t || r.at || ''} [${r.room || '–'}] ${r.name || '?'}: ${r.text || ''}`));
      offset += 50;
      more.hidden = offset >= rows.length;
    });
    output.replaceChildren(header, list, more); output.hidden = false;
    more.onclick();
  };
  let mode, busy = false;
  const pref = h('p', 'prof-dim');
  const drawMode = () => {
    pref.textContent = { on: 'Bulut kaydı açık.', off: 'Bulut kaydı kapalı.', 'delete-history': 'Bulut geçmişi silme bekliyor. Yeniden silmeyi dene.', 'delete-account': 'Hesap silme bekliyor. Profil ekranından yeniden dene.' }[mode] || 'Bulut kayıt ayarı doğrulanamadı.';
    toggle.textContent = mode === 'on' ? 'Bulut Kaydını Kapat' : 'Bulut Kaydını Aç';
    toggle.disabled = busy || !['on', 'off'].includes(mode);
    cloudDelete.disabled = busy || mode === 'delete-account';
  };
  const refresh = async () => { try { mode = await cloud.chatHistoryMode(); } catch { mode = null; } if (active()) drawMode(); };
  const controls = [];
  const action = (text, fn) => {
    const b = button(text, async () => {
      if (busy || !active()) return;
      busy = true; for (const item of controls) item.disabled = true;
      drawMode(); say('İşlem sürüyor…');
      try { await fn(); } catch (e) { if (active()) say(authMessage(e), true); }
      finally { busy = false; if (active()) { for (const item of controls) item.disabled = false; drawMode(); } }
    });
    controls.push(b); return b;
  };
  const input = h('input', 'mpinput'); input.type = 'number'; input.min = '0'; input.max = String(MAX_CHAT_LIMIT); input.step = '1'; input.value = String(localChatHistory().limit);
  input.onkeydown = (e) => e.stopPropagation();
  const label = h('label', '', 'Yerel satır sınırı (0 = kapalı) '); label.append(input);
  const resetView = () => { output.hidden = true; output.replaceChildren(); };
  local.append(label, action('Sınırı Kaydet', () => {
    setLocalChatLimit(input.valueAsNumber); resetView(); say('Yerel sınır kaydedildi.');
  }), action('Yerel Geçmişi Göster', () => { view(localChatHistory().rows.reverse(), 'Yerel'); say(''); }),
  action('Yerel JSON İndir', () => { download(localChatHistory().rows, 'yerel'); say(''); }),
  action('Yerel geçmişi temizle', () => {
    if (!confirm('Bu tarayıcıdaki sohbet geçmişin silinsin mi?')) { say(''); return; }
    resetView(); clearLocalChatHistory(); say('Yerel sohbet geçmişi temizlendi.');
  }));
  const toggle = action('Bulut Kaydını Aç', async () => {
    const enable = mode === 'off';
    if (enable && !confirm(`Bundan sonra gönderdiğin sohbet mesajlarının ${CHAT_RETENTION_DAYS} günlük saklama hedefiyle Google Firestore’a kaydedilmesini onaylıyor musun?`)) { say(''); return; }
    try { await cloud.setChatHistoryEnabled(enable); if (active()) say(enable ? 'Bulut kaydı açıldı.' : 'Bulut kaydı kapatıldı; mevcut kayıtlar silinmedi.'); }
    finally { await refresh(); }
  });
  const cloudDelete = action('Bulut Geçmişini Sil', async () => {
    if (!confirm('Buluttaki sohbet kayıtların kalıcı olarak silinsin ve bulut kaydı kapatılsın mı? Yerel geçmiş kalır.')) { say(''); return; }
    resetView();
    const r = await cloud.deleteChatHistory();
    await refresh();
    if (active()) say(r.ok ? 'Bulut sohbet geçmişi silindi ve kayıt kapatıldı.' : r.error, !r.ok);
  });
  remote.append(toggle,
    action('Bulut Geçmişini Göster', async () => { const rows = await cloud.listChatHistory(); if (active()) { view(rows, 'Bulut'); say(''); } }),
    action('Bulut JSON İndir', async () => { const rows = await cloud.listChatHistory(); if (active()) { download(rows, 'bulut'); say(''); } }),
    cloudDelete, action('Bulut Ayarını Yenile', async () => { await refresh(); if (active()) say(''); }));
  box.append(local, pref, remote, output);
  ui._mbtn(box, 'Geri', back);
  const off = cloud.onChange(() => {
    if (!active()) { resetView(); off(); if (box.isConnected) ui._menuMain(); }
  });
  drawMode(); refresh();
}

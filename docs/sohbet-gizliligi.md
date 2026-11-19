# Sohbet geçmişi ve gizlilik

- **Tarayıcı:** Lobi ve oyun içi çok oyunculu sohbette gönderilen ve alınan mesajlar, tarih/saat, oda ve görünen oyuncu adıyla birlikte bu siteye ait `localStorage` alanında, Firebase hesabına göre (`aevum.chatlog.v2.<uid>`) tutulur. Bu kopya cihazlar arasında taşınmaz. Varsayılan sınır son **1.000** satırdır; **0–5.000** arası ayarlanabilir, 0 yerel kaydı kapatır. Zamana dayalı silme yoktur: satır sınırı aşılınca eski satırlar atılır. Tarayıcı yazma kotasını aşarsa yeni kayıtlar yalnızca sekme belleğinde kalabilir. Hesapları karıştıran eski `aevum.chatlog.v1` kaydı yeni sürümde aktarılmaz, tarayıcıdan kaldırılır. Aynı tarayıcı profiline veya geliştirici araçlarına erişim, uygulamanın hesap ayrımından bağımsızdır.
- **Bulut:** Varsayılan kapalıdır. **Profil → Sohbet Geçmişi → Bulut Kaydını Aç** seçilip onaylanırsa yalnızca o noktadan sonra hesabın **gönderdiği** mesajlar Google Cloud Firestore’da `users/{uid}/chatlog/{id}` altında tutulur. Alınan mesajlar ve eski yerel geçmiş buluta aktarılmaz. Ayar hesap geneline uygulanır. Bağlantı veya eşzamanlı yazma hatasında sohbet iletilmeye devam eder; bulut kopyası için yeniden gönderim kuyruğu yoktur. Kapatmak yeni bulut kaydını durdurur, eski kayıtları silmez. Yeni belgelerin sona erme hedefi **30 gün**; kalıcı otomatik silme etkin Firestore TTL politikasına bağlıdır ve anlık değildir.
- **Erişim ve silme:** Profil ekranından kendi yerel ve bulut geçmişini ayrı ayrı görebilir, JSON indirebilir veya silebilirsin. **Bulut Geçmişini Sil** işlemi sırasında yeni bulut kayıtları durur; başarıyla bittiğinde ayar kapalı kalır. **Hesabı Sil** aynı Google hesabıyla doğrulama ister; sohbet alt koleksiyonunu sayfa sayfa boşaltıp bu tarayıcıdaki hesaba ait sohbet kopyasını kaldırmadan Firebase Auth hesabını silmez. Bir adım başarısızsa kısmi silme olabilir; aynı hesabınla aynı işlemi yeniden dene. Silme diğer cihazlardaki tarayıcı verilerini, diğer oyuncuların yerel kopyalarını veya önceden indirilen dosyaları kaldırmaz. Oyun sunucusu mesajları iletir (iletim sırasında bellekte tamponlayabilir), kalıcı sohbet arşivi tutmaz.

## Yayına alma: Firestore kuralları ve TTL

Canlı kurallar repoda tutulmuyor. Yayınlamadan önce Firebase Console → **Firestore Database → Rules** altında mevcut kuralları inceleyin. Sohbet ve `users/{uid}/meta/chat` ayarı yalnızca `request.auth.uid == uid` olan hesap tarafından okunup yönetilebilmelidir. Üst belgeyi silmek alt koleksiyonu silmez; kural ve TTL ayarları istemcinin açık silme akışının yerine geçmez.

Yeni istemci onayı kontrol eder; **eski/açık sekmelerin onaysız yazmasını da engellemek için** `/users/{uid}/chatlog/{id}` için aşağıdaki sohbet kuralını mevcut kurallara uyarlayın. Firestore'da eşleşen `allow` ifadeleri **VEYA** ile birleşir: `chatlog` için daha geniş bir izin varsa onu hariç tutun (örn. diğer hesap alt koleksiyonlarına yönelik `match /users/{uid}/{collection}/{rest=**}` koşulunda `collection != 'chatlog'`). Diğer koleksiyonların erişimini genişletmeyin. `meta/chat` için mevcut sahip kuralını koruyun; varsa alan doğrulamasını `{mode: 'off' | 'on' | 'delete-history' | 'delete-account'}` ile uyumlu hale getirin. Uygulama mesaj kayıtlarını güncellemez; yeni kayıt tek seferlik `create` işlemi kullanır.

```text
// Mevcut match /databases/{database}/documents bloğu içinde:
match /users/{uid}/chatlog/{id} {
  function owner() { return request.auth != null && request.auth.uid == uid; }
  allow read, delete: if owner();
  allow create: if owner()
    && existsAfter(/databases/$(database)/documents/users/$(uid)/meta/profile)
    && getAfter(/databases/$(database)/documents/users/$(uid)/meta/chat).data.mode == 'on'
    && request.resource.data.uid == uid
    && request.resource.data.at == request.time
    && request.resource.data.expiresAt is timestamp
    && request.resource.data.expiresAt > request.time
    && request.resource.data.expiresAt <= request.time + duration.value(31, 'd');
}
```

İki test hesabıyla kurallar yayımlanmadan önce doğrulayın: A, kendi geçmişini listeleyip silebilmeli; B, A’nın belgesini okuyamamalı ve A’nın koleksiyonunu listeleyememeli/silememeli. Onaysız, `expiresAt` içermeyen ve silme kilidi altındaki yazmalar reddedilmeli; onaylı yeni istemci yazması başarılı olmalı. Node testlerindeki Firebase taklidi sahiplik modelini sınar, **yayınlanmış kuralları sınamaz**.

1. Google Cloud Console → **Firestore → Time-to-live** bölümünde `(default)` veritabanını seçin. **Collection group:** `chatlog`, **timestamp field:** `expiresAt`. Alternatif olarak uygun yönetim yetkisiyle:
   ```sh
   gcloud firestore fields ttls update expiresAt --collection-group=chatlog --database='(default)' --enable-ttl --project=PROJE_KIMLIGI
   ```
2. Politikanın etkinleştiğini Console'dan doğrulayın. Sona ermiş belgeler tipik olarak 24 saat içinde silinir, ancak silme gecikebilir. TTL silmelerinin faturalandırma/plan gereksinimlerini kontrol edin (gerektiğinde Blaze/faturalandırma); sadece alan yazmak silme sağlamaz.
3. Eski `chatlog` belgelerinde `expiresAt` yoktur; TTL bunları kendiliğinden silmez. Yetkili bir operatör, mevcut saklama politikasına göre eski belgeleri silmeli veya güvenilir Firestore `at` zamanından `at + 30 gün` olacak şekilde **Timestamp** alanını doldurmalıdır. Güvenilir zaman yoksa ayrı olarak inceleyip silin. Otomatik toplu taşıma/değişiklik yapılmaz.

## Toplu okuma aracı

`tools/read-chatlog.mjs` bakım ve yetkili sohbet incelemesi için tüm `chatlog` koleksiyonlarında collection-group sorgusu çalıştırır. `--since` ve `--room` filtreleri **sonuçlar okunduktan sonra** uygulanır; aracı yalnızca bu kapsamda erişime yetkili operatör çalıştırmalıdır. Araç Firebase kullanıcı hesabı/oyun içi yönetici rolüyle değil, mevcut proje için Firestore sorgulama/okuma iznine sahip **Google Cloud IAM servis hesabıyla** çalışır. Bu erişim istemci Firestore kurallarından bağımsızdır; yalnızca gerekli IAM izinlerini verin (örn. sorgu için `datastore.entities.list`, belge okumaya ihtiyaç varsa `datastore.entities.get`). Mevcut rol ve izinler bu değişiklikle genişletilmez. Araç anahtarı `AEVUM_SA` ile verilen yerel dosyadan veya `~/.aevum/firebase-sa.json` yolundan okur. Anahtarı ya da sohbet çıktısını depoya koymayın; çıktıyı yetkisiz kişilerle paylaşmayın ve inceleme bitince kaldırın.

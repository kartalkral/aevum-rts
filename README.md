# Aevum

**Oyna:** https://aevum-8clf.onrender.com · **English:** see [CONTRIBUTING.md](CONTRIBUTING.md)

Tarayıcıda çalışan, özgün bir 3B gerçek zamanlı strateji oyunu. Taş Devri'nden Sanayi Çağı'na beş çağ boyunca köy kur, kaynak topla, ordu bas, rakibi yık.

## Çalıştırma

- `baslat.bat` dosyasına çift tıkla (Node.js gerekir). Tarayıcıda `http://localhost:5173` açılır.
- Elle: `node server.js`, sonra tarayıcıdan `http://localhost:5173`.
- Arkadaşınla internet üzerinden oynamak için `baslat-online.bat`: sunucuyu başlatır ve localhost.run üzerinden geçici bir adres açar (OpenSSH gerekir).
- Three.js CDN'den yüklenir, ilk açılışta internet gerekir. Kurulum / derleme adımı yok.

## Kontroller

| Tuş / fare | İşlev |
|---|---|
| Sol tık / sürükle | Seç / kutu ile seç |
| Shift + sol tık | Seçime ekle / çıkar |
| Çift tık | Ekrandaki aynı türden tüm birimleri seç |
| Sağ tık | Yürü, saldır, topla, inşa et / onar; bina seçiliyken toplanma noktası |
| Shift + sağ tık | Komutu sıraya ekle |
| WASD / ok tuşları / ekran kenarı | Kamerayı kaydır (WASD yalnızca kamerayı oynatır) |
| Fare tekerleği | İmlece doğru yakınlaş / uzaklaş |
| Orta tuş sürükle | Kamerayı döndür |
| Ctrl+1..9 / 1..9 | Grup ata / seç (çift bas: kamerayı götür) |
| Home / Backspace | Şehir merkezine git |
| Boşluk | Son uyarının olduğu yere git |
| . (nokta) / Tab | Sıradaki boşta köylü |
| Delete | Seçili kendi birimini / binanı sil |
| Esc | Yerleştirmeyi iptal et / seçimi bırak |
| Q E R T Y / F G H J K / Z X C V B | Komut kartı düğmeleri (ızgara sırasıyla) |
| Enter | Sohbet (çok oyunculu) |
| P / F10 | Duraklat (tek oyunculu) |
| F5 | Hızlı kayıt (tek oyunculu) |

Bina yerleştirirken: sol tık yerleştirir, Shift basılıyken yerleştirmeye devam eder, duvarı sürükleyerek hat halinde çekebilirsin, sağ tık / Esc iptal.

## Özellikler

- 5 çağ, 22 birim (gemiler dahil), 26 bina, teknolojiler, pazar ticareti, görevler
- 1-3 yapay zekâ rakip, üç zorluk, üç harita boyu, kum havuzu modu
- Harita türleri: Nehir Vadisi, Kıta, Yaylalar, Ovalar, İç Deniz, Adalar veya Rastgele (tohumdan seçilir)
- Çok oyunculu: oda kodlu lobi, en fazla 8 oyuncu (insan veya yapay zekâ), takımlar, sohbet, deterministik lockstep; kayıtlı çok oyunculu maça devam etme
- Savaş sisi, tarla döngüsü, kayıt / yükleme (tarayıcıda IndexedDB)
- Ana menünün arkasında kendi kendine oynayan demo sahne

## Kayıt ve yükleme

Tek oyunculu oyunda **F5** ile elle kayıt alınabilir; oyun ilerlerken yaklaşık 90 saniyede bir otomatik kayıt alınır. Çok oyunculu kayıtlar **Kayıtlı Maça Devam Et** üzerinden yeni bir lobide açılır; eski lobi, bağlantılar ve henüz simülasyonda işlenmemiş ağ komutları kayıttan dönmez.

| Durum | Yüklemede ne olur? |
|---|---|
| Kontrol grupları (Ctrl+1…9) | Oyuncu başına kaydedilir. Yükleyen oyuncu kendi gruplarını geri alır; ölmüş, artık mevcut olmayan veya sahipliği değişmiş üyeler ayıklanır. |
| Birim emirleri | Birimin yürürlükteki emri ve simülasyona işlenmiş Shift kuyruğu kayıttan döner. |
| Bina üretimi ve araştırma | Üretim, araştırma ve çağ atlama kuyrukları işlem süreleriyle birlikte saklanır. Bitmiş teknolojiler geri yüklenir, etkileri yeniden hesaplanır. |
| Görevler | Tek oyunculuda tamamlanan görevler ve ilerleme sayaçları saklanır; aktif görevler ve ilerleme metni yeniden hesaplanır. Yüklemenin hemen ardından, görev dinleyicileri kurulmadan tamamlanan bazı olaylar (ör. araştırma) görev sayacına yansımayabilir. Çok oyunculuda görev sistemi etkin değildir. |
| Yapay zekâ | Güncel kayıtlar AI gruplarını, keşif/hafıza durumunu, rastgele sayı üretecinin durumunu ve karar zamanlayıcılarını geri yükler. Eski AI kayıtlarında yalnızca eşlenebilen alanlar taşınır. |
| Arayüz | O anki seçim, kamera konumu, duraklatma ve bina yerleştirme önizlemesi kayda girmez. Kontrol grupları anlık seçimden ayrıdır. |

Yerel kopya bu tarayıcının IndexedDB deposundadır; site verisini silmek yerel kopyayı kaldırır. Varsa bulut kopyası bundan ayrıdır.

**Eski kayıtlar:** Oyun verisi `v: 1` olarak yazılır; bu etiket tek başına uyumluluk garantisi değildir. Yükleyici eski sıkıştırılmamış harita/sis dizilerini de okur. Kontrol grubu alanı olmayan kayıtlarda gruplar boş başlar. AI verisinin ayrı bir sürümü vardır (güncel `v: 2`); eski dalga verisinden yalnızca bazı grup ve zamanlama bilgileri taşınır, örneğin eski keşif rotası geri gelmez. Her eski kayıt ya da sürümler arasında birebir simülasyon devamı garanti edilmez.

## Sohbet gizliliği

Bulut sohbet geçmişi varsayılan olarak kapalıdır. **Profil → Sohbet Geçmişi** üzerinden yerel ve bulut kayıtlarını ayrı ayrı görüntüleyebilir, JSON olarak indirebilir ve silebilirsin. [Saklama, hesap silme ve Firestore yapılandırması](docs/sohbet-gizliligi.md).

## Dürüst notlar

- Modüller paralel yazıldı; bu sürümde uçtan uca oyun testi yapılmadı, hata çıkabilir.
- Harita editörü ve senaryo/kampanya yok.
- Duvarı sürüklerken önizleme yalnızca uç karoyu gösterir.

## Geliştirmeye katıl

Aevum açık kaynak; herkes geliştirebilir. Nasıl çalıştırılır, testler, PR kuralları: [CONTRIBUTING.md](CONTRIBUTING.md).

- Yerelde (`localhost`) yeni oyun ekranında **Geliştirici modu** çıkar: tüm harita açık, sınırsız kaynak, çağ değiştirme.
- Çok oyunculu ve hesap özellikleri için kendi Firebase projeni bağlayabilirsin (CONTRIBUTING.md).

## Lisans

Bu repo, [flickrz/aevum-rts](https://github.com/flickrz/aevum-rts) projesinin değiştirilmiş bir fork’udur. Bu sürüm: [kartalkral/aevum-rts](https://github.com/kartalkral/aevum-rts).

Kodun lisansı kökteki [LICENSE](LICENSE) dosyasında belirtilir. Modeller, ikonlar, sesler ve diğer üçüncü taraf içerikler kendi lisanslarına tabi olabilir. Ticari kullanım veya yeniden dağıtım öncesinde [varlık lisanslarını](assets/LICENSE.md), [ikon atıflarını](assets/icons/LICENSE.md) ve [ses kaynaklarını](assets/sfx/LICENSES.md) ayrıca kontrol edin. Aevum adı ve logosu için [mevcut proje politikasına](CONTRIBUTING.md#name) bakın.

Game-icons.net’ten alınan `badges/crown`, `badges/shield` ve `badges/star` ikonları [Delapouite](https://github.com/game-icons/icons/commit/e6fd03f28d7a48ac17af88b2e3ac35aed56b6994) tarafından eklenmiştir; sprite’a alınırken renkleri kaldırılmıştır ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)).

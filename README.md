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

## Lisans ve varlık kaynakları

Kodun lisansı tüm oyun paketine veya üçüncü taraf içeriklere otomatik olarak uygulanmaz. Dosya bazlı kaynaklar, doğrulama notları ve eksik seslerin yerel kurulumu: [assets/CREDITS.md](assets/CREDITS.md).

| Bileşen | Hak sahibi / kaynak | Lisans / durum | Kullanım koşulları |
| --- | --- | --- | --- |
| Oyun ve sunucu kodu | Aevum katkıcıları; [paket bildirimi](package.json), [lisans metni](LICENSE) | GNU AGPL v3 veya sonrası | Ticari kullanım yasaklanmaz. Dağıtım hükümlerine uyun; değiştirdiğiniz sürümle ağ üzerinden etkileşen kullanıcılara Karşılık Gelen Kaynağı ücretsiz edinme olanağı sunun (§13). |
| 3B modeller | [Depo bildirimi](assets/LICENSE.md): atıf “Aevum” | Depo beyanı: [CC BY-NC-SA 4.0](assets/LICENSE-CC-BY-NC-SA-4.0.txt); kaynak hakları bağımsız doğrulanamadı | Beyandaki izin ticari amaçlı kullanımı kapsamaz. Paylaşımda atıf, lisans ve değişiklik bilgisi; uyarlamalarda ShareAlike koşulu geçerlidir. |
| GLB içindeki dokular | 90 gömülü JPEG; dosya bazlı kaynak kaydı yok | Ayrı kaynak ve **lisansı doğrulanamadı** | Model klasörü beyanı var; JPEG'ler için ayrıca yeniden kullanım izni varsaymayın. Prosedürel dokular ayrı bir dosya olarak dağıtılmıyor. |
| İkonlar | Game-icons.net yazarları; [sprite atıfları](assets/icons/LICENSE.md) ve [istisnalar](assets/CREDITS.md#kod-modeller-ve-görseller) | Çoğu CC BY 3.0, Zeromancer `heart-plus` CC0 1.0; üç yerel duruş ikonunun **lisansı doğrulanamadı** | CC BY simgelerde kaynak/yazar ve lisansı belirtin, değişiklikleri işaretleyin. CC BY ve CC0 ticari kullanımı yasaklamaz. |
| CC0 kaynaklı sesler | Kenney ve OpenGameArt üreticileri; [dosya eşlemesi](assets/sfx/LICENSES.md) | 78 takip edilen MP3 yalnızca CC0 kaynaklarla eşlenmiş | CC0 kapsamındaki haklar bakımından ticari kullanım ve paylaşım serbesttir; aşağıdaki karışımlar ayrı incelenir. |
| LIB/KIT sesleri ve iki top sesi karışımı | Kaynak kaydında UR.FASTEDITOR paketi ve yerel kit; karışımlarda ayrıca Thimras | **Lisansı doğrulanamadı** | 32 ses açık dışa aktarım dışında. Takip edilen `cannon_shot2.mp3` ve `cannon_shot3.mp3` de yeniden dağıtım için doğrulanmış değil. [Ayrıntılar ve yerine ses koyma](assets/CREDITS.md#sesler-dosya-kaydı-ve-fiilî-dağıtım). |
| Fontlar | Google/Noto Emoji; sistem fontları kullanıcının cihazından | Noto Color Emoji: SIL OFL 1.1; sistem fontları depoda dağıtılmıyor | Noto font dosyasını tek başına satmayın; yeniden dağıtırken telif ve lisans metnini koruyun. |
| Tarayıcı kütüphaneleri (CDN) | Three.js yazarları, Arseny Kapoulkine, Google/Firebase | Three.js ve MeshoptDecoder: MIT; Firebase SDK: Apache-2.0 ([kaynak notları](assets/CREDITS.md#cdn-fontlar-ve-marka-işaretleri)) | Yeniden paketlerken ilgili lisans ve telif bildirimlerini koruyun. Firebase hizmet koşulları SDK lisansından ayrıdır. |
| Google giriş işareti | Google; [giriş düğmesi yönergeleri](https://developers.google.com/identity/branding-guidelines) | Depodaki SVG'nin ayrı **lisansı doğrulanamadı** | Yönergeler işaret için genel bir açık lisans değildir. |
| Aevum adı ve logosu | [Mevcut ad politikası](CONTRIBUTING.md#name), [varlık bildirimi](assets/LICENSE.md) | Mevcut depo politikasına göre bu lisansların dışında | Depo politikası fork'larda farklı bir ad kullanılmasını istiyor. Ayrı bir izin veya tescil durumu doğrulanmadı. |

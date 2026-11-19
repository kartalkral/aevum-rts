# Aevum: üçüncü taraf bileşenleri ve varlık kaynakları

Bu envanter bir lisans veya izin belgesi değildir. Mevcut [kod lisansını](../LICENSE), [varlık lisans bildirimini](LICENSE.md), [ikon atıflarını](icons/LICENSE.md) ve [dosya bazlı ses kaydını](sfx/LICENSES.md) değiştirmez. Aşağıdaki notlar, bu kayıtları takip edilen dosyalar ve erişilebilen kaynak yayınlarıyla karşılaştırır. **Lisansı doğrulanamadı** ifadesi izin verildiği ya da kesin olarak yasaklandığı anlamına gelmez: ilgili kullanım veya yeniden dağıtım için elde yeterli belge yoktur.

## Kod, modeller ve görseller

| Bileşen | Kaynak ve doğrulama | Lisans / kullanım notu |
| --- | --- | --- |
| Proje kodu | Aevum katkıcıları; [`package.json`](../package.json) `AGPL-3.0-or-later` bildirir, kök [`LICENSE`](../LICENSE) AGPL v3 metnidir. | AGPL-3.0-or-later. Ticari kullanım tek başına yasaklanmaz. Dağıtımda §§4–6, değiştirilmiş sürümle ağ üzerinden etkileşen kullanıcılara Karşılık Gelen Kaynak teklifinde §13 geçerlidir. Üçüncü taraf varlıklar ayrı değerlendirilir. |
| `models/{0–4}/*.glb`, `models/trees/{pine,crop}.glb` | [Varlık bildirimi](LICENSE.md) atıf olarak “Aevum”u listeler. [Yükleyici açıklaması](../src/render/glb-models.js) binalarda Seedream konsepti → Meshy 3B → çevrimdışı küçültme akışını belirtir; ağaç ve ekin için aynı hizmet/hesap zincirini belirtmez. 91 GLB'nin başlığı glTF-Transform 4.1.1 gösterir, hak sahibi veya lisans belirtmez. | Depo beyanı **CC BY-NC-SA 4.0** ([mevcut metin](LICENSE-CC-BY-NC-SA-4.0.txt)). Beyan yalnızca lisans verenin yetkili olduğu hakları kapsar. Kaynak girdileri, kullanılan hizmet planı ve dosya bazlı yeniden lisanslama yetkisi **doğrulanamadı**. |
| GLB içindeki dokular | 90 GLB'de birer gömülü JPEG, `trees/crop.glb`'de gömülü resim yok. Takip edilen ayrı doku dosyası veya JPEG'ler için varlık bazlı kaynak/lisans kaydı yok. | Modeller için yukarıdaki klasör beyanı mevcut; JPEG'lerin ayrı kaynağı ve hakları için **lisansı doğrulanamadı**. Dosyaya gömülü olması, bağımsız bir kullanım izni göstermez. |
| Prosedürel doku/modeller ve profil avatarları | [Render kodu](../src/render/renderer.js) ve [efektler](../src/render/fx.js) çalışma anında görseller oluşturur; [profil avatarları](../src/avatars.js) dosyada Aevum için çizilmiş satır içi SVG'ler olarak tanımlanır. | Üretim kodu proje kodunun lisans bildirimi kapsamındadır. Bu görseller için ayrı bir grafik varlığı lisans bildirimi bulunmadı. |
| İkon sprite'ı (`icons/icons.svg`) | [İkon eşlemesi](../tools/icons-map.json), [yazar listesi](icons/LICENSE.md), [Game-icons.net lisans kaydı](https://github.com/game-icons/icons/blob/82d948812bfe3f269ef8f731dcdb07b08160edc4/license.txt). 144 simgenin 141'inin çizim yolları [bu kaynak sürümüyle](https://github.com/game-icons/icons/tree/82d948812bfe3f269ef8f731dcdb07b08160edc4) eşleşti. | Game-icons kaynaklı simgeler için [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/legalcode) varsayılanı, aşağıdaki istisnalarla. Yeniden dağıtırken yazar/kaynak ve lisans atfını koruyun, uygulanan değişikliği (çizim yollarının sprite'a alınması, arka plan/dolgunun kaldırılması) belirtin. CC BY 3.0 ticari kullanımı yasaklamaz. |

Model bildiriminin kullanım koşulları için CC BY-NC-SA 4.0 §§1(k), 2(a) ve 3'e bakın: verilen izin ticari amaçlı kullanımı kapsamaz; paylaşımda “Aevum” atfı, lisans ve değişiklik bilgileri korunur, paylaşılan uyarlamalar aynı lisansa veya metnin izin verdiği uyumlu bir lisansa tabidir. Bu koşullar, proje kodunun lisansını değiştirmez.

**İkon kaydındaki ayrıntılar:**

- `badges/crown`, `badges/shield` ve `badges/star`: [Game-icons kaynak commit'i](https://github.com/game-icons/icons/commit/e6fd03f28d7a48ac17af88b2e3ac35aed56b6994) üçünü Delapouite'in eklediğini gösteriyor. Kaynakta bu klasör için ayrı bir lisans istisnası belirtilmiyor; genel CC BY 3.0 bildirimi uygulanıyor.
- `zeromancer/heart-plus`: [ikonun kaynak sayfası](https://game-icons.net/1x1/zeromancer/heart-plus.html) ve kaynak depo istisnası **CC0 1.0** gösteriyor; tüm sprite'ın CC BY 3.0 olduğu şeklindeki genel ifade bu simge için geçerli değil.
- `x-stance-aggr`, `x-stance-def`, `x-stance-hold`: eşleme bunları “own drawing” olarak işaretliyor; Game-icons'a atfedilmiyor. Ayrı bir kullanım izni, yazar adı veya lisans beyanı bulunamadı: **lisansı doğrulanamadı**.

## Sesler: dosya kaydı ve fiilî dağıtım

[Ses kaynak kaydı](sfx/LICENSES.md) MP3 adını, kaynak dosyayı, karışım katmanlarını ve uygulanan dönüşümleri listeler. **112 kayıt** var; bu checkout'ta **80 MP3 takip ediliyor**. Kaynak kaydı bunların **78'ini** yalnızca CC0 kaynaklarla eşliyor. Aşağıdaki yayınlarda CC0 teyit edildi; bu, işlenmiş her MP3'ün kaynakla ses düzeyinde karşılaştırıldığı anlamına gelmez. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode) kapsamındaki haklar bakımından ticari kullanım ve yeniden paylaşım yasaklanmaz, atıf zorunlu değildir.

| Kayıt kodu | Kaynak yayını ve üretici |
| --- | --- |
| KENNEY / KIMPACT | Kenney — [RPG Audio](https://kenney.nl/assets/rpg-audio), [Impact Sounds](https://kenney.nl/assets/impact-sounds) |
| SNM | Ben Jaszczak ve Brian Nelson (Still North Media) — [Medieval Sound Effects: Weapon Impacts](https://opengameart.org/content/medieval-sound-effects-weapon-impacts); arşiv yayını ve kaynak beyanı |
| BAS | Thimras — [Battle at Sea](https://opengameart.org/content/battle-at-sea) |
| ADB / ADS | artisticdude — [Battle Sound Effects](https://opengameart.org/content/battle-sound-effects) (CC0 seçeneklerden biri), [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) |
| JSW | Vehicle / Jan Schupke — [Fantasy Weapons and Apparel SFX Library](https://opengameart.org/content/fantasy-weapons-and-apparel-sfx-library) |
| RD100 / RD100v2 / RD80 | rubberduck — [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx), [100 CC0 SFX #2](https://opengameart.org/content/100-cc0-sfx-2), [80 CC0 RPG SFX](https://opengameart.org/content/80-cc0-rpg-sfx) |
| GRUNTS / YELL | thebardofblasphemy — [Grunts of Male Death and Pain](https://opengameart.org/content/grunts-male-death-and-pain); HaelDB — [Male Grunt/Yelling Sounds](https://opengameart.org/content/male-gruntyelling-sounds) (CC0 seçeneklerden biri) |

**LIB / KIT — lisansı doğrulanamadı.** Ses kaydı LIB'i “1000+ UR.FASTEDITOR SFX”, KIT'i bu kütüphaneden hazırlanmış yerel kit olarak tanımlıyor. Özgün dağıtımın geçerli lisans metni ve örnek başına hak zinciri bulunamadı. Ücretsiz edinim, yeniden dağıtım veya ticari kullanım izni olduğunun kanıtı değildir. [Açık dışa aktarım listesi](../tools/public-exclude.txt) bu checkout'ta bulunmayan 32 dosyayla eşleşiyor.

**Yayım öncesi inceleme:** `sfx/cannon_shot2.mp3` ve `sfx/cannon_shot3.mp3` Git'te takip ediliyor ve dışlama listesinde yok. Kaynak kaydı ikisi için de **BAS + LIB** katmanları gösteriyor. BAS'ın CC0 olması karışımın tamamını kapsamaz. İki karışımın **lisansı doğrulanamadı**; mevcut MP3'lerin hangi girdilerden üretildiğini veya paylaşım iznini bakımcı doğrulamalı. Buna kadar bu dosyaları yeniden dağıtım için doğrulanmış saymayın; yayımlanacak bir kopyadan çıkarın veya doğrulanmış girdilerle yeniden hazırlayın. Bu belge, dosyaları veya dışa aktarım ayarlarını değiştirmez.

### Eksik sesleri yerelde kullanma veya yerine ses koyma

1. Eksik dosya adlarını [dışlama listesinden](../tools/public-exclude.txt), özgün örnek eşlemesini [ses kaydından](sfx/LICENSES.md) alın. Özgün LIB/KIT için bakımcıdan yetkili edinim adresini, paket sürümünü, özgün örneğin kaynağını ve kullanımınıza uygun lisans metnini isteyin. Doğrulanmış bir edinim adresi bulunamadı; özel kit dizini bir indirme kaynağı değildir.
2. Yerel kullanımınıza izin verildiği doğrulanmışsa, sesleri [oyunun beklediği adlarla](../src/audio.js) `assets/sfx/<ad>.mp3` olarak yerel çalışma kopyasına koyun. Kaynak kaydındaki biçim mono 44,1 kHz MP3; tarayıcı `<ad>.mp3` ister ve okunamayan örneği atlar. Ek bir oyun ayarı gerekmez. Dosyaları izin kapsamı doğrulanmadan commit etmeyin, statik web dağıtımına veya başka bir pakete dahil etmeyin.
3. İzin veya kaynak bulunamazsa dosyaları eklemeyin (ilgili ses çalmaz; başka kayıtlı varyantlar varsa kullanılabilir) ya da örneğin yukarıdaki Kenney/OGA yayınlarından lisansı doğrulanmış bir sesle değiştirin. Yerine konan sesin kaynak URL'sini, lisansını ve yapılan düzenlemeyi kaydedin. Açık yayım için aynı adı taşıyan bir yedek, [dışa aktarım aracının](../tools/public-sync.mjs) dışlama listesinden hâlâ çıkarılacaktır; liste değişikliği, yedeğin hakları doğrulandıktan sonra ayrı bir bakımcı kararıdır.

## CDN, fontlar ve marka işaretleri

| Bileşen | Kaynak | Lisans ve kullanım koşulu |
| --- | --- | --- |
| Three.js `0.160.0` ve kullanılan eklentileri (`GLTFLoader`, `BufferGeometryUtils`) | Three.js yazarları; [`index.html` import map](../index.html), [r160 MIT metni](https://github.com/mrdoob/three.js/blob/r160/LICENSE) ve sürümün npm paketi | **MIT**. Ticari kullanım mümkündür. Kopyalara veya yazılımın esaslı bölümlerine telif ve izin bildirimi eşlik etmeli. Dosyalar repoya alınmamış, CDN'den yükleniyor. |
| MeshoptDecoder `0.18` | Arseny Kapoulkine; Three.js paketindeki [`meshopt_decoder.module.js` başlığı](https://github.com/mrdoob/three.js/blob/r160/examples/jsm/libs/meshopt_decoder.module.js), [Meshoptimizer v0.18 lisansı](https://github.com/zeux/meshoptimizer/blob/v0.18/LICENSE.md). | **MIT**, Three.js'nin kendi telif bildiriminden ayrı. Kopyalarken kendi telif ve izin metnini koruyun. |
| Firebase Web SDK `10.14.1` (`firebase-app.js`, `firebase-auth.js`) | Google LLC / Firebase; [`src/cloud/google.js`](../src/cloud/google.js), [sürümün kaynak lisansı](https://github.com/firebase/firebase-js-sdk/blob/firebase%4010.14.1/LICENSE) ve npm bildirimleri | **Apache-2.0**; upstream lisans dosyası protobuf için ayrı BSD-3-Clause istisnası belirtir. SDK'yı yeniden paketlerseniz ilgili lisansları ve varsa NOTICE'ı koruyun, değiştirilen dosyaları işaretleyin. Firebase hizmet koşulları SDK lisansından ayrıdır. |
| Noto Color Emoji | Google / Noto Emoji Project Authors; Google Fonts üzerinden [`index.html`](../index.html), [Google Fonts lisans metni](https://github.com/google/fonts/blob/main/ofl/notocoloremoji/OFL.txt) | **SIL OFL 1.1** (font yazılımı). Font tek başına satılamaz; font dosyalarını dağıtırken telif ve lisans bildirimini koruyun, değiştirilmiş fontlarda uygulanabilir ayrılmış ad koşulunu kontrol edin. Font dosyası repoda yok. |
| Sistem fontları / yerel alternatifler | [`style.css`](../style.css): Segoe UI, Inter, Roboto, Arial, sistem/Apple ve emoji alternatifleri | Yalnızca tarayıcıdaki font seçimi; depo font dosyalarını dağıtmıyor. Bu CSS listesi ayrı font dosyalarını yeniden dağıtma izni vermez. |
| Google “G” işareti | Google; giriş düğmesindeki satır içi [`G_SVG`](../src/ui/cloud-ui.js). [Google'ın giriş düğmesi yönergeleri](https://developers.google.com/identity/branding-guidelines) kullanım bağlamı ve resmî varlıklar için kaynaktır. | Bu SVG'nin hangi paketten alındığı ve bağımsız yeniden kullanım için **lisansı doğrulanamadı**. Google'ın yönergeleri genel bir açık lisans değildir; mevcut düğmenin uyumlu olduğu bu envanterle doğrulanmış değildir. |
| Aevum adı ve logosu | [Varlık bildirimi](LICENSE.md) ve [katkı rehberindeki ad politikası](../CONTRIBUTING.md#name). Menüdeki yazı işareti HTML/CSS ile oluşturulur. | Mevcut depo politikası, ad ve logoyu bu lisansların dışında tutuyor ve fork'larda başka ad kullanılmasını istiyor. Ayrı bir kullanım izni, tescil kaydı veya ayrıntılı marka politikası bulunamadı; belge yeni bir yasak veya izin getirmez. |

## Bakımcıdan / hak sahibinden istenecek açıklamalar

- **Modeller ve dokular:** dosya başına üretici ve kaynak girdileri, Seedream/Meshy hesap planı ve üretim tarihinde geçerli koşullar, gömülü JPEG kaynakları, lisans verenin dağıtım ve CC BY-NC-SA altında sunma yetkisi. Aynı kayıt `pine.glb` ve `crop.glb` için de gerekli.
- **Ses:** LIB/KIT için yetkili edinim kaynağı ve kullanım/yeniden dağıtım hükümleri; özellikle depoda takip edilen iki top sesi karışımının üretim kaydı veya doğrulanmış alternatifleri.
- **Özgün çizimler ve marka:** üç duruş ikonunun yazarı ve yeniden kullanım izni; Aevum ad/logo politikasının yetkili metni ve varsa izin kanalı. Google giriş işareti için kullanılan özgün varlığın kaynağı ve düğme uygulamasının ilgili yönergelere uyumu.

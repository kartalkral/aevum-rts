# RTS sorumluluk haritası

Bu refaktör oyun kurallarını, dengeyi, arayüz akışını veya kayıt biçimini değiştirmez. `Game`, `AIController` ve `UI` mevcut giriş noktalarıdır. Aşağıdaki dosyalar bu sınıfların kullandığı iç modüllerdir.

| Katman | Dosya | Sorumluluk |
| --- | --- | --- |
| Simülasyon | `src/sim/game.js` | Dünya ve varlık yaşam döngüsü, ana tick, ağ komut doğrulaması, görüş, demiryolu ve deniz taşıması |
| | `game-orders.js` | Birim emirleri, kontrol grupları, hareket ve yol bulma |
| | `game-economy.js` | Kaynak hesabı, toplama/teslimat, tarla ve sürü işleri, ticaret ve kaynak aktarımı |
| | `game-combat.js` | Hedefleme, saldırı emirlerinin yürütülmesi, hasar ve mermiler |
| | `game-production.js` | Bina yerleştirme, inşaat ve bina tick'i, üretim sıraları, araştırma ve çağ atlama |
| | `game-save.js` | `serialize`, kayıt alanlarının paketlenmesi ve geri yüklenmesi |
| | `game-shared.js` | Simülasyon ve AI tarafından kullanılan süre katsayıları, görüş ve harita geometrisi |
| AI | `src/sim/ai.js` | `AIController` durumu, karar sırası, görüş/hafıza, karar döngüsü ve kayıt |
| | `ai-economy.js` | Gelir tahmini, işçi dağıtımı, kaynak arama, kamplar ve pazar |
| | `ai-build-order.js` | Alışveriş listesi, harcama ve üretim öncelikleri, yerleştirme, donanma ve ray yatırımları |
| | `ai-fortifications.js` | Sur yerleşimi, geçilebilirlik kontrolü, kapılar ve kuleler |
| | `ai-military.js` | Keşif, savunma, baskın, taarruz ve askeri grup emirleri |
| | `ai-shared.js` | Ortak karar sabitleri ve saf hesap yardımcıları |
| Arayüz | `src/ui/ui.js` | `UI` kurulumu, ortak oyuncu bilgisi, simge başlangıcı ve maç içi sohbet |
| | `ui-hud.js` | HUD yenilemeleri, üst bar, mini harita, işaretler ve bildirimler |
| | `ui-menus.js` | Ana menü, ayarlar, kayıt ekranı, duraklatma ve çok oyunculu lobi |
| | `ui-panels.js` | Seçim ve komut kartı, araç ipuçları, teknoloji, istatistik ve kaynak aktarımı panelleri |
| | `ui-shared.js` | DOM yardımcıları, kaynak etiketleri ve biçimlendirme |

## Uyumluluk ve bağımlılıklar

- `Game` (`src/sim/game.js`), `AIController` (`src/sim/ai.js`) ve `UI` (`src/ui/ui.js`) aynı yerden içe aktarılır. Önceki adlandırılmış export'lar korunur; `Game.deserialize` statik kalır. Kaynak karşılaştırmasında üç sınıfın 371 metot tanımı birebir aynıydı.
- `src/method-table.js` taşınan metotları örneğe sarmalayıcı eklemeden, enumerate edilmeyen prototip üyeleri olarak kurar. `execCommand` ve inşaat sonrası otomatik toplama hâlâ doğrudan `Game.prototype` üzerinden çağrı yapar; ağ sarmalayıcılarına tekrar girmez.
- Tick, AI karar, komut ve oyun koleksiyonlarını dolaşma sırası korunur. Kaydın alanları, sırası ve eski alanlara yapılan geri dönüşler aynıdır. AI durumu yeni nesnelere taşınmadı.
- Statik ES modülü taramasında `game.js` ↔ `ai.js` döngüsü kalktı; `src` altında yeni döngü yok. Simülasyon DOM veya Three.js yüklemez; oyun zamanı, AI kararları ve RNG ilerlemesi duvar saatine bağlı değildir. Var olan `stats.ms` ölçümü yalnızca profil amaçlıdır ve olduğu gibi bırakılmıştır.

## Önce/sonra doğrulaması

Başlangıç: `1e518d5` kaynakları ve iki tarafta da aynı, önceden mevcut görev düzeltmesi. Karşılaştırma aynı seed ve aynı test komutlarıyla, her 300 tick'te yapıldı. Karşılaştırılan değerler `Game.hash()`, RNG durumu `rs` ve `JSON.stringify` ile üretilen kaydın SHA-256 özeti. Özet için yalnızca AI profil ölçümünün iki kopyası (`stats.ms`, `x.stats.ms`) sıfırlandı; normal oyun ve kayıt akışı değişmedi.

| Senaryo | Eşleşme | Örnek `Game.hash()` (önce = sonra) |
| --- | --- | --- |
| Seed 3, 12 dk lockstep ve komut tekrarı | 73/73 | Tick 0: `2774381929`; tick 21600: `780748365` |
| Seed 77, 6 dk + kayıt/yükleme + 6 dk; ek olarak seed 5 tek oyunculu kayıt | 74/74 | MP tick 10800: `1821511680`; MP tick 21600: `4130095583`; SP tick 900: `1594114571` |

Varsayılan `determinism-test`, `mp-save-test` ve `sim-smoke` geçti. Hedefli kayıt, görev, takım, sur/kapı, kaynak toplama ve playtest testleri de geçti. Ayrı jsdom karşılaştırmasında ana menü, kurulum, ayarlar, çok oyunculu menü, giriş ekranı, HUD, görevler, seçim, komut kartı, teknoloji ve duraklatma için üretilen DOM aynıydı. Demiryolu/ağıl (`land-test`) ve statik sunucu sınır testi de geçti. Depoda ayrı bir paketleme adımı yok.

`meeting-test.mjs`, `plow / crop / irrigation / breeding moved to the farm` kontrolünde hem referansta hem refaktör sonrasında tek hata verdi. Bu önceden var olan test hatası değiştirilmedi.

Karşılaştırmayı tekrarlamak için iki kaynak ağacında aynı test dosyalarını kullanın. Aşağıdaki komutlar, **çalışma ağacında önceki görev düzeltmesi hâlâ ayrı bir yama olarak duruyorsa**, yamayı referansa da uygular:

```sh
base=$(mktemp -d)
git archive 1e518d5 src test package.json | tar -xf - -C "$base"
git diff HEAD -- src/sim/quests.js > "$base/quest.patch"
if [ -s "$base/quest.patch" ]; then (cd "$base" && git apply quest.patch); fi
cp test/replay-trace.mjs test/determinism-test.mjs test/mp-save-test.mjs "$base/test/"

# mp-save-test.mjs için argümanlar: 6 6
AEVUM_TRACE=1 node "$base/test/determinism-test.mjs" 12 > "$base/before.log"
AEVUM_TRACE=1 node test/determinism-test.mjs 12 > "$base/after.log"
grep '^TRACE ' "$base/before.log" > "$base/before.trace"
grep '^TRACE ' "$base/after.log" > "$base/after.trace"
diff -u "$base/before.trace" "$base/after.trace"
```

## Kalan teknik borç

- Modüller, davranışı korumak için mevcut `this` ve ortak mutable durum sözleşmesini kullanıyor. Daha dar bağımlılıkları ve tipli arayüzleri tanımlamak ayrı bir iş.
- `game.js` hâlâ harita/varlık yaşam döngüsü ve ulaşım sistemlerini birlikte içeriyor; bina tick'i de üretim, pasif gelir ve atışları yönlendiriyor. Bu sıralı bağımlılıkları şimdi parçalamak kapsam dışı bırakıldı.
- `stats.ms` profil bilgisinin kayıt içinde iki yerde bulunması ve kayıt nesnesinin bazı canlı nesnelere referans tutması değişmedi. Görev olaylarının yüklemeden sonraki bağlanma zamanlaması da bu refaktörün kapsamına alınmadı.

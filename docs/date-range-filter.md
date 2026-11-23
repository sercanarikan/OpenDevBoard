# Tarih aralığı filtresi

Pipeline Health, Deployment Metrics, Team Activity ve My History ekranları aynı tarih aralığı filtresini kullanır. Filtre, bu dokümandaki API sözleşmesiyle birebir eşleşen bir `DateRange` modelinden beslenir.

## Desteklenen aralıklar

| Preset | Tür | API parametresi |
| --- | --- | --- |
| Son 7 gün | Kayan (rolling) | `days=7` |
| Son 14 gün | Kayan | `days=14` |
| Son 30 gün (varsayılan) | Kayan | `days=30` |
| Son 90 gün | Kayan | `days=90` |
| Bu ay | Takvim | `startDate` = ayın 1'i, `endDate` = bugün (UTC) |
| Geçen ay | Takvim | `startDate` = önceki ayın 1'i, `endDate` = önceki ayın son günü (UTC) |
| Özel aralık | Takvim | `startDate`, `endDate` |

Kasıtlı olarak eklenmeyenler: **Bu yıl** ve **Son 1 yıl**. Veri toplama, cache kapsamı ve pagination garantileri yalnızca 90 güne kadar doğrulandığı için bu seçenekler sunulmaz.

Özel aralık kuralları (UI ve API aynı kuralları uygular, sessiz kırpma yoktur):

- Başlangıç ve bitiş dahildir (inclusive), UTC takvim günü olarak yorumlanır.
- En fazla **90 gün** (her iki uç dahil).
- Bitiş bugünden (UTC) ileri olamaz.
- Başlangıç, bugünden geriye doğru **89 gün**den daha eski olamaz (bugün dahil toplam 90 gün).
- Biçim `YYYY-MM-DD` olmalıdır; 29 Şubat yalnızca artık yıllarda geçerlidir.

Geçersiz aralıklar HTTP 400 ile reddedilir ve mesaj döner.

## UX kararları

- **Konum:** Her ekranda mevcut kontrol satırında (eski 7/30 gün seçicisinin yerinde) tek bir tetikleyici düğme. Düğme seçili preset'i ve tarih aralığını gösterir.
- **Presetler:** Kayan presetler ve "Bu ay/Geçen ay" tek tıkla hemen uygulanır ve panel kapanır.
- **Özel aralık:** Takvimde önce başlangıç, sonra bitiş gününe tıklanır. Değişiklik **Uygula** tuşuna basılmadan API'ye gönderilmez; **İptal** taslağı atar.
- **Seçilemeyen günler:** Bugünden sonraki günler ve 90 gün sınırını aşan günler devre dışıdır. Hata durumunda (ör. geçersiz aralık) Uygula tuşu kapalı kalır ve nedeni bir uyarı olarak gösterilir.
- **Klavye:** Tetikleyici Enter/Space ile açılır; takvimde ok tuşları gün arasında gezinir; Escape paneli kapatıp odağı tetikleyiciye geri verir. Presetler `radiogroup` / `radio` rolüyle işaretlidir; gün düğmeleri `aria-label` ile tam tarihi ve `aria-pressed` ile seçimi bildirir.
- **Tema ve yoğunluk:** Mevcut `brand` token'ları ve light/dark sınıfları kullanılır; yeni tema değişkeni eklenmez.
- **Dil:** Tüm metinler `dateRange` i18n namespace'indedir (tr varsayılan, en desteklenir). Tarih etiketleri aktif dile göre `Intl` ile biçimlenir.
- **Durum sıfırlama:** Aralık değiştiğinde sayfa 1'e döner ve seçili kayıt (inspector) temizlenir. Önceki istek iptal edilir.
- **Grafikler:** Etiket adımı aralık uzunluğuna göre hesaplanır (`chartLabelStep`): 7 ve 14 günde her gün, 30 günde her 5. gün (önceki davranış), daha uzun aralıklarda yaklaşık altı etiket.

## Saat dilimi ve gün sınırları

- Tüm analitik hesaplamalar UTC'dir; bu değişmedi.
- Takvim aralığı `[startDate 00:00Z, endDate+1 00:00Z)` yarı açık aralığıdır.
- "Bu ay" ve "Geçen ay" presetleri UTC takvimine göre hesaplanır. Yerel saat dilimi farkı nedeniyle gün sınırında bir günlük kayma olabilir; UI bunu "Tarihler UTC takvim günleridir." notuyla belirtir.

## API sözleşmesi

Etkilenen endpoint'ler: `/api/pipeline-health`, `/api/pipelines`, `/api/pipelines/summary`, `/api/pipelines/runs`, `/api/pipelines/runs/<id>`, `/api/deployment-metrics`, `/api/deployments`, `/api/deployments/summary`, `/api/deployments/<id>`, `/api/team-activity` (ve alt endpoint'leri), `/api/my-history` (ve alt endpoint'leri).

- `days` (eski davranış): `now - days` ile `now` arasında kayan pencere. Geçersiz değerler eski mesajlarla 400 döner. `pipeline-health` yalnızca `7, 14, 30, 90` kabul eder.
- `startDate` + `endDate`: birlikte verilmelidir; birinin tek başına gelmesi 400'dür. Verilirse `days` yok sayılır.
- Calendar aralığında `periodDays` aralığın gün sayısını (`endDate - startDate + 1`) taşır.
- Team Activity yanıtları artık `window` nesnesi içerir: `{ kind, startDate, endDate, days, timezone: "UTC" }`. Diğer alanlar değişmedi.
- Summary ve liste yanıtları aynı pencereyi kullanır: filtre, özet, grafik ve pagination aynı `[start, end)` aralığından beslenir.
- Detay endpoint'leri (`/<id>`) aynı parametreleri kabul eder; böylece 30 günden eski bir kayıt, o kaydı içeren aralık seçiliyse açılabilir. UI detayı liste satırından açtığı için ek bir istek gerekmez.

Demo/fixture modunda (`demoApi`) aralık yalnızca gün sayısına indirgenir; sentetik veri takvim filtrelemesi yapmaz.

## Cache stratejisi

Önceki cache, tek bir durum satırında (`*_cache_state.requested_days`) tek bir kayan pencereyi izliyordu. Takvim aralıkları bu modeli bozmamalıdır:

- **Kayan pencere:** Değişmedi. Kısa süreli cache kısayolu (`requested_days` eşleşmesi + TTL) ve durum satırı yazımı aynen çalışır.
- **Takvim aralığı:** Cache kısayolu **kullanılmaz** ve durum satırı **yazılmaz**. Gerekçe: takvim fetch'i zaman çizelgesinin yalnızca bir parçasını kapsar; yazılırsa sonraki kayan istek eksik veriyi tam kapsam sanır. Takvim fetch'i yalnızca gerçek kayıtları upsert eder ve kendi penceresi dışındaki satırları silmez.
- **Upstream sınırı:** Azure DevOps çağrıları pencereye göre sınırlandırılır ve sonuç bellekte de `[start, end)` ile filtrelenir. Pipeline/deployment için `maxTime`/`maxStartedTime`, team PR'ları için `searchCriteria.minTime/maxTime` kullanılır; bu parametreler desteklenmese bile bellek içi filtre doğru sonuç verir.
- **Coalescing ve cache izolasyonu:** Canlı istek anahtarı `window.key` ile üretilir (`rolling`+gün sayısı veya `calendar`+başlangıç+bitiş). Farklı aralıklar birbirinin sonucunu paylaşmaz.
- **Maliyet:** Takvim aralığına her geçişte upstream isteği yapılır (Apply sonrası). Bu, cache'ten okumaya göre daha pahalıdır; bu kasıtlı bir dengedir ve gelecekteki iyileştirme adayıdır (tam kapsama sahip satır aralığını DB'den okuma).
- **Boş veri ≠ kayıt yok:** Cache'te veri bulunmaması, dönemde kayıt olmadığı anlamına gelmez. Sonuç `cacheStatus` ile (`stale`, `complete`, `paginationBounded`) ayrılır.

## Doğrulama

- `services/api/test_date_window_api.py`: ayrıştırma sınırları, artık yıl, yıl sonu, 90/89 gün sınırları, gün kovaları, cache anahtarı izolasyonu, route sözleşmesi.
- `services/api/test_date_window_services.py` ve `test_date_window_team_history.py`: servis düzeyinde takvim sınırları, cache kısayolunun ve durum yazımının atlanması, WIQL sınırları (`@Today` yok), silme davranışı.
- `apps/web/src/services/dateRange.test.ts`: preset hesapları, ay/yıl ve artık yıl sınırları, doğrulama kuralları, takvim ızgarası, grafik etiket adımı.
- `apps/web/src/components/Common/DateRangeFilter.test.tsx`: tetikleyici etiketi, dil bağımlı tarih biçimi, devre dışı durum.
- i18n anahtar testleri (`dateRange` namespace'i dahil) her iki dilde çözümlenmeyi doğrular.

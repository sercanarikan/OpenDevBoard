# Tarih aralığı filtresi

Uygulamada **tek bir global tarih filtresi** vardır; üst çubukta (header) bulunur ve seçilen aralık `DateRangeProvider` ile tüm ekranlara dağıtılır. Ekranlarda ayrı bir tarih filtresi yoktur. Seçim yalnızca **Uygula** ile kesinleşir ve tarayıcıda (`opendevboard.dateRange.v1`, localStorage) saklanır; bozuk veya sınır dışı bir kayıt varsayılana (son 30 gün) döner. Global değişiklik yalnızca bağlamı günceller; her açık ekran kendi metriklerini kendisi çeker, kapalı ekranlar için upstream isteği başlamaz.

Filtre iki tüketici için çalışır:

- **Liste ekranları** (Pipeline Health, Deployment Metrics, Team Activity, My History): global aralığı okur ve kendi isteğini yapar. Aralık değişince sayfa 1'e döner; geç gelen eski yanıt yeni seçimi ezmez.
- **Aktivite görünümleri** (Dashboard'daki "Zaman içinde aktivite" kartı): günlük sayılar yerel kapsam kaydından (coverage ledger) okunur. Seçilebilecek en uzun aralık **1096 gün**dür (üç yıl). Uzun aralıklar parça parça (ay bazında) ve arka planda çekilir.

## Presetler

| Preset | Tür | API karşılığı |
| --- | --- | --- |
| Son 1 gün | Takvim | `startDate` = `endDate` = bugün (UTC) |
| Son 7 / 14 / 30 / 90 gün | Kayan | `days=7/14/30/90` |
| Son 6 ay | Takvim | bugünden 6 ay öncesinin ertesi günü … bugün |
| Son 1 yıl | Takvim | bugünden 1 yıl öncesinin ertesi günü … bugün |
| Bugün / Dün | Takvim | tek UTC günü |
| Bu ay / Geçen ay | Takvim | ayın ilk günü … bugün; önceki ayın tamamı |
| Bu çeyrek / Geçen çeyrek | Takvim | çeyreğin ilk günü … bugün; önceki çeyreğin tamamı |
| Bu yıl / Geçen yıl | Takvim | yılın ilk günü … bugün; önceki yılın tamamı |

Presetler sol tarafta dikey bir listedir; en sık kullanılan sekiz dönem açıktır, kalanı **Diğer dönemler** altındadır. Telefonda (<640 px) presetler tek bir seçim kutusudur. Preset seçmek yalnızca taslağı değiştirir; **Uygula** ile kesinleşir, **İptal** taslağı atar.

Takvim başlığına (ay adı) tıklamak **Ay / Çeyrek / Yıl** seçicisini açar (varsayılan görünümde gizlidir). Ay, çeyrek ve yıl doğrudan tam dönem olarak seçilir; yıl listesi sabit değildir (geriye sınırsız gezilir, ileri bu yılla sınırlıdır; saklama yaşından eski yıllar seçilemez). Devam eden bir dönem bugüne kadar kırpılır; gelecek günler asla seçilmez. Takvimde iki tıklamayla başlangıç ve bitiş seçilir; alttaki başlangıç/bitiş alanlarına `YYYY-AA-GG` yazılabilir (geçersiz giriş Uygula'yı kapatır).

## Sınırlar (UTC)

- Aralık en fazla **1096 gün** (iki uç dahil) olabilir.
- Başlangıç bugünden en fazla **3650 gün** önce olabilir.
- Bitiş bugünden ileri olamaz; sessiz kırpma yapılmaz, geçersiz aralık HTTP 400 ile reddedilir.
- Tarihler UTC takvim günleridir. Yerel saat dilimi farkı gün sınırında bir günlük kaymaya yol açmaz.

## Aktivite görünümü

Picker içinde (ve dashboard kartında) iki bileşen bulunur:

- **Zaman çizelgesi:** gün, hafta veya ay çubukları (120 güne kadar günlük, 400 güne kadar haftalık, daha uzun aralıklarda aylık; Gün/Hafta/Ay düğmesiyle daha kaba bir boyut seçilebilir). İki tutamaç (başlangıç, bitiş) sürüklenebilir; klavyeyle (ok tuşları ±1 gün, Shift+ok ±7 gün, Home/End sınır) ve **−/+** düğmeleriyle de değiştirilebilir. Sürükleme yalnızca taslağı değiştirir; **Uygula** ile seçim kesinleşir.
- **Isı haritası:** her takvim günü seçili kaynağın günlük sayısını gösterir. Takvim hücresi aynı zamanda ısı haritasıdır: yoğunluk 6 seviyedir, seçili aralık hücre altındaki çizgiyle, giriş/çıkış günleri koyu dolguyla gösterilir (yoğunluk ve seçim ayrı kanallardır). İpucu (tooltip) yalnızca fare üzerine gelince ve klavye odağında görünür; dokunmatikte gün bilgisi alt satırda gösterilir. Her hücrenin erişilebilir adı tarihi, durumu ve sayıyı içerir; ekran okuyucu ve klavye odağı bu bilgiyi okur.

### Gün durumları

Bir gün yalnızca üç durumdan biriyle **sayı** taşır; diğer durumlarda sayı gösterilmez:

| Durum | Anlamı | Görünüm |
| --- | --- | --- |
| `covered_zero` | Gün başarıyla tarandı, kayıt yok | Nötr dolgu, "0 değil, tarandı" etiketi |
| `covered_active` | Gün başarıyla tarandı, kayıt var | Mavi yoğunluk, sayı |
| `partial` | Gün kapsayan ay kısmen çekildi | Çapraz desen; sıfır olarak gösterilmez |
| `not_collected` | Bu ay için hiçbir çekim tamamlanmadı | Kesik kenar |
| `unavailable_retention` | Saklama süresi dışında (yalnızca `ACTIVITY_RETENTION_DAYS` tanımlıysa) | Kesik kenar, etiket "saklama süresi dışında" |

Kapsamı tamamlanmış ama yenileme süresi geçmiş günler **bayat (stale)** işaretiyle gösterilir; veri yine görünür, yenileme beklediğini belirten küçük bir nokta eklenir.

## Kapsam kaydı ve yenileme

Upstream çekimler **UTC takvim ayı** parçalarına bölünür (chunk). Parça anahtarı ayın ilk günüdür; aynı ay için farklı sorgular aynı kaydı paylaşır.

- Kayıt `(kapsam, kaynak, ay)` anahtarıyla tutulur. Kapsam; organizasyon URL'si, sıralı proje kümesi ve (kullanıcıya özgü kaynaklar için) kullanıcı kimliğinin karmasından oluşur. Ham kimlik veya PAT saklanmaz.
- **Kapsam** (`complete` / `partial`) yalnızca çekim sonucuyla yazılır. Kısmi veya başarısız bir yenileme `complete` kaydı **asla düşürmez**; yalnızca deneme kaydı eklenir.
- **Tazelik** (`fresh` / `stale`) ayrı hesaplanır: bugünü içeren parça için 15 dakika, geçmiş parçalar için 7 gün.
- Arka plan işleri en fazla **2** eşzamanlı parça çeker; aynı parçanın tekrar eden istekleri birleştirilir (coalescing); süreç genelinde en fazla 64 bekleyen iş vardır. İstek bu işleri beklemez; arayüz 2 saniyede bir yoklar.
- İstisna durumlarında yalnızca hata sınıfı adı kaydedilir; hata metni (URL, token olabilir) saklanmaz.

### API: `GET /api/activity/daily`

| Parametre | Açıklama |
| --- | --- |
| `metric` | `pipelines`, `deployments`, `commits`, `pull-requests-created`, `pull-requests-closed`, `workitems-completed` veya `workitems-created` |
| `startDate`, `endDate` | `YYYY-MM-DD`, UTC, iki uç dahil; birlikte zorunlu |
| `mode` | `cache` (upstream başlatmaz) veya `refresh` (varsayılan; eksik, kısmi ve bayat parçalar için arka plan işi başlatır) |

Yanıt: `metric`, `window` (`kind`, `startDate`, `endDate`, `days`, `timezone: "UTC"`), `days` (her UTC günü için `date`, `count`, `state`, `stale`), `job` (`state`: `idle` / `running` / `done` / `partial` / `failed`; ayrıca `pending`, `completed`, `partial`, `failed`) ve `cacheStatus` (`complete`, `partialDays`, `notCollectedDays`).

Hatalar HTTP 400 döner: geçersiz metrik veya mod, eksik tarih, 1096 günü aşan aralık, 3650 günden eski başlangıç, gelecek bitiş, 37 aydan fazla parça. Yanıtlar kimlik bilgisi içermez.

Demo ve fixture modunda istemci, aynı sözleşmeyi taklit eden deterministik bir veri üretir; yanıt `fixture: true` taşır ve arayüzde "Örnek veri, canlı değil" olarak gösterilir. Bu veri gerçek kapsam kaydı değildir.

### Pull request pencereleri

Takvim pencerelerinde PR verisi yerel `pull_requests` tablosundan okunur; takvim isteği sırasında canlı PR çekimi yapılmaz. Eksik parçalar ay bazında arka planda çekilir (yalnızca `GET`; sayfa bütçesi dolarsa veya bir istek başarısız olursa parça `partial` kalır). İki ayrı anlam vardır ve karıştırılmaz:

- `pull-requests-created`: oluşturulma tarihine (`creation_date`) göre; `queryTimeRangeType=created`, her durum.
- `pull-requests-closed`: pencerede **tamamlanan** PR'lar (`closed_date`, yalnızca `status=completed`); `queryTimeRangeType=closed`, `status=completed`. Terk edilen PR'lar sayılmaz.
- `workitems-completed`: pencerede **tamamlanan** iş öğeleri (`[Microsoft.VSTS.Common.ClosedDate]`, durum Closed/Completed/Done/Resolved); `workitems-created`: pencerede **oluşturulan** iş öğeleri (`[System.CreatedDate]`, tüm durumlar). `ChangedDate` hiçbirinin yerine kullanılmaz. Veriler aktif `work_items` önbelleğinden ayrı `work_items_window` tablosunda (`id`, `kind`) tutulur; aktif/bloke/atanmamış/kanban metrikleri aktif önbelleği okumaya devam eder ve tarih aralığını izlemez. Yalnızca WIQL `POST` ve ayrıntı `GET` istekleri kullanılır; 20000 sonuç sınırına ulaşan parça `partial` işaretlenir.

Her anlamın kapsam kaydı ayrıdır. `GET /api/pull-requests` ve `/api/pull-requests/summary` takvim penceresiyle (`startDate`/`endDate`) çağrıldığında yerel okuma yapar; `dateField=created` (varsayılan) veya `closed` seçilir, geçersiz değer HTTP 400 döner. Yanıt `cacheStatus.coverage` (`complete`/`partial`/`missing`), `job`, `window` ve `dateField` taşır. `/api/team-activity*` PR'ları `created` anlamıyla okur; `cacheStatus.pullRequestCoverage` PR parça kapsamını verir ve `job` commit ile PR işlerini birleştirir. Kayan (`days`) istekler eski yolu kullanır.

## Dashboard

- **Zaman içinde aktivite** kartı global aralığı kullanır; kendi tarih filtresi yoktur. Isı haritasının kaynağını seçen metrik seçici (pipeline çalıştırması, deployment, commit) filtrenin içinde ve kartta bulunur; yalnızca ısı haritası kaynağını değiştirir, global aralığı değiştirmez.
- **Anlık** durum kartları (aktif görevler, engellenen işler, bekleyen ve açık PR'lar) etiketlidir ve tarih filtresinden etkilenmez.

## Bilinen sınırlamalar

- **Liste ekranları** global aralığı (1096 güne kadar) olduğu gibi gönderir; parça parça (chunk) yükleme bu ekranlar için henüz tamamlanmamıştır, çok uzun aralıklarda yanıt yavaş olabilir (D3 kapsamında ele alınacaktır).
- **My History** için aktivite görünümü yoktur.
- **Dashboard'un dönemsel kartları** (CI/CD, deployment, takım özeti, geçmiş) hâlâ AppContext'teki sabit pencereleri kullanır; sayfa düzeyinde bir tarih filtresine bağlı değildir.
- **Yerel senkronizasyonlar** (kayan pencere) kapsam kaydı yazmaz. Bu günler, bir takvim çekimi kapsayana kadar `not_collected` görünür.
- `ACTIVITY_RETENTION_DAYS` tanımlı değilse `unavailable_retention` hiç üretilmez; geçmiş verinin varlığı iddia edilmez.

## Doğrulama

- `services/api/test_date_window_api.py`: üç yıl sınırı, 3650 gün yaş sınırı, sıkılaştırılmış sınırlar, artık yıl, gün kovaları, route sözleşmesi.
- `services/api/test_activity_chunks.py`: ay parçaları, anahtarın sorgudan bağımsızlığı, yıl sonu, 29 Şubat, 37 parça sınırı.
- `services/api/test_coverage_ledger.py`: kısmi yenileme `complete` kaydı düşürmez, başarısız deneme kapsamı değiştirmez, kapsam izolasyonu, tazelik TTL'i.
- `services/api/test_activity_service.py`: gün sınıflandırması, sıfır ile toplanmamış ayrımı, saklama süresi, yıl sonu ve artık gün.
- `services/api/test_activity_jobs.py`: birleştirme, eşzamanlılık sınırı (2), bekleyen sınırı, hata sınıfı kaydı, durum hesabı.
- `services/api/test_activity_api.py`: 400 doğrulamaları, `mode=cache` upstream çağırmaz, eksik parçalar için iş başlatma, kısmi yanıtın sıfır üretmemesi, PAT'in yanıtta olmaması.
- `apps/web/src/services/dateRange.test.ts`: presetler, dönem seçimleri, sınır doğrulamaları.
- `apps/web/src/services/activityDaily.test.ts`: sorgu sözleşmesi, demo fixture'ı, tüm gün durumları.
- `apps/web/src/components/Common/dateRange/*.test.ts(x)`: görünüm modeli, heatmap/timeline etiketleri ve klavye, sürüklemenin istek üretmemesi, yoklama, eski yanıtın reddi.
- `apps/web/src/components/Common/DateRangeFilter*.test.tsx`: presetler (taslak), başlığa tıklayınca açılan ay/çeyrek/yıl seçici, sınırsız yıl gezintisi, mobil preset seçimi, elle giriş doğrulaması, Uygula/İptal, tooltip (fare/klavye) ve dokunmatik alt satır, global bağlam.
- `apps/web/src/context/DateRangeContext.test.tsx`: varsayılan, kalıcılık, bozuk/sınır dışı kayıt, depolama hatası, isteksiz değişiklik.
- `apps/web/src/components/Dashboard/DashboardActivityCard.test.tsx`: metrik seçici ve dönemsel etiket.

# Veri kapsamı, sayfalama ve cache/sync

API sözleşmesi (uçlar, parametreler, yanıt şekilleri): [pagination-api.md](pagination-api.md).

## Satır sınıfları

`work_items` tablosundaki her satır şu üç sınıftan biridir:

| Sınıf | Alan | Anlamı |
|---|---|---|
| Kapsam içi | `is_context = 0` | Aktif WIQL'in (full sync) veya "değişenler" sorgusunun (incremental) döndürdüğü iş. `is_active = 0` ise iş tamamlanmış/kaldırılmıştır ama cache'te tutulur. |
| Bağlam | `is_context = 1` | Yalnızca bir kapsam içi işin **atası, torunu veya bağımlılık hedefi** olduğu için tutulur. Listelenmez, sayılmaz; hiyerarşi, canonical progress ve ilişki özetleri için kullanılır. |
| Silinmiş | `deleted_at IS NOT NULL` | Soft delete. Hiçbir listede, sayıda, hiyerarşide görünmez. Satırlar **asla fiziksel olarak silinmez**. |

Bağlam satırları, tamamlanmış çocukların aktif WIQL sonuçlarında yer almadığı durumlarda hiyerarşik ilerlemenin doğru hesaplanmasını sağlar. Bu kayıtlar listelenmez; yalnızca kapsam içindeki işlerin ilişkileri ve ilerleme özetleri için kullanılır.

## Akış

```
Azure DevOps ──WIQL (yalnızca ID)──► collect_ids  (20.000 sınırı: [System.Id] aralıklarına bölünür)
            ──GET workitems (≤200 ID, $expand=relations, errorPolicy=omit)
            ──ata / torun / bağımlılık kapanışı (200'lük batch)
            ──[full sync] uzlaştırma planı
                    │
                    ▼
        TEK SQLite transaction (BEGIN IMMEDIATE … COMMIT / ROLLBACK)
        upsert → soft delete → orphan temizliği → recompute_derived → watermark/meta
```

Azure DevOps'a giden tek istek türleri: `GET` ve WIQL sorgu `POST`'u (`/_apis/wit/wiql`). `AzureClient` bunun dışındaki her metodu çağrı öncesinde reddeder (testle doğrulanır).

## Sessiz veri kaybı yoktur

| Konu | Davranış |
|---|---|
| `max_items` | Varsayılan **sınırsız**. Açıkça verilen bir sınır kayıt keserse sonuç `partial` olur; watermark, `last_full_sync`, `last_success_at` ilerlemez, uzlaştırma çalışmaz. |
| WIQL 20.000 sonuç sınırı | HTTP 400 `VS402337` ya da tam 20.000 sonuç "kesilmiş olabilir" sayılır; `[System.Id]` aralığı ikiye bölünerek her yaprak sorgu 20.000'in altına inene dek devam edilir. Sonuç tekilleştirilir. |
| Detay çağrısı | En fazla 200 ID. Dönmeyen ID `missing_detail` uyarısı olarak raporlanır. |
| Hız sınırı / geçici hata | 429, 502, 503, 504 ve ağ hataları için sınırlı yeniden deneme (`Retry-After` dikkate alınır, en fazla 3). |
| Kısmi sonuç | Hiçbir zaman `success` olarak işaretlenmez. |

## Silinen ve kapsamdan çıkan kayıtlar (full sync uzlaştırması)

Yalnızca **tam ve eksiksiz** bir full sync'te çalışır. Incremental sync hiçbir zaman silmez.

1. `cached_scope` = canlı, `is_active=1`, `is_context=0` satırlar. `scope` = full WIQL'in döndürdüğü ID'ler.
2. `cached_scope − scope` kümesi **aday**dır; "silindi" kanıtı değildir.
3. Adaylar ID ile yeniden getirilir (`errorPolicy=omit`):
   - **Döndü** (örn. `Closed`, `Resolved`): kapsam dışına çıkmıştır. Satır **silinmez**, `state`/`is_active` güncellenir (`out_of_scope++`).
   - **Dönmedi** ve çağrı HTTP 200: Azure DevOps'ta yok. Satıra `deleted_at` yazılır.
   - **Herhangi bir hata/istisna**: durum **bilinmiyor**. Satırlara dokunulmaz, sonuç `partial` olur. API hatası silinme kanıtı sayılmaz.
4. **Toplu silme koruması:** aday sayısı `max(50, %10 × cached_scope)` değerini aşarsa hiçbir şey silinmez, `mass_delete_blocked` uyarısı ve `partial` döner (insan kararı gerekir).
5. **Yetim bağlam temizliği:** kapsam içi satırlar, ataları, onların tüm torunları ve ilişki hedefleri "gerekli" sayılır. Gerekli olmayan bağlam satırlarına `deleted_at` yazılır.
6. Yeniden görülen satır dirilir (`deleted_at = NULL`).

## Türetilmiş veri hiçbir zaman bayatlamaz

`recompute_derived` **her başarılı sync'in** transaction'ı içinde çalışır: ilişki özetlerini (başlık/tip/durum/atanan/proje) cache'teki hedeften yeniler ve `is_blocked` / `is_blocking` değerlerini yeniden hesaplar. Böylece bir predecessor `Done` olduğunda, kendisi hiç değişmeyen bağımlı iş de (incremental sync onu tekrar çekmese bile) engelden çıkar.

Kural (istemcideki `hierarchy.ts` ile aynı): `blocked` = tamamlanmamış en az bir predecessor (`Done/Closed/Completed` dışındaki her durum, `Resolved` dahil; durumu bilinmeyen hedef = çözülmemiş). `blocking` = en az bir successor.

## Güvenilirlik

- Aynı anda tek sync (`sync_lock`, bloklamayan). İkinci çağrı `in_progress` döner ve meta'ya dokunmaz.
- Tek transaction: hata/istisna → `ROLLBACK`, önceki sağlıklı snapshot aynen kalır.
- Altı Work Item okuma yolu (`GET /api/work-items`, `/api/work-items/summary`, `/api/work-items/<id>/children`, `/api/work-items/batch`, `/api/work-items/progress`, `/api/kanban`) `db_lock` almaz, dolayısıyla sync'in yazma aşamasını **beklemez**. Her biri tek bir commit edilmiş snapshot üzerinde (`read_snapshot`) çalışır; döndürdüğü satırlar, sayımlar, `dataVersion` ve `lastSyncedAt` aynı snapshot'a aittir. Sync commit edilene kadar bu istekler önceki tutarlı veriyi görür, yarım uygulanmış bir sync'i görmez. Bu davranış **yalnızca bu altı yol için** geçerlidir: sistemin geri kalanı (örn. `/api/sync-status`, `/api/work-items/counts`, `/api/work-items-pool`, `/api/work-items/<id>`, yazıcılar ve diğer servisler) hâlâ `db_lock` kullanır ve apply süresince bekleyebilir.
- `sync_status` `finally` yolunda her zaman `idle` / `partial` / `error` olur; süreç sync ortasında ölürse açılışta `syncing` → `idle` sıfırlanır.
- Incremental: WIQL `ChangedDate` yalnızca tarih hassasiyetindedir (saat HTTP 400 verir); sorgu watermark'ın **bir gün öncesinden** başlar (kontrollü overlap, upsert idempotent).
- Incremental, değişmemiş kayıtlar: penceredeki id sayısı bir istek grubundan (`PROBE_MIN_IDS` = 200) büyükse ve cache'te zaten canlı, kapsam içi (`is_context = 0`), ilişkileri ve `rev` değeri olan kayıtlar varsa, bunlar için önce yalnızca `System.Rev` + `System.ChangedDate` istenir (≈ 0,2 KB/kayıt; `$expand=relations` ile ≈ 5,7 KB/kayıt). `(Rev, ChangedDate)` cache ile birebir aynıysa kayıt tam okunmaz; yalnızca `last_synced_at` / `last_seen_at` güncellenir. Diğer her şey (cache'te olmayan, context, soft-delete, `rev`'i olmayan, probe'a cevap alınamayan) eskisi gibi tam okunur. Probe bir grupta başarısız olursa (istemci kendi yeniden denemelerini ve `Retry-After` beklemesini zaten yapmıştır) probe orada durur: o ana kadar değişmemiş kanıtlanan kayıtlar atlanır, kalanlar tam okunur; tur yine de güvenle tamamlanamazsa watermark ilerlemez. Bir bedeli vardır: pencerede az kayıt değişmişse tam okuma yerine hafif okuma + küçük bir tam okuma yapılır, yani istek sayısı bir veya iki artabilir, indirilen bayt belirgin azalır. Eksik (`partial`) biten bir tur ilişki kapanışında (ata/torun/bağımlılık) boşluk bırakmış olabileceğinden `closure_dirty` işaretlenir; işaret kalkana kadar (bir sonraki tam başarılı tur) probe atlanır ve pencere eskisi gibi tam okunur. Okunamayan ilişki hedefleri (silinmiş ya da henüz erişilemeyen) `closure_missing` meta anahtarında tutulur ve, onları bağlayan kayıt probe ile atlansa bile, o turu ilk kaçıran sync artımlı pencerenin (watermark gününden bir gün öncesi) dışına çıkana kadar her turda yeniden istenir; hedef erişilebilir olunca bir sonraki incremental turda cache'e girer. Her hedef için onu bağlayan kayıtlar da saklanır; bağlayan kayıt o turda yeniden okunduysa kaldırdığı ilişki için yeniden deneme biter (gereksiz context satırı oluşmaz), yeniden okunmayan ve hâlâ bağlayan başka bir kayıt varsa yeniden deneme sürer. Hedef, hâlâ bağlayan kayıtların bağlama türüne göre okunur: biri hiyerarşi (alt öğe/üst öğe) ile bağlıysa kendi alt öğeleri de gelir, yalnızca bağımlılıkla bağlıysa gelmez. Pencere dışına çıkınca hedefi yalnızca periyodik full sync (veya bağlayan kaydın değişmesi) alır; bu probe öncesiyle aynıdır. Liste en fazla 2000 kayıttır; bu sayı aşılırsa `closure_dirty` işaretlenir ve bir sonraki tur pencereyi eskisi gibi tam okur (probe kapalı), böylece hiçbir hedef unutulmaz. Sayaçlar: `fetched` / `upserted` eskisi gibi pencerede güncellenen kayıt sayısıdır; ayrıca `details_fetched`, `unchanged_skipped`, `probed` eklenmiştir. `derived.rows_updated` artık yalnızca gerçekten yeniden yazılan satırları sayar.
- Arka plan döngüsü: ilk açılışta full, sonra her `SYNC_INTERVAL_SEC` (300 sn) incremental; ek olarak `RECONCILE_INTERVAL_SEC` (6 saat, `0` = kapalı) dolunca full + uzlaştırma. Hatada üstel geri çekilme.
- Disk tabanlı staging (opt-in): `SYNC_CHUNKED=1` (varsayılan `0` = bellek içi, eski yol). Detay istekleri akış olarak okunur (`AzureClient.iter_batches`, en çok `2 × SYNC_DETAIL_WORKERS` yanıt bellekte), her grup ayrıştırılıp cache dizinindeki özel `devops_stage.db` dosyasına yazılır; ata/alt/bağımlılık kapanışı bu dosya üzerinde SQL ile yürür (aynı turlar, aynı `MAX_CONTEXT_ITEMS` sınırı, aynı uyarılar). Gerçek cache'e yalnızca sonunda, **tek** `BEGIN IMMEDIATE … COMMIT` ile yazılır (`INSERT … SELECT`, yumuşak silmeler, orphan taraması ve `recompute_derived` id sıralı parçalar halinde, watermark/meta); sonuç bellek içi yolla aynıdır (tablo, ilişkiler, türetilmiş alanlar, sayaçlar, liste). Commit'ten önce hiçbir şey cache'te görünmez: hata, kesinti, `kill -9` veya yayın sırasında hata önceki snapshot'ı, watermark'ı ve `last_success_at` değerini olduğu gibi bırakır; partial koşu bellek içi yoldaki gibi tamamlanmış sayılmaz (watermark ve `last_full_sync` yazılmaz, `closure_dirty=1`). İlk kullanılabilir liste yine yalnızca son commit'ten sonra açılır. Ölçüm (sentetik, gecikmesiz HTTP stub'ı, 4 worker): 100k Work Item'da peak RSS 834 MB → 94 MB, full sync 16,1 s → 17,7 s; gecikme modelinde süre aynı. İstek sayısı ve indirilen bayt değişmez.
  - **Disk bütçesi:** staging dosyası cache satırı başına ≈ 4 KB, yayın transaction'ının WAL'ı ≈ staging boyutu, WAL checkpoint'inde cache de yaklaşık o kadar büyür; geçici disk ihtiyacı ≈ **cache boyutunun 3 katı** (100k'da ≈ 0,4 GB staging + 0,4 GB WAL + cache büyümesi; 300k'da ≈ 1 GB'ın üzerinde her biri). Başlamadan önce (id sayısı × 1,3 × 4 KB tahmini), her grupta (ölçülen bayt/satır) ve yayından önce `kalan staging + 2 × staging + 256 MB` boş alan aranır; yetmezse koşu `insufficient_disk_space` hatasıyla durur, cache'e dokunulmaz. Staging yazımında veya yayında disk dolarsa (`staging_write_failed`, `disk is full`) yayın geri alınır ve önceki cache korunur.
  - **Platform:** staging, `devops_stage.lock` üzerindeki POSIX `flock` (`fcntl`) olmadan **asla** çalışmaz: kilit, artık dosyanın gerçekten eski olduğunu kanıtlar ve iki süreci aynı dosyadan uzak tutar. Desteklenenler: Linux, macOS ve Docker imajı. `fcntl` bulunmayan platformda (yerel Windows) `SYNC_CHUNKED=1` ilk istekten önce `staging_unsupported_platform` hatasıyla reddedilir, cache'e dokunulmaz; kilitsiz yedek yol yoktur. `SYNC_CHUNKED=0` (varsayılan) bu platformlarda da eskisi gibi başlar ve çalışır; açılıştaki artık dosya temizliği `fcntl` yoksa hiçbir şey silmeden atlanır ve açılışı engellemez.
  - **Temizlik:** `devops_stage.db` (+ `-journal`/`-wal`/`-shm`) yalnızca bu özelliğe aittir ve `devops_stage.lock` üzerindeki `flock` ile korunur (süreç ölünce çekirdek kilidi bırakır). Her koşu başlarken ve backend açılırken, kilit alınabiliyorsa (canlı koşu yoksa) artık dosyalar silinir; başka dosyalara dokunulmaz.
  - **Bilinen sınırlar:** yayın transaction'ı tek yazıcıyı tutar (sentetik 300k'da ≈ 22 sn; okuyucuları engellemez, bir sonraki yazıcıyı bekletir). `MAX_CONTEXT_ITEMS` (25.000) sınırı ve ilk koşusu partial biten full sync'in her turda yeniden full çalışması **bu seçenekle değişmez**. 100k kullanıcı listesi bellek içi yolla yalnızca örneklemle (her 25 sayfadan biri) karşılaştırıldı, tablo ve ilişkiler tam karşılaştırıldı. Canlı Azure DevOps ile doğrulanmadı.
- Detay okuma paralelliği: `SYNC_DETAIL_WORKERS` (varsayılan `1` = sıralı, eski davranış; önerilen opt-in `4`; üst sınır `8`, geçersiz/sıfır/negatif değer `1`) `get_items` içindeki salt okunur GET isteklerini sınırlı sayıda eşzamanlı yürütür. Sonuçlar istek sırasına göre birleştirilir: `missing`, `failed_batches` ve hata raporları sıralı koşuyla aynıdır; hata ya da kesintide cache'e yarım veri yazılmaz ve watermark ilerlemez. HTTP 429 veya `Retry-After` içeren bir yanıt tüm worker'ları bildirilen süre kadar bekletir ve o fan-out için eşzamanlılığı yarıya indirir (geri açılmaz); diğer geçici hatalar (502/503/504, ağ) yalnızca ilgili isteği üstel olarak bekletir. HTTP 500 yeniden denenmez (değişmedi). Kazanç sentetik, gecikmeli bir HTTP stub'ında ölçüldü; canlı Azure DevOps hız sınırı davranışı doğrulanmadı. İlk listenin yalnızca full sync commit'inde açılması ve yüksek peak RSS bu ayarla değişmez.

## Sync raporu

Her çalışma sonunda `sync_state.last_sync_result` (JSON) yazılır; `GET /api/sync-status` bunu döner:

`mode` (`full`/`incremental`), `status` (`success`/`partial`/`error`/`in_progress`), `fetched`, `upserted`, `deleted`, `out_of_scope`, `context_upserted`, `orphans_removed`, `skipped`, `probed`, `unchanged_skipped`, `details_fetched`, `partitions`, `warnings` (en fazla 20), `derived`, `duration_ms`, `started_at`, `finished_at`, `error`.

Ayrı meta anahtarları: `last_success_at` (yalnızca `success`), `last_full_sync`, `last_incremental_sync`, `watermark` (yalnızca tam başarıda ilerler), `sync_error`, `total_org_active`.

`total_org_active` **bilgilendirme amaçlıdır** (son full sync'teki WIQL sayısı). Hiçbir ekran sayacı bu değerden hesaplanmaz.

## Header göstergesi

| Durum | Gösterim |
|---|---|
| Sağlıklı | `Azure DevOps Live` + `Önbellek Verisi · son başarılı senkronizasyon` |
| Sync sürüyor | `Senkronizasyon Sürüyor` |
| Sync başarısız / kısmi | `Senkronizasyon Başarısız` / `Kısmi`; son sağlıklı veri gösterilir, son başarılı zaman korunur |
| Backend yok (başladıktan sonra) | `Sunucuya Ulaşılamıyor`; son bilinen veri görünür, geri gelince otomatik yenilenir |
| Backend hiç yok (açılışta) | `Demo Modu (Örnek Veri)`; asla canlı gibi gösterilmez |
| Fixture | `Test Verisi (Fixture)` |

## Fixture modu (CI ve yerel test)

`DEVOPS_FIXTURE_MODE=1` ise API Azure DevOps'a **hiç** bağlanmaz ve arka plan sync'i başlamaz. `POST /api/sync` fixture verisini deterministik ve ağsız biçimde doğrular/tohumlar; gerçek organization URL veya PAT gerekmez. Veritabanında fixture işareti olmayan satırlar varsa endpoint `409 fixture_data_conflict` döndürür ve veriye dokunmaz. Uygulama başlangıcındaki aynı koruma da bu veritabanıyla API'nin açılmasını engeller (çıkış kodu 3), yani fixture canlı veriyi asla kirletemez.

## Sayaç sözlüğü

| Kavram | Kaynak |
|---|---|
| Aktif iş (ekran sayaçları, sidebar, sekmeler, header) | `GET /api/work-items/summary` — liste uçlarıyla aynı koşullar; aynı filtrede `list.total == summary` |
| Tamamlanmış (kapsamdaki) | `summary.completed` |
| Cache'teki canlı satır | `sync-status.totalCached` (bağlam dahil) |
| Bağlam satırı | `sync-status.contextCount` |
| Org anlık görüntüsü (bilgi) | `sync-status.totalOrgActive` |
| Sayfada görünen | alt çubuk: `{from}–{to} / {total}` |

## Dashboard özet kartları: pipeline, dağıtım ve ekip aktivitesi

Üç kart ayrı uçlardan (`/api/pipelines/summary`, `/api/deployments/summary`, `/api/team-activity/summary`) beslenir. Her biri kendi isteğini ve durumunu taşır; biri yavaşlarsa ya da hata verirse diğerleri bağımsız yüklenir. Tek bir kartın hatası, backend `/api/health` ile hâlâ erişilebilirse genel bağlantı uyarısına dönüşmez.

- **Cache süresi:** Üç servis de sonucu 5 dakika (`CACHE_TTL_SECONDS`) boyunca SQLite cache'inden sunar. `?refresh=true` bu süreyi atlar.
- **Pipeline:** Proje kapsamlı okuma `partial` etiketini **korur** (organizasyon anlık görüntüsü iddia edilmez). Keşif ve tüm proje çağrıları hatasız bittiyse okuma yine de TTL boyunca cache'ten sunulur. Başarısız bir proje varsa `completed_at` boş kalır ve bir sonraki istek yeniden dener.
- **Ekip aktivitesi:** Azure DevOps, devre dışı bırakılmış (`isDisabled`) bir deponun commit geçmişi için her zaman HTTP 404 döndürür. Bu depolar sorgulanmaz ve hata sayılmaz; `outcome` yalnızca etkin depolara göre `complete` olabilir. Devre dışı depoların cache'teki mevcut commit'leri silinmez. Etkin bir depo hata verirse sonuç `partial` ve `stale` kalır, cache'lenmez.
- **HTTP bağlantıları:** Bu üç servisin Azure DevOps `GET` istekleri `azure_http.py` içindeki paylaşılan keep-alive oturumundan geçer (yalnızca `GET`, çerez saklanmaz, otomatik yeniden deneme yok). Her istekte yeni TCP/TLS bağlantısı kurulmaz.
- **Eşzamanlı istekler:** Aynı gün sayısı ve `refresh` değeriyle aynı anda gelen pipeline, dağıtım ve ekip aktivitesi istekleri (kart, gezgin sayfası, birden çok sekme) tek bir Azure DevOps çağrı kümesini paylaşır (`request_coalescing.py`). İstekler bittiğinde sonuç ayrıca saklanmaz; `refresh=true` istekleri `refresh` olmayanlara katılmaz.
- **Arayüz:** Kartlar yenileme sırasında son veriyi ve güncellik notunu (`kısmi`, `güncel değil`) görünür tutar, yalnızca küçük bir "Güncelleniyor" göstergesi ekler. Dashboard'daki **Yenile** düğmesi üç kartı da yeniden ister. Ekip kartı hata (`Ekip aktivitesi alınamadı.`), kısmi/güncel olmayan veri ve gerçek boş sonucu birbirinden ayırır.

## Yedek / geri yükleme

Cache'in tutarlı kopyası `sqlite3.Connection.backup()` ile alınır (WAL açıkken dosya kopyası güvenli değildir) ve `PRAGMA integrity_check` ile doğrulanır. Ayrıntı: [backup-restore.md](backup-restore.md).

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
- `sync_status` `finally` yolunda her zaman `idle` / `partial` / `error` olur; süreç sync ortasında ölürse açılışta `syncing` → `idle` sıfırlanır.
- Incremental: WIQL `ChangedDate` yalnızca tarih hassasiyetindedir (saat HTTP 400 verir); sorgu watermark'ın **bir gün öncesinden** başlar (kontrollü overlap, upsert idempotent).
- Arka plan döngüsü: ilk açılışta full, sonra her `SYNC_INTERVAL_SEC` (300 sn) incremental; ek olarak `RECONCILE_INTERVAL_SEC` (6 saat, `0` = kapalı) dolunca full + uzlaştırma. Hatada üstel geri çekilme.

## Sync raporu

Her çalışma sonunda `sync_state.last_sync_result` (JSON) yazılır; `GET /api/sync-status` bunu döner:

`mode` (`full`/`incremental`), `status` (`success`/`partial`/`error`/`in_progress`), `fetched`, `upserted`, `deleted`, `out_of_scope`, `context_upserted`, `orphans_removed`, `skipped`, `partitions`, `warnings` (en fazla 20), `derived`, `duration_ms`, `started_at`, `finished_at`, `error`.

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

## Yedek / geri yükleme

Cache'in tutarlı kopyası `sqlite3.Connection.backup()` ile alınır (WAL açıkken dosya kopyası güvenli değildir) ve `PRAGMA integrity_check` ile doğrulanır. Ayrıntı: [backup-restore.md](backup-restore.md).

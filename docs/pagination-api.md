# Sayfalama (pagination) API sözleşmesi

Tüm uçlar `services/api` altındadır, SQLite cache'ten okur, Azure DevOps'a **gitmez** (salt cache). Fixture modunda (`DEVOPS_FIXTURE_MODE=1`) hiçbir uç Azure'a bağlanmaz.

Ortak kurallar:

- Silinmiş kayıtlar (`deleted_at IS NOT NULL`) hiçbir listede, sayıda veya hiyerarşide görünmez.
- Sıralama **deterministiktir**: seçilen alan + `id ASC` tie-breaker. Aynı sorgu iki kez aynı sırayı verir; sayfalar arasında kayıt tekrarı/kaybı olmaz.
- Arama ve filtreler **tüm veri kümesine** uygulanır (yalnızca yüklü sayfaya değil).
- Arama büyük/küçük harf ve Unicode duyarsızdır (`İ`, `ş`, `ğ` dahil), `%` ve `_` literal kabul edilir.
- Her yanıt `dataVersion` içerir (cache içeriği değişince değişir; istemci eski cevabı ayırt eder).
- Hata: HTTP 4xx/5xx + `{"error": "<kısa mesaj>"}`. Geçersiz parametre 400 döner (sessizce yok sayılmaz).

## 1. `GET /api/work-items`

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `limit` (`pageSize`) | 50 | 1–200 |
| `offset` | 0 | Satır ofseti. `page` (1 tabanlı) verilirse `offset=(page-1)*limit` |
| `search` (`q`) | – | id, başlık, atanan, proje, üst iş başlığında alt dize |
| `project` | `all` | Proje adı (tam eşleşme) |
| `assignee` | – | Tekrarlanabilir; atanan adı (tam eşleşme). `Unassigned` atanmamışları seçer |
| `quickFilter` | `all` | `all`, `my-tasks` (`currentUser` gerekir), `unassigned`, `blocked`, `blocking`, `bugs` |
| `currentUser` | – | `my-tasks` için kullanıcı adı |
| `type` / `types` | – | Virgülle veya tekrarlı |
| `state` / `states` | – | Ham durum adları |
| `priority` / `priorities` | – | 1–4, virgülle |
| `column` | – | `todo`, `in-progress`, `resolved`, `done` (Kanban kolonu; durum kategorisinden) |
| `includeCompleted` | `false` | `true` ise tamamlanmış kayıtlar da gelir |
| `sortBy` | `changedDate` | `changedDate`, `priority`, `id`, `title`, `state` |
| `sortOrder` | `desc` | `asc`/`desc`. **Alanın kendisine uygulanır** (priority `asc` = P1 önce) |

`priority` sıralaması: `priority`, `is_blocked DESC`, `changed_date DESC`, `id`. Diğerleri: alan, ardından `id ASC`.

Yanıt:

```json
{
  "items": [ /* WorkItem */ ],
  "total": 123, "totalCount": 123,
  "limit": 50, "offset": 0,
  "page": 1, "pageSize": 50, "totalPages": 3,
  "hasNext": true, "hasPrev": false,
  "sort": {"by": "changedDate", "order": "desc"},
  "dataVersion": "123:2026-01-02T…:…:0",
  "lastSyncedAt": "…", "dataScope": "live_cached" | "fixture"
}
```

`total` yalnızca bu filtre kümesidir. Sayfa dışına taşan `offset` boş `items` ve doğru `total` döner. Örnek değerler temsili olup gerçek müşteri veya production ölçümleri değildir.

## 2. `GET /api/work-items/summary?project=&currentUser=`

Sidebar/sekme sayaçları ve filtre seçenekleri için. **Liste sorgusuyla aynı tanım ve aynı kapsam** kullanılır (aynı filtre ile `GET /api/work-items` `total` değeri, buradaki sayıya eşittir).

```json
{
  "scope": {"project": "all", "total": 123, "myTasks": 12, "unassigned": 23, "blocked": 5,
            "blocking": 8, "bugs": 3},
  "facets": {"types": {"Task": 90}, "states": {"New": 84}, "priorities": {"1": 2, "2": 10}},
  "projects": [{"name": "Example Project", "total": 30}],
  "completed": 7,
  "dataVersion": "…"
}
```

`projects` proje filtresinden **bağımsızdır**. Sayılar aktif kayıtlar üzerindendir; `completed` kapsamdaki tamamlanmış kayıt sayısıdır, `total`'e dahil değildir. Örnek proje adı ve sayılar temsili olup gerçek kurumsal veriler değildir.

## 3. `GET /api/work-items/<id>`

Cache-first, bulunamazsa Azure'dan okur (fixture modunda yalnızca cache). Context kayıtlar (ebeveyn / bağımlılık hedefi) da döner. Silinmiş kayıt için 404 (Azure'dan tekrar bulunursa canlı veri döner).

## 4. `GET /api/work-items/progress?ids=1,2,3`

En fazla 500 id. Kanonik progress (`apps/web/src/utils/progress.ts` ile aynı kural), **görünür sayfadan bağımsız**, tam hiyerarşiden hesaplanır:

```json
{"progress": {"123": {"totalUnits": 5, "completedUnits": 2, "percent": 40,
                       "blockedCount": 1, "unassignedCount": 2, "hasChildren": true}},
 "dataVersion": "…"}
```

Kurallar: çocuğu olmayan düğüm tek birimdir; `Removed` kapsam dışı; tamamlanmış yalnızca `Done/Closed/Completed`; `Resolved` tamamlanmış değildir; yaprak birimler `id` ile tekilleştirilir; döngüde sonsuz döngü yoktur.

## 5. `GET /api/kanban`

`GET /api/work-items` ile aynı filtre parametreleri (`search`, `project`, `quickFilter`, `currentUser`, `type`, `state`, `priority`, `assignee`, `sortBy`, `sortOrder`, `includeCompleted`) ve:

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `swimlane` | `none` | `none`, `parent`, `assignee`, `priority` |
| `laneLimit` | 25 | 1–100 |
| `laneOffset` | 0 | Şerit ofseti |
| `cardLimit` | 15 | Her şerit-kolon için ilk kart sayısı (1–50) |
| `hideCompleted` | `false` | `true` ise `done` kolonu boş |

```json
{
  "columns": {"todo": 841, "in-progress": 120, "resolved": 5, "done": 0},
  "total": 966,
  "laneMode": "parent",
  "laneTotal": 212, "laneLimit": 25, "laneOffset": 0,
  "lanes": [{
    "id": "parent-123", "key": "123", "mode": "parent",
    "title": "Story başlığı", "type": "User Story", "project": "Alpha",
    "total": 7,
    "counts": {"todo": 4, "in-progress": 2, "resolved": 1, "done": 0},
    "columns": {"todo": [/*WorkItem, en fazla cardLimit*/], "in-progress": [], "resolved": [], "done": []},
    "progress": {"totalUnits": 5, "completedUnits": 2, "percent": 40}
  }],
  "dataVersion": "…"
}
```

- `columns` (üst düzey): filtre kapsamının **tamamı** için kolon toplamlarıdır (şerit sınırından bağımsız).
- Şerit sırası: `parent` → görünür kart sayısı azalan, sonra `id`; bağımsız (`key: "none"`) en sonda. `assignee` → görünür kart sayısı azalan, `Unassigned Pool` en sonda. `priority` → 1,2,3,4. `none` → tek şerit `all`.
- `parent` şeridinde `progress` kanonik progress'tir (§4). Diğer modlarda şeritteki kartlardan `done/total`.
- Bir şeridin bir kolonunun devamı: `GET /api/work-items` + `column=<kolon>` + `lane=<mode>:<key>` (`lane` parametresi bu uçta da geçerlidir: `parent:123`, `parent:none`, `assignee:Fixture Person A`, `assignee:Unassigned`, `priority:2`).

## 6. `GET /api/work-items-pool`

Yalnızca **Story & Tasks** ve **Dependency Explorer** için tam hiyerarşi/ilişki verisi gerektiğinde, ekran açılınca yüklenir (açılışta yüklenmez). Yanıt `dataVersion` içerir ve yalnızca cache'ten gelir.

## 7. `GET /api/sync-status`

```json
{"status": "idle|syncing|error", "source": "live|fixture",
 "lastSyncedAt": "…", "lastSuccessAt": "…", "lastFullSyncAt": "…", "lastIncrementalSyncAt": "…",
 "lastError": null, "lastResult": {/* son sync raporu */},
 "totalOrgActive": 124, "totalCached": 136, "totalActiveCached": 123,
 "deletedCount": 0, "contextCount": 0, "dataVersion": "…"}
```

Eski alanlar (`error`, `totalOrgActive`, `totalCached`) korunur.

## 8. `GET /api/me`

`{"displayName": "…", "source": "live|fixture"}`. Fixture modunda `Fixture User`.

## 9. `GET /api/work-items/<id>/children`

Bir iş öğesinin **canlı** (`deleted_at IS NULL`) çocukları. Context (`is_context=1`) ve tamamlanmış kayıtlar **dahildir** (Inspector tamamlanmış görevleri göstermek zorunda). Sıra: `is_active DESC` (aktifler önce), `priority ASC`, `id ASC`. En fazla 500 satır; daha fazlası varsa `truncated: true`. Ebeveynin kendisi canlı değilse 404. Fixture modunda Azure'a gidilmez.

```json
{"items": [ /* WorkItem */ ], "total": 7, "truncated": false, "dataVersion": "…"}
```

`total` tüm çocukları sayar (500 sınırından bağımsız).

## 10. `GET /api/work-items/batch?ids=1,2,3`

En fazla 100 id. Canlı kayıtlar (context dahil) `items` içinde **istek sırasıyla** döner; tekrarlı id'ler bir kez işlenir. Canlı olmayan id'ler `missing` listesine girer. Virgüllü olmayan/tam sayı olmayan değer veya 100'den fazla id → 400.

```json
{"items": [ /* WorkItem */ ], "missing": [999], "dataVersion": "…"}
```

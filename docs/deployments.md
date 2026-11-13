# OpenDevBoard - Deployment Metrics Dokümantasyonu

Bu doküman, OpenDevBoard uygulamasının Azure DevOps sürüm dağıtım (release deployment) süreçlerini, ortam sağlığını ve dağıtım sıklığını izleyen **Deployment Metrics** modülünü açıklar.

---

## 1. Mimari ve Desteklenen Kaynaklar

1. **Desteklenen Kaynak:**
   - **Classic Release Deployments:** Azure DevOps Visual Studio Release Management (VSRM) REST API (`https://vsrm.dev.azure.com/{org}/{project}/_apis/release/deployments`) üzerinden okunur.
   - Organizasyonda yapılandırılmış tüm release pipeline'larının ortam bazlı dağıtım sonuçlarını, sürelerini ve tetikleyicilerini kapsar.
2. **Kapsam Notu:**
   - Azure DevOps'ta YAML tabanlı Multi-stage Pipeline Environments ayrı bir API yapısı kullanır. Organizasyonda YAML Environment yapılandırılmamışsa arayüzde açıkça desteklenen kaynak belirtilir ve sahte veri üretilmez.
3. **Kesinlikle Salt Okunur:**
   - Dağıtım tetikleme, onaylama (approval), reddetme veya geri alma (rollback) yetkisi verilmez; yalnızca durum ve metrikler izlenir.

---

## 2. Backend API Sözleşmesi

### 2.1. `GET /api/deployments`
Sayfalama, arama, proje, ortam ve durum filtreleme destekleyen dağıtım kayıtları listesi.

**Sorgu Parametreleri:**
- `project` (string, opsiyonel): Proje filtresi (varsayılan: `'all'`).
- `environment` (string, opsiyonel): Azure DevOps ortam adı (ör. `Production`, `Staging`, `Test` veya yapılandırılmış özel bir ad).
- `status` (string, opsiyonel): `succeeded`, `failed`, `inProgress`, `canceled`, `all`.
- `search` (string, opsiyonel): Release adı, tanım veya ortamda arama.
- `days` (integer, varsayılan: 30): Zaman aralığı (7 veya 30 gün).
- `limit` (integer, varsayılan: 25, maks: 100): Sayfa boyutu.
- `offset` (integer, varsayılan: 0): Sayfa ofseti.
- `refresh` (boolean, opsiyonel): `true` verilirse önbellek atlanır ve VSRM API'den taze veri çekilir.

**Örnek Yanıt:**
```json
{
  "items": [
    {
      "id": 1001,
      "project": "Example Project",
      "releaseId": 3,
      "releaseName": "Example Release",
      "definitionId": 2,
      "definitionName": "Example deployment definition",
      "environmentId": 3,
      "environmentName": "Example Environment",
      "status": "succeeded",
      "attempt": 1,
      "startedOn": "2026-01-02T13:54:30Z",
      "completedOn": "2026-01-02T13:57:20Z",
      "durationSeconds": 170,
      "requestedBy": "Microsoft.VisualStudio.Services.ReleaseManagement",
      "url": "https://dev.azure.com/example/Example%20Project/_releaseProgress?releaseId=3"
    }
  ],
  "total": 12,
  "limit": 25,
  "offset": 0,
  "hasMore": true,
  "summary": {
    "periodDays": 30,
    "totalDeployments": 12,
    "succeeded": 10,
    "failed": 1,
    "inProgress": 0,
    "successRate": 83.3,
    "environments": [
      {"name": "Example Environment A", "total": 6, "succeeded": 6, "failed": 0, "successRate": 100.0},
      {"name": "Example Environment B", "total": 6, "succeeded": 4, "failed": 1, "successRate": 66.7}
    ]
  },
  "supportedSources": [
    "Classic Release Deployments (Azure DevOps VSRM API)"
  ],
  "dataScope": "live_cached",
  "lastSyncedAt": "2026-01-02T16:50:00Z"
}
```

### 2.2. `GET /api/deployments/summary`
Dashboard ve özet görünüm için hafif uç noktası.

Yanıttaki `cacheStatus` güncellemenin `complete`, `partial` veya `failed` sonucunu ve son başarılı güncelleme zamanını (`lastSyncedAt`) taşır. Geçerli bir boş yanıt `complete` ve sıfır dağıtım döndürür. Azure erişimi başarısızsa cache varsa son snapshot `stale=true` ile sunulur; cache yoksa UI metrikleri sıfır yerine `—` gösterir. `errors` yalnızca `auth` (401/403), `rate_limited` (429), `upstream_http` (diğer HTTP yanıtları), `timeout` veya `connection_refused` gibi kategorileri içerir; ham yanıt gövdesi içermez. `Classic Release Deployments (VSRM API)` desteklenir; YAML Environments bu endpoint için desteklenmez.

### 2.3. `GET /api/deployments/<id>`
Tekil bir dağıtımın ortam, süre, attempt ve release bağlantısı detaylarını döndürür.

### 2.4. `GET /api/deployment-metrics`
Geriye dönük uyumluluk uç noktasıdır.

---

## 3. Gerçek Ortam İsimleri ve Dağılım

Sistem ortam isimlerini önceden belirlenmiş "Prod, Stage, Dev" seçenekleriyle kısıtlamaz. Azure DevOps üzerinde tanımlı ortam adlarını dinamik olarak listeler ve her ortamın kendi başarı oranını bağımsız hesaplar. Buradaki örnek ortam adları temsili olmalıdır.

---

## 4. Kullanıcı Arayüzü (Modern UI)

1. **Kenar Çubuğu (Sidebar):**
   - "Deployment Metrics" menü öğesi (`data-testid="nav-deployments"`).
2. **Özet Kartlar:**
   - Toplam dağıtım, başarılı/hatalı dağıtım sayısı ve başarı oranı; sonuçlar seçilen dönem ve filtrelere bağlıdır.
    - Ortam dağılımı çipleri: Tıklandığında ilgili ortama göre filtreleme yapar.
3. **Filtreler ve Arama:**
   - Durum seçici: *Tümü*, *Başarılı*, *Hatalı*.
   - Zaman aralığı seçici: *Son 7 Gün* / *Son 30 Gün*.
   - Arama kutusu (debounced 250ms).
4. **Detay Paneli (`DeploymentInspector.tsx`):**
   - Release satırına tıklandığında sağdan kayarak açılır.
   - Hedef ortam rozeti, tanım, deneme (attempt) numarası.
   - Dağıtım süresi (`2m 50s`), başlangıç ve tamamlanma saati.
   - Dağıtımı başlatan servis/kullanıcı.
   - "Azure DevOps Release'te Aç" butonu.

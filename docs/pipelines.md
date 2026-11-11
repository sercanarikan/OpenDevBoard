# OpenDevBoard - Pipeline Health Dokümantasyonu

Bu doküman, OpenDevBoard uygulamasının CI/CD derleme (build) ve test süreçlerini izleyen **Pipeline Health** modülünün veri mimarisini, durum ve sonuç sınıflandırmasını, API sözleşmesini ve arayüz entegrasyonunu açıklar.

---

## 1. Mimari ve Güvenlik İlkeleri

1. **Kesinlikle Salt Okunur (Strictly Read-Only):**
   - Azure DevOps üzerinde derleme tetikleme, iptal etme, kuyruğa alma veya onaylama işlemi yapılmaz.
   - Tüm iletişim `GET /_apis/build/builds` ve `GET /_apis/build/definitions` uç noktaları üzerinden salt okunur gerçekleştirilir.
2. **Durum (Status) ve Sonuç (Result) Ayrımı:**
   - Azure DevOps API'sinde `status` ve `result` alanları farklı kavramları temsil eder:
     - **Status (Çalışma Durumu):** `notStarted`, `inProgress`, `completed`, `cancelling`.
     - **Result (Koşum Sonucu):** `succeeded`, `partiallySucceeded`, `failed`, `canceled`.
   - Henüz devam eden (`inProgress`) veya kuyrukta bekleyen bir derleme asla başarısız (`failed`) sayılamaz.
3. **Başarı Oranı (Success Rate) Hesabı:**
   - Başarı oranı paydasında yalnızca **sonucu kesinleşmiş tamamlanmış çalıştırmalar** yer alır:
     $$\text{Başarı Oranı} = \frac{\text{Succeeded}}{\text{Succeeded} + \text{Failed} + \text{Partially Succeeded}} \times 100$$
   - Kuyruktaki veya devam eden işler başarı oranını yapay olarak düşürmez.
4. **YAML vs Classic Pipeline Ayrımı:**
   - Pipeline tanımları tipine göre etiketlenir (`YAML` veya `Classic`).
   - Duplicate kayıtlar `(id, project)` ikilisi üzerinden elenir.

---

## 2. Backend API Sözleşmesi

### 2.1. `GET /api/pipelines/runs`
Sayfalama, arama, proje, durum ve sonuç filtreleme destekleyen pipeline çalıştırmaları listesi.

**Sorgu Parametreleri:**
- `project` (string, opsiyonel): Proje filtresi (varsayılan: `'all'`).
- `status` (string, opsiyonel): `inProgress`, `completed`, `notStarted`, `all`.
- `result` (string, opsiyonel): `succeeded`, `failed`, `partiallySucceeded`, `canceled`, `all`.
- `branch` (string, opsiyonel): Kaynak dala göre filtreleme (ör. `main`, `dev`).
- `search` (string, opsiyonel): Pipeline adı, dal, ID veya tetikleyen kullanıcıda arama.
- `days` (integer, varsayılan: 30): Zaman aralığı (7 veya 30 gün).
- `limit` (integer, varsayılan: 25, maks: 100): Sayfa boyutu.
- `offset` (integer, varsayılan: 0): Sayfa ofseti.
- `refresh` (boolean, opsiyonel): `true` verilirse önbellek atlanır ve canlı API'den taze veri çekilir.

**Örnek Yanıt:**
```json
{
  "items": [
    {
      "id": 1001,
      "project": "Example Project",
      "pipelineId": 2,
      "pipelineName": "Example pipeline",
      "pipelineType": "yaml",
      "buildNumber": "1001",
      "status": "completed",
      "result": "succeeded",
      "sourceBranch": "dev",
      "sourceVersion": "0123456789abcdef",
      "requestedBy": "Example User",
      "queueTime": "2026-01-02T14:20:00Z",
      "startTime": "2026-01-02T14:21:00Z",
      "finishTime": "2026-01-02T14:29:34Z",
      "durationSeconds": 514,
      "url": "https://dev.azure.com/example/Example%20Project/_build/results?buildId=1001"
    }
  ],
  "total": 12,
  "limit": 25,
  "offset": 0,
  "hasMore": true,
  "summary": {
    "periodDays": 30,
    "totalPipelines": 3,
    "totalRuns": 12,
    "succeeded": 9,
    "failed": 2,
    "partiallySucceeded": 0,
    "inProgress": 0,
    "canceled": 1,
    "successRate": 81.8,
    "failedRuns": [],
    "dailyStats": []
  },
  "dataScope": "live_cached",
  "lastSyncedAt": "2026-01-02T16:50:00Z"
}
```

### 2.2. `GET /api/pipelines/summary`
Dashboard kartları ve özet paneller için hafif özet uç noktası.

### 2.3. `GET /api/pipelines/runs/<id>`
Tekil bir pipeline çalıştırmasının detaylarını, başlangıç/bitiş zaman damgalarını, kaynak commit bilgisini ve log bağlantısını döndürür.

### 2.4. `GET /api/pipeline-health`
Geriye dönük uyumluluk için korunmuştur.

- `days` (integer, opsiyonel; varsayılan: 30): Pipeline source fetch ve response summary için aynı zaman aralığı kullanılır. Desteklenen değerler `7`, `14`, `30` ve `90` gündür; eksik olmayan geçersiz değerler HTTP 400 döndürür.
- `periodDays` değeri hem ilk yüklemede hem period değişiminde gönderilir. Parametreyi doğrudan kullanan çağrılar için default 30 gündür.
- Status/result sınıflandırması ve success-rate denominator'ı değişmez.

---

## 3. Önbellek ve Hata Yönetimi

- SQLite veritabanında `pipeline_runs` tablosunda saklanır.
- **TTL:** 300 saniye (5 dakika).
- Tekrarlanan istekler yerel SQLite'tan ~5 ms içinde yanıtlanır.
- **Fixture Modu (`DEVOPS_FIXTURE_MODE=1`):** Çevrimdışı ve CI ortamında 20 deterministik pipeline çalıştırması üretir; ağ veya PAT gerektirmez.

---

## 4. Kullanıcı Arayüzü (Modern UI)

1. **Kenar Çubuğu (Sidebar):**
   - "Pipeline Health" menü öğesi (`data-testid="nav-pipelines"`).
   - Son 30 günde kırık build varsa kırmızı uyarı rozeti ile kırık sayısı gösterilir.
2. **Özet Kartlar:**
   - Toplam Pipeline, Toplam Koşum, Başarılı, Kırık/Hatalı, Devam Eden ve Başarı Oranı rozetleri.
3. **Filtreler ve Zaman Seçici:**
   - Hızlı filtreler: *Tümü*, *Başarılı*, *Başarısız*.
   - Zaman aralığı seçici: *Son 7 Gün* / *Son 30 Gün*.
   - Arama çubuğu (debounced 250ms).
4. **Detay Paneli (`PipelineInspector.tsx`):**
   - Bir pipeline satırına tıklandığında sağdan açılır.
   - Başarı/hata rozeti, süre (`8m 34s`), kuyruk/başlangıç/bitiş saatleri.
   - Kaynak dal ve commit SHA bilgisi.
   - "Azure DevOps'ta Aç" butonu.

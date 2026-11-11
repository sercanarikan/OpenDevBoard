# OpenDevBoard - My History (Geçmişim) Dokümantasyonu

Bu doküman, kullanıcının Azure DevOps üzerindeki doğrulanmış tamamlanan işlerini, commit'lerini ve kod inceleme hareketlerini kronolojik olarak sunan **My History** modülünün veri mimarisini ve kullanımını açıklar.

---

## 1. Mimari ve Olay Doğrulama İlkeleri

1. **Gerçek Olay Verisi (No Synthetic Inferences):**
   - Work Item'ın salt son durumuna bakılarak geçmiş olaylar uydurulmaz.
   - Gerçek Azure DevOps `Microsoft.VSTS.Common.ClosedDate` / `System.ChangedDate`, Git commit author tarihleri, PR oluşturma ve birleştirilme zaman damgaları kullanılır.
2. **Kanonik Olay Modeli:**
   ```json
   {
     "id": "wi-1001",
     "eventType": "workItem.closed",
      "occurredAt": "2026-01-02T15:00:00Z",
      "project": "Example Project",
     "entity": {
       "type": "workItem",
        "id": 1001,
        "title": "Example work item"
     },
      "summary": "Work Item #1001 completed and closed",
     "url": "https://dev.azure.com/...",
     "actor": {
       "id": "verified-guid",
        "displayName": "Example User"
     }
   }
   ```
3. **Deduplication (Tekilleştirme):**
   - Farklı kaynaklardan gelen aynı eylemler benzersiz `id` (`wi-{id}`, `commit-{sha8}`, `pr-merged-{id}`, `pr-review-{id}`) ile tekilleştirilir.
4. **İnceleme (Review) Zaman Damgası Denetimi:**
   - PR'ın genel `lastModifiedDate` veya kapanma tarihi reviewer'ın oy verdiği tarih olarak kabul edilmez.
   - Yalnızca reviewer kaydında kesin zaman damgası (`lastModifiedDate`/`voteDate`) ve aktif oy (`vote != 0`) mevcut olduğunda zaman tüneline review olayı eklenir. PR reviewers listesi bu alanlardan birini sağlamıyorsa PR-level `lastModifiedDate`, `closedDate` veya completion time yedek olarak kullanılmaz ve review olayı dışlanır.
   - Reviewer identity Azure DevOps PR reviewers response'indeki `id`/`displayName`/`uniqueName` üzerinden geçerli kullanıcıyla eşleştirilir. Mevcut event ID `pr-review-{PR id}` PR başına tekil bir kayıt anahtarıdır; bağımsız vote event ID'si değildir, bu nedenle ayrı reviewer event'leri API ile sağlanmadıkça tek olaya indirgenebilir.

---

## 2. Backend API Sözleşmesi

### 2.1. `GET /api/my-history/timeline`
Kişisel aktivite akışını sayfalanmış ve filtrelenebilir olarak döndürür.

**Sorgu Parametreleri:**
- `activityType` (string, opsiyonel): `'all'`, `'workItem'`, `'commit'`, `'pullRequest'`, `'review'`.
- `project` (string, opsiyonel): Proje filtresi.
- `search` (string, opsiyonel): Başlık, iş no veya commit mesajında arama.
- `days` (int, varsayılan: 30): 7 veya 30 günlük zaman penceresi.
- `limit`, `offset`: Sayfalama parametreleri.

### 2.2. `GET /api/my-history/summary`
Kullanıcının aktivite metriklerini ve katkı ısı haritasını döndürür:
- `totalEvents`: Toplam aktivite sayısı
- `completedWorkItems`: Tamamlanan iş öğesi sayısı
- `commitsCount`: Yazılan commit sayısı
- `prsCount`: Açılan/birleştirilen PR sayısı
- `reviewsCount`: Oy verilen inceleme sayısı
- `projectsTouched`: Dokunulan aktif projeler listesi
- `dailyHeatmap`: Günlük aktivite dağılımı

### 2.3. `GET /api/my-history/<eventId>`
Tekil bir aktivite olayının detaylarını döndürür.

### 2.4. `GET /api/my-history`
Geriye dönük uyumluluk endpoint'idir.

---

## 3. Kullanıcı Arayüzü (Modern UI)

- **Özet Metrik Kartları:** Toplam Aktivite (131), Tamamlanan İşler (11), Commit'ler (109), Pull Request'ler (4), İncelemeler (7).
- **Zaman Çizelgesi Grupları (Chronological Timeline):**
  - **Bugün (Today)**
  - **Dün (Yesterday)**
  - **Bu Hafta (This Week)**
  - **Daha Eski (Earlier)**
- **İnteraktif Çekmece Entegrasyonu:**
  - Bir Work Item kartına tıklandığında modern `WorkItemInspector` sağdan kayarak açılır.
  - Bir Pull Request kartına tıklandığında `PullRequestInspector` açılır.
  - Commit kartları doğrudan Azure DevOps commit sayfasına yönlendirir.
- **Filtreler ve Arama:**
  - Hızlı aktivite türü filtreleri: *Tüm Aktiviteler*, *Work Items*, *Commit'ler*, *Pull Requests*, *İncelemeler*.
  - Arama kutusu (debounced 250ms).
  - Dönem seçici: *Son 7 Gün* / *Son 30 Gün*.

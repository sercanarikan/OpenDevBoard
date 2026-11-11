# OpenDevBoard - Pull Requests Dokümantasyonu

Bu doküman, OpenDevBoard uygulamasındaki salt-okunur (read-only) Pull Request entegrasyonunu, backend mimarisini, kimlik eşleme kurallarını, oy eşlemelerini, önbellek stratejisini ve kullanıcı arayüzünü açıklar.

---

## 1. Mimari ve Güvenlik Prensipleri

1. **Kesinlikle Salt Okunur (Read-Only):**
   - Sistem Azure DevOps üzerinde PR oluşturma, onaylama (approve), reddetme (reject), oy verme veya yorum yazma işlemi yapmaz.
   - Bütün Azure DevOps çağrıları yalnızca `GET` HTTP metodunu kullanır.
2. **PAT ve Kimlik Güvenliği:**
   - Azure DevOps Personal Access Token (PAT) yalnızca backend konteynerinde (`api:5000`) bulunur.
   - Frontend doğrudan Azure DevOps API'sine erişmez; tüm istekler `/api/pull-requests` ters vekili (reverse proxy) üzerinden yönlendirilir.
   - PAT veya kimlik bilgileri loglara, yanıtlara veya commit'lere asla sızdırılmaz.
3. **Kapsam İzolasyonu:**
   - Work Item cache tabloları ve SQLite şeması bozulmaz; PR kayıtları izole `pull_requests` tablosunda saklanır.

---

## 2. Backend API Sözleşmesi

### 2.1. `GET /api/pull-requests`
Sunucu taraflı sayfalama, filtreleme, arama ve sıralama destekleyen ana PR listesi.

**Sorgu Parametreleri:**
- `project` (string, opsiyonel): Proje adı ile filtreler (varsayılan: `'all'`).
- `repository` (string, opsiyonel): Belirli bir Git deposuna göre filtreler.
- `status` (string, opsiyonel): `active` (varsayılan), `completed`, `abandoned`, `all`.
- `quickFilter` (string, opsiyonel):
  - `needs-my-review`: Kullanıcının reviewer olarak atandığı, yazar olmadığı ve henüz oy vermediği (`vote == 0`) aktif PR'lar.
  - `created-by-me`: Kullanıcının oluşturduğu PR'lar.
  - `involved`: Kullanıcının yazar veya reviewer olduğu PR'lar.
  - `all`: Proje kapsamındaki tüm PR'lar.
- `search` (string, opsiyonel): Başlık, ID, yazar, depo veya kaynak dalda büyük/küçük harf duyarsız arama.
- `limit` (integer, varsayılan: 25, maks: 100): Sayfa boyutu.
- `offset` (integer, varsayılan: 0): Sayfa ofseti.
- `sortBy` (string, varsayılan: `creationDate`): `creationDate`, `id`, `title`.
- `sortOrder` (string, varsayılan: `desc`): `desc`, `asc`.
- `refresh` (boolean, opsiyonel): `true` verilirse önbellek atlanır ve Azure DevOps'tan taze veri çekilir.

**Örnek Yanıt:**
```json
{
  "items": [
    {
      "id": 1001,
      "project": "Example Project",
      "repository": "example-repository",
      "title": "Example pull request title",
      "description": "PR description text...",
      "status": "active",
      "isDraft": 0,
      "authorId": "guid-here",
      "authorName": "Example User",
      "authorAvatar": "https://...",
      "sourceBranch": "feature/example",
      "targetBranch": "dev",
      "mergeStatus": "succeeded",
      "creationDate": "2026-01-02T14:32:00Z",
      "url": "https://dev.azure.com/example/Example%20Project/_git/example-repo/pullrequest/1001",
      "reviewers": [
        {
          "id": "guid-user",
          "displayName": "Reviewer Example",
          "vote": 0,
          "voteKey": "noVote",
          "voteLabel": "İnceleme Bekliyor",
          "isRequired": true
        }
      ],
      "workItems": [{"id": 1002, "url": ""}],
      "isAuthor": false,
      "isReviewer": true,
      "myVote": 0,
      "needsMyReview": true
    }
  ],
  "total": 2,
  "limit": 25,
  "offset": 0,
  "hasMore": false,
  "summary": {
    "needsMyReview": 2,
    "createdByMe": 0,
    "involved": 2,
    "totalActive": 2
  },
  "dataScope": "live_cached",
  "lastSyncedAt": "2026-01-02T14:32:00Z"
}
```

### 2.2. `GET /api/pull-requests/summary`
Dashboard kartları ve kenar çubuğu sayaçları için hafif (lightweight) özet uç noktası.

**Örnek Yanıt:**
```json
{
  "needsMyReview": 2,
  "createdByMe": 0,
  "involved": 2,
  "totalActive": 2,
  "lastSyncedAt": "2026-01-02T14:32:00Z"
}
```

### 2.3. `GET /api/pull-requests/<id>`
Belirli bir PR'ın tam açıklama, tüm inceleyenler ve ilişkili Work Item detaylarını döndürür.

---

## 3. Reviewer Kimlik ve Oy Eşleme Kuralları

Azure DevOps üzerindeki inceleyen kimliği, oturum açmış kullanıcının kimliğiyle 3 kademeli doğrulanır:
1. **Azure DevOps Identity GUID (`id`):** En güvenilir benzersiz eşleşme.
2. **Subject Descriptor / UPN (`uniqueName`):** Kurumsal e-posta/kullanıcı adı eşleşmesi.
3. **Display Name (`displayName`):** Büyük/küçük harf duyarsız tam veya alt dize eşleşmesi.

**Oy Değerleri:**
| Vote Kodu | Durum Anahtarı | Türkçe Etiket | İngilizce Etiket |
| :---: | :--- | :--- | :--- |
| `10` | `approved` | Onaylandı | Approved |
| `5` | `approvedWithSuggestions` | Önerilerle Onaylandı | Approved with suggestions |
| `0` | `noVote` | İnceleme Bekliyor | Waiting for review |
| `-5` | `waitingForAuthor` | Yazar Yanıtı Bekleniyor | Waiting for author |
| `-10` | `rejected` | Reddedildi | Rejected |

---

## 4. Önbellek Mimarisi

- SQLite veritabanında `pull_requests` tablosunda saklanır.
- **TTL:** 300 saniye (5 dakika).
- 5 dakika içindeki istekler Azure DevOps'a gitmeden anında yerel veritabanından döndürülür (~5 ms).
- Manuel "Yenile" butonuna basıldığında `refresh=true` ile Azure DevOps'tan taze veri çekilir.
- **İzole Test Modu (`DEVOPS_FIXTURE_MODE=1`):** Ağ erişimi olmadan 16 deterministik PR üretilerek CI testlerinin stabil çalışması sağlanır.

---

## 5. Kullanıcı Arayüzü (Modern UI)

1. **Kenar Çubuğu (Sidebar):**
   - "Pull Requests" menü öğesi eklenmiştir (`data-testid="nav-pull-requests"`).
   - Kullanıcının inceleme bekleyen PR sayısı kadar rozet (badge) gösterilir.
2. **Explorer Ekranı (`PullRequestExplorer.tsx`):**
   - Hızlı filtre sekmeleri: "İncelememi Bekleyenler", "Oluşturduklarım", "İlgilendiklerim", "Tümü".
   - Durum seçici: Aktif, Tamamlandı, Terk Edildi, Tümü.
   - Arama çubuğu (debounced).
   - Sayfalama çubuğu (Pager).
3. **Detay Paneli (`PullRequestInspector.tsx`):**
   - Bir PR satırına tıklandığında sağdan kayarak açılır.
   - Dal akışı (`sourceBranch ➔ targetBranch`) ve birleştirme durumu.
   - Yazar bilgisi, oluşturulma tarihi.
   - İnceleyenler listesi, oy durumu ve zorunlu inceleyen rozetleri.
   - PR açıklama metni.
   - İlişkili Work Item çipleri: Tıklandığında doğrudan `WorkItemInspector` açılarak iş öğesi incelenebilir.

# OpenDevBoard - Team Activity (Ekip Aktivitesi) Dokümantasyonu

Bu doküman, OpenDevBoard uygulamasının Azure DevOps depoları üzerindeki commit akışlarını, pull request aktivitelerini ve ekip katkı metriklerini analiz eden **Team Activity** modülünün mimarisini ve kullanımını açıklar.

---

## 1. Mimari ve Veri Güvenliği İlkeleri

1. **Kesinlikle Salt-Okunur (Strictly Read-Only):**
   - Azure DevOps üzerinde commit, push, PR oluşturma, onay veya değişiklik yapılmaz.
   - Tüm veriler Azure DevOps Git REST API (`/_apis/git/repositories`, `/_apis/git/repositories/{id}/commits`, `/_apis/git/pullrequests`) üzerinden salt-okunur olarak toplanır.
2. **Rol ve Olay Ayrımı:**
   - **Commit Author vs. Pusher:** Commit'i yazan geliştirici ile depoya push eden hesap farklı olabilir; veri modelinde commit yazarının doğrulanmış adı ve e-postası esas alınır.
   - **Reviewer vs. İnceleme Aktivitesi:** Bir kullanıcının PR inceleme listesinde olması (`reviewer`), mutlaka kod incelemesi yaptığı anlamına gelmez. Yalnızca oy veren (`vote != 0`) veya geri bildirimde bulunan kullanıcılar aktif inceleme yapmış sayılır.
   - **Adil ve Şeffaf Gösterim:** Commit veya PR sayıları bir çalışan sıralaması veya yapay performans puanı değildir; geliştirme süreçlerinin şeffaf görünürlüğünü sağlayan analitik göstergelerdir.

### 1.1. Team Activity vs. My History İnceleme (Review) Metrik Farkı
- **Team Activity (İncelemeler / Reviews):** Organizasyondaki açık ve yakın zamanda tamamlanmış PR'lar üzerinde kullanıcının sahip olduğu **aktif oy kayıtlarının (active reviewer votes, `vote != 0`)** toplam hacmini sayar. Bir PR üzerinde oy verilmiş olması takım aktivitesi olarak listelenir.
- **My History (Zaman Tüneli İnceleme Olayları):** Reviewer identity ile eşleşen, reviewer kaydında ayrı `lastModifiedDate` veya `voteDate` zamanı bulunan olayları içerir. PR genelindeki `lastModifiedDate` kullanılmaz; Azure response'unda reviewer-level timestamp yoksa olay timeline'a eklenmez.
Bu iki metrik farklı amaçlara hizmet eder; yapay olarak eşitlenmez.

---

## 2. Backend API Sözleşmesi

### 2.1. `GET /api/team-activity/summary`
Seçilen zaman penceresindeki (7 veya 30 gün) özet metrikleri döndürür.

**Sorgu Parametreleri:**
- `days` (int, varsayılan: 30): 7 veya 30 günlük zaman penceresi. Alternatif olarak `startDate` ve `endDate` (`YYYY-MM-DD`, UTC, ikisi birlikte) takvim aralığı verilebilir; bkz. [Tarih aralığı filtresi](date-range-filter.md).
- `project` (string, opsiyonel): Proje filtresi (`'all'` veya proje adı).
- `refresh` (boolean, opsiyonel): `true` ise önbellek atlanır ve canlı API sorgulanır.

**Örnek Yanıt:**
```json
{
  "periodDays": 30,
  "totalCommits": 12,
  "totalPRs": 3,
  "activeContributors": 2,
  "dailyStats": [
    {"date": "02 Jan", "commits": 2, "prs": 1, "total": 3}
  ],
  "contributors": [
    {
      "name": "Example User",
      "email": "user@example.invalid",
      "commitCount": 5,
      "authoredPRs": 1,
      "reviewsCount": 2,
      "reviewerAssignments": 2,
      "reviewVotesCount": 1,
      "lastActivity": "2026-01-02T14:20:00Z"
    }
  ],
  "repositories": [
    {
      "project": "Example Project",
      "repository": "example-repository",
      "commitCount": 5,
      "prCount": 1,
      "lastActivity": "2026-01-02T14:20:00Z"
    }
  ],
  "lastSyncedAt": "2026-01-02T16:30:00Z"
}
```

**Reviewer alanları (katkıda bulunan başına):**
- `reviewerAssignments`: Dönemde **oluşturulmuş** PR'larda reviewer olarak listelenen (PR yazarı hariç) PR sayısı. Bu bir *reviewer atamasıdır*, yapılmış bir inceleme olayı değildir. Arayüzde "Reviewer olarak atandığı PR" olarak etiketlenir.
- `reviewsCount`: Geriye dönük uyumluluk için korunan eski ad; her zaman `reviewerAssignments` ile aynı değerdir. Yapılan inceleme sayısı olarak sunulmamalıdır.
- `reviewVotesCount`: Aynı PR'lar arasında **güncel oy durumu** sıfırdan farklı olan reviewer sayısı. Zaman damgalı bir inceleme olayı değildir ve dönem içine tarihlenmez; dönem metriği olarak kullanılmamalıdır. Tarihli, doğrulanmış inceleme olayları için My History modülüne bakın.

### 2.2. `GET /api/team-activity/contributors`
Katkıda bulunan geliştiricilerin aranabilir, sıralanabilir ve sayfalanmış listesi.

**Parametreler:**
- `search`: Geliştirici adı veya e-postasında arama.
- `sortBy`: `commits`, `prs`, `reviews`, `name`, `activity`. `reviews` anahtarı geriye dönük uyumluluk için korunur ve `reviewerAssignments` sayısına göre sıralar.
- `sortOrder`: `asc`, `desc`.
- `limit`, `offset`: Sayfalama pencereleri.

### 2.3. `GET /api/team-activity/commits`
Seçilen proje, depo veya katkıda bulunana göre filtrelenebilir son commit akışı.

### 2.4. `GET /api/team-activity/repositories`
Depo bazında commit sayısı, PR sayısı ve son aktivite tarihi.

### 2.5. `GET /api/team-activity`
Eski UI consumers ile geriye dönük uyumluluğu korur.

---

## 3. SQLite Önbellek ve Performans

- **Tablo:** `team_commits` tablosu `(commit_id, repository)` birincil anahtarıyla SQLite'ta saklanır.
- **TTL:** 300 saniye (5 dakika).
- Tekrarlanan sorgular yerel SQLite'tan ~3 ms içinde yanıtlanır.
- **Fixture Modu:** `DEVOPS_FIXTURE_MODE=1` durumunda 22 deterministik commit ve 11 pull request aktivitesi üretir; harici ağ veya kimlik bilgisi gerektirmez.

---

## 4. Kullanıcı Arayüzü (Modern UI)

- **Genel Bakış Kartları:** Toplam Commit (276), Aktif Katkıda Bulunan (11), Toplam PR (20), Dönem Seçici (Son 7 Gün / Son 30 Gün).
- **Aktivite Trendi (Activity Trend Chart):** Günlük bazda commit (mavi) ve PR (mor) dağılımını gösteren görsel bar grafiği.
- **Alt Sekmeler:**
  - **Katkı Sağlayanlar:** Sıralama rozetleri (🥇, 🥈, 🥉), commit, PR ve inceleme sayıları; tıklandığında sağdan detay çekmecesi açılır.
  - **Depo Bazlı Aktivite:** Depoların commit ve PR yoğunlukları.
  - **Son Commit Akışı:** Commit ID, mesaj, yazar ve Azure DevOps bağlantıları.
- **Tema & Dil:** TR (varsayılan) ve EN, Açık ve Koyu tema, 1024/1440/1920px responsive.

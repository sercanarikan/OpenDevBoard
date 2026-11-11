# OpenDevBoard - İstemci Taraflı Yönlendirme (Client-Side Routing) Dokümantasyonu

Bu doküman, OpenDevBoard uygulamasının React tabanlı yönlendirme (routing) mimarisini, URL kalıcılığını (persistence), Nginx SPA fallback yapılandırmasını ve sayfa bazlı gezinme kurallarını açıklar.

---

## 1. Yönlendirme Mimarisi ve URL Tablosu

OpenDevBoard, HTML5 History API ve `react-router-dom` tabanlı istemci taraflı bir yönlendirme yapısı kullanır. Her modülün kendine ait açık ve kalıcı bir URL adresi vardır:

| Modül / Ekran | URL Rotası | Görünüm Kodu (`ViewMode`) | Açıklama |
| :--- | :--- | :--- | :--- |
| **Genel Bakış** | `/dashboard` | `dashboard` | Merkezi başlangıç paneli, günlük iş durumu, CI/CD ve aktivite özeti |
| **İş Listesi** | `/tasks` | `explorer` | Sunucu taraflı sayfalanmış Work Item listesi ve filtreler |
| **Kanban Panosu** | `/kanban` | `board` | Durum kolonları, yüzme şeritleri ve kart yoğunluğu |
| **Hiyerarşi Ağacı** | `/hierarchy` | `hierarchy` | Epic → Feature → Story → Task ağacı ve kanonik ilerleme |
| **Bağımlılık Grafiği** | `/dependencies` | `dependencies` | Bloklayan/engellenen ilişkiler, hop seçici ve MiniMap |
| **Pull Requests** | `/pull-requests` | `pull-requests` | Kod inceleme talepleri, oylama rozetleri ve filtreler |
| **Pipeline Health** | `/pipelines` | `pipelines` | CI/CD derleme/test çalıştırmaları ve kırık build uyarıları |
| **Deployment Metrics**| `/deployments` | `deployments` | Ortam dağılımları, başarı oranları ve sürüm geçmişi |
| **Ekip Aktivitesi** | `/team-activity` | `team-activity` | Katkıda bulunanlar, günlük trend grafiği ve commit akışı |
| **Geçmişim** | `/my-history` | `my-history` | Kullanıcının doğrulanmış kronolojik eylem zaman çizelgesi |
| **Kök Dizin** | `/` | — | Otomatik olarak `/dashboard` rotasına yönlendirilir (`replace: true`) |
| **Bilinmeyen Rota** | `*` | — | 404 Sayfa Bulunamadı (`NotFoundView`) bileşeni |

Geriye dönük uyumluluk için eski `/explorer` adresi `/tasks`'a, `/board` adresi `/kanban`'a otomatik yönlendirilir.

---

## 2. Navigasyon Davranışları ve Kalıcılık

1. **Sayfa Yenileme (Browser Refresh / F5):**
   - Kullanıcı örneğin `/pull-requests?project=Example%20Project` adresindeyken F5 yaptığında uygulama aynı sayfada ve aynı proje kapsamında kalır; kesinlikle Task Explorer'a veya Dashboard'a geri dönmez.
2. **Doğrudan URL Girişi ve Paylaşım (Deep Linking):**
   - Tarayıcının yeni bir sekmesinde doğrudan `http://localhost:5174/pipelines` açıldığında uygulama bootstrap sırasında rota bilgisini kaybetmez; doğrudan ilgili ekran yüklenir.
3. **Geri ve İleri Gezinme (Browser Back / Forward):**
   - Tarayıcının Geri ve İleri düğmelerine basıldığında URL ve aktif sayfa senkronize olarak değişir; sol kenar çubuğundaki (`Sidebar`) ilgili menü öğesi anında vurgulanır (`aria-current="page"`).
4. **Hata ve 404 Ekranı:**
   - Tanımsız bir adres ziyaret edildiğinde (ör. `/bilinmeyen-sayfa`) şık bir 404 ekranı açılır ve kullanıcıya "Geri Dön" veya "Dashboard" seçenekleri sunulur.

---

## 3. URL Sorgu Parametreleri (Query Parameters) ve Proje Kapsamı

Uygulamanın URL ile taşınan kapsamı ve filtreleri:

* **Proje Kapsamı:** `?project=<proje-adi>` (Örnek: `/dashboard?project=Example%20Project`). Proje seçimi değiştiğinde URL sorgusu güncellenir ve sayfalar arası gezinirken proje kapsamı kaybolmaz. Dashboard, Tasks, Kanban, Hierarchy, Dependency Graph, PR, Pipelines, Deployments, Team Activity ve My History istekleri proje scope'unu kullanır; Dependency Graph bunu bütün organizasyon Work Item'larını bir araya getiren kapsam olarak değil, yüklenen graph içindeki proje seçimi olarak uygular.
* **İş Filtresi:** `/tasks?quickFilter=blocked` ve `quickFilter=my-tasks` ilk yüklemede uygulanır. Route değiştirme işlemi `project` parametresini taşır, modüle özel parametreleri route'lar arasında korumaz.
* Bilinmeyen veya modülün henüz okumadığı query parametreleri uygulamayı çökertmez. `status`, `days`, `sort`, `focus` ve `mode` için genel URL persistence sözleşmesi uygulanmış değildir; ilgili komponentlerde URL okuma/yazma eklenene kadar bu örnekler desteklenmiş sayılmaz.

---

## 4. Nginx SPA Fallback Yapılandırması

Canlı ve Docker ortamında Nginx sunucusu istemci taraflı rotaları destekleyecek şekilde yapılandırılmıştır (`apps/web/nginx.conf`):

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

Bu kural sayesinde doğrudan açılan `/pull-requests`, `/pipelines` gibi yollar Nginx tarafında 404 hatası vermez; `index.html` dosyasını döndürerek yönlendirmeyi React Router'a devreder. `/api/*` istekleri ise bağımsız olarak Flask backend servisine vekil sunucu (`proxy_pass`) ile iletilir.

---

## 5. Screenshot Optimizasyonu

Fixture E2E screenshot'ları `E2E_CAPTURE_SCREENSHOTS=1` ile opt-in'dir. `npm --prefix scripts run visual` ana route'ları responsive viewport, theme ve dil kombinasyonlarında doğrular. Görsel kanıt `captureVerifiedScreenshot` ile beklenen URL ve sayfa selector'ı doğrulandıktan sonra alınır. Screenshot kayıtları tarih/sürüm/topic klasörlerinde tutulur; manifest denetimi duplicate kayıtları, diskte olmayan referansları ve manifest dışı PNG'leri yakalar.

## 6. Test ve Doğrulama Komutları

### Linux ve macOS

```bash
# Repository kökünde; Node 22 gerekir
npm ci --prefix apps/web
npm --prefix apps/web test
npm --prefix apps/web run build

# İzole fixture stack; önce orchestrator kontratı, sonra sequential browser E2E
npm ci --prefix scripts
npm --prefix scripts run e2e:test
npm --prefix scripts run e2e
npm --prefix scripts run visual

docker compose config --quiet
```

### Windows PowerShell

```powershell
# Repository kökünde; Node 22 gerekir
npm.cmd ci --prefix apps/web
npm.cmd --prefix apps/web test
npm.cmd --prefix apps/web run build

# İzole fixture stack; önce orchestrator kontratı, sonra sequential browser E2E
npm.cmd ci --prefix scripts
npm.cmd --prefix scripts run e2e:test
npm.cmd --prefix scripts run e2e
npm.cmd --prefix scripts run visual

docker compose config --quiet
```

---

## 7. Geri Alma (Rollback)

Yönlendirme altyapısı bağımsız bir commit olarak izlenmektedir:

```bash
git revert dca8bba
```
*(Bu komut salt routing altyapısını geri alır; sidebar menü sıralamasını veya CSS yoğunluk ayarlarını bozmaz)*

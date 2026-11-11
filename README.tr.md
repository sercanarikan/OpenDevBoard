# OpenDevBoard

[English](README.md) | [Türkçe](README.tr.md)

Azure DevOps için açık kaynaklı gösterge paneli. OpenDevBoard; iş öğelerini, pull request'leri, pipeline'ları, dağıtımları, ekip etkinliğini ve geçmişi yerel önbellekle desteklenen modern bir web arayüzünde sunar. Azure DevOps ile tüm etkileşimler salt okunurdur.

## Özellikler

- Azure DevOps iş öğelerini ve pull request'leri görüntüleme.
- Pipeline ve dağıtım bilgilerini inceleme.
- Ekip etkinliğini ve kişisel geçmişi keşfetme.
- Türkçe veya İngilizce arayüzü, açık ya da koyu temayla kullanma.
- Deterministik demo verisiyle çalıştırma veya Azure DevOps organizasyonuna bağlanma.

## Mimari

Public Edition; React 19, TypeScript, Vite ve Tailwind kullanan bir frontend ile Python 3.12 Flask backend'inden oluşur. Frontend nginx üzerinden sunulur ve `/api` isteklerini ters vekil aracılığıyla backend'e iletir. Azure DevOps ile bağlantı kuran ve SQLite önbelleğini tutan tek bileşen backend'dir. Docker Compose `web` ve `api` servislerini çalıştırır; API portu host'a açılmaz.

## Gereksinimler

- Tam yığını çalıştırmak için Docker Engine ve Docker Compose v2 (önerilir)
- Yerel frontend geliştirme için Node.js 22 ve npm
- Yerel backend geliştirme için Python 3.12
- Canlı Azure DevOps verisi için organizasyon URL'si ve en az yetkili, salt okunur Personal Access Token (PAT)

## Docker Compose ile hızlı başlangıç

Yığını çevrimdışı fixture/demo modunda başlatın. `.env`, organizasyon URL'si veya PAT gerekmez:

```sh
docker compose up --build -d
```

<http://localhost:5174> adresini açın. Servis sağlığını `docker compose ps`, backend günlüklerini `docker compose logs api` ile kontrol edin. Yığını `docker compose down` ile durdurun; bu komut projeye ait SQLite cache volume'ünü korur. Canlı Azure DevOps verisi için yok sayılan kök `.env` dosyasında `DEVOPS_FIXTURE_MODE=0`, `AZURE_DEVOPS_ORG_URL` ve salt okunur `AZURE_DEVOPS_PAT` değerlerini ayarlayın. Dağıtılan `.env.example` dosyasında placeholder değer bulunmaz.

Servis ve ortam ayrıntıları için [Docker kurulum kılavuzuna](docs/docker-setup.tr.md) bakın.

## Azure DevOps salt okunur PAT

Görüntülemek istediğiniz Azure DevOps verileri için gerekli salt okunur kapsamlarla bir PAT oluşturun. PAT'i yalnızca kök `.env` dosyası üzerinden backend için `AZURE_DEVOPS_PAT` olarak yapılandırın. Frontend değişkenlerine, kaynak dosyalarına, shell geçmişine, günlük kayıtlarına, ekran görüntülerine, hata raporlarına veya commit'lere koymayın. `.env` dosyasını Git'e eklemeyin; Git tarafından yok sayılır. Uygulama Azure DevOps kayıtlarını oluşturmaz, değiştirmez, onaylamaz, tetiklemez veya silmez.

## Ortam değişkenleri

| Değişken | Amacı |
| --- | --- |
| `AZURE_DEVOPS_ORG_URL` | Azure DevOps organizasyon URL'si; ör. `https://dev.azure.com/<organization>` |
| `AZURE_DEVOPS_PAT` | Yalnız backend'de kullanılan, en az yetkili salt okunur PAT |
| `DEVOPS_FIXTURE_MODE` | Deterministik çevrimdışı demo verisi için varsayılan `1`; yalnız canlı Azure DevOps için `0` yapın |
| `DEVOPS_DATA_DIR` | Backend SQLite veri dizini; Compose değeri `/data` |
| `SYNC_INTERVAL_SEC` | Arka plan eşitleme aralığı (saniye) |
| `DISABLE_BACKGROUND_SYNC` | Otomatik eşitlemeyi kapatmak için `1` yapın |
| `WEB_PORT` | Web servisi host portu; varsayılan `5174` |
| `VITE_API_BASE_URL` | Yerel geliştirmede frontend API yolu; varsayılan `/api` |

Dağıtılan şablon için [`.env.example`](.env.example) dosyasına bakın. Secret'ları `apps/web/.env` veya `VITE_*` değişkenlerine koymayın.

## Geliştirme ve test

Frontend, backend ve fixture E2E komutları için [geliştirme kılavuzuna](docs/development.tr.md) bakın. Kılavuz Linux/macOS shell ve Windows PowerShell adımlarını ayrı ayrı içerir. E2E orchestrator testleri sıralı çalıştırır ve sentetik fixture verisiyle restart/outage/recovery kontrollerini kapsar; PAT veya canlı Azure DevOps erişimi gerekmez.

## Proje yapısı

```text
apps/web/       React, TypeScript ve Vite kullanıcı arayüzü
services/api/   Flask API, Azure DevOps istemcisi, SQLite cache ve backend testleri
docs/           Kurulum, mimari, API davranışı ve özellik kılavuzları
scripts/        Çevrimdışı fixture E2E runner'ı ve sözleşme testleri
docker-compose.yml
```

## Güvenlik

API Compose ağı içinde kalmalıdır; güvenilmeyen ağlara doğrudan açmayın. En az yetkili salt okunur PAT kullanın ve istemci tarafı yapılandırmasından uzak tutun. Compose dosyası yerel geliştirme örneğidir; üretim dağıtımı veya güvenlik onayı değildir. Üretim kullanımından önce kimlik, secret yönetimi, TLS/ingress, ağ erişimi, izleme, yedekleme/saklama ve PAT politikası ayrıca incelenmelidir.

Şüpheli güvenlik açıklarını kimlik bilgileri veya istismar ayrıntılarıyla herkese açık issue'lara eklemek yerine repository sorumlusuna özel olarak bildirin.

## Lisans

Public Edition kök dizini MIT Lisansı ile dağıtılır. Bkz. [LICENSE](LICENSE). Lisans yalnızca sorumlusunun lisanslama yetkisi olan özgün OpenDevBoard katkıları için geçerlidir; üçüncü taraf bileşen ve varlıklar kendi koşullarına tabidir. [Üçüncü taraf bildirimlerine](docs/THIRD_PARTY_NOTICES.md) bakın.

## Katkıda bulunma

Katkılarınızı bekliyoruz. Değişiklik göndermeden önce ilgili frontend, backend ve fixture E2E kontrollerini çalıştırın; Azure DevOps salt okunur sözleşmesini koruyun, secret'ları repository dışında tutun ve davranış veya yapılandırma değiştiğinde kullanıcı dokümantasyonunu güncelleyin. Değişiklikleri odaklı tutun ve davranış değişikliklerine test ekleyin.

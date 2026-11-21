# Docker kurulumu

[English version](docker-setup.md) | [Türkçe](docker-setup.tr.md)

OpenDevBoard — Azure DevOps için Açık Kaynak Gösterge Paneli — kök dizindeki `docker-compose.yml` ile `web` ve `api` servislerini çalıştırır.

## Uygulamayı başlatma

Servisleri repository kökünden başlatın. Compose varsayılan olarak çevrimdışı fixture/demo modunu kullanır; `.env` dosyası veya Azure DevOps kimlik bilgileri gerekmez:

```sh
docker compose up --build -d
```

<http://localhost:5174> adresini açın. Servis sağlığını `docker compose ps`, backend günlüklerini `docker compose logs -f api` ile kontrol edin.

## Mimari

```text
Tarayıcı ──► web (nginx, host portu 5174)
             └── /api/* ──► api:5000 (yalnızca dahili Compose ağı)
                              └── /data altında SQLite cache
```

| Servis | Amacı | Host'a açılan port |
| --- | --- | --- |
| `web` | React frontend'ini sunar ve `/api` isteklerini vekil olarak iletir | Varsayılan `5174` |
| `api` | Flask API, salt okunur Azure DevOps istemcisi ve SQLite cache | Yalnızca dahili; 5000 portu host'a açılmaz |

Azure DevOps'a yalnızca backend bağlanır. Canlı mod için kök `.env` içinde `DEVOPS_FIXTURE_MODE=0`, `AZURE_DEVOPS_ORG_URL` ve `AZURE_DEVOPS_PAT` gerekir. En az yetkili, salt okunur PAT kullanın. Dağıtılan `.env.example` boş Azure ayarları içerir ve istek başlatmaz.

## Sık kullanılan komutlar

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f api
docker compose restart api
docker compose down
```

`docker compose down` isimli cache volume'ünü korur. Yerel önbelleği bilerek silmek istemiyorsanız `-v` eklemeyin.

## Portlar ve ortam

Frontend portu varsayılan olarak `5174`'tür ve `WEB_PORT` ile değiştirilebilir. API host'a açılmaz. İlgili backend ayarları `DEVOPS_DATA_DIR` (Compose varsayılanı `/data`), `SYNC_INTERVAL_SEC` (varsayılan `300`), `SYNC_DETAIL_WORKERS` (varsayılan `1`; ilk eşitlemeyi hızlandırmak için önerilen opt-in değeri `4`, üst sınır `8`), `SYNC_CHUNKED` (varsayılan `0`; `1` eşitlemeyi cache'in yanındaki geçici bir SQLite dosyasında hazırlar, bellek sabit kalır; eşitleme sürerken `/data` biriminde cache boyutunun yaklaşık 3 katı boş alan gerekir, POSIX dosya kilidi gerekir, Linux container'ı bunu sağlar (yerel Windows'ta çalışan backend `1` değerini `staging_unsupported_platform` ile reddeder, `0` ile çalışmayı sürdürür); alan yoksa eşitleme `insufficient_disk_space` ile durur ve mevcut cache'e dokunulmaz) ve otomatik eşitlemeyi kapatan `DISABLE_BACKGROUND_SYNC=1` değişkenleridir. Kök `.env` dosyasında ayarlayın; Compose bu dosyayı `api` container'ına geçirir, dosyayı düzenledikten sonra container'ı yeniden oluşturun (`docker compose up -d`). Şablon değerleri için `.env.example` dosyasına bakın.

Daha geniş context closure için `SYNC_CONTEXT_POLICY=budgeted` ayarını pozitif `SYNC_CONTEXT_MAX_ITEMS` ve `SYNC_CONTEXT_MAX_REQUESTS` değerleriyle birlikte açıkça etkinleştirin. Bu ayar yoksa 25.000 sabit sınır korunur. Sync başına HTTP attempt bütçesi WIQL, ana detay/probe, context, hollow ve scope reconciliation istekleriyle retry'ları da sayar. Ana detaylar bitmeden bütçe tükenirse partial snapshot yayımlanmadan hata oluşur. Closure veya reconciliation tamamlanamazsa sonuç `partial` kalır ve completion marker'ları ilerlemez. Ayrıntılar için [Veri eşitleme](data-sync.md) belgesine bakın.

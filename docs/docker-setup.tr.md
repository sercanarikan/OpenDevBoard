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

Frontend portu varsayılan olarak `5174`'tür ve `WEB_PORT` ile değiştirilebilir. API host'a açılmaz. İlgili backend ayarları `DEVOPS_DATA_DIR` (Compose varsayılanı `/data`), `SYNC_INTERVAL_SEC` (varsayılan `300`) ve otomatik eşitlemeyi kapatan `DISABLE_BACKGROUND_SYNC=1` değişkenleridir. Şablon değerleri için `.env.example` dosyasına bakın.

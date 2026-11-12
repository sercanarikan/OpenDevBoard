# Geliştirme

[English version](development.md) | [Türkçe](development.tr.md)

Bu kılavuz, OpenDevBoard Public Edition'ın geliştirme dosyalarını ve komutlarını açıklar. Uygulama iki servisten oluşur: React frontend'i (`web`) ve Flask API'si (`api`).

## Gereksinimler

- Git
- Frontend geliştirme için Node.js 22 ve npm
- Backend geliştirme için Python 3.12 ve `venv` modülü
- Tam yığın ve fixture E2E testleri için Docker Engine ve Docker Compose v2

## Ortamı yapılandırma

Varsayılan Compose kurulumu çevrimdışı fixture/demo modunda başlar; `.env`, Azure DevOps URL'si veya PAT gerekmez. Canlı veri için kök dizinde `.env` oluşturup `DEVOPS_FIXTURE_MODE=0`, `AZURE_DEVOPS_ORG_URL` ve en az yetkili salt okunur `AZURE_DEVOPS_PAT` değerlerini ayarlayın. `.env` dosyasını commit etmeyin ve PAT'i frontend değişkenlerine koymayın.

`.env.example` yalnızca çevrimdışı fixture varsayılanları ve boş Azure değişkenleri içerir.

## Frontend

Repository'deki `.nvmrc`, CI ile uyumlu Node.js 22.23.4 sürümünü sabitler. Linux ve macOS'ta nvm kullanıp repository kökünde `nvm install` ve `nvm use` çalıştırın. Windows'ta nvm-windows veya resmi Node.js kurucusuyla Node 22.23.4 kurun.

### Linux ve macOS

```sh
cd apps/web
npm ci
npm test
npm run build
npm run dev
```

### Windows PowerShell

```powershell
Set-Location apps/web
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

Geliştirme sunucusu `apps/web/vite.config.ts` yapılandırmasını kullanır; API temel yolu varsayılan olarak `/api`'dir.

## Backend

Python 3.12 sanal ortamı oluşturun ve backend gereksinimlerine CI test komutunun kullandığı iki paketi ekleyin.

### Linux ve macOS

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -c services/api/constraints.txt -r services/api/requirements.txt python-dateutil python-dotenv
.venv/bin/python -m unittest discover -s services/api -p 'test_*.py'
```

### Windows PowerShell

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -c services/api/constraints.txt -r services/api/requirements.txt python-dateutil python-dotenv
.\.venv\Scripts\python.exe -m unittest discover -s services/api -p 'test_*.py'
```

Yerel API geliştirme için repository kökünden `python services/api/run_backend.py` çalıştırın. API varsayılan olarak `127.0.0.1:5000` üzerinde dinler.

## Docker Compose

Repository kökünden çalıştırın:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

Windows PowerShell'de de aynı Docker Compose komutlarını kullanabilirsiniz.

Frontend <http://localhost:5174> adresindedir. Yığını durdurmak için `docker compose down` çalıştırın; cache volume'ünü korumak için `-v` eklemeyin. Ayrıntılar için [Docker kurulumuna](docker-setup.md) bakın.

## Testler

Tarayıcı kullanmadan E2E orchestrator sözleşmesini çalıştırın:

```sh
npm --prefix scripts run e2e:test
```

Windows PowerShell'de `npm.cmd --prefix scripts run e2e:test` kullanın.

Çevrimdışı fixture E2E akışını sıralı çalıştırın:

```sh
npm --prefix scripts run e2e
```

Windows PowerShell'de `npm.cmd --prefix scripts run e2e` kullanın.

Runner kendi yalıtılmış Compose projesini derleyip başlatır; API kesintisi/restart/recovery kontrolleri dahil sentetik fixture testlerini sıralı çalıştırır ve sonrasında yalnızca kendi container'larını durdurur. PAT veya canlı Azure DevOps erişimi gerekmez. Linux/macOS'ta script bağımlılıklarını `npm ci --prefix scripts`, Chromium'u `npm --prefix scripts exec -- playwright install chromium` ile kurun. Windows PowerShell'de `npm.cmd ci --prefix scripts` ve `npm.cmd --prefix scripts exec -- playwright install chromium` kullanın. Fixture volume'ü ve diğer Compose projeleri etkilenmez.

API imajı, yalıtılmış derleme sırasında Python paketlerini root olarak kurduğu için pip root-user uyarısı verebilir. Bu işlem host üzerine paket kurmaz. Yalnızca uyarıyı kaldırmak için runtime kullanıcısı ve SQLite volume izinleri değiştirilmemiştir; kullanıcı değişikliği ayrı bir izin ve dağıtım incelemesi gerektirir.

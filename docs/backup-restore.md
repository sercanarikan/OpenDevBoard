# Yedekleme ve geri yükleme

Yedekleri repository dışındaki, erişimi kısıtlı bir dizinde zaman damgalı arşivler olarak tutun. Mevcut yedekleri silmeyin veya üzerine yazmayın. Aşağıdaki komutlar repository kökünden çalıştırılır.

## Neler yedeklenir / yedeklenmez

| Yedeklenir | Yedeklenmez |
|---|---|
| Kaynak kod, testler, Docker/Compose, `*.example`, dokümanlar | `node_modules`, `dist`, `.venv`, `__pycache__` |
| | `.env` (**PAT/secret**), `*.db` (cache) |

## Kaynak yedeği

### Linux ve macOS

```bash
set -euo pipefail
ts=$(date -u +%Y%m%d-%H%M%S)
backup_root="$HOME/opendevboard-backups"
mkdir -p "$backup_root"
archive="$backup_root/OpenDevBoard-$ts.tar.gz"
tar -czf "$archive" \
  --exclude='./.git' --exclude='./.venv' --exclude='*/node_modules' \
  --exclude='*/dist' --exclude='*/__pycache__' --exclude='./.env' \
  --exclude='*.db' .
tar -tzf "$archive" >/dev/null
shasum -a 256 "$archive" | tee "$archive.sha256"
git bundle create "$backup_root/OpenDevBoard-$ts.bundle" --all
```

Arşivi benzersiz bir geçici dizine açıp `tar -tzf` ile içeriğini doğrulayın. Geri yüklenen kaynakta frontend için `npm ci --prefix apps/web`, `npm --prefix apps/web test` ve `npm --prefix apps/web run build` komutlarını çalıştırın. Backend kurulumu için [geliştirme kılavuzunu](development.md) izleyin.

### Windows PowerShell

```powershell
$ErrorActionPreference = 'Stop'
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $HOME 'opendevboard-backups'
$stage = Join-Path $backupRoot "OpenDevBoard-$timestamp"
$archive = Join-Path $backupRoot "OpenDevBoard-$timestamp.zip"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# Robocopy 1/2 kodları başarılı kopyalama olarak değerlendirilir.
robocopy . $stage /E /R:2 /W:1 /XD .git .venv node_modules dist __pycache__ /XF .env *.db
if ($LASTEXITCODE -gt 7) { throw "Robocopy failed with exit code $LASTEXITCODE" }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive
Remove-Item -LiteralPath $stage -Recurse
Get-FileHash -Algorithm SHA256 $archive | Format-List

# Git geçmişini isterseniz ayrı bir bundle olarak saklayın.
$bundle = Join-Path $backupRoot "OpenDevBoard-$timestamp.bundle"
git bundle create $bundle --all
```

Arşivi doğrulamak için `Expand-Archive` ile benzersiz bir geçici dizine açın. Kaynak yedeğinde `.env`, PAT veya cache veritabanı bulunmamalıdır. `.env` dosyasını arşivden geri yüklemeyin; gerekiyorsa secret'ları yerel backend ortamına yeniden girin.

## SQLite cache yedeği

Cache WAL modunda olabilir; çalışan serviste `.db` dosyasını doğrudan kopyalamayın. SQLite online backup API'sini kullanın. Komutlar mevcut Compose projesinin `api` servisini hedefler.

### Linux ve macOS

```bash
set -euo pipefail
ts=$(date -u +%Y%m%d-%H%M%S)
backup_root="$HOME/opendevboard-backups"
mkdir -p "$backup_root"
api_container=$(docker compose ps -q api)
test -n "$api_container"
docker exec "$api_container" python -c "import sqlite3; s=sqlite3.connect('file:/data/devops_cache.db?mode=ro',uri=True); d=sqlite3.connect('/tmp/opendevboard-cache.db'); s.backup(d); d.close(); c=sqlite3.connect('/tmp/opendevboard-cache.db'); print(c.execute('PRAGMA integrity_check').fetchone()[0])"
docker cp "$api_container:/tmp/opendevboard-cache.db" "$backup_root/opendevboard-cache-$ts.db"
docker exec "$api_container" rm -f /tmp/opendevboard-cache.db
shasum -a 256 "$backup_root/opendevboard-cache-$ts.db" | tee "$backup_root/opendevboard-cache-$ts.db.sha256"
```

### Windows PowerShell

```powershell
$ErrorActionPreference = 'Stop'
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $HOME 'opendevboard-backups'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$apiContainer = (docker compose ps -q api).Trim()
if (-not $apiContainer) { throw 'Compose api service is not running.' }
$sqliteBackup = "import sqlite3; s=sqlite3.connect('file:/data/devops_cache.db?mode=ro',uri=True); d=sqlite3.connect('/tmp/opendevboard-cache.db'); s.backup(d); d.close(); c=sqlite3.connect('/tmp/opendevboard-cache.db'); print(c.execute('PRAGMA integrity_check').fetchone()[0])"
docker exec $apiContainer python -c $sqliteBackup
if ($LASTEXITCODE -ne 0) { throw 'SQLite online backup failed.' }
$dbFile = Join-Path $backupRoot "opendevboard-cache-$timestamp.db"
docker cp "${apiContainer}:/tmp/opendevboard-cache.db" $dbFile
docker exec $apiContainer rm -f /tmp/opendevboard-cache.db
Get-FileHash -Algorithm SHA256 $dbFile | Format-List
```

Beklenen bütünlük sonucu `ok` olmalıdır. Cache sentetik fixture modunda yeniden üretilebilir. Cache'i geri yüklemeniz gerekiyorsa önce yalnız bu repository'nin `api` servisini durdurun, yedek dosyasını aynı Compose projesinin `api` servisine `/data/devops_cache.db` olarak yerleştirin ve servisi yeniden başlatın. Compose project adınız farklıysa kendi proje volume'ünüzü hedeflediğinizi doğrulayın. Başka projelerin volume'lerine dokunmayın. `docker compose down -v` çalıştırmayın; volume'ü siler.

# Development

[English](development.md) | [Türkçe](development.tr.md)

This guide covers the files and commands included in the OpenDevBoard Public Edition — Open-Source Dashboard for Azure DevOps. The application has two services: a React frontend (`web`) and a Flask API (`api`).

## Requirements

- Git
- Node.js 22 and npm for frontend development
- Python 3.12 and its `venv` module for backend development
- Docker Engine with Docker Compose v2 for running the complete stack and fixture E2E tests

## Configure the environment

The default Compose setup starts in offline fixture/demo mode and requires no `.env`, Azure DevOps URL, or PAT. For live data, create a root `.env` and set `DEVOPS_FIXTURE_MODE=0`, `AZURE_DEVOPS_ORG_URL`, and a minimally scoped, read-only `AZURE_DEVOPS_PAT`. Never commit `.env` or expose the PAT to frontend variables.

`.env.example` contains only offline fixture defaults and empty Azure variables.

## Frontend

Repository `.nvmrc` pins Node.js 22.23.4 (the CI-compatible Node 22 line). On Linux and macOS, use nvm and run `nvm install` and `nvm use` from the repository root. On Windows, use nvm-windows or the official Node.js installer and select Node 22.23.4.

### Linux and macOS

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

The development server uses the Vite configuration in `apps/web/vite.config.ts`; the API base path defaults to `/api`.

## Backend

Create a Python 3.12 virtual environment and install the backend requirements plus the two packages used by the CI test command.

### Linux and macOS

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

For local API development, run `python services/api/run_backend.py` from the repository root. The API listens on `127.0.0.1:5000` by default.

## Docker Compose

From the repository root:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

Windows PowerShell can use the same Docker Compose commands from the repository root.

The frontend is available at <http://localhost:5174>. Stop the stack with `docker compose down`; omit `-v` to preserve the cache volume. See [Docker setup](docker-setup.md).

## Tests

Run the E2E orchestrator contract without a browser:

```sh
npm --prefix scripts run e2e:test
```

On Windows PowerShell, use `npm.cmd --prefix scripts run e2e:test`.

Run the offline fixture E2E flow sequentially:

```sh
npm --prefix scripts run e2e
```

On Windows PowerShell, use `npm.cmd --prefix scripts run e2e`.

The runner builds and starts its own isolated Compose project, runs the sequential synthetic fixture suite including API outage/restart/recovery checks, and stops only its own containers afterward. It does not need a PAT or live Azure DevOps access. On Linux/macOS, install scripts dependencies with `npm ci --prefix scripts` and Chromium with `npm --prefix scripts exec -- playwright install chromium`. On Windows PowerShell, use `npm.cmd ci --prefix scripts` and `npm.cmd --prefix scripts exec -- playwright install chromium`. The fixture volume and other Compose projects are left untouched.

The API image installs Python packages as root during its isolated build, so pip may report its root-user warning. This does not install packages on the host. The runtime user and SQLite volume permissions have not been changed merely to remove the warning; switching users requires a separate permissions and deployment review.

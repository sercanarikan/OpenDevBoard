# Docker setup

[English](docker-setup.md) | [Türkçe](docker-setup.tr.md)

OpenDevBoard — Open-Source Dashboard for Azure DevOps — uses the root `docker-compose.yml` to run two services: `web` and `api`.

## Start the application

Start the services from the repository root. Compose defaults to offline fixture/demo mode, so no `.env` or Azure DevOps credentials are needed:

```sh
docker compose up --build -d
```

Open <http://localhost:5174>. Check service health with `docker compose ps`; view backend logs with `docker compose logs -f api`.

## Architecture

```text
Browser ──► web (nginx, host port 5174)
             └── /api/* ──► api:5000 (internal Compose network)
                              └── SQLite cache in /data
```

| Service | Purpose | Host exposure |
| --- | --- | --- |
| `web` | Serves the React frontend and proxies `/api` requests | `5174` by default |
| `api` | Flask API, Azure DevOps read-only client, and SQLite cache | Internal only; port 5000 is not published |

The backend is the only service that connects to Azure DevOps. Live mode requires `DEVOPS_FIXTURE_MODE=0`, `AZURE_DEVOPS_ORG_URL`, and `AZURE_DEVOPS_PAT` in the root `.env`. Use a minimally scoped, read-only PAT. The shipped `.env.example` contains empty Azure settings and does not trigger requests.

## Common commands

```sh
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f api
docker compose restart api
docker compose down
```

`docker compose down` preserves the named cache volume. Do not add `-v` unless you intentionally want to delete local cached data.

## Ports and environment

The frontend port defaults to `5174` and can be changed with `WEB_PORT`. The API is not published to the host. Relevant backend settings include `DEVOPS_DATA_DIR` (Compose default `/data`), `SYNC_INTERVAL_SEC` (default `300`), and `DISABLE_BACKGROUND_SYNC` (`1` disables automatic synchronization). See `.env.example` for the available template values.

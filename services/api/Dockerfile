# DevOpsFlow API (Flask + SQLite sync). Build context: services/api
#
#   --target test        backend unit tests (includes test_*.py; no network/Azure/.env needed)
#   (default / production) runtime image, last stage: no test_*.py files in any layer
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1
ENV PORT=5000

WORKDIR /app

# curl is used by the container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt constraints.txt .
RUN pip install --no-cache-dir -c constraints.txt -r requirements.txt python-dateutil python-dotenv

# Test image: every source file, including test_*.py
FROM base AS test

# Application code lives in /app/api (same layout as before the monorepo move)
COPY . /app/api/

WORKDIR /app/api

CMD ["python", "-m", "unittest", "discover", "-s", "/app/api", "-p", "test_*.py", "-v"]

# Staging copy of the application without test files. Only the production stage
# copies from it, so the test files never reach a layer of the final image.
FROM base AS app-src

COPY . /app/api/
RUN find /app/api -name "test_*.py" -delete

# Production (last stage: default target of docker build / docker compose build)
FROM base AS production

EXPOSE 5000

COPY --from=app-src /app/api /app/api

WORKDIR /app/api

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:5000/api/health || exit 1

CMD ["python", "run_backend.py"]

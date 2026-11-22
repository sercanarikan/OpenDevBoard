# OpenDevBoard frontend

[English](README.md) | [Türkçe](README.tr.md)

The frontend is a React, TypeScript, and Vite application. From the repository root, use Node.js 22 (see `.nvmrc`), then run:

```sh
cd apps/web
npm ci
npm test
npm run lint
npm run build
npm run dev
```

The Vite development server uses `vite.config.ts`; the API base path defaults to `/api`. The API is a separate Flask service. Do not put credentials in frontend configuration or `VITE_*` variables.

For backend setup, Windows PowerShell commands, and offline fixture E2E tests, see the [development guide](../../docs/development.md). For Compose, see the [Docker guide](../../docs/docker-setup.md).

# OpenDevBoard frontend

[English](README.md) | [Türkçe](README.tr.md)

Frontend, React, TypeScript ve Vite uygulamasıdır. Repository kökünden Node.js 22 kullanın (`.nvmrc` dosyasına bakın), ardından şu komutları çalıştırın:

```sh
cd apps/web
npm ci
npm test
npm run lint
npm run build
npm run dev
```

Vite geliştirme sunucusu `vite.config.ts` kullanır; API temel yolu varsayılan olarak `/api`'dir. API ayrı bir Flask servisidir. Kimlik bilgilerini frontend yapılandırmasına veya `VITE_*` değişkenlerine koymayın.

Backend kurulumu, Windows PowerShell komutları ve çevrimdışı fixture E2E testleri için [geliştirme kılavuzuna](../../docs/development.tr.md), Compose için [Docker kılavuzuna](../../docs/docker-setup.tr.md) bakın.

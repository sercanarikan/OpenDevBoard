# React + TypeScript + Vite

[English](README.md) | [Türkçe](README.tr.md)

Bu şablon, HMR ve bazı Oxlint kurallarıyla React'i Vite üzerinde çalıştırmak için gereken temel kurulumu sağlar.

Şu anda iki resmi eklenti bulunur:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react), [Oxc](https://oxc.rs) kullanır.
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc), [SWC](https://swc.rs/) kullanır.

## React Compiler

Derleme ve geliştirme performansına etkisi nedeniyle React Compiler bu şablonda etkin değildir. Eklemek için [kurulum dokümantasyonuna](https://react.dev/learn/react-compiler/installation) bakın.

## Oxlint yapılandırmasını genişletme

Üretim uygulaması geliştiriyorsanız `oxlint-tsgolint` yükleyip `.oxlintrc.json` dosyasını düzenleyerek tür bilgisi kullanan lint kurallarını etkinleştirmenizi öneririz:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

Kural ve kategori listeleri için [Oxlint kurallarına](https://oxc.rs/docs/guide/usage/linter/rules) bakın.

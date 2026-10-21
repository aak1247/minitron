# Karvis AI with Minitron

This example adapts the existing `karvis-electron` project for a Windows NSIS build. It keeps Karvis AI branding, packages its `assets/` as extra resources, and corrects the packaged Electron entry to `dist/main/index.js`. Normal Electron and Node.js development commands remain unchanged.

The example uses electron-builder 24.13.3, supported by the adapter. The adapter package is not published to npm yet:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-electron-builder-0.2.0.tgz
```

Copy `electron-builder.config.cjs` into `karvis-electron/`. It extends the existing `build` object from `package.json`, retaining its `files`, app identity, and icon settings, and adds `extraResources`, `extraMetadata`, and NSIS options. `asar` must remain enabled. The Minitron launcher icon uses Karvis's existing `assets/icon.png`.

Install Minitron launcher v0.2.0 into the project, then build from the `karvis-electron` directory so relative paths resolve from the project root:

```powershell
Invoke-WebRequest https://github.com/aak1247/minitron/releases/download/v0.2.0/install.ps1 -OutFile "$env:TEMP/minitron-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP/minitron-install.ps1" -Version v0.2.0 -InstallDir ./.minitron
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/karvis/manifest.json"
npm run build
npx electron-builder --config electron-builder.config.cjs --win nsis
```

`extraResources` puts `assets/` beside `app.asar`, where Karvis loads its packaged icons. Minitron app updates include `app.asar` and `app.asar.unpacked`; they do not include `extraResources`. Keep updateable files inside the ASAR or distribute external resource changes separately. NSIS handles installation and installer upgrades; `electron-updater` is not automatically connected to Minitron's manifest.

This adapter currently supports Windows NSIS. Linux packaging has an `afterPack` path, but the full installer flow has not been confirmed; macOS packaging through the adapter is not supported. The Minitron launcher binaries remain available for Windows x64, Linux x64, and macOS x64 / arm64.

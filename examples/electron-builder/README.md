# electron-builder example

This example assumes an existing app whose main file is `dist/main.js`, with icons at `build/app.ico`, `build/installer.ico`, `build/uninstaller.ico`, and `build/minitron-icon.png`, plus any files referenced by `resources/`. Keep the app's existing `files`, `extraResources`, `asarUnpack`, and NSIS settings when adapting the configuration. Minitron requires `asar: true`.

Copy this folder into the app project at `examples/electron-builder/`, or change the `--config` path in the build script to match where you place it. Run the build from the app project root.

Install the adapter and electron-builder in the app project:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-electron-builder-0.2.0.tgz
```

Add this script to the app's `package.json`:

```json
{
  "scripts": {
    "dist:windows": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --win nsis"
  }
}
```

Set the launcher and update manifest, then build:

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/manifest.json"
npm run dist:windows
```

Install launcher v0.2.0 into `.minitron` with the [Windows install script](https://github.com/aak1247/minitron/releases/download/v0.2.0/install.ps1). Run the command from the app project root. The configured `extraResources` are installed with NSIS; Minitron's app update archive contains the ASAR and its unpacked files.

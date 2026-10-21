# Karvis AI with Minitron

This example adapts the existing `karvis-electron` build configuration without changing the Karvis project. It retains the app identity, files, icon and `assets/` resources, and selects Windows NSIS, Linux DEB/RPM, and macOS DMG/PKG targets. The Minitron and app icons use Karvis's existing `assets/icon.png`.

Install the adapter and electron-builder 24.13.3 in the Karvis project:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-electron-builder-0.3.0.tgz
```

Copy `electron-builder.config.cjs` into `karvis-electron/`. The config extends `build` from the app's `package.json`, keeps the packaged entry at `dist/main/index.js`, and preserves existing `files`, `extraResources`, `extraMetadata`, and platform settings. Keep `asar` enabled.

Install the v0.3.0 launcher for the target platform and architecture. Build from the `karvis-electron` project directory:

Use the platform install script in the [Minitron install guide](../../README.md#install) to place the launcher in `.minitron`.

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/karvis/manifest.json"
npm run build
npx electron-builder --config electron-builder.config.cjs --win nsis
```

Linux DEB/RPM packages need a real maintainer email. The example uses `MINITRON_MAINTAINER` when set, or the email in `package.json`'s `author` field. If neither provides an email, set the environment variable before building Linux packages:

```sh
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
export MINITRON_MANIFEST_URL="https://updates.example.com/karvis/manifest.json"
export MINITRON_MAINTAINER="Your Name <you@company.com>"
npx electron-builder --config electron-builder.config.cjs --linux --x64
```

Linux DEB/RPM packages need a homepage URL. Set `homepage` in the app's `package.json`, or let electron-builder infer it from the Git origin.

Install the DEB with `sudo apt install ./release/*.deb` or the RPM with `sudo dnf install ./release/*.rpm`. Package upgrades stop the previous app and retain its runtime registration; remove with `sudo apt remove <package>` or `sudo dnf remove <package>` to stop and unregister it.

Build macOS x64 and arm64 separately with the matching v0.3.0 launcher. Existing electron-builder signing and notarization settings can be used for these builds; provide your own Apple signing identity and notarization credentials when required.

```sh
export MINITRON_MANIFEST_URL="https://updates.example.com/karvis/manifest.json"
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
npx electron-builder --config electron-builder.config.cjs --mac --x64

export MINITRON_LAUNCHER="$PWD/.minitron/minitron" # install the arm64 launcher at this path before building
npx electron-builder --config electron-builder.config.cjs --mac --arm64
```

Open a DMG and drag Karvis AI to Applications, or install the PKG. A PKG upgrade stops the running app before replacing it. To uninstall, run `"/Applications/Karvis AI.app/Contents/Resources/minitron-uninstall.command"` from Terminal, then remove Karvis AI from Applications. Dragging the app to Trash does not run the script.

`assets/` is installed beside `app.asar`, but Minitron app updates contain only `app.asar` and `app.asar.unpacked`. Keep updateable files in ASAR or distribute external resource changes separately. `electron-updater` is not automatically connected to the Minitron manifest.

For the full platform overview, see the [adapter guide](../../packages/electron-builder/README.md) and [general example](../electron-builder/README.md).

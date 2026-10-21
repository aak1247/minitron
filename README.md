# minitron

**Smaller Electron packages, shared runtime.**

**English** | [简体中文](README.zh-CN.md) · [Downloads](https://github.com/aak1247/minitron/releases/latest)

Minitron packages Electron apps separately from their runtime. Your app ships with a small native launcher and reuses the same Electron installation as other apps using that version.

- App-only ASAR packages, including native modules.
- Shared runtimes with resumable downloads and automatic cleanup.
- Background updates and rollback to the previous app version.
- English and Chinese, selected from the system display language.

Available for **Windows x64, Linux x64, and macOS Intel / Apple Silicon**.

![minitron launcher](docs/images/launcher-en.png)

## Quick start

Run these commands from your existing Electron project. Skip the build step if the app is already compiled.

```sh
npm install --save-dev minitron-builder
npm run build
npx minitron-builder
```

The CLI reads your existing `electron-builder` config or `package.json` `build` field, then downloads the matching Minitron launcher. It uses your normal `appId`, `productName`, icon, files, `extraResources`, `asarUnpack`, and installer settings. Electron development stays unchanged.

Here is a minimal three-platform `package.json` configuration:

```json
{
  "homepage": "https://example.com/my-app",
  "author": { "name": "Example", "email": "packaging@example.com" },
  "build": {
    "appId": "com.example.desktop",
    "productName": "Example Desktop",
    "asar": true,
    "directories": { "output": "release" },
    "win": { "target": ["nsis"], "icon": "build/app.ico" },
    "linux": { "target": ["deb", "rpm"], "icon": "build/app.png" },
    "mac": { "target": ["dmg", "pkg"], "icon": "build/app.png" }
  }
}
```

`npx minitron-builder` targets the current platform by default. Select another package format when needed:

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Build macOS x64 and arm64 packages separately. Linux DEB/RPM builds also need a `homepage` and a real maintainer email in your package metadata or Linux build settings. Output goes to `build.directories.output`, or to `dist` if no output directory is configured.

No update server is needed for the first launch: the installed app downloads its shared Electron runtime from the official Electron distribution. You can add app updates from a manifest later; see the [update guide](docs/usage.md#publishing-updates). On macOS, run the included `minitron-uninstall.command` before deleting the app.

## Package size

v0.3.0, using the included example and Electron 32.2.0. Downloads are compressed; other columns show uncompressed file sizes.

| Platform | Launcher download | Launcher | Example app | Electron runtime |
|---|---:|---:|---:|---:|
| Windows x64 | [5.20 MiB](https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-v0.3.0-windows-x64.zip) | 9.67 MiB | 9.68 MiB | 264.74 MiB |
| Linux x64 | [6.53 MiB](https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-v0.3.0-linux-x64.tar.gz) | 13.27 MiB | 13.27 MiB | 264.98 MiB |
| macOS Intel | [5.31 MiB](https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-v0.3.0-macos-x64.tar.gz) | 9.74 MiB | 9.75 MiB | 246.06 MiB |
| macOS Apple Silicon | [5.14 MiB](https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-v0.3.0-macos-arm64.tar.gz) | 8.47 MiB | 8.48 MiB | 239.90 MiB |

The example app includes the launcher, configuration and app resources; its shared runtime is separate. The example app update ZIP is **8.22 KiB**. Exact byte counts are available in [sizes.json](https://github.com/aak1247/minitron/releases/download/v0.3.0/sizes.json).

Karvis AI 2.0.0 on Windows (Electron 28.3.3, NSIS): **77.34 MiB → 10.56 MiB**, about **86% smaller**. The shared runtime is separate and downloads once on first launch.

Karvis AI 2.0.0 installers on Linux and macOS (Electron 28.3.3, shared runtime downloaded separately):

| Platform | Formats | Installer sizes |
|---|---|---:|
| Linux x64 | DEB / RPM | 7.65 / 7.67 MiB |
| macOS Intel | PKG / DMG | 12.79 / 14.24 MiB |
| macOS Apple Silicon | PKG / DMG | 12.55 / 13.98 MiB |

## Advanced use

For portable app directories or separate launcher installation, see the [packaging guide](docs/usage.md#packaging-an-app). You can also install the launcher directly from a [prebuilt release](https://github.com/aak1247/minitron/releases/latest).

Linux requires a desktop environment with glibc 2.35+, fontconfig, X11 or Wayland, and xkbcommon. On Ubuntu 22.04+, launcher dependencies can be installed with `sudo apt-get install libfontconfig1 libxkbcommon0 libxkbcommon-x11-0 libx11-xcb1 libxcursor1 libxi6`; Electron also needs GTK3, notifications, NSS, audio and GBM libraries.

See the [copyable electron-builder example](examples/electron-builder/README.md), the [Karvis integration example](examples/karvis/README.md), or the [usage guide](docs/usage.md) for advanced configuration and update publishing.

The launcher follows the system display language: Simplified Chinese for Chinese systems, English otherwise. Override it with `MINITRON_LANG=en`, `zh` or `auto`.

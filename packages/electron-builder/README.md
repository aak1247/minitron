# @minitron/electron-builder

Package an existing Electron app with the Minitron launcher through electron-builder. Your app's normal Electron and Node.js development workflow stays the same; Minitron changes apply when the packaged app starts through its launcher.

The adapter currently supports Windows NSIS packaging. The Linux `afterPack` path is available, but the complete installer flow has not been confirmed. macOS packaging through this adapter is not supported yet. The Minitron launcher itself remains available for Windows x64, Linux x64, and macOS x64 / arm64.

## Install

The package is not published to npm yet. Install the v0.2.0 release tarball and the supported electron-builder version:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-electron-builder-0.2.0.tgz
```

The adapter requires Minitron launcher v0.2.0 or newer. On Windows, install that launcher into your project:

```powershell
Invoke-WebRequest https://github.com/aak1247/minitron/releases/download/v0.2.0/install.ps1 -OutFile "$env:TEMP/minitron-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP/minitron-install.ps1" -Version v0.2.0 -InstallDir ./.minitron
```

## Configure electron-builder

Wrap your existing electron-builder configuration with `withMinitron`:

```js
const { withMinitron } = require("@minitron/electron-builder");

module.exports = withMinitron(
  {
    appId: "com.example.desktop",
    productName: "Example Desktop",
    asar: true,
    // Keep your existing files, resources, ASAR, icon, and installer options here.
  },
  {
    launcherPath: process.env.MINITRON_LAUNCHER,
    manifestUrl: process.env.MINITRON_MANIFEST_URL,
    iconPath: "build/minitron-icon.png",
  },
);
```

`launcherPath` and `manifestUrl` are required, and `asar` must be enabled. `iconPath` is a project-relative PNG copied into the app's resources directory. If omitted, the adapter looks for a PNG among the configured app icons. Run electron-builder from the app project root so project-relative paths resolve as expected. You can set `projectDir` when the app root differs from the current working directory, and can also set `runtimeVersion`, `manifestPublicKey`, and `allowLocalhostHttp`; HTTPS is required unless localhost HTTP is explicitly enabled.

The wrapper retains your existing `files`, `extraResources`, `asarUnpack`, icons, shortcuts, and NSIS install or uninstall options. It adds the Minitron lifecycle include to `nsis.include` and chains your existing `afterPack` hook.

Add a build script and set the two environment variables before building:

```json
{
  "scripts": {
    "dist:windows": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --win nsis"
  }
}
```

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/manifest.json"
npm run dist:windows
```

See the [copyable configuration](https://github.com/aak1247/minitron/tree/main/examples/electron-builder/README.md) and the [Karvis integration example](https://github.com/aak1247/minitron/tree/main/examples/karvis/README.md).

## Updates and packaged resources

NSIS distributes and upgrades the installed package. Minitron app updates use the configured manifest and update `app.asar` plus `app.asar.unpacked`. Files copied through `extraResources` are included in the installer, but are not included in Minitron's app update archive; use ASAR resources for files that must change with an app update, or update external resources separately.

`electron-updater` is not automatically integrated with Minitron. Use the Minitron manifest for Minitron app updates.

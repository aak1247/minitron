# electron-builder example

This configuration wraps an existing app. Keep its files, `extraResources`, `asarUnpack`, icons and installer settings. Minitron requires `asar: true`. The example uses electron-builder 24.13.3 and the v0.3.0 adapter release.

The app project should provide `build/app.ico`, `build/installer.ico`, and `build/uninstaller.ico` for Windows; `build/app.png` for Linux and macOS; and `build/minitron-icon.png` for Minitron. electron-builder can generate the macOS icon from the PNG. The example assumes the app entry is `dist/main.js` and app-owned resources live under `resources/`.

Install the adapter in the app project:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-electron-builder-0.3.0.tgz
```

Install the matching Minitron launcher with the [platform install script](../../README.md#install), then set `MINITRON_LAUNCHER` to its path.

The config selects Windows NSIS, Linux DEB/RPM, and macOS DMG/PKG. For Linux, set `MINITRON_MAINTAINER` to an actual maintainer email, for example `Your Name <you@company.com>`. The config requires it for Linux builds; Windows and macOS builds do not need it.

Linux DEB/RPM metadata also needs a homepage URL. electron-builder reads `homepage` from the app's `package.json` or can infer it from the Git origin; if you build from a snapshot without `.git`, set `homepage` explicitly.

Add platform build commands to the app's `package.json`:

```json
{
  "scripts": {
    "dist:windows": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --win nsis",
    "dist:linux": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --linux --x64",
    "dist:mac:x64": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --mac --x64",
    "dist:mac:arm64": "electron-builder --config examples/electron-builder/electron-builder.config.cjs --mac --arm64"
  }
}
```

Run from the app project root and select a launcher that matches the build platform and architecture. On Windows:

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/manifest.json"
npm run dist:windows
```

On Linux, use the v0.3.0 Linux launcher:

```sh
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
export MINITRON_MANIFEST_URL="https://updates.example.com/manifest.json"
export MINITRON_MAINTAINER="Your Name <you@company.com>"
npm run dist:linux
```

On macOS, build x64 and arm64 separately, setting the corresponding v0.3.0 launcher before each command:

```sh
export MINITRON_MANIFEST_URL="https://updates.example.com/manifest.json"
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
npm run dist:mac:x64

export MINITRON_LAUNCHER="$PWD/.minitron/minitron" # install the arm64 launcher at this path before building
npm run dist:mac:arm64
```

Install Windows output with its NSIS installer, Debian output with `sudo apt install ./release/*.deb`, or RPM output with `sudo dnf install ./release/*.rpm`. Open a DMG and drag the app to Applications, or install the PKG. Launch the app normally; Minitron downloads the required runtime on first start and uses the manifest for app updates.

NSIS uninstall stops the Windows app and unregisters it. Linux package-manager upgrades stop the prior app and keep its runtime registration; remove with `sudo apt remove <package>` or `sudo dnf remove <package>` to stop and unregister it. A PKG upgrade stops the running app before replacing it. To uninstall a macOS app, run `"/Applications/Example Desktop.app/Contents/Resources/minitron-uninstall.command"` in Terminal, then remove the app from Applications. Dragging the app to Trash does not run the uninstaller.

App updates include `app.asar` and `app.asar.unpacked`; files copied with `extraResources` are installed with the package but are not part of the Minitron app update archive.

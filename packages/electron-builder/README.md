# minitron-builder

Build an existing Electron app with its normal electron-builder settings and a small Minitron launcher. App development stays the same; the shared Electron runtime is downloaded on the user's first launch.

## Quick start

From your Electron project, install the npm package, build your app, then run the CLI:

```sh
npm install -D minitron-builder
npm run build
npx minitron-builder
```

Skip `npm run build` when your app is already compiled. The CLI reads the existing electron-builder configuration or `package.json` `build` field and fetches a launcher for the selected platform and architecture. No update server is needed to launch the app for the first time.

Minitron requires `asar: true`. Keep your existing `appId`, `productName`, app icons, `files`, `extraResources`, `asarUnpack`, and installer settings. For example:

```json
{
  "homepage": "https://example.com/my-app",
  "author": { "name": "Example", "email": "packaging@example.com" },
  "build": {
    "appId": "com.example.desktop",
    "productName": "Example Desktop",
    "asar": true,
    "win": { "target": ["nsis"], "icon": "build/app.ico" },
    "linux": { "target": ["deb", "rpm"], "icon": "build/app.png" },
    "mac": { "target": ["dmg", "pkg"], "icon": "build/app.png" }
  }
}
```

The default target is the current platform. Choose targets explicitly when needed:

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Build macOS x64 and arm64 separately. Linux DEB/RPM builds require a `homepage` and a real maintainer email in package metadata or Linux settings. Artifacts go to `build.directories.output`, or `dist` when no output directory is configured.

## Install and updates

Install Windows packages with NSIS, DEB packages with `apt`, RPM packages with `dnf` or `rpm`, and macOS packages with DMG or PKG. Start the app from its normal shortcut or Applications folder. Minitron downloads the matching official Electron runtime on first launch.

An app update manifest is optional. To publish app updates, configure a manifest URL and follow the [update guide](../../docs/usage.md#publishing-updates). Minitron update archives contain `app.asar` and `app.asar.unpacked`; `extraResources` are included in the installer but not in those app update archives. `electron-updater` is not automatically connected to the Minitron manifest.

NSIS and Linux package managers handle their normal upgrade and uninstall lifecycle. A PKG upgrade stops the old app before replacing it. On macOS, run `Contents/Resources/minitron-uninstall.command` in Terminal before deleting the app; dragging it to Trash does not run the command. DMG installs do not have a package-manager uninstall hook.

For portable app directories or manual launcher installation, see the [packaging guide](../../docs/usage.md#packaging-an-app) and [prebuilt releases](https://github.com/aak1247/minitron/releases/latest). For a copyable project example, see [examples/electron-builder](../../examples/electron-builder/README.md) and [examples/karvis](../../examples/karvis/README.md).

## Supported targets

- Windows x64: NSIS.
- Linux x64: DEB and RPM. AppImage and Snap are not supported by the installer integration.
- macOS: DMG and PKG. Build x64 and arm64 separately; Universal and Mac App Store targets are not supported.

The CLI selects the matching launcher automatically and requires launcher v0.4.0 or newer on all platforms. The lower-level `withMinitron` API is documented in the [adapter example](../../examples/electron-builder/README.md#low-level-adapter).

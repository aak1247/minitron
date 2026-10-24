# Minitron

Package Electron apps with a native launcher and a shared Electron runtime. Each installer contains your application code and launcher; compatible apps reuse the same runtime in the current user's cache.

**English** | [简体中文](README.zh-CN.md) · [Releases](https://github.com/aak1247/minitron/releases/latest) · [npm](https://www.npmjs.com/package/minitron-builder) · [Changelog](CHANGELOG.md)

## Quick start

Use **Node.js 22.12+** and an existing Electron project with electron-builder configuration. Run these commands on the operating system you are packaging for:

```sh
npm install --save-dev minitron-builder
npm run build
npx minitron-builder
```

Skip `npm run build` if your application is already compiled. The CLI reads your electron-builder configuration or the `build` field in `package.json`, then downloads the matching Minitron launcher.

Keep your existing application ID, name, icons, files and installer settings. **ASAR must be enabled.** For example, merge these fields into your existing configuration:

```json
{
  "build": {
    "appId": "com.example.desktop",
    "productName": "Example Desktop",
    "asar": true
  }
}
```

Artifacts are written to `build.directories.output`, or `dist` by default. For a complete configuration, including icons and Linux package metadata, use the [electron-builder example](examples/electron-builder/README.md).

## What users see

| Situation | Behavior |
|---|---|
| Required Electron version is not installed | Download, verify and install it; then open the application. |
| Runtime is already installed | Open the application directly, without a launcher window. |
| Application updates with the same Electron version | Reuse the installed runtime. |
| Application needs another Electron version | Reuse that version if cached; otherwise download it once. |
| Another Minitron application uses the same version | Share the runtime for the same user, OS and architecture. |
| One application is uninstalled | Keep runtimes still referenced by other installations. |

Sharing requires the **exact Electron version** and the same cache directory. Different user accounts have separate caches. Missing or damaged runtime files may require another download.

Interrupted downloads resume when the server supports ranges. Complete cached archives are verified and reused. The launcher window appears for downloads or preparation errors; routine launches go straight to the app.

![Launcher shown while downloading Electron](docs/images/launcher-en.png)

## Supported packages

| Platform | Architecture | Installer formats |
|---|---|---|
| Windows | x64 | NSIS |
| Linux | x64 | DEB, RPM |
| macOS | Intel, Apple Silicon | DMG, PKG; build each architecture separately |

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Linux packages need a `homepage` and a real maintainer email in application metadata or Linux build settings. The launcher needs a desktop environment and glibc 2.35+; see [platform requirements](docs/usage.md#platform-requirements) for dependencies. AppImage, Snap, macOS Universal and Mac App Store targets are not supported by the installer integration.

## Updates and compatibility

An update server is optional. Without one, the installed application obtains its required runtime from the official Electron distribution. To deliver application and launcher updates, configure a Minitron manifest using the [update guide](docs/usage.md#publishing-updates).

- Application updates are staged in the background and activated on a later launch, with rollback support.
- `electron-updater` is not automatically connected to Minitron manifests.
- `extraResources` ship in installers but are not included in Minitron application update archives.
- On macOS, run the included `Contents/Resources/minitron-uninstall.command` before deleting an application. Moving it to Trash does not run this cleanup.

To use the latest Minitron launcher in future builds, update the development dependency and rebuild your installer:

```sh
npm install --save-dev minitron-builder@latest
npx minitron-builder
```

Updating this dependency does not replace launchers in applications that are already installed.

## Documentation

- [Usage guide](docs/usage.md): portable packaging, configuration, runtime caches, troubleshooting and update publishing.
- [Builder reference](packages/electron-builder/README.md): installer integration and supported targets.
- [Karvis example](examples/karvis/README.md): package an existing application with native resources.
- [Package size measurements](docs/benchmarks.md): versioned measurements and their limits. Current release measurements are in [sizes.json](https://github.com/aak1247/minitron/releases/latest/download/sizes.json).
- [Contributing](CONTRIBUTING.md): local checks and release validation.

The launcher follows the system display language: Simplified Chinese for Chinese locales, English otherwise. Override it with `MINITRON_LANG=en`, `zh` or `auto`.

# @minitron/electron-builder

Use `withMinitron` to adapt an existing electron-builder configuration. Your regular Electron development and packaging settings remain in place; the adapter replaces the packaged Electron runtime with the Minitron launcher and adds installer lifecycle handling.

## Supported packages

- Windows x64 with NSIS; launcher v0.2.0 or newer.
- Linux x64 with DEB or RPM; launcher v0.3.0 or newer. AppImage and Snap are not supported. Set `linux.target` to `deb` and/or `rpm`; the adapter supplies both when `linux.target` is omitted.
- macOS with DMG or PKG; launcher v0.3.0 or newer. Build x64 and arm64 separately with the matching launcher. Universal and Mac App Store builds are not supported.

The package requires Node.js 22.12 or newer. The example below pins electron-builder 24.13.3.

## Install

The package is distributed as a GitHub release tarball:

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-electron-builder-0.3.0.tgz
```

Set `MINITRON_LAUNCHER` to the launcher for the target platform and architecture, and `MINITRON_MANIFEST_URL` to your HTTPS app-update manifest. Use the matching v0.3.0 launcher on Linux and macOS; Windows accepts v0.2.0 or newer.

## Configure electron-builder

Wrap your existing configuration without replacing its files, resources, icons, or platform settings:

```js
const { withMinitron } = require("@minitron/electron-builder");

module.exports = withMinitron(
  {
    appId: "com.example.desktop",
    productName: "Example Desktop",
    asar: true,
    linux: {
      target: ["deb", "rpm"],
      maintainer: process.env.MINITRON_MAINTAINER,
      icon: "build/app.png",
    },
    mac: {
      target: ["dmg", "pkg"],
      icon: "build/app.png",
    },
    // Keep your existing files, extraResources, asarUnpack, Windows and NSIS options.
  },
  {
    launcherPath: process.env.MINITRON_LAUNCHER,
    manifestUrl: process.env.MINITRON_MANIFEST_URL,
    iconPath: "build/minitron-icon.png",
  },
);
```

Minitron requires ASAR packaging. `iconPath` is a PNG included in app resources; if omitted, the adapter looks for a PNG among the configured application icons. Configure an app icon for macOS and a Linux PNG/icon set; electron-builder can generate the macOS icon from a PNG. Linux DEB/RPM builds need a real maintainer email in `MINITRON_MAINTAINER` or `linux.maintainer`, such as `Your Name <you@company.com>`.

Linux DEB/RPM packages need a homepage URL. Set `homepage` in the app's `package.json`, or let electron-builder infer it from the Git origin.

`withMinitron` preserves your existing `afterPack` hook and runs it before Minitron conversion. It retains NSIS options and composes the NSIS lifecycle include. Linux DEB/RPM keeps configured `afterInstall` and `afterRemove` scripts, stops the old app before upgrades, and unregisters it on final removal. PKG builds retain user scripts and add an app-stop step before replacing the installed bundle.

`launcherPath` and `manifestUrl` are required. Relative paths resolve from `projectDir` or the build working directory. `runtimeVersion` is inferred from electron-builder's resolved Electron runtime; `manifestPublicKey` and `allowLocalhostHttp` are optional. HTTPS is required unless localhost HTTP is explicitly enabled. CommonJS and ESM application entries are supported.

Use the platform targets in the [copyable example](../../examples/electron-builder/README.md). For macOS, supply electron-builder's usual signing identity and notarization credentials/settings when distributing signed and notarized packages. The adapter does not provide developer certificates or make an unsigned build signed.

## Install, start, update, and uninstall

Install Windows builds with the NSIS installer, DEB builds with `apt`, or RPM builds with `dnf`/`rpm`. Install a DMG app by dragging it to Applications; install a PKG by opening the package installer. Start the app from its normal shortcut or Applications folder. Minitron obtains the required shared Electron runtime on first launch and applies app updates from the configured manifest.

NSIS handles Windows installation, upgrade and removal; a real uninstall stops the app and unregisters it while respecting your existing NSIS app-data options. Linux package-manager upgrades stop the old app and retain its registration. Remove a DEB with `sudo apt remove <package>` or an RPM with `sudo dnf remove <package>`; the package hook stops the app and unregisters it. PKG upgrades stop the running app for each registered user before replacing the bundle. A DMG has no package-manager uninstall hook.

On macOS, run the app's `Contents/Resources/minitron-uninstall.command` from Terminal before deleting the `.app`. For example:

```sh
"/Applications/Example Desktop.app/Contents/Resources/minitron-uninstall.command"
```

The command stops the app and unregisters its Minitron runtime state. Dragging the app to Trash does not run this command; remove the app from Applications after running it. For a DMG upgrade, quit the running app before replacing it in Applications. Use PKG when an installer should stop the old app automatically.

Minitron app updates replace `app.asar` and `app.asar.unpacked`. `extraResources` are included in the installer but not in the app update archive. Keep updateable content in ASAR or distribute external resource changes separately. `electron-updater` is not automatically connected to the Minitron manifest.

In a packaged app, `process.execPath` identifies the shared Electron runtime. Use `process.env.MINITRON_LAUNCHER` when your app needs to relaunch itself through Minitron.

## 简体中文

适配器保留现有 electron-builder 配置，并将打包后的 Electron 主程序替换为 Minitron 启动器。支持 Windows NSIS、Linux DEB/RPM，以及 macOS DMG/PKG。Linux 不支持 AppImage 或 Snap；macOS x64 与 arm64 必须分别打包，不能使用 universal 或 Mac App Store 目标。Linux/macOS 启动器最低为 v0.3.0，Windows 最低为 v0.2.0。Linux DEB/RPM 还需要应用 homepage；electron-builder 会读取 `package.json` 的 `homepage`，或尝试从 Git origin 推断。可在应用 `package.json` 中设置 `homepage`。

安装启动器和平台操作见[通用配置示例](../../examples/electron-builder/README.zh-CN.md)与[Karvis 示例](../../examples/karvis/README.zh-CN.md)。macOS 卸载前需手动运行 `.app/Contents/Resources/minitron-uninstall.command`；将应用拖进废纸篓不会自动运行该脚本。

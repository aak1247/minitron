# Karvis AI 接入 Minitron

此示例扩展现有 `karvis-electron` 打包配置，不修改 Karvis 项目本身。它保留应用标识、文件、图标和 `assets/` 资源，并配置 Windows NSIS、Linux DEB/RPM、macOS DMG/PKG。Minitron 和应用图标均使用 Karvis 现有的 `assets/icon.png`。

在 Karvis 项目中安装 electron-builder 24.13.3 和适配器：

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-electron-builder-0.3.0.tgz
```

将 `electron-builder.config.cjs` 复制到 `karvis-electron/`。配置会扩展应用 `package.json` 的 `build`，保留 `files`、`extraResources`、`extraMetadata` 和平台设置，并将打包入口设为 `dist/main/index.js`。请保持 ASAR 启用。

安装与目标平台、架构匹配的 v0.3.0 启动器。从 `karvis-electron` 项目目录构建 Windows：

可按照 [Minitron 安装指南](../../README.zh-CN.md#安装)使用对应平台的安装脚本，并将启动器安装到 `.minitron`。

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/karvis/manifest.json"
npm run build
npx electron-builder --config electron-builder.config.cjs --win nsis
```

Linux DEB/RPM 必须使用真实维护者邮箱。示例优先使用 `MINITRON_MAINTAINER`，否则读取 `package.json` 中 `author` 的邮箱。两处都没有邮箱时，请在 Linux 构建前设置环境变量：

```sh
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
export MINITRON_MANIFEST_URL="https://updates.example.com/karvis/manifest.json"
export MINITRON_MAINTAINER="你的名字 <you@company.com>"
npx electron-builder --config electron-builder.config.cjs --linux --x64
```

Debian 使用 `sudo apt install ./release/*.deb` 安装，RPM 使用 `sudo dnf install ./release/*.rpm`。包管理器升级会停止旧应用并保留运行时登记；使用 `sudo apt remove <软件包名>` 或 `sudo dnf remove <软件包名>` 卸载时会停止应用并注销登记。

macOS x64 和 arm64 必须分别使用匹配的 v0.3.0 启动器构建。可以使用 electron-builder 现有的签名与公证配置；需要分发签名或公证版本时，请提供自己的 Apple 签名身份和公证凭据。

```sh
export MINITRON_MANIFEST_URL="https://updates.example.com/karvis/manifest.json"
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
npx electron-builder --config electron-builder.config.cjs --mac --x64

export MINITRON_LAUNCHER="$PWD/.minitron/minitron" # 构建前将匹配的 arm64 启动器放到此路径
npx electron-builder --config electron-builder.config.cjs --mac --arm64
```

打开 DMG 并将 Karvis AI 拖到“应用程序”，或运行 PKG 安装器。PKG 升级会先停止正在运行的应用。卸载前请在终端运行 `"/Applications/Karvis AI.app/Contents/Resources/minitron-uninstall.command"`，然后从“应用程序”移除 Karvis AI。将应用拖进废纸篓不会自动运行脚本。

`assets/` 会安装在 `app.asar` 旁边，但 Minitron 应用更新只包含 `app.asar` 和 `app.asar.unpacked`。需随应用更新的文件放入 ASAR，或单独分发外部资源更新。`electron-updater` 不会自动接入 Minitron manifest。

完整平台说明见[适配器指南](../../packages/electron-builder/README.md)和[通用示例](../electron-builder/README.zh-CN.md)。

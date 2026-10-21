# electron-builder 示例

此配置包装现有 Electron 应用，并保留原有 `files`、`extraResources`、`asarUnpack`、图标和安装选项。Minitron 要求 `asar: true`。示例使用 electron-builder 24.13.3 和 v0.3.0 适配器。

应用项目需准备 Windows 图标 `build/app.ico`、`build/installer.ico`、`build/uninstaller.ico`，Linux 和 macOS 图标 `build/app.png`，以及 Minitron 图标 `build/minitron-icon.png`。electron-builder 可以根据 PNG 生成 macOS 图标。示例假设入口为 `dist/main.js`，应用资源位于 `resources/`。

在应用项目中安装适配器：

```sh
npm install --save-dev electron-builder@24.13.3 https://github.com/aak1247/minitron/releases/download/v0.3.0/minitron-electron-builder-0.3.0.tgz
```

通过[平台安装脚本](../../README.zh-CN.md#安装)安装匹配的 Minitron 启动器，并将其路径设置到 `MINITRON_LAUNCHER`。

配置包含 Windows NSIS、Linux DEB/RPM 和 macOS DMG/PKG。Linux 打包必须提供真实维护者邮箱，例如 `MINITRON_MAINTAINER="你的名字 <you@company.com>"`；Windows 和 macOS 构建不需要此变量。

Linux DEB/RPM 元数据还需要应用 homepage。electron-builder 会读取应用 `package.json` 中的 `homepage`，也可尝试从 Git origin 推断；从不含 `.git` 的快照构建时，需要显式设置 `homepage`。

在应用 `package.json` 中添加命令：

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

从应用项目根目录构建，并为平台和架构选择匹配的启动器。Windows 示例：

```powershell
$env:MINITRON_LAUNCHER = (Resolve-Path ./.minitron/minitron.exe).Path
$env:MINITRON_MANIFEST_URL = "https://updates.example.com/manifest.json"
npm run dist:windows
```

Linux 使用 v0.3.0 Linux 启动器：

```sh
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
export MINITRON_MANIFEST_URL="https://updates.example.com/manifest.json"
export MINITRON_MAINTAINER="你的名字 <you@company.com>"
npm run dist:linux
```

macOS x64 和 arm64 必须分别构建，并在每次构建前设置匹配的 v0.3.0 启动器：

```sh
export MINITRON_MANIFEST_URL="https://updates.example.com/manifest.json"
export MINITRON_LAUNCHER="$PWD/.minitron/minitron"
npm run dist:mac:x64

export MINITRON_LAUNCHER="$PWD/.minitron/minitron" # 构建前将匹配的 arm64 启动器放到此路径
npm run dist:mac:arm64
```

Windows 使用 NSIS 安装程序，Debian 使用 `sudo apt install ./release/*.deb`，RPM 使用 `sudo dnf install ./release/*.rpm`。打开 DMG 后将应用拖到“应用程序”，或运行 PKG 安装器。正常启动应用即可；Minitron 首次启动时下载所需运行时，并通过 manifest 获取应用更新。

NSIS 卸载会停止 Windows 应用并注销登记。Linux 包管理器升级会停止旧应用并保留运行时登记；使用 `sudo apt remove <软件包名>` 或 `sudo dnf remove <软件包名>` 卸载时会停止应用并注销登记。PKG 升级会在替换应用前停止正在运行的实例。卸载 macOS 应用时，先在终端运行 `"/Applications/Example Desktop.app/Contents/Resources/minitron-uninstall.command"`，然后从“应用程序”中移除应用。将应用拖进废纸篓不会自动运行卸载脚本。

应用更新包含 `app.asar` 和 `app.asar.unpacked`。通过 `extraResources` 复制的文件随安装包分发，但不属于 Minitron 应用更新归档。

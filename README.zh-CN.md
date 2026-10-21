# minitron

**更小的 Electron 应用包，共享同一份运行时。**

[English](README.md) | **简体中文** · [下载](https://github.com/aak1247/minitron/releases/latest)

minitron 将 Electron 应用与运行时分开打包。应用只携带一个轻量原生启动器，多个应用可复用同一份 Electron，减少重复下载和应用更新体积。

- 仅包含应用的 ASAR 包，支持原生模块。
- 共享运行时、断点续传和自动清理。
- 后台更新与上一版本回滚。
- 根据系统显示语言自动选择中文或英文。

支持 **Windows x64、Linux x64、macOS Intel / Apple Silicon**。首次启动应用时下载 Electron，使用相同版本的应用共享运行时。

![minitron 启动器](docs/images/launcher-zh.png)

## 包体积

v0.2.0，使用内置示例应用和 Electron 32.2.0。下载列为压缩包体积，其余为解压后的文件大小。

| 平台 | 启动器下载 | 启动器 | 示例应用目录 | Electron 运行时 |
|---|---:|---:|---:|---:|
| Windows x64 | [5.20 MiB](https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-v0.2.0-windows-x64.zip) | 9.66 MiB | 9.67 MiB | 264.74 MiB |
| Linux x64 | [6.51 MiB](https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-v0.2.0-linux-x64.tar.gz) | 13.23 MiB | 13.24 MiB | 264.98 MiB |
| macOS Intel | [5.26 MiB](https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-v0.2.0-macos-x64.tar.gz) | 9.64 MiB | 9.65 MiB | 246.06 MiB |
| macOS Apple Silicon | [5.09 MiB](https://github.com/aak1247/minitron/releases/download/v0.2.0/minitron-v0.2.0-macos-arm64.tar.gz) | 8.41 MiB | 8.41 MiB | 239.90 MiB |

示例应用目录包含启动器、配置和应用资源，不含共享运行时。示例的应用更新 ZIP 仅 **7.88 KiB**。完整字节数见 Release 中的 [sizes.json](https://github.com/aak1247/minitron/releases/download/v0.2.0/sizes.json)。

Karvis AI 2.0.0 的 Windows 安装包（Electron 28.3.3、NSIS）：**77.34 MiB → 10.56 MiB**，缩小约 **86%**。共享运行时另计，在首次启动时下载一次。

## 安装

直接下载[预编译二进制](https://github.com/aak1247/minitron/releases/latest)，或用脚本安装最新启动器，无需 Rust 工具链。

### Windows

```powershell
Invoke-WebRequest https://github.com/aak1247/minitron/releases/latest/download/install.ps1 -OutFile "$env:TEMP/minitron-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP/minitron-install.ps1" -InstallDir ./minitron-bin
./minitron-bin/minitron.exe --help
```

### Linux / macOS

```sh
curl -fsSL https://github.com/aak1247/minitron/releases/latest/download/install.sh -o /tmp/minitron-install.sh
sh /tmp/minitron-install.sh --dir ./minitron-bin
./minitron-bin/minitron --help
```

脚本自动选择当前平台的二进制并校验 SHA-256。Windows 可用 `-Version v0.2.0`、Linux/macOS 可用 `--version v0.2.0` 指定版本。已有应用配置和资源会保留。

Linux 需要桌面环境、glibc 2.35+、fontconfig、X11 或 Wayland 及 xkbcommon。Ubuntu 22.04+ 可运行 `sudo apt-get install libfontconfig1 libxkbcommon0 libxkbcommon-x11-0 libx11-xcb1 libxcursor1 libxi6` 安装启动器依赖，Electron 还需要 GTK3、NSS、音频和 GBM 等桌面库；在 Ubuntu 22.04 上可安装 `libgtk-3-0 libnss3 libasound2 libgbm1`。

## 打包应用

### electron-builder

通过 [Minitron 适配器](packages/electron-builder/README.md)包装现有 electron-builder 配置，可生成 Windows NSIS、Linux DEB/RPM 和 macOS DMG/PKG 安装包，保留应用名称、图标和系统入口。日常 Electron 和 Node.js 开发流程保持不变。

参见[通用 electron-builder 配置](examples/electron-builder/README.zh-CN.md)和[Karvis 接入示例](examples/karvis/README.zh-CN.md)。macOS 应用包含手动运行的 `minitron-uninstall.command`；将应用拖入废纸篓不会自动执行该脚本。

### 便携应用目录

安装 Node.js 22.12+，然后按[打包指南](docs/usage.zh-CN.md#打包应用)操作。Windows 和 Linux/macOS 脚本使用预编译启动器，生成以下目录：

```text
application/
  minitron.exe         # Linux/macOS 下为 minitron
  minitron.toml
  resources/
    app.asar
    app.asar.unpacked/ # 按需生成
```

将此目录分发给用户。Windows 打开 `minitron.exe`，Linux/macOS 运行 `./minitron`。应用更新在后台下载，下次启动时生效；更新 ZIP 只包含应用资源。

Windows 还可通过 [NSIS 打包脚本](docs/usage.zh-CN.md#windows-安装包)生成安装程序。

## 语言

启动器跟随系统显示语言：中文系统使用简体中文，其他语言使用英语。可通过 `MINITRON_LANG=en`、`zh` 或 `auto` 手动指定。

配置、签名更新和启动参数见[使用指南](docs/usage.zh-CN.md)。

# Package size measurements / 包体积测量

[English README](../README.md) · [中文 README](../README.zh-CN.md)

These are historical measurements, not size guarantees for the latest release. Installer size excludes the shared Electron download. Application resources, native modules, compression and signing all affect the result.

以下为历史测量，不代表最新版的固定体积。安装包不包含另行下载的共享 Electron；应用资源、原生模块、压缩与签名都会影响结果。

## Minitron v0.4.1 example

The included example uses Electron 32.2.0. The download column is compressed; the other columns are uncompressed. The application directory includes its launcher, configuration and resources, but excludes Electron.

内置示例使用 Electron 32.2.0。下载列为压缩体积，其余列为解压体积。应用目录包含启动器、配置和应用资源，不含 Electron。

| Platform / 平台 | Launcher download / 下载 | Launcher / 启动器 | Example app / 示例应用 | Electron runtime / 运行时 |
|---|---:|---:|---:|---:|
| Windows x64 | 5.21 MiB | 9.70 MiB | 9.71 MiB | 264.74 MiB |
| Linux x64 | 6.53 MiB | 13.28 MiB | 13.29 MiB | 264.98 MiB |
| macOS Intel | 5.31 MiB | 9.75 MiB | 9.76 MiB | 246.06 MiB |
| macOS Apple Silicon | 5.14 MiB | 8.49 MiB | 8.49 MiB | 239.90 MiB |

The example's application update ZIP is 8.22 KiB. Exact byte counts and archive hashes are recorded in the [v0.4.1 sizes.json](https://github.com/aak1247/minitron/releases/download/v0.4.1/sizes.json). For current measurements, use the [latest release's sizes.json](https://github.com/aak1247/minitron/releases/latest/download/sizes.json).

示例的应用更新 ZIP 为 8.22 KiB。上述版本的精确字节数与归档哈希见 [v0.4.1 sizes.json](https://github.com/aak1247/minitron/releases/download/v0.4.1/sizes.json)，最新数据见[当前版本 sizes.json](https://github.com/aak1247/minitron/releases/latest/download/sizes.json)。

## Karvis AI 2.0.0 example

Using Electron 28.3.3, the measured Windows NSIS installer changed from 77.34 MiB to 10.56 MiB. The shared runtime is a separate download; this comparison describes installer transfer size, not total disk usage.

使用 Electron 28.3.3 时，Windows NSIS 安装包从 77.34 MiB 变为 10.56 MiB。共享运行时单独下载；此比较仅说明安装包传输体积，不代表完整磁盘占用。

| Platform / 平台 | Formats / 格式 | Installer size / 安装包体积 |
|---|---|---:|
| Linux x64 | DEB / RPM | 7.65 / 7.67 MiB |
| macOS Intel | PKG / DMG | 12.79 / 14.24 MiB |
| macOS Apple Silicon | PKG / DMG | 12.55 / 13.98 MiB |

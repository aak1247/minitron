# minitron

**更小的 Electron 应用包，共享同一份运行时。**

[English](README.md) | **简体中文**

minitron 将 Electron 应用与运行时分开发行。应用只携带轻量启动器和业务资源，多个应用共享 Electron，减少重复下载和应用更新包体积。

- 纯应用打包，支持 ASAR 和原生模块。
- 共享运行时，支持断点续传和自动清理。
- 后台更新，下次启动生效，支持回退上一版本。
- 中英双语，自动跟随系统显示语言。

适用于 **Windows x64**。首次启动下载 Electron，后续启动复用已安装的运行时。

![minitron 启动器](docs/images/launcher-zh.png)

## 快速开始

构建工具：Node.js 22.12+、Rust 1.92+、MSVC/Windows SDK 和 NSIS。使用原生模块时还需 Python 和 C++ 构建工具。

```powershell
git clone https://github.com/aak1247/minitron.git
cd minitron

./scripts/build-windows.ps1 -RuntimeVersion 32.2.0 -ManifestUrl https://example.com/myapp/manifest.json
```

将 Electron 版本和更新地址换成应用对应的配置。此命令打包内置示例应用；已有应用可参考[打包应用](docs/usage.zh-CN.md#打包应用)。

产物位于 `dist/windows/1.0.0/`：

| 产物 | 用途 |
|---|---|
| `application/` | 不含 Electron 的应用目录 |
| `MyApp-Setup-1.0.0.exe` | Windows 安装包 |
| `app-1.0.0-win32-x64-electron-32.2.0.zip` | 应用更新包 |

启动器从配置的更新源下载 Electron，更新源的部署方式见[发布更新](docs/usage.zh-CN.md#发布更新)。

## 启动应用

打开应用目录内的 `shell.exe`。更新在后台下载，下次启动时生效。

```powershell
./shell.exe --offline       # 离线启动
./shell.exe --no-update     # 启动时不检查应用更新
./shell.exe --rollback      # 恢复上一版本
./shell.exe --help          # 查看可用选项
```

## 语言

启动器自动跟随系统显示语言。中文使用简体中文，其他语言使用英语。

```powershell
$env:MINITRON_LANG = 'en'    # 英语
$env:MINITRON_LANG = 'zh'    # 中文
$env:MINITRON_LANG = 'auto'  # 跟随系统；未设置时也自动识别
```

更多打包、配置和签名更新选项见[使用指南](docs/usage.zh-CN.md)。

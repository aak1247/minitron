# 使用指南

[README](../README.zh-CN.md) · [English](usage.md) | **简体中文**

标准桌面安装包请使用[打包 CLI](../packages/electron-builder/README.md)。本指南介绍便携打包和高级配置。

[打包](#打包应用) · [更新](#发布更新) · [配置](#配置) · [缓存与启动](#运行时缓存与启动) · [问题排查](#问题排查) · [平台要求](#平台要求)

## 打包应用

需要带应用名称、图标和系统入口的安装包时，使用 [electron-builder 适配器](../packages/electron-builder/README.md)，支持 Windows NSIS、Linux DEB/RPM 和 macOS DMG/PKG。以下脚本用于生成便携应用目录。

应用源码目录需包含 `package.json`、`package-lock.json` 和已构建的入口文件。安装 Node.js 22.12+，获取打包工具：

```sh
git clone https://github.com/aak1247/minitron.git
cd minitron
npm --prefix app ci
```

Windows（PowerShell）：

```powershell
./install.ps1 -InstallDir ./bin
node scripts/build-app.mjs `
  --source ../my-electron-app `
  --launcher ./bin/minitron.exe `
  --out ./dist/myapp `
  --app-id com.example.myapp `
  --runtime-version 32.2.0 `
  --manifest-url https://example.com/myapp/manifest.json
./dist/myapp/application/minitron.exe
```

Linux / macOS：

```sh
sh ./install.sh --dir ./bin
sh scripts/build-unix.sh \
  --source ../my-electron-app \
  --launcher ./bin/minitron \
  --out ./dist/myapp \
  --app-id com.example.myapp \
  --runtime-version 32.2.0 \
  --manifest-url https://example.com/myapp/manifest.json
./dist/myapp/application/minitron
```

应用版本默认读取源项目的 `package.json`，可用 `--version 1.0.0` 覆盖。将 `--source`、Electron 版本和更新地址替换为自己的值，并按下文部署更新源。原生模块会为当前系统和架构重新编译，需要 Python 与 C++ 编译工具。

`dist/myapp/application/` 是不含 Electron 的完整应用目录；同级的 `app-<version>-<platform>-<arch>-electron-<version>.zip` 是应用更新包。macOS 输出为可通过终端运行的目录，未封装成 `.app` 或 `.dmg`。

打包器会包含 `package.main` 所在目录。额外文件和必须通过真实文件路径访问的资源可在应用的 `package.json` 中配置：

```json
{
  "runtimePackaging": {
    "files": ["config", "assets"],
    "asarUnpack": ["ffi/**"]
  }
}
```

`files` 使用相对文件或目录路径，`asarUnpack` 使用 glob 模式。原生库会自动解包。

应用资源通过 `app.getAppPath()` 或 `__dirname` 访问。`process.resourcesPath` 指向共享 Electron 运行时。原生库等解包文件位于归档旁的 `app.asar.unpacked/`。

## 发布更新

使用应用 ZIP 和官方 Electron ZIP 生成更新源：

```powershell
node scripts/publish-release.mjs `
  --app-id com.example.myapp `
  --version 1.0.0 `
  --runtime-version 32.2.0 `
  --platform win32-x64 `
  --app-zip ./dist/myapp/app-1.0.0-win32-x64-electron-32.2.0.zip `
  --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip `
  --base-url https://example.com/myapp `
  --out ./dist/publish
```

将 `dist/publish` 的内容部署到 base-url，使 `manifest.json` 可通过启动器配置的 `ManifestUrl` 访问。

后续发布增加应用版本，并传入 `--previous-manifest <previous-manifest.json>`，保留旧安装所需的运行时条目及对应 ZIP 文件。

为每个系统和架构使用独立的发布目录与更新清单地址。Linux x64 使用 `--platform linux-x64`，Mac 使用 `darwin-x64` 或 `darwin-arm64`，并选择对应平台的应用 ZIP 与官方 Electron ZIP。

发布启动器更新时，追加 `--shell <minitron-binary> --shell-version <version>`。应用需要特定启动器版本时，可通过 `--min-shell-version <version>` 设置最低版本。

### 签名更新

生成 Ed25519 私钥：

```powershell
node -e "
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync('release-private.pem', privateKey.export({ format: 'pem', type: 'pkcs8' }));
"
```

发布命令追加 `--signing-key ./release-private.pem`。构建应用时传入 `--manifest-public-key <public-key.txt中的值>`，公钥来自生成的 `dist/publish/public-key.txt`。应用中仅包含公钥。

### 本地更新源

发布时使用 `--base-url http://127.0.0.1:8787 --out ./dist/local-source`；构建时使用 `--manifest-url http://127.0.0.1:8787/manifest.json --allow-localhost-http`，然后启动服务：

```powershell
node scripts/serve-release.mjs --dir ./dist/local-source --port 8787
```

## 配置

构建脚本在启动器旁生成 `minitron.toml`：

| 配置项 | 用途 |
|---|---|
| `app_id` | 应用标识 |
| `app_version` | 初始安装的应用版本 |
| `required_runtime` | 精确的 Electron 版本 |
| `manifest_url` | 可选更新清单地址；空值表示不使用托管更新 |
| `runtime_download` | 固定运行时归档的 URL、SHA-256 和大小；打包 CLI 会生成此配置，以便无更新服务器时启动 |
| `manifest_public_key` | 可选的 Ed25519 公钥 |
| `allow_localhost_http` | 允许使用本地 HTTP 更新源 |

[Windows 安装器脚本](#windows-安装包)另有 `-Makensis <path>`、`-OutputDirectory <path>` 和 `-SkipInstaller` 参数。这些是 PowerShell 参数，与便携打包脚本的 `--options` 分开使用。

## 运行时缓存与启动

| 系统 | 默认缓存目录 |
|---|---|
| Windows | `%LOCALAPPDATA%/SharedElectron` |
| Linux | `$XDG_DATA_HOME/SharedElectron`，通常为 `~/.local/share/SharedElectron` |
| macOS | `~/Library/Application Support/SharedElectron` |

`ELECTRON_RUNTIME_ROOT` 可用绝对路径覆盖缓存目录。应用共享运行时需要使用同一缓存目录，且系统、架构与 **Electron 精确版本**完全相同。应用 ID 不会拆分运行时缓存；不同系统用户通常各自缓存。

启动器在打开应用前校验已安装的运行时。有效时直接打开应用，不显示引导窗口；缺失或损坏时可能需要重新准备。中断下载在服务器支持时断点续传；中断准备后留下的完整归档会先校验再复用，不重新下载，也不显示下载窗口。准备失败时保留重试入口。

应用和启动器升级会保留兼容的运行时。Electron 版本变化时，仅在新版本尚未缓存的情况下下载。卸载一个应用会保留其他安装仍在引用的运行时；最后一个引用及运行中的进程租约释放后，可清理闲置运行时，因此之后重新安装可能再次下载。

应用更新状态同样存放在安装目录之外。应用安装到 `Program Files` 时，日常启动和更新不需要写入该安装目录。

## 启动选项

| 选项 | 用途 |
|---|---|
| `--offline` | 离线启动 |
| `--no-update` | 跳过应用更新检查；缺少运行时时仍可下载 |
| `--headless` | 在控制台显示运行时准备进度 |
| `--check-update` | 下载更新，供下次启动使用 |
| `--rollback` | 恢复上一版本 |
| `--uninstall` | 注销当前安装并清理闲置运行时 |
| `--stop` | 停止属于当前安装的进程 |
| `--runtime-root` | 输出当前安装使用的运行时缓存路径 |
| `--state-dir` | 输出当前安装的可变更新状态目录 |
| `-- <arguments>` | 向应用传递参数 |

通过 `MINITRON_LANG=en`、`zh` 或 `auto` 设置语言。未指定时跟随系统显示语言，无法匹配时使用英语。

## Windows 安装包

安装 NSIS 后，可基于同一份预编译启动器和应用资源生成安装程序：

```powershell
./scripts/build-windows.ps1 `
  -SkipAppBuild `
  -ShellBinary ./bin/minitron.exe `
  -OutputDirectory ./dist/myapp `
  -AppId com.example.myapp `
  -AppName MyApp `
  -AppVersion 1.0.0 `
  -RuntimeVersion 32.2.0 `
  -ManifestUrl https://example.com/myapp/manifest.json
```

输出 `dist/myapp/MyApp-Setup-1.0.0.exe`。可用 `-Makensis <path>` 指定 NSIS 路径。

## 问题排查

| 现象 | 检查方式 |
|---|---|
| 每次启动都下载运行时 | 确认上次已完成准备；检查是否更换了用户、Electron 版本或 `ELECTRON_RUNTIME_ROOT`。收集标准错误输出，查看 `RUNTIME_UNAVAILABLE` 后的校验原因。 |
| 离线启动失败 | `--offline` 要求已有完整有效的已安装运行时，先正常启动一次完成准备。 |
| 已安装的应用仍用旧启动器 | npm 依赖更新只影响后续构建，需要重建并分发安装包，或发布已配置的启动器更新。 |
| 找不到资源或原生模块 | 应用资源使用 `app.getAppPath()` 或 `__dirname`；`process.resourcesPath` 属于共享运行时。原生模块需匹配 Electron 精确版本和架构。 |
| 应用更新没有包含改动的 `extraResources` | 此类资源随安装器分发，变更后应发布新安装包。 |

便携应用可在 PowerShell 中运行 `./application/minitron.exe --no-update 2> startup.log` 收集启动日志；Linux/macOS 使用 `./application/minitron --no-update 2> startup.log`。提交问题前先移除日志中的凭据与私人应用数据。

## 平台要求

- **Windows：**x64 桌面环境；编译原生模块需要 Python 和 C++ 编译工具。
- **Linux：**桌面环境、glibc 2.35+、fontconfig、X11 或 Wayland 及 xkbcommon。Ubuntu 22.04+ 可运行下方命令安装启动器依赖；Electron 还需要 GTK3、通知、NSS、音频和 GBM 库。
- **macOS：**Intel 与 Apple Silicon 分别构建。需要 `.app` 时使用 electron-builder 的 DMG 或 PKG；便携脚本输出从终端启动的目录。

```sh
sudo apt-get install libfontconfig1 libxkbcommon0 libxkbcommon-x11-0 libx11-xcb1 libxcursor1 libxi6
```

# 使用指南

[README](../README.zh-CN.md) · [English](usage.md) | **简体中文**

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
node scripts/build-app.mjs --source ../my-electron-app --launcher ./bin/minitron.exe --out ./dist/myapp --app-id com.example.myapp --runtime-version 32.2.0 --manifest-url https://example.com/myapp/manifest.json
./dist/myapp/application/minitron.exe
```

Linux / macOS：

```sh
sh ./install.sh --dir ./bin
sh scripts/build-unix.sh --source ../my-electron-app --launcher ./bin/minitron --out ./dist/myapp --app-id com.example.myapp --runtime-version 32.2.0 --manifest-url https://example.com/myapp/manifest.json
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
node scripts/publish-release.mjs --app-id com.example.myapp --version 1.0.0 --runtime-version 32.2.0 --platform win32-x64 --app-zip ./dist/myapp/app-1.0.0-win32-x64-electron-32.2.0.zip --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip --base-url https://example.com/myapp --out ./dist/publish
```

将 `dist/publish` 的内容部署到 base-url，使 `manifest.json` 可通过启动器配置的 `ManifestUrl` 访问。

后续发布增加应用版本，并传入 `--previous-manifest <previous-manifest.json>`，保留旧安装所需的运行时条目及对应 ZIP 文件。

为每个系统和架构使用独立的发布目录与更新清单地址。Linux x64 使用 `--platform linux-x64`，Mac 使用 `darwin-x64` 或 `darwin-arm64`，并选择对应平台的应用 ZIP 与官方 Electron ZIP。

发布启动器更新时，追加 `--shell <minitron-binary> --shell-version <version>`。应用需要特定启动器版本时，可通过 `--min-shell-version <version>` 设置最低版本。

### 签名更新

生成 Ed25519 私钥：

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync('release-private.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));"
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
| `manifest_url` | 更新清单地址 |
| `manifest_public_key` | 可选的 Ed25519 公钥 |
| `allow_localhost_http` | 允许使用本地 HTTP 更新源 |

构建选项包括：`-Makensis <path>` 指定 NSIS，`-OutputDirectory <path>` 指定输出目录，`-SkipInstaller` 仅生成应用目录。

共享运行时默认存放在 Windows 的 `%LOCALAPPDATA%/SharedElectron`、Linux 的 `$XDG_DATA_HOME/SharedElectron`（默认 `~/.local/share/SharedElectron`）或 macOS 的 `~/Library/Application Support/SharedElectron`，可通过 `ELECTRON_RUNTIME_ROOT` 指定其他目录。卸载应用时会保留其他应用仍在使用的运行时。

## 启动选项

| 选项 | 用途 |
|---|---|
| `--offline` | 离线启动 |
| `--no-update` | 跳过应用更新检查；缺少运行时时仍可下载 |
| `--headless` | 在控制台显示运行时准备进度 |
| `--check-update` | 下载更新，供下次启动使用 |
| `--rollback` | 恢复上一版本 |
| `--uninstall` | 注销当前安装并清理闲置运行时 |
| `-- <arguments>` | 向应用传递参数 |

通过 `MINITRON_LANG=en`、`zh` 或 `auto` 设置语言。未指定时跟随系统显示语言，无法匹配时使用英语。

## Windows 安装包

安装 NSIS 后，可基于同一份预编译启动器和应用资源生成安装程序：

```powershell
./scripts/build-windows.ps1 -SkipAppBuild -ShellBinary ./bin/minitron.exe -OutputDirectory ./dist/myapp -AppId com.example.myapp -AppName MyApp -AppVersion 1.0.0 -RuntimeVersion 32.2.0 -ManifestUrl https://example.com/myapp/manifest.json
```

输出 `dist/myapp/MyApp-Setup-1.0.0.exe`。可用 `-Makensis <path>` 指定 NSIS 路径。

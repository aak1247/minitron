# 使用指南

[README](../README.zh-CN.md) · [English](usage.md) | **简体中文**

## 打包应用

应用源码包含 package.json、package-lock.json 和已构建的入口文件。在 minitron 目录运行：

```powershell
npm --prefix app ci

node app/scripts/pack-asar.js --source ../my-electron-app --runtime-version 32.2.0 --version 1.0.0 --out ./dist/windows/1.0.0/resources

./scripts/build-windows.ps1 -SkipAppBuild -AppId com.example.myapp -AppName MyApp -AppVersion 1.0.0 -RuntimeVersion 32.2.0 -ManifestUrl https://example.com/myapp/manifest.json
```

两条打包命令使用相同的 Electron 版本。原生模块按当前主机的平台和架构重建。

打包器自动包含 `package.main` 所在目录。其他文件和需要真实文件路径的资源可在应用的 package.json 中配置：

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
node scripts/publish-release.mjs --app-id com.example.myapp --version 1.0.0 --runtime-version 32.2.0 --platform win32-x64 --app-zip ./dist/windows/1.0.0/app-1.0.0-win32-x64-electron-32.2.0.zip --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip --base-url https://example.com/myapp --out ./dist/publish
```

将 `dist/publish` 的内容部署到 base-url，使 `manifest.json` 可通过启动器配置的 `ManifestUrl` 访问。

后续发布增加应用版本，并传入 `--previous-manifest <previous-manifest.json>`，保留旧安装所需的运行时条目及对应 ZIP 文件。

发布启动器更新时，追加 `--shell <launcher.exe> --shell-version <version>`。应用需要特定启动器版本时，可通过 `--min-shell-version <version>` 设置最低版本。

### 签名更新

生成 Ed25519 私钥：

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync('release-private.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));"
```

发布命令追加 `--signing-key ./release-private.pem`。构建应用时传入 `-ManifestPublicKey <public-key.txt中的值>`，公钥来自生成的 `dist/publish/public-key.txt`。应用中仅包含公钥。

### 本地更新源

发布时使用 `--base-url http://127.0.0.1:8787 --out ./dist/local-source`；构建时使用 `-ManifestUrl http://127.0.0.1:8787/manifest.json -AllowLocalhostHttp`，然后启动服务：

```powershell
node scripts/serve-release.mjs --dir ./dist/local-source --port 8787
```

## 配置

构建脚本在启动器旁生成 `shell.toml`：

| 配置项 | 用途 |
|---|---|
| `app_id` | 应用标识 |
| `app_version` | 初始安装的应用版本 |
| `required_runtime` | 精确的 Electron 版本 |
| `manifest_url` | 更新清单地址 |
| `manifest_public_key` | 可选的 Ed25519 公钥 |
| `allow_localhost_http` | 允许使用本地 HTTP 更新源 |

构建选项包括：`-Makensis <path>` 指定 NSIS，`-OutputDirectory <path>` 指定输出目录，`-SkipInstaller` 仅生成应用目录。

共享运行时默认存放在 `%LOCALAPPDATA%/SharedElectron`，可通过 `ELECTRON_RUNTIME_ROOT` 指定其他目录。卸载应用时会保留其他应用仍在使用的运行时。

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

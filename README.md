# minitron

**Smaller Electron packages, shared runtime.**

[![Windows CI](https://github.com/aak1247/minitron/actions/workflows/windows.yml/badge.svg)](https://github.com/aak1247/minitron/actions/workflows/windows.yml)

面向 Electron 的轻量打包器：将业务应用与 Electron 运行时分开发行，让多个应用共享运行时，减少安装包和更新包体积。

Windows x64 示例实测：应用目录 **8.84 MiB**，NSIS 安装包 **4.86 MiB**，均不含 Electron；首次使用需另行下载运行时。完整口径与平台边界见[验证报告](docs/验证报告.md)。

- **纯应用打包**：ASAR、生产依赖、原生模块 ABI 重建与 unpack。
- **共享运行时**：精确版本隔离、断点续传、完整性校验、并发下载协调与安全回收。
- **可恢复更新**：后台准备，下次启动切换；应用资源和运行时整体回滚。
- **发布工具**：清单签名、运行时历史目录、启动器自更新和用户级 Windows 安装包。

当前完成实际发行验收的平台为 **Windows x64**。macOS/Linux 尚未完成对应系统的发行与端到端验证。

## 工作方式

应用发行目录仅包含 Rust 启动器、配置和业务资源；同一用户的多个应用复用精确版本的官方 Electron。首次安装仍需下载运行时，后续安装和业务更新不再重复分发。

```text
应用目录                         当前用户共享缓存
shell.exe                        SharedElectron/versions/win32-x64/v32.2.0/
shell.toml                         electron.exe + 完整 Chromium/Node
resources/app.asar
resources/app.asar.unpacked/      refs.json + locks/ + leases/
updates/releases/                按平台、架构和版本隔离
```

壳执行 `electron.exe <app.asar绝对路径>`。此入口的 `process.defaultApp` 为 true；`process.resourcesPath` 指向共享运行时，应用资源应从 `app.getAppPath()` / `__dirname` 查找。标准 Electron API、preload 和 IPC 保持可用。

## 构建 Windows 应用

需要 Node.js >=22.12、Rust >=1.92、MSVC/Windows SDK；生成安装包还需 NSIS。原生模块重建需要 Python 和 C++ 构建工具。应用依赖和 Rust 依赖均有锁文件。

```powershell
git clone https://github.com/aak1247/minitron.git
cd minitron
cd app
npm ci
npm test
npm run pack:asar -- --runtime-version 32.2.0 --version 1.0.0 --out ../dist/resources
cd ..

./scripts/build-windows.ps1 -RuntimeVersion 32.2.0 -ManifestUrl https://your-host.example/myapp/manifest.json
```

默认输出：

- `dist/windows/1.0.0/application/`：可独立分发的应用目录，不含 Electron。
- `dist/windows/1.0.0/MyApp-Setup-1.0.0.exe`：用户级 NSIS 安装包。
- `dist/windows/1.0.0/app-1.0.0-win32-x64-electron-32.2.0.zip`：纯应用更新包。
- `dist/windows/1.0.0/build.json`：构建参数及产物路径。

`-Makensis <path>` 可指定 NSIS；脚本也会查找 PATH 和 electron-builder 的本机 NSIS 缓存。`-CargoHome <dir>` 可隔离有问题的全局 Cargo 镜像配置，无需修改用户设置。`-Configuration Debug` 可用于开发构建，`-SkipInstaller` 只组装应用目录。

纯资源打包通过 `@electron/asar` 直接完成，不使用 `electron-builder --dir`。构建过程在临时 staging 中 `npm ci --omit=dev`，按精确 Electron 版本重建原生模块；默认 unpack `.node/.dll/.dylib/.so` 及 `ffi/`。其他需要真实路径的文件可在应用 package.json 的 `runtimePackaging.asarUnpack` 中追加 glob。

可用 `--source <dir>` 打包其他应用，源目录需含 package.json、package-lock.json 和入口资源。构建器自动加入 package.main 所在顶层目录，支持 dist/main/index.js 等布局；额外文件/目录可在 `runtimePackaging.files` 数组中明确指定（相对路径，不是 glob）。构建会检查入口存在并拒绝越界、符号链接或与输出目录重叠的输入。native 构建仅支持当前主机平台/架构，避免误发 ABI 不匹配的产物。

## 发布更新源

准备官方 Electron ZIP 和纯应用 ZIP，由发布工具计算真实 SHA256/大小并写出清单：

```powershell
node scripts/publish-release.mjs --app-id com.example.myapp --version 1.0.0 --runtime-version 32.2.0 --platform win32-x64 --app-zip ./dist/windows/1.0.0/app-1.0.0-win32-x64-electron-32.2.0.zip --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip --base-url https://your-host.example/myapp --out ./dist/publish
```

将 `dist/publish` 上传到对应地址。清单支持 `runtimes` 历史目录；后续发布传 `--previous-manifest <旧manifest.json>` 保留旧应用所需的运行时入口。旧 runtime artifact 文件也应继续保留在更新源中。

本机演示可把 base-url 和 ManifestUrl 设为 `http://127.0.0.1:8787` 及其 manifest.json 路径，构建传 `-AllowLocalhostHttp`。运行 `node scripts/serve-release.mjs --dir ./dist/demo-source --port 8787` 提供本地更新源，再启动应用目录内的 shell.exe。

生产清单可配置 Ed25519：

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync('release-private.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));"
# 在上面的发布命令追加 --signing-key ./release-private.pem
# 构建应用时传 -ManifestPublicKey <dist/publish/public-key.txt中的base64值>
```

配置公钥后，缺失签名、错误公钥、清单篡改均会拒绝；不配置公钥仅提供 HTTPS 和 artifact SHA256 完整性校验。私钥不进入应用包或版本控制。签名字节规则见 `docs/架构设计.md`。

`manifest/manifest.json` 是模板，含有故意无效的 URL/哈希占位，不能直接作为生产源；发布工具会生成真实值。示例 Electron 32.2.0 用于复现，正式发布应选择维护中的版本并重新验证原生模块。

## 启动与更新

```powershell
./shell.exe                         # 本地就绪后立即启动，后台准备更新
./shell.exe --headless              # 缺 runtime 时在控制台报告进度
./shell.exe --no-update             # 允许补齐 runtime，但不后台检查应用更新
./shell.exe --offline               # 完全不访问更新源
./shell.exe --check-update          # 下载并准备候选版本，本次不激活应用资源
./shell.exe --rollback              # 切回保留的上一完整版本
./shell.exe --uninstall             # 注销当前安装引用，安全回收无人使用的 runtime
./shell.exe -- --your-app-argument  # 将参数传给 Electron 应用
```

共享根目录默认为当前用户本地数据目录下的 `SharedElectron`，Windows 为 `%LOCALAPPDATA%/SharedElectron`。`ELECTRON_RUNTIME_ROOT` 可显式覆盖。每个安装路径独立登记；卸载 A 不会删除 B 仍依赖或进程仍使用的 runtime。登记损坏会报错并保留文件。

应用更新下载到不可变版本目录，完整准备后写 pending；下次启动再切换 active 指针。asar、unpacked、应用版本和 runtime 版本绑定整体回滚，运行中的 DLL 不会被热替换。同一应用版本视为不可变，更新需增加应用版本。

应用可通过环境变量 `ERS_READY_FILE`、`ERS_RELEASE_TXID` 接入就绪协议：真实页面与 IPC 初始化成功后，原子写入 `{"txid":"对应ID","ready":true}`。示例已接入。未接入时只用成功退出或启动宽限期作弱判据，不能代表业务健康。已就绪后的晚期崩溃不触发自动版本回滚。

壳更新通过清单 `shell.version/platforms` 和 `app.min_stub_version` 配合发布。发布工具追加 `--shell <新壳exe> --shell-version <版本> --min-shell-version <最低版本>`。临时 copier 等待原父进程退出后替换目标，结果与日志写在应用的 updates 目录。

## 测试

```powershell
node --test scripts/publish-release.test.mjs
cd app; npm test; cd ..
cd shell; cargo test --locked; cargo check --locked; cd ..
./scripts/e2e-windows.ps1 -RuntimeZip C:/downloads/electron-v32.2.0-win32-x64.zip -UpgradeRuntimeZip C:/downloads/electron-v33.3.1-win32-x64.zip
```

E2E 使用临时目录、loopback HTTP 源和临时签名密钥，覆盖下载 UI、真实页面/preload/IPC、native addon、首次下载、离线启动、共享卸载、后台 staging、激活、回滚、跨 runtime 更新、并发、孤儿进程 lease、损坏登记与真实壳自更新。`dist/e2e-report.json` 保存结果及 fixture 路径。

E2E 默认使用 release 壳，并编译 0.1.1 的 debug 壳作为自更新 fixture；`-ShellBinary`、`-NewShellBinary` 可指定已有测试二进制。测试不接触默认共享缓存。生产 CDN、代码签名和 macOS 公证需在发布环境自行配置。

GitHub Actions 每次 push/PR 运行 Node/Rust 测试、release 构建与 NSIS 编译，并保存构建产物。在 Actions 手动运行 Windows CI 并勾选 `run_e2e`，还会下载校验官方测试运行时并执行完整 E2E。

## 项目结构

| 路径 | 用途 |
|---|---|
| `app/` | 标准 Electron 示例应用、ASAR 打包器与测试 |
| `shell/` | Rust/Slint 启动器、运行时管理和更新逻辑 |
| `scripts/` | Windows 构建、发布清单、本地服务和 E2E |
| `installer/` | 用户级 NSIS 安装脚本 |
| `manifest/` | 更新清单模板 |
| `docs/` | [架构设计](docs/架构设计.md)与[验证报告](docs/验证报告.md) |

仓库只保存源码；依赖缓存、构建产物和本机演示源由构建/发布命令生成。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Minitron

使用原生启动器和共享 Electron 运行时打包应用。每个安装包包含应用代码与启动器；兼容的应用复用当前用户缓存中的同一份运行时。

[English](README.md) | **简体中文** · [最新版本](https://github.com/aak1247/minitron/releases/latest) · [npm](https://www.npmjs.com/package/minitron-builder) · [版本记录](CHANGELOG.md)

## 快速开始

需要 **Node.js 22.12+**，以及已有 electron-builder 配置的 Electron 项目。在需要打包的操作系统上运行：

```sh
npm install --save-dev minitron-builder
npm run build
npx minitron-builder
```

应用已编译时可跳过 `npm run build`。CLI 会读取 electron-builder 配置或 `package.json` 中的 `build`，然后下载对应平台与架构的 Minitron 启动器。

保留现有的应用 ID、名称、图标、文件和安装器配置，**必须启用 ASAR**。例如，将以下字段合并到现有配置：

```json
{
  "build": {
    "appId": "com.example.desktop",
    "productName": "Example Desktop",
    "asar": true
  }
}
```

产物写入 `build.directories.output`，默认目录为 `dist`。包含图标和 Linux 包元数据的完整配置见 [electron-builder 示例](examples/electron-builder/README.zh-CN.md)。

## 用户启动时会发生什么

| 场景 | 行为 |
|---|---|
| 尚未安装所需的 Electron 版本 | 下载、校验并安装运行时，然后打开应用。 |
| 所需运行时已经安装 | 直接打开应用，不显示启动器窗口。 |
| 应用更新，Electron 版本不变 | 复用已安装的运行时。 |
| 应用需要另一个 Electron 版本 | 有缓存则复用，没有则下载该版本一次。 |
| 另一个 Minitron 应用使用相同版本 | 同一用户、系统和架构下共享运行时。 |
| 卸载其中一个应用 | 保留其他安装仍在引用的运行时。 |

共享要求 **Electron 版本完全一致**，且使用同一缓存目录。不同用户账户分别缓存；运行时文件被删除或损坏后，可能需要重新下载。

服务器支持范围请求时，中断下载会断点续传；已完整下载的归档会先校验再复用。只有下载或准备出错时才显示启动器窗口，日常启动直接进入应用。

![下载 Electron 时显示的启动器](docs/images/launcher-zh.png)

## 支持的平台与格式

| 平台 | 架构 | 安装包格式 |
|---|---|---|
| Windows | x64 | NSIS |
| Linux | x64 | DEB、RPM |
| macOS | Intel、Apple Silicon | DMG、PKG；两种架构分别构建 |

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Linux 包需要 `homepage` 和有效维护者邮箱，可在应用元数据或 Linux 构建选项中设置。启动器需要桌面环境和 glibc 2.35+，依赖清单见[平台要求](docs/usage.zh-CN.md#平台要求)。安装器集成暂不支持 AppImage、Snap、macOS Universal 和 Mac App Store。

## 更新与兼容性

更新服务器为可选项。未配置时，安装后的应用会从 Electron 官方分发源获取所需运行时。需要分发应用和启动器更新时，按[更新指南](docs/usage.zh-CN.md#发布更新)配置 Minitron 更新清单。

- 应用更新在后台暂存，后续启动时激活，支持回滚。
- `electron-updater` 不会自动接入 Minitron 更新清单。
- `extraResources` 随安装包分发，不包含在 Minitron 应用更新归档中。
- macOS 删除应用前，应运行应用内的 `Contents/Resources/minitron-uninstall.command`；移到废纸篓不会执行清理。

让后续打包使用最新版启动器，需要更新开发依赖并重新构建安装包：

```sh
npm install --save-dev minitron-builder@latest
npx minitron-builder
```

更新开发依赖不会替换用户已经安装的应用启动器。

## 文档入口

- [使用指南](docs/usage.zh-CN.md)：便携打包、配置、运行时缓存、问题排查和更新发布。
- [打包器参考](packages/electron-builder/README.md)：安装器集成与支持范围。
- [Karvis 示例](examples/karvis/README.zh-CN.md)：打包包含原生资源的现有应用。
- [包体积测量](docs/benchmarks.md)：注明版本的历史测量与适用范围；当前版本的精确数据见 [sizes.json](https://github.com/aak1247/minitron/releases/latest/download/sizes.json)。
- [贡献指南](CONTRIBUTING.md)：本地检查和发布验证。

启动器跟随系统显示语言：中文环境使用简体中文，其他语言使用英语。可通过 `MINITRON_LANG=en`、`zh` 或 `auto` 覆盖。

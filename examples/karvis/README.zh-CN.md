# Karvis AI 接入 Minitron

此示例打包现有 `karvis-electron` 应用，不修改其源代码。应用保留 Karvis 名称、图标和资源；Minitron 提供轻量启动器，并在首次启动时下载 Electron。

在 electron-builder 配置中保留现有应用标识和图标，并启用 ASAR。Karvis 的资源布局还需在现有 `build` 配置中设置应用入口和资源：

```json
{
  "extraMetadata": { "main": "dist/main/index.js" },
  "extraResources": [
    { "from": "assets", "to": "assets", "filter": ["**/*"] }
  ],
  "asar": true
}
```

将这些字段合并到现有 `build` 对象，并保留其他打包设置。`extraResources` 会把 `assets/` 安装到 `app.asar` 旁边。可选的 [`electron-builder.config.cjs`](electron-builder.config.cjs) 展示等价的底层适配器配置。

在 `karvis-electron` 项目目录安装 CLI 并构建应用：

```sh
npm install -D minitron-builder
npm run build
npx minitron-builder
```

应用已编译时可跳过 `npm run build`。

CLI 默认构建当前平台。需要时可指定安装包格式：

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

macOS x64 与 arm64 需分别构建。Linux DEB/RPM 需要主页 URL 和应用元数据或 Linux 设置中的真实维护者邮箱。产物写入配置的 `directories.output`，未配置时默认为 `dist`。

Windows 使用 NSIS，Linux 使用 DEB/RPM，macOS 使用 DMG/PKG。通过常规安装器或“应用程序”目录安装，然后从原有快捷方式启动 Karvis AI。Minitron 首次启动时会下载匹配的 Electron 运行时；开始使用不需要应用更新服务器，之后可选配 manifest。`extraResources` 不包含在 Minitron 应用更新归档中，`electron-updater` 也不会自动接入。

卸载 macOS 应用前，请在终端运行 `"/Applications/Karvis AI.app/Contents/Resources/minitron-uninstall.command"`。将应用拖进废纸篓不会运行该脚本。

支持目标和更新边界见[适配器指南](../../packages/electron-builder/README.md)和[通用 electron-builder 示例](../electron-builder/README.zh-CN.md)。

# electron-builder 示例

现有 Electron 项目无需改变日常开发流程即可使用 Minitron。在项目目录安装 npm CLI 并照常构建：

```sh
npm install -D minitron-builder
npm run build
npx minitron-builder
```

应用已编译时可跳过构建命令。CLI 会读取项目现有的 electron-builder 配置或 `package.json` 中的 `build`，保留文件、`extraResources`、`asarUnpack`、图标和安装选项，并下载匹配的启动器。请启用 `asar: true`。

一个简短的跨平台 `package.json` 配置如下：

```json
{
  "homepage": "https://example.com/my-app",
  "author": { "name": "Example", "email": "packaging@example.com" },
  "build": {
    "appId": "com.example.desktop",
    "productName": "Example Desktop",
    "asar": true,
    "directories": { "output": "release" },
    "win": { "target": ["nsis"], "icon": "build/app.ico" },
    "linux": { "target": ["deb", "rpm"], "icon": "build/app.png" },
    "mac": { "target": ["dmg", "pkg"], "icon": "build/app.png" }
  }
}
```

默认构建当前平台。也可以指定目标：

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

macOS x64 与 arm64 需分别构建。Linux DEB/RPM 需要主页 URL 和有效维护者邮箱。产物写入配置的 `directories.output`，未配置时默认为 `dist`。

首次启动不需要更新服务器：应用会从 Electron 官方分发源下载共享运行时，之后可选配应用更新 manifest。参见[更新指南](../../docs/usage.zh-CN.md#发布更新)。`extraResources` 随安装包分发，但不包含在 Minitron 应用更新归档中。

## 底层适配器

旁边的 [`electron-builder.config.cjs`](electron-builder.config.cjs) 展示直接调用 `withMinitron` 并自行配置启动器和 manifest 路径的方式；使用上方 CLI 时无需此配置。安装器生命周期、手动安装启动器和高级选项见[适配器指南](../../packages/electron-builder/README.md)。

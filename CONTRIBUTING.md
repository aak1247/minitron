# 参与 minitron 开发

当前完整验收目标是 Windows x64。准备 Node.js >=22.12、Rust >=1.92、MSVC/Windows SDK 和 NSIS；原生模块 E2E 还需要 Python 和 C++ 构建工具。

在项目根目录运行发布工具测试：

```powershell
node --test scripts/publish-release.test.mjs
```

应用打包器测试：

```powershell
cd app
npm ci
npm test
```

在 `shell/` 运行启动器验证：

```powershell
cargo fmt --all -- --check
cargo test --locked
cargo build --locked --release
```

启动器界面可以独立预览，不访问网络或共享运行时缓存。在 `shell/` 运行：

```powershell
cargo run --locked --example launcher-preview -- downloading
```

状态可选 `checking`、`downloading`、`verifying`、`error`、`done`。错误预览支持展开详情、选择复制诊断信息和重试；重试会切回准备状态。追加输出路径（如 `downloading preview.ppm`）可导出 Slint 实际渲染的截图并自动关闭窗口。截图路径后可加 `compact` 检查最小窗口，或在 `error` 状态加 `details` / `retry` 实际点击对应按钮并截图；`retry` 会断言状态与进度重置。设置 `SLINT_SCALE_FACTOR` 可检查不同缩放比例。界面采用固定浅色 Fluent 控件与绘制的材质背景，不依赖系统背景模糊效果。

完整打包、签名发布和 E2E 命令见 [README](README.md)。修改运行时、更新事务、自更新或原生模块打包时，运行完整 Windows E2E；测试使用临时目录和独立共享缓存。GitHub Actions 可手动勾选 `run_e2e` 执行同一套用例。

多语言文案集中在 `shell/ui/translations.slint`，系统语言选择在 `shell/src/i18n.rs`。设置 `MINITRON_LANG=en` / `zh` 可预览两种语言，`auto` 或未设置时跟随系统。修改文案后检查两种语言的五个状态、错误详情和重试，并在根目录运行 `node scripts/check-launcher-languages.mjs ./shell/target/release/electron-shell.exe` 验证发布版帮助输出及回退规则。

提交时包含对应锁文件；不要提交 `dist/`、运行时 ZIP、依赖目录、私钥或本机缓存。对其他平台的改动请注明测试系统，避免将源码支持表述为已完成发行验收。

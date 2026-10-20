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

完整打包、签名发布和 E2E 命令见 [README](README.md)。修改运行时、更新事务、自更新或原生模块打包时，运行完整 Windows E2E；测试使用临时目录和独立共享缓存。GitHub Actions 可手动勾选 `run_e2e` 执行同一套用例。

提交时包含对应锁文件；不要提交 `dist/`、运行时 ZIP、依赖目录、私钥或本机缓存。对其他平台的改动请注明测试系统，避免将源码支持表述为已完成发行验收。

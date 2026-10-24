# Contributing

[README](README.md) · [中文使用指南](docs/usage.zh-CN.md)

## Report a problem

Open a [GitHub issue](https://github.com/aak1247/minitron/issues) with the Minitron and Electron versions, OS and architecture, installer format, expected behavior and reproduction steps. Include a minimal electron-builder configuration when packaging fails. Remove credentials and personal application data from logs before sharing them.

问题报告请包含 Minitron 与 Electron 版本、系统与架构、安装包格式、预期行为和复现步骤。打包问题请附最小 electron-builder 配置；日志中不要包含凭据或个人应用数据。

## Local development

Use Node.js 22.12+ and the Rust toolchain pinned in `.github/workflows/release.yml` (currently 1.92.0). Native addon fixtures also require Python and the platform's C++ build tools. Linux dependencies are listed in the [usage guide](docs/usage.md#platform-requirements).

```sh
npm --prefix app ci
npm --prefix packages/electron-builder ci --ignore-scripts
npm --prefix app test
npm --prefix packages/electron-builder test
node --test scripts/publish-release.test.mjs scripts/build-app.test.mjs scripts/install.test.mjs
node scripts/check-docs.mjs
cargo fmt --manifest-path shell/Cargo.toml --all -- --check
cargo test --manifest-path shell/Cargo.toml --locked
cargo build --manifest-path shell/Cargo.toml --locked --release
```

Run real Electron acceptance tests after changes to launch, download, cache, update or installer behavior. `scripts/download-e2e-runtimes.mjs` fetches and verifies the official fixture archives. Use `scripts/e2e-windows.ps1` on Windows or `scripts/e2e-unix.sh` on Linux/macOS; Linux tests need a desktop session or Xvfb. Reports are written under `dist/`.

启动、下载、缓存、更新和安装器行为的修改，还需运行真实 Electron 端到端验证。Windows 使用 `scripts/e2e-windows.ps1`，Linux/macOS 使用 `scripts/e2e-unix.sh`；Linux 需要桌面会话或 Xvfb。测试归档由 `scripts/download-e2e-runtimes.mjs` 下载并校验，报告写入 `dist/`。

## Changes and documentation

- Keep changes focused and preserve unrelated work in shared checkouts.
- Update both language versions when changing documented behavior. Keep commands copyable and distinguish optional configuration from required steps.
- Preserve the runtime identity of OS, architecture and exact Electron version; application names and IDs must not split otherwise compatible caches.
- Do not modify a runtime held by a live process. Keep reference tracking, leases, atomic state writes and rollback behavior intact.
- Explain the user-visible change and the checks performed in commits or pull requests. Record release-facing changes in `CHANGELOG.md`.

## Release validation

The native launcher and npm package use the same version, including their lockfiles. A `v<version>` tag triggers `.github/workflows/release.yml`.

The workflow runs unit tests, real Electron/native-addon acceptance and npm CLI packaging on Windows x64, Linux x64, macOS x64 and macOS arm64. It publishes GitHub assets only after all four platforms pass. Archives, `SHA256SUMS` and `sizes.json` are collected from those tested builds; release notes come from the matching changelog entry.

Publish the exact `minitron-builder-<version>.tgz` from that release to npm with the `latest` tag. Then verify the public package version, dist-tag and tarball integrity against the GitHub artifact. Do not replace already published artifacts under an existing version; make a new patch release for corrections.

启动器与 npm 包及其锁文件需保持同一版本。四个平台的测试全部通过后才发布 GitHub 产物；npm 必须发布这次 Release 中相同的 tarball，并在发布后核对公开版本、`latest` 标签和 tarball 完整性。已发布版本需要修正时，应发布新的补丁版本。

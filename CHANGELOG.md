# Changelog

Versions apply to both the native Minitron launcher and the `minitron-builder` npm package. Changes to an installed launcher require a rebuilt installer or a configured launcher update; updating the npm dependency alone affects future builds.

版本同时适用于原生启动器与 `minitron-builder` npm 包。已安装的启动器需通过重建安装包或已配置的启动器更新分发；仅更新 npm 依赖只影响后续构建。

## 0.4.2 — 2026-10-24

### Fixed

- Recover and verify a completely downloaded `.part` file before making another HTTP request. This avoids discarding a valid download after an interruption at the final read or commit.
- Keep runtime preparation invisible when it can reuse a complete archive or another installation has already prepared the runtime. Downloads and preparation errors still show the launcher window.
- Log the reason an installed runtime cannot be reused, to make unexpected downloads diagnosable.

### Documentation

- Reorganize the English and Chinese entry points around setup, startup behavior, compatibility and update paths.
- Explain exact-version runtime sharing, cache locations, upgrade behavior and troubleshooting.
- Separate historical size measurements from current release metadata and add contribution and release guidance.

### 中文摘要

- 完整的 `.part` 文件先校验复用，避免最后读取或提交中断后重新下载。
- 复用完整归档或其他安装已准备好的运行时时，不显示引导窗口；下载和错误提示仍保留。
- 记录运行时无法复用的原因，并重新整理中英文文档、缓存与升级说明、历史体积测量和贡献指南。

## 0.4.1 — 2026-10-21

- Move mutable application state outside protected installation directories, including migration of existing state and reconciliation after installer upgrades.
- Support long Windows paths in atomic state replacement and launcher self-updates.
- Provide multiple icon sizes for default NSIS installer and uninstaller icons while preserving custom icons.

Earlier release notes are available on [GitHub Releases](https://github.com/aak1247/minitron/releases).

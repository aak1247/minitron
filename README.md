# minitron

**Smaller Electron packages, shared runtime.**

**English** | [简体中文](README.zh-CN.md)

[![Windows CI](https://github.com/aak1247/minitron/actions/workflows/windows.yml/badge.svg)](https://github.com/aak1247/minitron/actions/workflows/windows.yml)

Package your Electron app separately from its runtime. A small Rust launcher installs the exact Electron version on demand, and multiple apps share that runtime instead of bundling it repeatedly.

The verified Windows x64 example has a **9.63 MiB application directory** and a **5.21 MiB NSIS installer**, excluding Electron. First use still downloads the runtime. These measurements describe the previously verified build; see the [validation report](docs/验证报告.md) for the build commit and measurement details.

- **App-only packages:** ASAR, production dependencies, native module rebuilds and unpacked libraries.
- **Shared runtimes:** exact versions, resumable downloads, SHA256 verification, coordinated installation and safe cleanup.
- **Recoverable updates:** stage in the background, activate on the next launch, and roll back app resources and runtime bindings together.
- **Release tooling:** signed manifests, retained runtime versions, launcher self-updates and per-user Windows installers.
- **English and Chinese:** automatically follow the operating system's preferred display language, with English as the fallback.

**Windows x64 is the validated release platform.** macOS and Linux still require release and end-to-end validation on their respective systems.

## How it works

```text
Application directory             Shared per-user cache
shell.exe                         SharedElectron/versions/win32-x64/v32.2.0/
shell.toml                          electron.exe + Chromium + Node.js
resources/app.asar
resources/app.asar.unpacked/       refs.json + locks/ + leases/
updates/releases/                 isolated by platform, architecture and version
```

The launcher runs `electron.exe <absolute-path-to-app.asar>`. This entry point has `process.defaultApp === true`. Because `process.resourcesPath` points to the shared runtime, resolve app resources through `app.getAppPath()` or `__dirname`. Standard Electron APIs, preload scripts and IPC remain available.

## Build a Windows application

Requirements: **Node.js >=22.12**, **Rust >=1.92**, MSVC and the Windows SDK. Installer builds also require NSIS. Native module rebuilds require Python and C++ build tools. Both npm and Cargo dependencies have lockfiles.

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

Default outputs under `dist/windows/1.0.0/`:

| Output | Contents |
|---|---|
| `application/` | Distributable app directory, excluding Electron |
| `MyApp-Setup-1.0.0.exe` | Per-user NSIS installer |
| `app-1.0.0-win32-x64-electron-32.2.0.zip` | App-only update archive |
| `build.json` | Build settings and artifact paths |

Use `-Makensis <path>` to select NSIS, `-Configuration Debug` for development, or `-SkipInstaller` to assemble only the application directory. `-CargoHome <dir>` isolates Cargo configuration without changing global settings. The script also searches PATH and the local electron-builder NSIS cache.

The ASAR packager stages `npm ci --omit=dev`, rebuilds native modules for the exact Electron version, and unpacks `.node/.dll/.dylib/.so` files and `ffi/`. Add other files requiring real paths to `runtimePackaging.asarUnpack` in the app's package.json.

To package another app:

```powershell
node app/scripts/pack-asar.js --source ../my-electron-app --runtime-version 32.2.0 --version 1.0.0 --out ./dist/resources
```

The source needs package.json, package-lock.json and its entry files. The top-level directory containing `package.main` is included automatically, including layouts such as `dist/main/index.js`. Add extra relative files or directories through `runtimePackaging.files` (explicit paths, not globs). Unsafe paths, symlinks and source/output overlap are rejected. Native rebuilds target the current host platform and architecture.

## Publish an update source

Provide an official Electron ZIP and the app-only ZIP. The publishing tool calculates real hashes and sizes:

```powershell
node scripts/publish-release.mjs --app-id com.example.myapp --version 1.0.0 --runtime-version 32.2.0 --platform win32-x64 --app-zip ./dist/windows/1.0.0/app-1.0.0-win32-x64-electron-32.2.0.zip --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip --base-url https://your-host.example/myapp --out ./dist/publish
```

Upload the generated directory to that base URL. On subsequent releases, pass `--previous-manifest <manifest.json>` to retain historical runtime entries. Keep their runtime archives available as well.

For a local demo, publish with `--base-url http://127.0.0.1:8787 --out ./dist/demo-source`, build with the matching `-ManifestUrl http://127.0.0.1:8787/manifest.json -AllowLocalhostHttp`, then serve the generated source:

```powershell
node scripts/serve-release.mjs --dir ./dist/demo-source --port 8787
```

The repository does not include generated demo artifacts. `manifest/manifest.json` is a template containing deliberately invalid URLs and hash placeholders.

### Sign manifests

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync('release-private.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));"
# Add --signing-key ./release-private.pem to the publish command.
# Build with -ManifestPublicKey <base64 value from dist/publish/public-key.txt>.
```

When a public key is configured, missing signatures, incorrect keys and modified manifests are rejected. Without one, verification uses HTTPS and artifact SHA256 hashes. Keep private keys out of app packages and version control. See the [architecture document](docs/架构设计.md) for signing rules.

Electron 32.2.0 is a reproducible test fixture. Choose a maintained Electron version for production and revalidate native modules. Configure your own CDN, code signing and any required macOS notarization.

## Launch and update

```powershell
./shell.exe                         # Launch a ready app; stage updates in the background
./shell.exe --headless              # Report runtime preparation in the console
./shell.exe --no-update             # Prepare a missing runtime without background app updates
./shell.exe --offline               # Do not access the update source
./shell.exe --check-update          # Prepare a candidate without activating app resources
./shell.exe --rollback              # Restore the retained previous release
./shell.exe --uninstall             # Unregister this installation and safely collect unused runtimes
./shell.exe -- --your-app-argument  # Forward arguments to the Electron app
```

The shared root defaults to the user's local data directory, `%LOCALAPPDATA%/SharedElectron` on Windows. Override it with `ELECTRON_RUNTIME_ROOT`. Each installation path has its own reference; uninstalling one app preserves runtimes used by another installation or a live process. Corrupt registration data causes an error and preserves files.

Updates use immutable release directories and a pending pointer. The next launch activates the complete ASAR, unpacked resources, app version and runtime binding together. Loaded DLLs are not overwritten. App versions are immutable; increment the version for each release.

Apps can opt into readiness reporting through `ERS_READY_FILE` and `ERS_RELEASE_TXID`: after the real page and IPC are ready, atomically write `{"txid":"matching ID","ready":true}`. The example implements this protocol. Unmodified apps use successful exit or a startup grace period as a weak signal, not a business-health guarantee. Crashes after readiness do not trigger automatic rollback.

Launcher updates use `shell.version/platforms` and `app.min_stub_version` in the manifest. Publish with `--shell <new-exe> --shell-version <version> --min-shell-version <minimum>`. A temporary copier waits for the original parent to exit, replaces the launcher, and writes results and logs under the app's updates directory.

## Language

The launcher supports **English** and **Simplified Chinese**. It reads the user's preferred OS display language: `zh-*` selects Chinese; English, unsupported languages and detection failures use English. On Windows, this follows display-language preferences rather than regional date/number formatting.

The window title, status messages, controls, accessibility labels, help text and startup error dialog follow the selected language. Technical error details and machine-readable diagnostic markers retain their original text.

Override detection for testing or a specific installation:

```powershell
$env:MINITRON_LANG = 'en'  # English
$env:MINITRON_LANG = 'zh'  # Chinese
$env:MINITRON_LANG = 'auto' # Follow the operating system (also the default when unset)
```

The launcher preview uses the same translations. In `shell/`, run `cargo run --locked --example launcher-preview -- downloading`. Available preview states: `checking`, `downloading`, `verifying`, `error`, `done`. Append a PPM output path to capture the actual Slint window.

## Tests

```powershell
node --test scripts/publish-release.test.mjs
cd app
npm test
cd ../shell
cargo test --locked
cargo check --locked
cd ..
./scripts/e2e-windows.ps1 -RuntimeZip C:/downloads/electron-v32.2.0-win32-x64.zip -UpgradeRuntimeZip C:/downloads/electron-v33.3.1-win32-x64.zip
```

E2E uses temporary directories, a loopback update source and temporary signing keys. It covers the actual download UI, Electron page/preload/IPC, native addons, offline launch, shared uninstall, staging, activation, rollback, runtime upgrades, concurrency, orphan-process leases, corrupt registration data and genuine launcher self-updates. Results are saved to `dist/e2e-report.json`.

Smoke mode uses software rendering and starts its watchdog before Electron readiness. The suite defaults to a release launcher and builds a debug 0.1.1 self-update fixture. Use `-ShellBinary` and `-NewShellBinary` for existing binaries. Tests use an isolated cache.

GitHub Actions runs Node/Rust tests, release builds and NSIS compilation on pushes and pull requests. To run the complete E2E suite, manually start **Windows CI** with `run_e2e` enabled.

## Repository layout

| Path | Purpose |
|---|---|
| `app/` | Standard Electron example, ASAR packager and tests |
| `shell/` | Rust/Slint launcher, runtime management and updates |
| `scripts/` | Windows builds, manifest publishing, local server and E2E |
| `installer/` | Per-user NSIS installer |
| `manifest/` | Update manifest template |
| `docs/` | [Architecture](docs/架构设计.md) and [validation report](docs/验证报告.md) (Chinese) |

Only source is committed. Build commands generate dependency caches, application artifacts and local demo sources. See the [contributing guide](CONTRIBUTING.md) (Chinese) for development instructions.

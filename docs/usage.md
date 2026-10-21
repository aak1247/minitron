# Usage guide

[README](../README.md) · **English** | [简体中文](usage.zh-CN.md)

## Packaging an app

For branded desktop installers, use the [electron-builder adapter](../packages/electron-builder/README.md): Windows NSIS, Linux DEB/RPM, or macOS DMG/PKG. The scripts below create portable app directories.

The source directory needs `package.json`, `package-lock.json` and its built entry files. Install Node.js 22.12+ and get the packaging tools:

```sh
git clone https://github.com/aak1247/minitron.git
cd minitron
npm --prefix app ci
```

Windows (PowerShell):

```powershell
./install.ps1 -InstallDir ./bin
node scripts/build-app.mjs --source ../my-electron-app --launcher ./bin/minitron.exe --out ./dist/myapp --app-id com.example.myapp --runtime-version 32.2.0 --manifest-url https://example.com/myapp/manifest.json
./dist/myapp/application/minitron.exe
```

Linux / macOS:

```sh
sh ./install.sh --dir ./bin
sh scripts/build-unix.sh --source ../my-electron-app --launcher ./bin/minitron --out ./dist/myapp --app-id com.example.myapp --runtime-version 32.2.0 --manifest-url https://example.com/myapp/manifest.json
./dist/myapp/application/minitron
```

The app version defaults to the source project's `package.json`; override it with `--version 1.0.0`. Set your source path, Electron version and update URL, then host the update source described below. Native modules are rebuilt for the current system and architecture and require Python and C++ build tools.

`dist/myapp/application/` is the complete app directory without Electron. The adjacent `app-<version>-<platform>-<arch>-electron-<version>.zip` is the app update package. On macOS, the output is a directory launched from the terminal; it is not wrapped in an `.app` or `.dmg`.

The packager includes the directory containing `package.main`. Extra files and resources that need a real filesystem path can be configured in the app's `package.json`:

```json
{
  "runtimePackaging": {
    "files": ["config", "assets"],
    "asarUnpack": ["ffi/**"]
  }
}
```

`files` accepts relative files or directories; `asarUnpack` accepts glob patterns. Native libraries are unpacked automatically.

Resolve app resources with `app.getAppPath()` or `__dirname`. `process.resourcesPath` points to the shared Electron runtime. Native libraries and other unpacked files are stored beside the archive in `app.asar.unpacked/`.

## Publishing updates

Create an update source from the app ZIP and an official Electron ZIP:

```powershell
node scripts/publish-release.mjs --app-id com.example.myapp --version 1.0.0 --runtime-version 32.2.0 --platform win32-x64 --app-zip ./dist/myapp/app-1.0.0-win32-x64-electron-32.2.0.zip --runtime-zip C:/downloads/electron-v32.2.0-win32-x64.zip --base-url https://example.com/myapp --out ./dist/publish
```

Host the contents of `dist/publish` at the base URL, with `manifest.json` available at the launcher's configured `ManifestUrl`.

For later releases, increase the app version and add `--previous-manifest <previous-manifest.json>`. This preserves runtime entries needed by older installations; keep the corresponding archives available.

Use a separate publishing directory and manifest URL for each system and architecture. For Linux x64, use `--platform linux-x64`; for Mac, use `darwin-x64` or `darwin-arm64`, with the matching app ZIP and official Electron ZIP.

To distribute a launcher update, add `--shell <minitron-binary> --shell-version <version>`. Use `--min-shell-version <version>` when an app release needs a particular launcher version.

### Signed updates

Generate an Ed25519 private key:

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync('release-private.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));"
```

Add `--signing-key ./release-private.pem` to the publish command. Build the app with `--manifest-public-key <value-from-public-key.txt>`, using the generated `dist/publish/public-key.txt`. Only the public key belongs in the application.

### Local update source

Publish with `--base-url http://127.0.0.1:8787 --out ./dist/local-source`. Build with `--manifest-url http://127.0.0.1:8787/manifest.json --allow-localhost-http`, then start the server:

```powershell
node scripts/serve-release.mjs --dir ./dist/local-source --port 8787
```

## Configuration

The build script generates `minitron.toml` beside the launcher:

| Setting | Use |
|---|---|
| `app_id` | Application identifier |
| `app_version` | Initially installed app version |
| `required_runtime` | Exact Electron version |
| `manifest_url` | Update manifest URL |
| `manifest_public_key` | Optional Ed25519 public key |
| `allow_localhost_http` | Allow a local HTTP update source |

Build options include `-Makensis <path>` for NSIS, `-OutputDirectory <path>` for output, and `-SkipInstaller` for an app directory without an installer.

Shared runtimes use `%LOCALAPPDATA%/SharedElectron` on Windows, `$XDG_DATA_HOME/SharedElectron` (default `~/.local/share/SharedElectron`) on Linux, or `~/Library/Application Support/SharedElectron` on macOS. Set `ELECTRON_RUNTIME_ROOT` to use a different directory. Uninstalling an app preserves runtimes still used by other apps.

## Launcher options

| Option | Use |
|---|---|
| `--offline` | Launch without network access |
| `--no-update` | Skip app update checks; a missing runtime can still download |
| `--headless` | Show runtime preparation in the console |
| `--check-update` | Download an update for the next launch |
| `--rollback` | Restore the previous app version |
| `--uninstall` | Unregister this installation and clean up unused runtimes |
| `-- <arguments>` | Pass arguments to the app |

Language selection is controlled by `MINITRON_LANG=en`, `zh` or `auto`. With no override, the launcher follows the system display language and falls back to English.

## Windows installer

With NSIS installed, create an installer from the same prebuilt launcher and app resources:

```powershell
./scripts/build-windows.ps1 -SkipAppBuild -ShellBinary ./bin/minitron.exe -OutputDirectory ./dist/myapp -AppId com.example.myapp -AppName MyApp -AppVersion 1.0.0 -RuntimeVersion 32.2.0 -ManifestUrl https://example.com/myapp/manifest.json
```

The output is `dist/myapp/MyApp-Setup-1.0.0.exe`. Use `-Makensis <path>` to select the NSIS executable.

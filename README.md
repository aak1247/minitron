# minitron

**Smaller Electron packages, shared runtime.**

**English** | [简体中文](README.zh-CN.md) · [Downloads](https://github.com/aak1247/minitron/releases/latest)

minitron packages Electron apps separately from their runtime. Apps ship with a small native launcher and reuse the same Electron installation, reducing repeated runtime downloads and app update sizes.

- App-only ASAR packages, including native modules.
- Shared runtimes with resumable downloads and automatic cleanup.
- Background updates and rollback to the previous app version.
- English and Chinese, selected from the system display language.

Available for **Windows x64, Linux x64, and macOS Intel / Apple Silicon**. Electron downloads on the first app launch and is shared by apps using the same version.

![minitron launcher](docs/images/launcher-en.png)

## Install

Download a [prebuilt binary](https://github.com/aak1247/minitron/releases/latest), or install the latest launcher with a script. No Rust toolchain is needed.

### Windows

```powershell
Invoke-WebRequest https://github.com/aak1247/minitron/releases/latest/download/install.ps1 -OutFile "$env:TEMP/minitron-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP/minitron-install.ps1" -InstallDir ./minitron-bin
./minitron-bin/minitron.exe --help
```

### Linux / macOS

```sh
curl -fsSL https://github.com/aak1247/minitron/releases/latest/download/install.sh -o /tmp/minitron-install.sh
sh /tmp/minitron-install.sh --dir ./minitron-bin
./minitron-bin/minitron --help
```

The scripts select the native binary and check its SHA-256 checksum. Use `-Version v0.1.0` on Windows or `--version v0.1.0` on Linux/macOS to select a release. Existing app configuration and resources are preserved.

Linux requires a desktop environment with glibc 2.35+, fontconfig, X11 or Wayland, and xkbcommon. On Ubuntu 22.04+, install the launcher dependencies with `sudo apt-get install libfontconfig1 libxkbcommon0 libxkbcommon-x11-0 libx11-xcb1 libxcursor1 libxi6`. Electron also needs its usual desktop libraries.

## Package an app

Install Node.js 22.12+ and follow the [packaging guide](docs/usage.md#packaging-an-app). The Windows and Linux/macOS scripts use a prebuilt launcher to produce:

```text
application/
  minitron.exe         # minitron on Linux/macOS
  minitron.toml
  resources/
    app.asar
    app.asar.unpacked/ # when needed
```

Distribute this directory to users. Open `minitron.exe` on Windows or run `./minitron` on Linux/macOS. App updates download in the background and activate on the next launch. The update ZIP contains only app resources.

A Windows installer is also available through the [NSIS packaging script](docs/usage.md#windows-installer).

## Language

The launcher follows the system display language: Simplified Chinese for Chinese systems, English otherwise. Override it with `MINITRON_LANG=en`, `zh` or `auto`.

See the [usage guide](docs/usage.md) for configuration, signed updates and launcher options.

# electron-builder example

Use Minitron from an existing Electron project without changing its normal development workflow. Install the npm CLI and build as usual:

```sh
npm install -D minitron-builder
npm run build
npx minitron-builder
```

Skip the build command if the app is already compiled. The CLI reads the project's existing electron-builder config or `package.json` `build` field, keeps the app's files, `extraResources`, `asarUnpack`, icons and installer options, and downloads the matching launcher. Require `asar: true`.

A compact cross-platform `package.json` configuration looks like this:

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

The default target is the current platform. To select a target explicitly:

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Build macOS x64 and arm64 separately. Linux DEB/RPM needs a homepage URL and a real maintainer email. Output goes to the configured `directories.output`, or `dist` by default.

No update server is needed for first launch. The app downloads its shared Electron runtime from the official Electron distribution; an app update manifest can be added later. See the [update guide](../../docs/usage.md#publishing-updates). The app's `extraResources` are installed with the package but are not included in Minitron app update archives.

## Low-level adapter

The adjacent [`electron-builder.config.cjs`](electron-builder.config.cjs) demonstrates the direct `withMinitron` API for projects that want to configure launcher and manifest paths themselves. It is not required for the CLI workflow above. See the [adapter guide](../../packages/electron-builder/README.md) for installer lifecycle behavior, manual launcher installation, and advanced settings.

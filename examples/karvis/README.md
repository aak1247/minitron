# Karvis AI with Minitron

This example packages the existing `karvis-electron` app without changing its source. The app keeps its Karvis name, icon and assets; Minitron supplies the small launcher and downloads Electron on first launch.

Keep the existing app identity and icons in electron-builder settings, with ASAR enabled. For this Karvis layout, set the packaged entry and assets in the existing `build` configuration:

```json
{
  "extraMetadata": { "main": "dist/main/index.js" },
  "extraResources": [
    { "from": "assets", "to": "assets", "filter": ["**/*"] }
  ],
  "asar": true
}
```

Merge these keys into the existing `build` object and preserve its other packaging settings. `extraResources` installs `assets/` beside `app.asar`. The optional [`electron-builder.config.cjs`](electron-builder.config.cjs) shows the equivalent lower-level adapter configuration.

From the `karvis-electron` project directory, install the CLI and build the app:

```sh
npm install -D minitron-builder
npm run build
npx minitron-builder
```

Skip `npm run build` if the app is already compiled.

By default, the CLI builds for the current platform. Select installer formats as needed:

```sh
npx minitron-builder --win nsis
npx minitron-builder --linux deb rpm
npx minitron-builder --mac dmg pkg --x64
npx minitron-builder --mac dmg pkg --arm64
```

Build macOS x64 and arm64 separately. Linux DEB/RPM builds require a homepage URL and a real maintainer email in the app metadata or Linux settings. Output uses the configured `directories.output`, or `dist` by default.

Windows uses the NSIS installer, Linux uses DEB/RPM, and macOS uses DMG/PKG. Install through the normal installer or Applications folder and start Karvis AI from its usual shortcut. Minitron downloads the matching official Electron runtime on first launch; no app-update server is needed to get started. A manifest can be added later for app updates. `extraResources` are not included in Minitron app update archives, and `electron-updater` is not automatically connected.

On macOS, run `"/Applications/Karvis AI.app/Contents/Resources/minitron-uninstall.command"` from Terminal before deleting the app. Dragging the app to Trash does not run the script.

For supported targets and update behavior, see the [adapter guide](../../packages/electron-builder/README.md) and [general electron-builder example](../electron-builder/README.md).

"use strict";

const { withMinitron } = require("@minitron/electron-builder");

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be set before running electron-builder`);
  }
  return value;
}

const appConfig = {
  appId: "com.example.desktop",
  productName: "Example Desktop",
  directories: {
    output: "release",
    buildResources: "build",
  },
  files: ["dist/**", "package.json"],
  extraResources: [
    {
      from: "resources",
      to: "example-resources",
      filter: ["**/*"],
    },
  ],
  asar: true,
  asarUnpack: ["node_modules/better-sqlite3/**"],
  win: {
    target: ["nsis"],
    icon: "build/app.ico",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Example Desktop",
    installerIcon: "build/installer.ico",
    uninstallerIcon: "build/uninstaller.ico",
    deleteAppDataOnUninstall: false,
  },
};

module.exports = withMinitron(appConfig, {
  launcherPath: requiredEnvironmentValue("MINITRON_LAUNCHER"),
  manifestUrl: requiredEnvironmentValue("MINITRON_MANIFEST_URL"),
  iconPath: "build/minitron-icon.png",
});

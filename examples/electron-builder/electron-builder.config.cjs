"use strict";

const { withMinitron } = require("minitron-builder");

function linuxBuildRequested() {
  return process.argv.some((argument) =>
    argument.startsWith("--linux") || argument === "-l" || (/^-[^-]+$/.test(argument) && argument.slice(1).includes("l")));
}

const linuxMaintainer = process.env.MINITRON_MAINTAINER;
if (linuxBuildRequested() && !/\S+@\S+\.\S+/.test(linuxMaintainer || "")) {
  throw new Error("Linux DEB/RPM builds require MINITRON_MAINTAINER with an actual email, for example 'Your Name <you@company.com>'");
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
  linux: {
    target: ["deb", "rpm"],
    maintainer: linuxMaintainer,
    icon: "build/app.png",
  },
  mac: {
    target: ["dmg", "pkg"],
    icon: "build/app.png",
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
  ...(process.env.MINITRON_LAUNCHER ? { launcherPath: process.env.MINITRON_LAUNCHER } : {}),
  ...(process.env.MINITRON_MANIFEST_URL ? { manifestUrl: process.env.MINITRON_MANIFEST_URL } : {}),
  iconPath: "build/minitron-icon.png",
});

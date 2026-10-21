"use strict";

const path = require("node:path");
const { withMinitron } = require("minitron-builder");

function emailIn(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\S+@\S+\.\S+/);
  return match ? value.trim() : undefined;
}

function packageAuthorMaintainer(author) {
  if (author && typeof author === "object") return emailIn(author.email);
  return emailIn(author);
}

function linuxBuildRequested() {
  return process.argv.some((argument) =>
    argument.startsWith("--linux") || argument === "-l" || (/^-[^-]+$/.test(argument) && argument.slice(1).includes("l")));
}

const projectDir = process.cwd();
const projectPackage = require(path.join(projectDir, "package.json"));
const originalBuild = projectPackage.build || {};
const linuxMaintainer = emailIn(process.env.MINITRON_MAINTAINER)
  || emailIn(originalBuild.linux?.maintainer)
  || packageAuthorMaintainer(projectPackage.author);
if (linuxBuildRequested() && !linuxMaintainer) {
  throw new Error("Linux DEB/RPM builds require a real email: set MINITRON_MAINTAINER or add an email to package.json author");
}
const appConfig = {
  ...originalBuild,
  appId: originalBuild.appId || "com.karvis.ai",
  productName: originalBuild.productName || "Karvis AI",
  directories: {
    ...originalBuild.directories,
    output: "release",
  },
  files: originalBuild.files || ["dist/**/*", "assets/**/*"],
  extraResources: [
    ...(originalBuild.extraResources || []),
    {
      from: "assets",
      to: "assets",
      filter: ["**/*"],
    },
  ],
  extraMetadata: {
    ...originalBuild.extraMetadata,
    main: "dist/main/index.js",
  },
  asar: true,
  win: {
    ...originalBuild.win,
    target: ["nsis"],
    icon: originalBuild.win?.icon || "assets/icon.png",
  },
  linux: {
    ...originalBuild.linux,
    target: ["deb", "rpm"],
    icon: originalBuild.linux?.icon || "assets/icon.png",
    ...(linuxMaintainer ? { maintainer: linuxMaintainer } : {}),
  },
  mac: {
    ...originalBuild.mac,
    target: ["dmg", "pkg"],
  },
  nsis: {
    ...originalBuild.nsis,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Karvis AI",
    deleteAppDataOnUninstall: false,
  },
};

module.exports = withMinitron(appConfig, {
  projectDir: path.resolve(projectDir),
  ...(process.env.MINITRON_LAUNCHER ? { launcherPath: process.env.MINITRON_LAUNCHER } : {}),
  ...(process.env.MINITRON_MANIFEST_URL ? { manifestUrl: process.env.MINITRON_MANIFEST_URL } : {}),
  iconPath: "assets/icon.png",
});

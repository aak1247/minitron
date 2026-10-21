"use strict";

const path = require("node:path");
const { withMinitron } = require("@minitron/electron-builder");

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be set before running electron-builder`);
  }
  return value;
}

const projectDir = process.cwd();
const projectPackage = require(path.join(projectDir, "package.json"));
const originalBuild = projectPackage.build || {};
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
  launcherPath: requiredEnvironmentValue("MINITRON_LAUNCHER"),
  manifestUrl: requiredEnvironmentValue("MINITRON_MANIFEST_URL"),
  iconPath: "assets/icon.png",
});

"use strict";

const path = require("node:path");
const { composeInstallerInclude } = require("./lib/nsis-include");
const { createAfterPackHook } = require("./lib/after-pack");

const DEFAULT_INSTALLER_INCLUDE = path.join(__dirname, "installer.nsh");

function withMinitron(config, options) {
  if (!isRecord(config)) {
    throw new TypeError("withMinitron(config, options) requires a builder configuration object");
  }
  if (!isRecord(options)) {
    throw new TypeError("withMinitron(config, options) requires an options object");
  }
  if (config.asar === false) {
    throw new Error("Minitron requires electron-builder ASAR packaging; set build.asar to true or omit it");
  }

  const launcherPath = requireString(options.launcherPath, "options.launcherPath");
  const manifestUrl = requireString(options.manifestUrl, "options.manifestUrl");
  const projectDir = path.resolve(options.projectDir || config.projectDir || process.cwd());
  const lifecycleIncludePath = options.installerIncludePath === undefined
    ? DEFAULT_INSTALLER_INCLUDE
    : resolveFromProject(requireString(options.installerIncludePath, "options.installerIncludePath"), projectDir);
  const userIncludes = config.nsis && config.nsis.include != null ? config.nsis.include : [];
  const includePath = composeInstallerInclude({ userIncludes, lifecycleIncludePath, projectDir });

  return {
    ...config,
    nsis: {
      ...(isRecord(config.nsis) ? config.nsis : {}),
      include: includePath,
    },
    afterPack: createAfterPackHook(config.afterPack, {
      launcherPath,
      manifestUrl,
      allowLocalhostHttp: options.allowLocalhostHttp,
      manifestPublicKey: options.manifestPublicKey,
      runtimeVersion: options.runtimeVersion,
      iconPath: options.iconPath,
    }),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function resolveFromProject(value, projectDir) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectDir, value);
}

module.exports = { withMinitron };

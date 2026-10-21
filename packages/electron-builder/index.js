"use strict";

const path = require("node:path");
const { composeInstallerInclude } = require("./lib/nsis-include");
const { createAfterPackHook } = require("./lib/after-pack");

const DEFAULT_INSTALLER_INCLUDE = path.join(__dirname, "installer.nsh");

function withMinitron(config, options = {}) {
  if (!isRecord(config)) {
    throw new TypeError("withMinitron(config, options) requires a builder configuration object");
  }
  if (!isRecord(options)) {
    throw new TypeError("withMinitron(config, options) requires an options object");
  }
  if (config.asar === false) {
    throw new Error("Minitron requires electron-builder ASAR packaging; set build.asar to true or omit it");
  }

  const launcherPath = options.launcherPath === undefined
    ? undefined
    : requireString(options.launcherPath, "options.launcherPath");
  const manifestUrl = options.manifestUrl === undefined
    ? ""
    : requireOptionalString(options.manifestUrl, "options.manifestUrl");
  const configuredProjectDir = options.projectDir === undefined ? config.projectDir : options.projectDir;
  if (configuredProjectDir !== undefined && (typeof configuredProjectDir !== "string" || configuredProjectDir.trim() === "")) {
    throw new TypeError("options.projectDir or config.projectDir must be a non-empty path when provided");
  }
  const projectDir = path.resolve(configuredProjectDir || process.cwd());
  const lifecycleIncludePath = options.installerIncludePath === undefined
    ? DEFAULT_INSTALLER_INCLUDE
    : resolveFromProject(requireString(options.installerIncludePath, "options.installerIncludePath"), projectDir);
  const userIncludes = config.nsis && config.nsis.include != null ? config.nsis.include : [];
  const includePath = composeInstallerInclude({ userIncludes, lifecycleIncludePath, projectDir });
  const linuxConfig = isRecord(config.linux) ? { ...config.linux } : {};
  if (linuxConfig.target === undefined) {
    linuxConfig.target = ["deb", "rpm"];
  }

  return {
    ...config,
    linux: linuxConfig,
    nsis: {
      ...(isRecord(config.nsis) ? config.nsis : {}),
      include: includePath,
    },
    afterPack: createAfterPackHook(config.afterPack, {
      launcherPath,
      launcherVersion: options.launcherVersion,
      projectDir: configuredProjectDir === undefined ? undefined : projectDir,
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

function requireOptionalString(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string when provided`);
  }
  return value;
}

function resolveFromProject(value, projectDir) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectDir, value);
}

module.exports = { withMinitron };

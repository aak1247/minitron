"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { composeInstallerInclude } = require("./lib/nsis-include");
const { createAfterPackHook } = require("./lib/after-pack");

const DEFAULT_INSTALLER_INCLUDE = path.join(__dirname, "installer.nsh");
const temporaryIconDirectories = new Set();

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
  const nsisConfig = isRecord(config.nsis) ? { ...config.nsis } : {};
  const nsisIconPath = configureDefaultNsisIcons(nsisConfig, config, projectDir);
  const userIncludes = nsisConfig.include != null ? nsisConfig.include : [];
  const includePath = composeInstallerInclude({ userIncludes, lifecycleIncludePath, projectDir });
  const linuxConfig = isRecord(config.linux) ? { ...config.linux } : {};
  if (linuxConfig.target === undefined) {
    linuxConfig.target = ["deb", "rpm"];
  }

  return {
    ...config,
    linux: linuxConfig,
    nsis: { ...nsisConfig, include: includePath },
    afterPack: createAfterPackHook(config.afterPack, {
      launcherPath,
      launcherVersion: options.launcherVersion,
      projectDir: configuredProjectDir === undefined ? undefined : projectDir,
      manifestUrl,
      allowLocalhostHttp: options.allowLocalhostHttp,
      manifestPublicKey: options.manifestPublicKey,
      runtimeVersion: options.runtimeVersion,
      iconPath: options.iconPath,
      nsisIconPath,
    }),
  };
}

function configureDefaultNsisIcons(nsisConfig, config, projectDir) {
  const buildResources = typeof (config.directories && config.directories.buildResources) === "string"
    && config.directories.buildResources.trim() !== ""
    ? config.directories.buildResources
    : "build";
  const buildResourcesDir = resolveFromProject(buildResources, projectDir);
  let generatedIconPath;

  for (const [option, filename] of [
    ["installerIcon", "installerIcon.ico"],
    ["uninstallerIcon", "uninstallerIcon.ico"],
  ]) {
    const configuredIcon = nsisConfig[option];
    const usesBuilderDefault = configuredIcon == null
      || (typeof configuredIcon === "string" && configuredIcon.trim() === "");
    if (!usesBuilderDefault || fs.existsSync(path.join(buildResourcesDir, filename))) continue;
    generatedIconPath ||= path.join(createTemporaryIconDirectory(), "application.ico");
    nsisConfig[option] = generatedIconPath;
  }
  return generatedIconPath;
}

function createTemporaryIconDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-nsis-icons-"));
  temporaryIconDirectories.add(directory);
  return directory;
}

function cleanupTemporaryIconDirectories() {
  for (const directory of temporaryIconDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // The installer has already been built; cleanup is best-effort.
    }
  }
  temporaryIconDirectories.clear();
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

process.once("exit", cleanupTemporaryIconDirectories);

module.exports = { withMinitron };

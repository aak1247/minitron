"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const asar = require("@electron/asar");
const pickle = require("chromium-pickle-js");
const {
  renderConfig,
  validateManifestUrl,
  validatePublicKey,
  validateRuntimeDownloadArtifact,
  validateStableVersion,
} = require("./validation");
const {
  assertNotUniversalIntermediate,
  getMacArchitecture,
  removeMacElectronRuntimeFiles,
  replaceMacExecutable,
  resolveMacBundlePaths,
  resolveMacElectronBundle,
  validateMacElectronVersion,
  writeMacUninstaller,
} = require("./mac-app");
const { composeMacPkgLifecycle } = require("./mac-pkg");
const { withLinuxInstallers } = require("./linux-installer");

const CJS_BOOTSTRAP_ENTRY = "__minitron_bootstrap__.cjs";
const ESM_BOOTSTRAP_ENTRY = "__minitron_bootstrap__.mjs";
const BOOTSTRAP_ENTRIES = [CJS_BOOTSTRAP_ENTRY, ESM_BOOTSTRAP_ENTRY];
const MINIMUM_LAUNCHER_VERSIONS = {
  win32: [0, 2, 0],
  linux: [0, 3, 0],
  darwin: [0, 3, 0],
};
const MINIMUM_EMBEDDED_LAUNCHER_VERSION = [0, 4, 0];
const BUILDER_ARCHITECTURES = new Map([
  ["ia32", "ia32"], [0, "ia32"],
  ["x64", "x64"], [1, "x64"],
  ["armv7l", "armv7l"], [2, "armv7l"],
  ["arm64", "arm64"], [3, "arm64"],
  ["universal", "universal"], [4, "universal"],
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createAfterPackHook(previousHook, options, spawn = spawnSync, resolvers = {}) {
  return async (context) => {
    assertSupportedPlatform(context.electronPlatformName);
    if (previousHook != null) {
      const resolved = await resolveHook(previousHook, context);
      if (typeof resolved !== "function") {
        throw new TypeError("The existing electron-builder afterPack hook did not resolve to a function");
      }
      await resolved(context);
    }
    if (context.electronPlatformName === "linux") {
      composeLinuxInstallerLifecycle(context, options.projectDir);
    }
    await afterPack(context, options, spawn, resolvers);
  };
}

async function resolveHook(hook, context) {
  if (typeof hook !== "string") return hook;
  const projectDir = resolveProjectDir(context.packager);
  let resolvedPath;
  try {
    resolvedPath = require.resolve(hook, { paths: [projectDir] });
  } catch {
    resolvedPath = path.isAbsolute(hook) ? hook : path.resolve(projectDir, hook);
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  const isModule = context.packager.appInfo && context.packager.appInfo.type === "module";
  const loaded = extension === ".mjs" || (extension === ".js" && isModule)
    ? await import(pathToFileURL(resolvedPath).href)
    : require(resolvedPath);
  return loaded.afterPack || loaded.default || loaded;
}

function composeLinuxInstallerLifecycle(context, requestedProjectDir) {
  const packager = context.packager;
  if (!packager || typeof packager !== "object") {
    throw new Error("Minitron Linux installer lifecycle requires electron-builder's resolved packager context");
  }
  const appInfo = packager.appInfo;
  if (!appInfo || typeof appInfo !== "object") {
    throw new Error("electron-builder did not expose resolved appInfo for Linux installer lifecycle composition");
  }
  const productName = requireResolvedString(appInfo.productName, "appInfo.productName");
  const executableName = requireResolvedString(packager.executableName, "packager.executableName");
  const projectDir = requestedProjectDir === undefined
    ? resolveProjectDir(packager)
    : path.resolve(requestedProjectDir);
  const packagerConfig = isRecord(packager.config) ? packager.config : {};
  const configuredLinux = isRecord(packagerConfig.linux) ? packagerConfig.linux : {};
  const resolvedLinux = isRecord(packager.platformSpecificBuildOptions)
    ? packager.platformSpecificBuildOptions
    : {};
  const targetInstances = Array.isArray(context.targets) ? context.targets : [];
  const targetNames = targetInstances.map((target) => {
    if (!target || typeof target.name !== "string" || target.name.trim() === "") {
      throw new Error("electron-builder Linux afterPack context contains a target without a resolved name");
    }
    return target.name;
  });
  const installerConfig = {
    ...packagerConfig,
    projectDir,
    productName,
    executableName,
    linux: {
      ...configuredLinux,
      ...resolvedLinux,
      executableName,
      ...(targetNames.length > 0 ? { target: targetNames } : {}),
    },
  };
  const packageTargets = targetInstances.filter((target) => ["deb", "rpm"].includes(target.name.toLowerCase()));

  for (const target of packageTargets) {
    if (!isRecord(target.options)) {
      throw new Error(`electron-builder Linux ${target.name} target has no mutable options object`);
    }
    const name = target.name.toLowerCase();
    const configuredTarget = isRecord(packagerConfig[name]) ? packagerConfig[name] : {};
    const packageOptions = {
      ...configuredTarget,
      ...target.options,
    };
    const targetFpm = target.options.fpm !== undefined
      ? target.options.fpm
      : configuredTarget.fpm !== undefined
        ? configuredTarget.fpm
        : installerConfig.linux.fpm;
    packageOptions.fpm = targetFpm;
    installerConfig[name] = packageOptions;
  }

  const composed = withLinuxInstallers(installerConfig, { projectDir });
  for (const target of packageTargets) {
    const name = target.name.toLowerCase();
    const options = composed.config[name];
    if (!options || !Array.isArray(options.fpm)) {
      throw new Error(`Minitron failed to compose Linux ${name} FPM lifecycle arguments`);
    }
    target.options.fpm = options.fpm;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function afterPack(context, options, spawn = spawnSync, resolvers = {}) {
  assertSupportedPlatform(context && context.electronPlatformName);
  const packager = context && context.packager;
  if (!packager || typeof packager !== "object") {
    throw new Error("Minitron afterPack requires electron-builder's resolved packager context");
  }

  const projectDir = options.projectDir === undefined ? resolveProjectDir(packager) : path.resolve(options.projectDir);
  const appOutDir = path.resolve(context.appOutDir);
  if (!fs.existsSync(appOutDir) || !fs.statSync(appOutDir).isDirectory()) {
    throw new Error(`electron-builder appOutDir does not exist: ${appOutDir}`);
  }

  const appInfo = packager.appInfo;
  if (!appInfo || typeof appInfo !== "object") {
    throw new Error("electron-builder did not expose resolved appInfo in afterPack context");
  }
  const appId = requireResolvedString(appInfo.id, "appInfo.id");
  const appVersion = validateStableVersion(appInfo.version, "appInfo.version");
  const frameworkVersion = packager.info && packager.info.framework && packager.info.framework.version;
  const runtimeVersion = resolveRuntimeVersion(options.runtimeVersion, frameworkVersion);
  const allowLocalhostHttp = options.allowLocalhostHttp === undefined ? false : options.allowLocalhostHttp;
  const manifestUrl = validateManifestUrl(options.manifestUrl, allowLocalhostHttp);
  const manifestPublicKey = validatePublicKey(options.manifestPublicKey);
  const arch = resolveTargetArchitecture(context.electronPlatformName, context.arch);
  const requiresEmbeddedRuntime = manifestUrl === "";
  const macBundlePaths = context.electronPlatformName === "darwin"
    ? resolveMacBundlePaths(appOutDir, appInfo)
    : undefined;
  const resourcesDir = macBundlePaths ? macBundlePaths.resourcesDir : path.join(appOutDir, "resources");
  if (!fs.existsSync(resourcesDir) || !fs.statSync(resourcesDir).isDirectory()) {
    throw new Error(`electron-builder resources directory does not exist: ${resourcesDir}`);
  }
  const executable = resolveExecutable(context, appInfo);
  const iconPath = await resolveIconPath(context, options, projectDir);
  const electronDist = resolveElectronDist(packager, projectDir);
  let macElectronBundle;
  let macArchitecture;
  if (macBundlePaths) {
    assertNotUniversalIntermediate(appOutDir);
    macArchitecture = getMacArchitecture(context.arch);
    validateMacElectronVersion(electronDist, runtimeVersion);
    macElectronBundle = resolveMacElectronBundle(electronDist, packager);
  } else {
    validateElectronDist(electronDist, context.electronPlatformName, runtimeVersion);
  }
  if (packager.config && packager.config.asar === false) {
    throw new Error("Minitron requires electron-builder ASAR packaging; build.asar must not be false");
  }

  const appAsar = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(appAsar)) {
    throw new Error(`Minitron requires electron-builder's standard resources/app.asar output: ${appAsar}`);
  }
  const launcherPath = await resolveLauncherPath(options, projectDir, context.electronPlatformName, arch, resolvers);
  assertLauncherFile(launcherPath);
  const requiresModernLauncher = requiresEmbeddedRuntime || options.launcherPath === undefined;
  const launcherVersion = verifyLauncherVersion(
    launcherPath,
    spawn,
    context.electronPlatformName,
    requiresModernLauncher ? MINIMUM_EMBEDDED_LAUNCHER_VERSION : undefined,
  );
  const runtimeDownload = requiresEmbeddedRuntime
    ? await resolveRuntimeDownloadArtifact(
      options,
      resolvers,
      runtimeVersion,
      context.electronPlatformName,
      arch,
    )
    : undefined;
  const configText = renderConfig({
    appId,
    appVersion,
    runtimeVersion,
    manifestUrl,
    allowLocalhostHttp,
    manifestPublicKey,
    runtimeDownload,
  });
  await patchAsar(appAsar, resourcesDir, {
    appId,
    appVersion,
    productName: requireResolvedString(appInfo.productName, "appInfo.productName"),
    executableName: executable.name,
    runtimeVersion,
    manifestUrl,
    allowLocalhostHttp,
    manifestPublicKey,
  });

  const configPath = macBundlePaths ? macBundlePaths.configPath : path.join(appOutDir, "minitron.toml");
  writeFileIfSameOrMissing(configPath, configText, "Minitron configuration");
  copyIcon(iconPath, path.join(resourcesDir, "minitron-icon.png"));
  if (macBundlePaths) {
    await replaceMacExecutable(
      launcherPath,
      executable.path,
      macElectronBundle.executablePath,
      launcherVersion,
      macArchitecture,
      replaceExecutable,
    );
    await removeMacElectronRuntimeFiles(macElectronBundle, macBundlePaths, appInfo);
    writeMacUninstaller(macBundlePaths);
    composeMacPkgLifecycle(context, macBundlePaths, appInfo);
  } else {
    replaceExecutable(launcherPath, executable.path, launcherVersion, context.electronPlatformName);
    await removeOfficialRuntimeFiles(electronDist, appOutDir, executable.relativePath);
  }
}

function assertSupportedPlatform(platform) {
  if (platform === "mas") throw new Error("Minitron does not support the macOS App Store (MAS) target");
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
    throw new Error(`Minitron supports only electron-builder win32, linux, and darwin targets; received ${String(platform)}`);
  }
}

function resolveProjectDir(packager) {
  const projectDir = packager.projectDir || (packager.info && packager.info.projectDir);
  if (typeof projectDir !== "string" || projectDir.trim() === "") {
    throw new Error("electron-builder afterPack context is missing packager.projectDir");
  }
  return path.resolve(projectDir);
}

function resolveRuntimeVersion(requested, resolved) {
  const exactResolved = resolved == null ? undefined : validateStableVersion(resolved, "builder framework.version");
  const exactRequested = requested == null ? undefined : validateStableVersion(requested, "options.runtimeVersion");
  if (exactResolved && exactRequested && exactResolved !== exactRequested) {
    throw new Error(`options.runtimeVersion ${exactRequested} does not match resolved Electron runtime ${exactResolved}`);
  }
  const result = exactRequested || exactResolved;
  if (!result) {
    throw new Error("Could not determine an exact Electron version; set options.runtimeVersion or use a resolved builder framework");
  }
  return result;
}

function resolveExecutable(context, appInfo) {
  if (context.electronPlatformName === "win32") {
    const name = `${requireResolvedString(appInfo.productFilename, "appInfo.productFilename")}.exe`;
    return { name, path: path.join(context.appOutDir, name), relativePath: name };
  }

  if (context.electronPlatformName === "darwin") {
    const productFilename = requireResolvedString(appInfo.productFilename, "appInfo.productFilename");
    const bundleName = `${productFilename}.app`;
    return {
      name: productFilename,
      path: path.join(context.appOutDir, bundleName, "Contents", "MacOS", productFilename),
      relativePath: path.join(bundleName, "Contents", "MacOS", productFilename),
    };
  }

  const linuxExecutableName = requireResolvedString(context.packager.executableName, "packager.executableName");
  if (typeof linuxExecutableName !== "string" || linuxExecutableName.trim() === "") {
    throw new Error("electron-builder Linux context is missing packager.executableName");
  }
  if (linuxExecutableName === "." || linuxExecutableName === ".." || /[\\/]/.test(linuxExecutableName)) {
    throw new Error(`electron-builder Linux executableName must be a file name: ${linuxExecutableName}`);
  }
  return {
    name: linuxExecutableName,
    path: path.join(context.appOutDir, linuxExecutableName),
    relativePath: linuxExecutableName,
  };
}

async function resolveIconPath(context, options, projectDir) {
  const explicit = options.iconPath;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || explicit.trim() === "") {
      throw new TypeError("options.iconPath must be a non-empty path when provided");
    }
    const resolved = resolveFromProject(explicit, projectDir);
    assertPng(resolved);
    return resolved;
  }

  const packager = context.packager;
  const config = packager.config || (packager.info && packager.info.config) || {};
  const platformOptions = packager.platformSpecificBuildOptions || {};
  const candidates = [
    platformOptions.icon,
    config.win && config.win.icon,
    config.linux && config.linux.icon,
    config.icon,
    config.mac && config.mac.icon,
  ];
  const sources = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const resolved = resolveConfiguredIconPath(candidate, packager, config, projectDir);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (isPng(resolved)) return resolved;
    if (fs.existsSync(resolved)) sources.push(resolved);
  }

  for (const source of sources) {
    if (path.extname(source).toLowerCase() === ".ico") {
      return convertIcoToPng(source);
    }
    const resolver = packager.resolveIcon;
    if (typeof resolver !== "function") {
      throw new Error("electron-builder's resolved packager does not expose resolveIcon() to convert its configured icon");
    }
    const converted = await resolver.call(packager, [source], [], "set");
    return selectLargestPng(converted, source);
  }

  const defaultIcon = require("app-builder-lib/out/util/pathManager")
    .getTemplatePath(path.join("icons", "electron-linux", "256x256.png"));
  assertPng(defaultIcon);
  return defaultIcon;
}

function resolveConfiguredIconPath(candidate, packager, config, projectDir) {
  if (path.isAbsolute(candidate)) return path.normalize(candidate);
  const buildResources = packager.buildResourcesDir
    || (packager.info && packager.info.buildResourcesDir)
    || path.resolve(projectDir, config.directories && config.directories.buildResources || "build");
  for (const root of [buildResources, projectDir]) {
    const resolved = path.resolve(root, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return resolveFromProject(candidate, buildResources);
}

function selectLargestPng(icons, source) {
  if (!Array.isArray(icons)) {
    throw new Error(`electron-builder failed to convert configured icon to PNG: ${source}`);
  }
  const candidates = icons
    .filter((icon) => icon && typeof icon.file === "string" && isPng(icon.file))
    .sort((left, right) => (Number(right.size) || 0) - (Number(left.size) || 0));
  if (candidates.length === 0) {
    throw new Error(`electron-builder did not produce a PNG from configured icon: ${source}`);
  }
  return candidates[0].file;
}

function convertIcoToPng(source) {
  if (process.platform !== "win32") {
    throw new Error(`Converting a Windows .ico icon requires native Windows packaging: ${source}`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-icon-"));
  const output = path.join(directory, "icon.png");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "$icon = New-Object System.Drawing.Icon($env:MINITRON_ICON_SOURCE)",
    "$bitmap = $icon.ToBitmap()",
    "try { $bitmap.Save($env:MINITRON_ICON_DEST, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose(); $icon.Dispose() }",
  ].join("; ");
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, MINITRON_ICON_SOURCE: source, MINITRON_ICON_DEST: output },
    });
    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `PowerShell exited ${result.status}`).trim());
    assertPng(output);
    return Buffer.from(fs.readFileSync(output));
  } catch (error) {
    throw new Error(`Unable to convert configured Windows icon to PNG (${source}): ${error.message}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function isPngBytes(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function assertPng(filePath) {
  if (!isPng(filePath)) throw new Error(`Minitron icon must be a PNG image: ${filePath}`);
}

function isPng(filePath) {
  try {
    const descriptor = fs.openSync(filePath, "r");
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      const read = fs.readSync(descriptor, signature, 0, signature.length, 0);
      return read === PNG_SIGNATURE.length && signature.equals(PNG_SIGNATURE);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function assertLauncherFile(launcherPath) {
  let stat;
  try {
    stat = fs.statSync(launcherPath);
  } catch {
    throw new Error(`Minitron launcher does not exist: ${launcherPath}`);
  }
  if (!stat.isFile()) throw new Error(`Minitron launcher must be a file: ${launcherPath}`);
}

function verifyLauncherVersion(launcherPath, spawn = spawnSync, platform = "win32", minimumVersionOverride) {
  const result = spawn(launcherPath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Unable to run Minitron launcher --version: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Minitron launcher --version exited ${result.status}: ${(result.stderr || "").trim()}`);
  }
  const output = (result.stdout || "").trim();
  const match = /^(?:minitron\s+)?v?(\d+)\.(\d+)\.(\d+)$/i.exec(output);
  if (!match) {
    throw new Error(`Minitron launcher --version returned an invalid version: ${output || "<empty>"}`);
  }
  const version = match.slice(1).map(Number);
  const minimumVersion = minimumVersionOverride || MINIMUM_LAUNCHER_VERSIONS[platform];
  if (!minimumVersion) {
    throw new Error(`Minitron has no launcher compatibility policy for ${String(platform)}`);
  }
  if (compareVersions(version, minimumVersion) < 0) {
    throw new Error(`Minitron launcher ${match[1]}.${match[2]}.${match[3]} is too old; version ${minimumVersion.join(".")} or newer is required for ${platform}`);
  }
  return `${version[0]}.${version[1]}.${version[2]}`;
}

async function resolveLauncherPath(options, projectDir, platform, arch, resolvers) {
  const launcherVersion = normalizeRequestedLauncherVersion(options.launcherVersion);
  const launcherPath = options.launcherPath === undefined
    ? undefined
    : resolveFromProject(options.launcherPath, projectDir);
  const resolver = getResolver("resolveLauncher", options, resolvers, "./launcher-download", launcherPath !== undefined);
  if (!resolver) return launcherPath;
  const resolved = await resolver({
    projectDir,
    platform,
    arch,
    launcherPath,
    launcherVersion,
  });
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error("Minitron launcher resolver must return an absolute launcher path");
  }
  if (!path.isAbsolute(resolved)) {
    throw new Error(`Minitron launcher resolver returned a non-absolute path: ${resolved}`);
  }
  return path.normalize(resolved);
}

async function resolveRuntimeDownloadArtifact(options, resolvers, runtimeVersion, platform, arch) {
  const resolver = getResolver("resolveRuntimeDownload", options, resolvers, "./electron-download");
  const result = await resolver({ version: runtimeVersion, platform, arch });
  return validateRuntimeDownloadArtifact(result, "Minitron runtime download artifact");
}

function getResolver(name, options, resolvers, modulePath, optionalForExplicitPath = false) {
  const injected = resolvers && resolvers[name] !== undefined
    ? resolvers[name]
    : options[name];
  if (injected !== undefined) {
    if (typeof injected !== "function") throw new TypeError(`${name} must be a function when provided`);
    return injected;
  }
  let resolver;
  try {
    resolver = require(modulePath)[name];
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND" && error.message.includes(`'${modulePath}'`)) {
      if (optionalForExplicitPath) return undefined;
      throw new Error(`Minitron ${name} helper is unavailable; reinstall the complete minitron-builder package`);
    }
    throw error;
  }
  if (typeof resolver !== "function") throw new Error(`Minitron helper ${modulePath} does not export ${name}()`);
  return resolver;
}

function normalizeRequestedLauncherVersion(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("options.launcherVersion must be an exact stable x.y.z version when provided");
  }
  const normalized = value.trim().replace(/^v/i, "");
  return validateStableVersion(normalized, "options.launcherVersion");
}

function resolveTargetArchitecture(platform, contextArch) {
  if (platform === "darwin") return getMacArchitecture(contextArch);
  const arch = BUILDER_ARCHITECTURES.get(contextArch);
  if (!arch) {
    throw new Error(`Minitron cannot resolve electron-builder target architecture: ${String(contextArch)}`);
  }
  if (arch === "universal") {
    throw new Error("Minitron does not support electron-builder's universal target; build x64 and arm64 separately");
  }
  if (arch !== "x64") {
    throw new Error(`Minitron ${platform} packages currently support only x64 targets; received ${arch}`);
  }
  return arch;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function resolveFromProject(value, projectDir) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectDir, value);
}

function requireResolvedString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`electron-builder did not resolve ${label}`);
  }
  return value;
}

function resolveElectronDist(packager, projectDir) {
  const config = packager.config || (packager.info && packager.info.config) || {};
  if (typeof config.electronDist === "string" && config.electronDist.trim() !== "") {
    const configured = resolveFromProject(config.electronDist, projectDir);
    assertDirectory(configured, "configured electronDist");
    return configured;
  }

  let manifestPath;
  try {
    manifestPath = require.resolve("electron/package.json", { paths: [projectDir] });
  } catch {
    try {
      let current = path.dirname(require.resolve("electron", { paths: [projectDir] }));
      while (path.dirname(current) !== current) {
        const candidate = path.join(current, "package.json");
        if (fs.existsSync(candidate)) {
          const manifest = JSON.parse(fs.readFileSync(candidate, "utf8"));
          if (manifest.name === "electron") {
            manifestPath = candidate;
            break;
          }
        }
        current = path.dirname(current);
      }
    } catch {
      // The message below points to the supported custom-distribution option.
    }
  }
  if (!manifestPath) {
    throw new Error(`Unable to find node_modules/electron/dist from ${projectDir}; set build.electronDist to the official Electron distribution`);
  }
  const dist = path.join(path.dirname(manifestPath), "dist");
  assertDirectory(dist, "node_modules/electron/dist");
  return dist;
}

function validateElectronDist(electronDist, platform, runtimeVersion) {
  const runtimeBinary = platform === "win32" ? "electron.exe" : "electron";
  const runtimeBinaryPath = path.join(electronDist, runtimeBinary);
  assertFile(runtimeBinaryPath, `Electron ${platform} runtime executable`);

  const versionPath = path.join(electronDist, "version");
  let distributionVersion;
  try {
    distributionVersion = fs.readFileSync(versionPath, "utf8").trim().replace(/^v/, "");
  } catch {
    throw new Error(`Cannot verify the Electron runtime version in ${electronDist}; its version file is required`);
  }
  if (distributionVersion !== runtimeVersion) {
    throw new Error(`Electron distribution ${electronDist} is version ${distributionVersion || "<empty>"}, but electron-builder resolved ${runtimeVersion}; set build.electronDist to the matching target runtime`);
  }
}

function assertDirectory(directory, label) {
  try {
    if (!fs.statSync(directory).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Unable to read ${label}: ${directory}`);
  }
}

function writeFileIfSameOrMissing(filePath, contents, label) {
  const bytes = Buffer.from(contents, "utf8");
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (!existing.equals(bytes)) {
      throw new Error(`Refusing to overwrite existing ${label}: ${filePath}`);
    }
    return;
  }
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o644 });
}

function copyIcon(sourcePath, destinationPath) {
  let sourceBytes;
  if (Buffer.isBuffer(sourcePath)) {
    sourceBytes = sourcePath;
  } else {
    assertPng(sourcePath);
    sourceBytes = fs.readFileSync(sourcePath);
  }
  if (!isPngBytes(sourceBytes)) throw new Error("Minitron icon source is not a PNG image");
  if (fs.existsSync(destinationPath)) {
    if (fs.readFileSync(destinationPath).equals(sourceBytes)) return;
    throw new Error(`Refusing to overwrite existing Minitron icon resource: ${destinationPath}`);
  }
  fs.writeFileSync(destinationPath, sourceBytes, { flag: "wx", mode: 0o644 });
}

function replaceExecutable(sourcePath, destinationPath, verifiedVersion, targetPlatform) {
  if (verifiedVersion == null) throw new Error("Minitron launcher version was not verified");
  if (!fs.existsSync(destinationPath) || !fs.statSync(destinationPath).isFile()) {
    throw new Error(`electron-builder application executable was not found: ${destinationPath}`);
  }

  const directory = path.dirname(destinationPath);
  const extension = path.extname(destinationPath);
  const temporary = path.join(directory, `.minitron-launcher-${process.pid}-${crypto.randomUUID()}${extension}`);
  const backup = path.join(directory, `.minitron-electron-${process.pid}-${crypto.randomUUID()}${extension}`);
  fs.copyFileSync(sourcePath, temporary);
  if ((targetPlatform === "linux" || targetPlatform === "darwin") && process.platform !== "win32") {
    const sourceMode = fs.statSync(sourcePath).mode & 0o777;
    fs.chmodSync(temporary, sourceMode | 0o111);
  }

  let originalMoved = false;
  try {
    fs.renameSync(destinationPath, backup);
    originalMoved = true;
    fs.renameSync(temporary, destinationPath);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (originalMoved && !fs.existsSync(destinationPath)) {
      try {
        fs.renameSync(backup, destinationPath);
      } catch {
        // Keep the original in the adjacent backup when the filesystem refuses restoration.
      }
    }
    throw new Error(`Unable to replace electron-builder executable with Minitron ${verifiedVersion}: ${error.message}`);
  }
}

async function removeOfficialRuntimeFiles(electronDist, appOutDir, executableRelativePath) {
  const inventory = walkOfficialTree(electronDist);
  const normalizedExecutable = toPosix(executableRelativePath);

  for (const item of inventory) {
    const relative = toPosix(item.relativePath);
    if (relative === normalizedExecutable) continue;
    if (relative === "resources/app" || relative.startsWith("resources/app/")) continue;
    if (relative === "resources/app.asar" || relative.startsWith("resources/app.asar.unpacked/")) continue;
    const packagedPath = path.join(appOutDir, item.relativePath);
    let packagedStat;
    try {
      packagedStat = fs.lstatSync(packagedPath);
    } catch {
      continue;
    }
    if (item.type === "symlink") {
      if (packagedStat.isSymbolicLink() && fs.readlinkSync(packagedPath) === item.linkTarget) {
        fs.unlinkSync(packagedPath);
      }
    } else if (item.type === "file" && packagedStat.isFile() && packagedStat.size === item.size) {
      if (await filesEqual(item.sourcePath, packagedPath)) fs.unlinkSync(packagedPath);
    }
  }
}

function walkOfficialTree(root) {
  const result = [];
  function visit(current, relativeDir) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const sourcePath = path.join(current, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        result.push({ type: "symlink", relativePath, sourcePath, linkTarget: fs.readlinkSync(sourcePath) });
      } else if (stat.isDirectory()) {
        visit(sourcePath, relativePath);
      } else if (stat.isFile()) {
        result.push({ type: "file", relativePath, sourcePath, size: stat.size });
      } else {
        throw new Error(`Unsupported entry in Electron distribution tree: ${sourcePath}`);
      }
    }
  }
  visit(root, "");
  return result;
}

async function filesEqual(left, right) {
  const leftHash = await hashFile(left);
  const rightHash = await hashFile(right);
  return leftHash === rightHash;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function toNativeAsarPath(value) {
  return value.split("/").join(path.sep);
}

async function patchAsar(archivePath, resourcesDir, metadata) {
  const bootstrapPaths = new Map(BOOTSTRAP_ENTRIES.map((entry) => {
    const bootstrapPath = path.join(__dirname, "..", entry);
    assertFile(bootstrapPath, `Minitron ${entry} bootstrap`);
    return [entry, bootstrapPath];
  }));
  asar.uncache(archivePath);
  const rawHeader = asar.getRawHeader(archivePath).header;
  const originalManifest = readArchiveJson(archivePath, "package.json");
  const alreadyPatched = isPreviouslyPatchedManifest(originalManifest, metadata);
  if (BOOTSTRAP_ENTRIES.includes(originalManifest.main) && !alreadyPatched) {
    throw new Error(`The app's original main cannot use the reserved Minitron bootstrap path ${originalManifest.main}`);
  }
  const appManifest = prepareManifest(originalManifest, metadata, alreadyPatched);
  const tempRoot = fs.mkdtempSync(path.join(resourcesDir, ".minitron-asar-"));
  const extractedRoot = path.join(tempRoot, "app");
  const tempArchive = path.join(tempRoot, "app.asar");
  const sourceSidecar = `${archivePath}.unpacked`;
  const outputSidecar = `${tempArchive}.unpacked`;
  const destinationSidecar = `${archivePath}.unpacked`;
  const originalBackup = path.join(tempRoot, "original.asar");
  const sidecarBackup = path.join(tempRoot, "original.asar.unpacked");
  let retainTempRoot = false;

  try {
    asar.extractAll(archivePath, extractedRoot);
    const manifestPath = path.join(extractedRoot, "package.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(appManifest, null, 2)}\n`);
    const { streams, knownSidecarPaths } = buildAsarStreams(rawHeader, extractedRoot);
    for (const [entry, bootstrapPath] of bootstrapPaths) {
      const bootstrapDestination = path.join(extractedRoot, entry);
      const existing = lstatOrUndefined(bootstrapDestination);
      if (existing && !alreadyPatched) {
        throw new Error(`The app already contains reserved Minitron bootstrap path ${entry}`);
      }
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error(`An existing Minitron bootstrap path must be a regular file: ${entry}`);
      }
      fs.copyFileSync(bootstrapPath, bootstrapDestination);
      const bootstrapStat = fs.statSync(bootstrapDestination);
      const stream = streams.find((candidate) => candidate.path === entry);
      if (stream) {
        stream.type = "file";
        stream.streamGenerator = () => fs.createReadStream(bootstrapDestination);
        stream.unpacked = false;
        stream.stat = bootstrapStat;
        delete stream.symlink;
      } else {
        streams.push({
          type: "file",
          path: entry,
          streamGenerator: () => fs.createReadStream(bootstrapDestination),
          unpacked: false,
          stat: bootstrapStat,
        });
      }
    }
    await asar.createPackageFromStreams(tempArchive, streams);
    if (fs.existsSync(sourceSidecar)) {
      mergeSidecarExtras(sourceSidecar, outputSidecar, knownSidecarPaths);
    }
    await preserveAsarMetadata(tempArchive, rawHeader, extractedRoot);
    verifyPatchedArchive(tempArchive, appManifest, metadata, rawHeader);

    let archiveMoved = false;
    let sidecarMoved = false;
    let archiveInstalled = false;
    let sidecarInstalled = false;
    try {
      fs.renameSync(archivePath, originalBackup);
      archiveMoved = true;
      if (fs.existsSync(destinationSidecar)) {
        fs.renameSync(destinationSidecar, sidecarBackup);
        sidecarMoved = true;
      }
      fs.renameSync(tempArchive, archivePath);
      archiveInstalled = true;
      if (fs.existsSync(outputSidecar)) {
        fs.renameSync(outputSidecar, destinationSidecar);
        sidecarInstalled = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      const rollback = (operation) => {
        try {
          operation();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError.message);
        }
      };
      if (sidecarInstalled) rollback(() => fs.rmSync(destinationSidecar, { recursive: true, force: true }));
      if (archiveInstalled) rollback(() => fs.rmSync(archivePath, { force: true }));
      if (sidecarMoved) rollback(() => fs.renameSync(sidecarBackup, destinationSidecar));
      if (archiveMoved) rollback(() => fs.renameSync(originalBackup, archivePath));
      asar.uncache(archivePath);
      if (rollbackErrors.length > 0) {
        retainTempRoot = true;
        throw new Error(`Unable to repack ASAR: ${error.message}; rollback failed (${rollbackErrors.join("; ")}). Recovery files remain at ${tempRoot}`);
      }
      throw error;
    }
    asar.uncache(archivePath);
  } finally {
    if (!retainTempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

async function preserveAsarMetadata(archivePath, originalHeader, extractedRoot) {
  const originalHasIntegrity = headerHasIntegrity(originalHeader);
  const generated = asar.getRawHeader(archivePath);
  const changedFiles = new Map([
    ["package.json", path.join(extractedRoot, "package.json")],
    ...BOOTSTRAP_ENTRIES.map((entry) => [entry, path.join(extractedRoot, entry)]),
  ]);

  walkAsarLeaves(originalHeader, (relativePath, sourceEntry) => {
    const outputEntry = findAsarEntry(generated.header, relativePath);
    if (!outputEntry || outputEntry.files) {
      throw new Error(`ASAR repacking lost original member metadata: ${relativePath}`);
    }
    copyAsarMetadata(sourceEntry, outputEntry);
    const changedFile = changedFiles.get(relativePath);
    if (changedFile) {
      if (originalHasIntegrity) outputEntry.integrity = computeIntegrity(fs.readFileSync(changedFile));
      else delete outputEntry.integrity;
      changedFiles.delete(relativePath);
    }
  });

  const generatedLeaves = [];
  walkAsarLeaves(generated.header, (relativePath, entry) => generatedLeaves.push([relativePath, entry]));
  for (const [relativePath, entry] of generatedLeaves) {
    if (!findAsarEntry(originalHeader, relativePath)) {
      const changedFile = changedFiles.get(relativePath);
      if (changedFile && originalHasIntegrity) {
        entry.integrity = computeIntegrity(fs.readFileSync(changedFile));
      } else if (!originalHasIntegrity) {
        delete entry.integrity;
      }
      changedFiles.delete(relativePath);
      continue;
    }
    if (!originalHasIntegrity) delete entry.integrity;
  }

  if (changedFiles.size > 0) {
    throw new Error(`ASAR repacking is missing required changed members: ${[...changedFiles.keys()].join(", ")}`);
  }

  const headerPickle = pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(generated.header));
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  const prefix = Buffer.concat([sizePickle.toBuffer(), headerBuffer]);
  const payloadStart = 8 + generated.headerSize;
  const archiveStat = fs.statSync(archivePath);
  if (payloadStart > archiveStat.size) throw new Error("Generated ASAR header extends past the archive payload");

  const rewrittenPath = `${archivePath}.metadata-${process.pid}-${crypto.randomUUID()}`;
  const backupPath = `${archivePath}.pre-metadata-${process.pid}-${crypto.randomUUID()}`;
  try {
    const archiveContents = async function* () {
      yield prefix;
      for await (const chunk of fs.createReadStream(archivePath, { start: payloadStart })) yield chunk;
    };
    await pipeline(
      Readable.from(archiveContents()),
      fs.createWriteStream(rewrittenPath, { flags: "wx" }),
    );
    fs.renameSync(archivePath, backupPath);
    try {
      fs.renameSync(rewrittenPath, archivePath);
      fs.rmSync(backupPath, { force: true });
    } catch (error) {
      if (!fs.existsSync(archivePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, archivePath);
      throw error;
    }
  } finally {
    fs.rmSync(rewrittenPath, { force: true });
  }
  asar.uncache(archivePath);
}

function headerHasIntegrity(header) {
  let found = false;
  walkAsarLeaves(header, (_relativePath, entry) => {
    if (entry.integrity && typeof entry.integrity === "object") found = true;
  });
  return found;
}

function walkAsarLeaves(header, callback) {
  const walk = (directory, prefix) => {
    for (const [name, entry] of Object.entries(directory.files || {})) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, relativePath);
      else callback(relativePath, entry);
    }
  };
  if (!header || !header.files || typeof header.files !== "object") {
    throw new Error("The packaged ASAR archive has an invalid header");
  }
  walk(header, "");
}

function findAsarEntry(header, relativePath) {
  let current = header;
  for (const segment of relativePath.split("/")) {
    current = current && current.files && current.files[segment];
    if (!current) return undefined;
  }
  return current;
}

function copyAsarMetadata(source, destination) {
  if (typeof source.executable === "boolean") destination.executable = source.executable;
  else delete destination.executable;
  if (source.integrity && typeof source.integrity === "object") {
    destination.integrity = structuredClone(source.integrity);
  } else {
    delete destination.integrity;
  }
}

function computeIntegrity(contents) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let offset = 0; offset < contents.length; offset += blockSize) {
    blocks.push(crypto.createHash("sha256").update(contents.subarray(offset, offset + blockSize)).digest("hex"));
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(contents).digest("hex"),
    blockSize,
    blocks,
  };
}

function prepareManifest(originalManifest, metadata, alreadyPatched) {
  if (!originalManifest || typeof originalManifest !== "object" || Array.isArray(originalManifest)) {
    throw new Error("Packaged app package.json must contain an object");
  }
  const currentMain = originalManifest.main;
  const originalMain = alreadyPatched ? originalManifest.minitronOriginalMain : currentMain;
  const canonicalOriginalMain = validateOriginalMain(originalMain);
  const bootstrapEntry = resolveBootstrapEntry(canonicalOriginalMain, originalManifest.type);

  const existingMetadata = originalManifest.metadata;
  if (existingMetadata !== undefined && (!existingMetadata || typeof existingMetadata !== "object" || Array.isArray(existingMetadata))) {
    throw new Error("Packaged app package.json metadata must be an object so Minitron metadata can be added safely");
  }
  const minitronMetadata = existingMetadata && existingMetadata.minitron;
  if (minitronMetadata !== undefined && (!minitronMetadata || typeof minitronMetadata !== "object" || Array.isArray(minitronMetadata))) {
    throw new Error("Packaged app metadata.minitron must be an object when already present");
  }

  return {
    ...originalManifest,
    productName: metadata.productName,
    main: bootstrapEntry,
    minitronOriginalMain: canonicalOriginalMain,
    metadata: {
      ...(existingMetadata || {}),
      minitron: {
        ...(minitronMetadata || {}),
        appId: metadata.appId,
        executableName: metadata.executableName,
        iconRelativePath: "minitron-icon.png",
      },
    },
  };
}

function isPreviouslyPatchedManifest(manifest, metadata) {
  if (!manifest || !BOOTSTRAP_ENTRIES.includes(manifest.main)) return false;
  const minitron = manifest.metadata && manifest.metadata.minitron;
  if (!minitron || minitron.appId !== metadata.appId || minitron.executableName !== metadata.executableName) return false;
  try {
    const originalMain = validateOriginalMain(manifest.minitronOriginalMain);
    return manifest.main === resolveBootstrapEntry(originalMain, manifest.type);
  } catch {
    return false;
  }
}

function resolveBootstrapEntry(originalMain, packageType) {
  const extension = path.extname(originalMain).toLowerCase();
  return extension === ".mjs" || (extension === ".js" && packageType === "module")
    ? ESM_BOOTSTRAP_ENTRY
    : CJS_BOOTSTRAP_ENTRY;
}

function validateOriginalMain(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Packaged app package.json must have a non-empty main entry");
  }
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[a-zA-Z]:/.test(portable) || portable.includes("\0")) {
    throw new Error(`Packaged app main entry must be relative to the application: ${value}`);
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`Packaged app main entry must stay inside the application: ${value}`);
  }
  return segments.join("/");
}

function readArchiveJson(archivePath, name) {
  try {
    return JSON.parse(asar.extractFile(archivePath, name).toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${name} from ${archivePath}: ${error.message}`);
  }
}

function buildAsarStreams(rawHeader, extractedRoot) {
  if (!rawHeader || !rawHeader.files || typeof rawHeader.files !== "object") {
    throw new Error("The packaged ASAR archive has an invalid header");
  }
  const streams = [];
  const knownSidecarPaths = new Set();
  const walk = (directory, relativeDir, inheritedUnpacked) => {
    for (const [name, entry] of Object.entries(directory.files || {})) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const unpacked = inheritedUnpacked || entry.unpacked === true;
      if (entry.files) {
        if (relative !== "") {
          streams.push({ type: "directory", path: relative, unpacked });
          if (unpacked) knownSidecarPaths.add(relative);
        }
        walk(entry, relative, unpacked);
      } else if (typeof entry.link === "string") {
        streams.push({
          type: "link",
          path: relative,
          symlink: entry.link,
          unpacked,
          stat: { mode: 0o777, size: 0 },
        });
        if (unpacked) knownSidecarPaths.add(relative);
      } else {
        const sourcePath = path.join(extractedRoot, ...relative.split("/"));
        let stat;
        try {
          stat = fs.statSync(sourcePath);
        } catch {
          throw new Error(`ASAR member is missing after safe extraction: ${relative}`);
        }
        if (!stat.isFile()) throw new Error(`ASAR member is not a regular file: ${relative}`);
        streams.push({
          type: "file",
          path: relative,
          streamGenerator: () => fs.createReadStream(sourcePath),
          unpacked,
          stat,
        });
        if (unpacked) knownSidecarPaths.add(relative);
      }
    }
  };
  walk(rawHeader, "", false);
  return { streams, knownSidecarPaths };
}

function mergeSidecarExtras(sourceRoot, destinationRoot, knownSidecarPaths) {
  if (!fs.existsSync(destinationRoot)) fs.mkdirSync(destinationRoot, { recursive: true });
  const walk = (sourceDir, relativeDir) => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationRoot, relative);
      if (entry.isDirectory()) {
        const destinationStat = lstatOrUndefined(destinationPath);
        if (destinationStat && !destinationStat.isDirectory()) {
          throw new Error(`An untracked ASAR sidecar entry conflicts with generated content: ${relative}`);
        }
        fs.mkdirSync(destinationPath, { recursive: true });
        walk(sourcePath, relative);
        continue;
      }
      if (knownSidecarPaths.has(toPosix(relative))) continue;
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      if (entry.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(sourcePath);
        const destinationStat = lstatOrUndefined(destinationPath);
        if (destinationStat) {
          if (!destinationStat.isSymbolicLink() || fs.readlinkSync(destinationPath) !== linkTarget) {
            throw new Error(`An untracked ASAR sidecar entry conflicts with generated content: ${relative}`);
          }
        } else {
          fs.symlinkSync(linkTarget, destinationPath);
        }
      } else if (entry.isFile()) {
        const destinationStat = lstatOrUndefined(destinationPath);
        if (destinationStat) {
          if (!destinationStat.isFile()) {
            throw new Error(`An untracked ASAR sidecar entry conflicts with generated content: ${relative}`);
          }
          if (!fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath))) {
            throw new Error(`An untracked ASAR sidecar file conflicts with generated content: ${relative}`);
          }
        } else {
          fs.copyFileSync(sourcePath, destinationPath);
        }
      } else {
        throw new Error(`Unsupported ASAR sidecar entry: ${sourcePath}`);
      }
    }
  };
  walk(sourceRoot, "");
}

function verifyPatchedArchive(archivePath, expectedManifest, metadata, originalHeader) {
  const manifest = readArchiveJson(archivePath, "package.json");
  if (manifest.main !== expectedManifest.main || manifest.minitronOriginalMain !== expectedManifest.minitronOriginalMain) {
    throw new Error("Minitron ASAR bootstrap entry did not survive archive repacking");
  }
  const originalMain = validateOriginalMain(manifest.minitronOriginalMain);
  const mainStat = asar.statFile(archivePath, toNativeAsarPath(originalMain));
  if (!mainStat || mainStat.files) throw new Error(`Original application main is missing from repacked ASAR: ${originalMain}`);
  const patchedHeader = asar.getRawHeader(archivePath).header;
  const expectsIntegrity = headerHasIntegrity(originalHeader);
  for (const entry of BOOTSTRAP_ENTRIES) {
    const bootstrapStat = asar.statFile(archivePath, toNativeAsarPath(entry));
    if (!bootstrapStat || bootstrapStat.unpacked) throw new Error(`Minitron bootstrap ${entry} must be embedded in app.asar`);
    const expectedIntegrity = expectsIntegrity ? computeIntegrity(asar.extractFile(archivePath, entry)) : undefined;
    const actualIntegrity = findAsarEntry(patchedHeader, entry).integrity;
    if (JSON.stringify(actualIntegrity) !== JSON.stringify(expectedIntegrity)) {
      throw new Error(`Minitron bootstrap integrity verification failed for ${entry}`);
    }
  }
  const originalUnpacked = collectUnpackedFiles(originalHeader).filter((file) => !BOOTSTRAP_ENTRIES.includes(file));
  for (const file of originalUnpacked) {
    const stat = asar.statFile(archivePath, toNativeAsarPath(file));
    if (!stat.unpacked) throw new Error(`Repacking changed an ASAR unpacked member into an archived member: ${file}`);
    const sidecarPath = path.join(`${archivePath}.unpacked`, ...file.split("/"));
    if (!lstatOrUndefined(sidecarPath)) throw new Error(`Repacking lost an ASAR unpacked sidecar file: ${file}`);
  }
  const minitron = manifest.metadata && manifest.metadata.minitron;
  if (!minitron || minitron.appId !== metadata.appId || minitron.executableName !== metadata.executableName) {
    throw new Error("Minitron app metadata did not survive ASAR repacking");
  }
}

function lstatOrUndefined(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

function collectUnpackedFiles(header) {
  const files = [];
  const walk = (directory, prefix, inherited) => {
    for (const [name, entry] of Object.entries(directory.files || {})) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const unpacked = inherited || entry.unpacked === true;
      if (entry.files) {
        walk(entry, relative, unpacked);
      } else if (unpacked) {
        files.push(relative);
      }
    }
  };
  walk(header, "", false);
  return files;
}

function assertFile(filePath, label) {
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

module.exports = {
  afterPack,
  createAfterPackHook,
  patchAsar,
  resolveIconPath,
  resolveRuntimeVersion,
  resolveTargetArchitecture,
  verifyLauncherVersion,
};

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");
const {
  renderConfig,
  validateManifestUrl,
  validatePublicKey,
  validateStableVersion,
} = require("./validation");

const BOOTSTRAP_ENTRY = "__minitron_bootstrap__.cjs";
const MINIMUM_LAUNCHER_VERSION = [0, 2, 0];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createAfterPackHook(previousHook, options) {
  return async (context) => {
    assertSupportedPlatform(context.electronPlatformName);
    if (previousHook != null) {
      const resolved = await resolveHook(previousHook, context);
      if (typeof resolved !== "function") {
        throw new TypeError("The existing electron-builder afterPack hook did not resolve to a function");
      }
      await resolved(context);
    }
    await afterPack(context, options);
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

async function afterPack(context, options, spawn = spawnSync) {
  const packager = context && context.packager;
  if (!packager || typeof packager !== "object") {
    throw new Error("Minitron afterPack requires electron-builder's resolved packager context");
  }

  const projectDir = options.projectDir === undefined ? resolveProjectDir(packager) : path.resolve(options.projectDir);
  const appOutDir = path.resolve(context.appOutDir);
  const resourcesDir = path.join(appOutDir, "resources");
  if (!fs.existsSync(appOutDir) || !fs.statSync(appOutDir).isDirectory()) {
    throw new Error(`electron-builder appOutDir does not exist: ${appOutDir}`);
  }
  if (!fs.existsSync(resourcesDir) || !fs.statSync(resourcesDir).isDirectory()) {
    throw new Error(`electron-builder resources directory does not exist: ${resourcesDir}`);
  }

  const launcherPath = resolveFromProject(options.launcherPath, projectDir);
  assertLauncherFile(launcherPath);
  const launcherVersion = verifyLauncherVersion(launcherPath, spawn);

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
  const executable = resolveExecutable(context, appInfo);
  const iconPath = resolveIconPath(context, options, projectDir);
  const electronDist = resolveElectronDist(packager, projectDir);
  validateElectronDist(electronDist, context.electronPlatformName, runtimeVersion);
  if (packager.config && packager.config.asar === false) {
    throw new Error("Minitron requires electron-builder ASAR packaging; build.asar must not be false");
  }

  const configText = renderConfig({
    appId,
    appVersion,
    runtimeVersion,
    manifestUrl,
    allowLocalhostHttp,
    manifestPublicKey,
  });

  const appAsar = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(appAsar)) {
    throw new Error(`Minitron requires electron-builder's standard resources/app.asar output: ${appAsar}`);
  }
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

  writeFileIfSameOrMissing(path.join(appOutDir, "minitron.toml"), configText, "Minitron configuration");
  copyIcon(iconPath, path.join(resourcesDir, "minitron-icon.png"));
  replaceExecutable(launcherPath, executable.path, launcherVersion, context.electronPlatformName);

  await removeOfficialRuntimeFiles(electronDist, appOutDir, executable.relativePath);
}

function assertSupportedPlatform(platform) {
  if (platform !== "win32" && platform !== "linux") {
    if (platform === "darwin" || platform === "mas") {
      throw new Error("Minitron does not support macOS packaging yet; app bundle conversion is not implemented");
    }
    throw new Error(`Minitron supports only electron-builder win32 and linux targets; received ${String(platform)}`);
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

function resolveIconPath(context, options, projectDir) {
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
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const resolved = resolveFromProject(candidate, projectDir);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (isPng(resolved)) return resolved;
  }
  throw new Error("Minitron requires a PNG icon; set options.iconPath or configure a PNG build icon");
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

function verifyLauncherVersion(launcherPath, spawn = spawnSync) {
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
  if (compareVersions(version, MINIMUM_LAUNCHER_VERSION) < 0) {
    throw new Error(`Minitron launcher ${match[1]}.${match[2]}.${match[3]} is too old; version 0.2.0 or newer is required`);
  }
  return `${version[0]}.${version[1]}.${version[2]}`;
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
  assertPng(sourcePath);
  const sourceBytes = fs.readFileSync(sourcePath);
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
  if (targetPlatform === "linux" && process.platform !== "win32") {
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

async function patchAsar(archivePath, resourcesDir, metadata) {
  const bootstrapPath = path.join(__dirname, "..", BOOTSTRAP_ENTRY);
  assertFile(bootstrapPath, "Minitron bootstrap");
  asar.uncache(archivePath);
  const rawHeader = asar.getRawHeader(archivePath).header;
  const originalManifest = readArchiveJson(archivePath, "package.json");
  const appManifest = prepareManifest(originalManifest, metadata);
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
    const bootstrapDestination = path.join(extractedRoot, BOOTSTRAP_ENTRY);
    if (fs.existsSync(bootstrapDestination)) {
      throw new Error(`The app already contains reserved Minitron bootstrap path ${BOOTSTRAP_ENTRY}`);
    }
    fs.copyFileSync(bootstrapPath, bootstrapDestination);

    const { streams, knownSidecarPaths } = buildAsarStreams(rawHeader, extractedRoot);
    const bootstrapStat = fs.statSync(bootstrapDestination);
    streams.push({
      type: "file",
      path: BOOTSTRAP_ENTRY,
      streamGenerator: () => fs.createReadStream(bootstrapDestination),
      unpacked: false,
      stat: bootstrapStat,
    });
    await asar.createPackageFromStreams(tempArchive, streams);
    if (fs.existsSync(sourceSidecar)) {
      mergeSidecarExtras(sourceSidecar, outputSidecar, knownSidecarPaths);
    }
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

function prepareManifest(originalManifest, metadata) {
  if (!originalManifest || typeof originalManifest !== "object" || Array.isArray(originalManifest)) {
    throw new Error("Packaged app package.json must contain an object");
  }
  const currentMain = originalManifest.main;
  const originalMain = currentMain === BOOTSTRAP_ENTRY ? originalManifest.minitronOriginalMain : currentMain;
  validateOriginalMain(originalMain);

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
    main: BOOTSTRAP_ENTRY,
    minitronOriginalMain: originalMain,
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
  if (manifest.main !== BOOTSTRAP_ENTRY || manifest.minitronOriginalMain !== expectedManifest.minitronOriginalMain) {
    throw new Error("Minitron ASAR bootstrap entry did not survive archive repacking");
  }
  const originalMain = validateOriginalMain(manifest.minitronOriginalMain);
  const mainStat = asar.statFile(archivePath, originalMain);
  if (!mainStat || mainStat.files) throw new Error(`Original application main is missing from repacked ASAR: ${originalMain}`);
  const bootstrapStat = asar.statFile(archivePath, BOOTSTRAP_ENTRY);
  if (!bootstrapStat || bootstrapStat.unpacked) throw new Error("Minitron bootstrap must be embedded in app.asar");
  const originalUnpacked = collectUnpackedFiles(originalHeader);
  for (const file of originalUnpacked) {
    const stat = asar.statFile(archivePath, file);
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
  resolveRuntimeVersion,
  verifyLauncherVersion,
};

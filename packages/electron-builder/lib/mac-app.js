"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MACHO_CPU_TYPES = {
  x64: 0x01000007,
  arm64: 0x0100000c,
};

function resolveMacBundlePaths(appOutDir, appInfo) {
  const productFilename = requiredName(appInfo.productFilename, "appInfo.productFilename");
  if (productFilename.endsWith(" Helper")) {
    throw new Error("Minitron macOS packaging does not support appInfo.productFilename ending in ' Helper'; electron-builder rewrites CFBundleExecutable to remove that suffix");
  }
  const bundlePath = path.join(appOutDir, `${productFilename}.app`);
  const contentsDir = path.join(bundlePath, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");
  const macosDir = path.join(contentsDir, "MacOS");
  const executablePath = path.join(macosDir, productFilename);
  for (const [directory, label] of [
    [bundlePath, "macOS application bundle"],
    [contentsDir, "macOS application Contents directory"],
    [resourcesDir, "macOS application Resources directory"],
    [macosDir, "macOS application MacOS directory"],
  ]) {
    assertDirectory(directory, label);
  }
  return {
    bundlePath,
    contentsDir,
    resourcesDir,
    macosDir,
    executablePath,
    configPath: path.join(macosDir, "minitron.toml"),
    infoPlistPath: path.join(contentsDir, "Info.plist"),
    productFilename,
  };
}

function resolveMacElectronBundle(electronDist, packager) {
  const frameworkBundleName = packager.info && packager.info.framework && packager.info.framework.distMacOsAppName;
  const configuredBundleName = typeof frameworkBundleName === "string" && frameworkBundleName.trim() !== ""
    ? frameworkBundleName
    : `${packager.config && packager.config.electronBranding && packager.config.electronBranding.productName || "Electron"}.app`;
  if (path.basename(configuredBundleName) !== configuredBundleName || !configuredBundleName.endsWith(".app")) {
    throw new Error(`electron-builder resolved an invalid macOS Electron bundle name: ${configuredBundleName}`);
  }
  const bundlePath = path.join(electronDist, configuredBundleName);
  assertDirectory(bundlePath, "official Electron macOS application bundle");
  const sourceProductName = configuredBundleName.slice(0, -".app".length);
  const contentsDir = path.join(bundlePath, "Contents");
  const executablePath = path.join(contentsDir, "MacOS", sourceProductName);
  assertFile(executablePath, "official Electron macOS executable");
  assertFile(path.join(contentsDir, "Info.plist"), "official Electron macOS Info.plist");
  return { bundlePath, contentsDir, executablePath, sourceProductName };
}

function validateMacElectronVersion(electronDist, runtimeVersion) {
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

function getMacArchitecture(contextArch) {
  const names = new Map([
    ["x64", "x64"], [1, "x64"],
    ["arm64", "arm64"], [3, "arm64"],
    ["universal", "universal"], [4, "universal"],
  ]);
  const name = names.get(contextArch);
  if (!name) {
    throw new Error(`Minitron macOS packaging supports only x64 and arm64 targets; received ${String(contextArch)}`);
  }
  if (name === "universal") {
    throw new Error("Minitron macOS packaging does not support electron-builder's universal target; build x64 and arm64 separately with matching launchers");
  }
  return name;
}

function assertMachOArchitecture(filePath, architecture, label) {
  const architectures = readMachOArchitectures(filePath);
  if (!architectures) {
    throw new Error(`${label} is not a valid Mach-O executable: ${filePath}`);
  }
  if (!architectures.has(MACHO_CPU_TYPES[architecture])) {
    throw new Error(`${label} does not contain the ${architecture} architecture: ${filePath}`);
  }
}

function readMachOArchitectures(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(descriptor, header, 0, header.length, 0) < 8) return undefined;
    const magic = header.readUInt32BE(0);
    const thinEndian = magic === 0xfeedface || magic === 0xfeedfacf
      ? "BE"
      : magic === 0xcefaedfe || magic === 0xcffaedfe
        ? "LE"
        : undefined;
    if (thinEndian) {
      const cpuType = thinEndian === "BE" ? header.readUInt32BE(4) : header.readUInt32LE(4);
      return new Set([cpuType]);
    }

    let fatEndian;
    let isFat64 = false;
    if (magic === 0xcafebabe) fatEndian = "BE";
    else if (magic === 0xbebafeca) fatEndian = "LE";
    else if (magic === 0xcafebabf) { fatEndian = "BE"; isFat64 = true; }
    else if (magic === 0xbfbafeca) { fatEndian = "LE"; isFat64 = true; }
    else return undefined;

    const readCount = fatEndian === "BE" ? header.readUInt32BE(4) : header.readUInt32LE(4);
    if (readCount < 1 || readCount > 32) return undefined;
    const recordSize = isFat64 ? 32 : 20;
    const records = Buffer.alloc(recordSize * readCount);
    if (fs.readSync(descriptor, records, 0, records.length, 8) !== records.length) return undefined;
    const result = new Set();
    for (let index = 0; index < readCount; index += 1) {
      const offset = index * recordSize;
      result.add(fatEndian === "BE" ? records.readUInt32BE(offset) : records.readUInt32LE(offset));
    }
    return result;
  } finally {
    fs.closeSync(descriptor);
  }
}

async function replaceMacExecutable(launcherPath, destinationPath, electronExecutable, verifiedVersion, architecture, replace) {
  assertMachOArchitecture(electronExecutable, architecture, "Selected Electron macOS runtime");
  assertMachOArchitecture(launcherPath, architecture, "Minitron launcher");

  if (!fs.existsSync(destinationPath) || !fs.statSync(destinationPath).isFile()) {
    throw new Error(`electron-builder macOS application executable was not found: ${destinationPath}`);
  }
  const isOfficialElectron = await filesEqual(destinationPath, electronExecutable);
  const isAlreadyMinitron = await filesEqual(destinationPath, launcherPath);
  if (!isOfficialElectron && !isAlreadyMinitron) {
    throw new Error(`Refusing to replace the macOS application executable because it does not match the selected Electron runtime: ${destinationPath}`);
  }
  if (isOfficialElectron) replace(launcherPath, destinationPath, verifiedVersion, "darwin");
}

async function removeMacElectronRuntimeFiles(electronBundle, bundlePaths, appInfo) {
  const sourceRoot = electronBundle.contentsDir;
  const inventory = walkTree(sourceRoot);
  const sourceProductName = electronBundle.sourceProductName;
  const sanitizedProductName = requiredName(appInfo.sanitizedProductName || appInfo.productFilename, "appInfo.sanitizedProductName");
  const appProductFilename = requiredName(appInfo.productFilename, "appInfo.productFilename");
  const destinationRoot = bundlePaths.contentsDir;
  const directories = new Set();
  let removedElectronFrameworkBinary = false;

  for (const item of inventory) {
    const relative = toPosix(item.relativePath);
    const mapped = mapElectronContentsPath(relative, {
      sourceProductName,
      sanitizedProductName,
      appProductFilename,
    });
    if (!mapped || shouldPreserveMacPath(mapped)) continue;

    const destinationPath = path.join(destinationRoot, ...mapped.split("/"));
    if (item.type === "directory") {
      directories.add(destinationPath);
      continue;
    }

    const packagedStat = lstatOrUndefined(destinationPath);
    if (!packagedStat) continue;
    let matches = false;
    if (item.type === "symlink") {
      matches = packagedStat.isSymbolicLink() && fs.readlinkSync(destinationPath) === item.linkTarget;
    } else if (item.type === "file" && packagedStat.isFile()) {
      if (isHelperInfoPlist(mapped)) {
        matches = helperPlistsMatch(item.sourcePath, destinationPath, mapped);
        if (!matches) {
          throw new Error(`Refusing to strip a builder-renamed Electron helper bundle because its Info.plist has unexpected changes: ${destinationPath}`);
        }
      } else if (packagedStat.size === item.size) {
        matches = await filesEqual(item.sourcePath, destinationPath);
      }
    }

    if (matches) {
      fs.unlinkSync(destinationPath);
      if (mapped.startsWith("Frameworks/Electron Framework.framework/")) removedElectronFrameworkBinary = true;
    }
  }

  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && error.code !== "ENOTEMPTY") throw error;
    }
  }
  if (!removedElectronFrameworkBinary) {
    throw new Error(`Minitron did not remove the official Electron Framework from ${bundlePaths.bundlePath}; verify build.electronDist matches the target bundle`);
  }
}

function mapElectronContentsPath(relative, names) {
  const segments = relative.split("/");
  if (segments.length === 2 && segments[0] === "MacOS" && segments[1] === names.sourceProductName) {
    segments[1] = names.appProductFilename;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.startsWith(`${names.sourceProductName} Helper`) || segment.startsWith(`${names.sourceProductName} Login Helper`)) {
      segments[index] = `${names.sanitizedProductName}${segment.slice(names.sourceProductName.length)}`;
    }
  }
  return segments.join("/");
}

function shouldPreserveMacPath(relative) {
  const portable = toPosix(relative);
  if (portable === "Info.plist" || portable === "PkgInfo") return true;
  if (portable === "Resources/icon.icns" || portable === "Resources/minitron-icon.png") return true;
  if (portable === "Resources/app.asar" || portable.startsWith("Resources/app.asar.unpacked/")) return true;
  return false;
}

function isHelperInfoPlist(relative) {
  const portable = toPosix(relative);
  if (!portable.endsWith("/Contents/Info.plist")) return false;
  return portable.startsWith("Frameworks/") || portable.startsWith("Library/LoginItems/");
}

function helperPlistsMatch(sourcePath, packagedPath, relative) {
  let plist;
  try {
    const osxSignEntry = require.resolve("@electron/osx-sign");
    const plistPath = require.resolve("plist", { paths: [path.dirname(osxSignEntry)] });
    plist = require(plistPath);
  } catch (error) {
    throw new Error(`Cannot safely inspect the builder-renamed Electron helper Info.plist; electron-builder's @electron/osx-sign plist dependency is required: ${error.message}`);
  }

  let original;
  let packaged;
  try {
    original = plist.parse(fs.readFileSync(sourcePath, "utf8"));
    packaged = plist.parse(fs.readFileSync(packagedPath, "utf8"));
  } catch {
    return false;
  }
  const expectedExecutable = path.posix.basename(path.posix.dirname(path.posix.dirname(relative))).replace(/\.app$/, "");
  if (packaged.CFBundleExecutable !== expectedExecutable || typeof packaged.CFBundleIdentifier !== "string" || packaged.CFBundleIdentifier === "") {
    return false;
  }
  const brandingFields = ["CFBundleExecutable", "CFBundleDisplayName", "CFBundleIdentifier", "CFBundleVersion"];
  for (const field of brandingFields) {
    delete original[field];
    delete packaged[field];
  }
  return canonicalJson(original) === canonicalJson(packaged);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function walkTree(root) {
  const result = [];
  function visit(current, relativeDir) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const sourcePath = path.join(current, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        result.push({ type: "symlink", relativePath, sourcePath, linkTarget: fs.readlinkSync(sourcePath) });
      } else if (stat.isDirectory()) {
        result.push({ type: "directory", relativePath, sourcePath });
        visit(sourcePath, relativePath);
      } else if (stat.isFile()) {
        result.push({ type: "file", relativePath, sourcePath, size: stat.size });
      } else {
        throw new Error(`Unsupported entry in Electron macOS bundle: ${sourcePath}`);
      }
    }
  }
  visit(root, "");
  return result;
}

function writeMacUninstaller(bundlePaths) {
  const launcherPath = `"$APP_ROOT/Contents/MacOS/${shellDoubleQuote(bundlePaths.productFilename)}"`;
  const contents = [
    "#!/bin/sh",
    "set -eu",
    'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"',
    'APP_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"',
    `LAUNCHER=${launcherPath}`,
    '"$LAUNCHER" --app-dir "$APP_ROOT" --stop',
    'exec "$LAUNCHER" --app-dir "$APP_ROOT" --uninstall',
    "",
  ].join("\n");
  const scriptPath = path.join(bundlePaths.resourcesDir, "minitron-uninstall.command");
  if (fs.existsSync(scriptPath)) {
    if (fs.readFileSync(scriptPath, "utf8") !== contents) {
      throw new Error(`Refusing to overwrite an existing Minitron uninstaller: ${scriptPath}`);
    }
  } else {
    fs.writeFileSync(scriptPath, contents, { flag: "wx", mode: 0o755 });
  }
  if (process.platform !== "win32") fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function assertNotUniversalIntermediate(appOutDir) {
  if (/-x64-temp$|-arm64-temp$/i.test(path.basename(appOutDir))) {
    throw new Error("Minitron macOS packaging does not support electron-builder's universal target; build x64 and arm64 separately with matching launchers");
  }
}

async function filesEqual(left, right) {
  if (fs.statSync(left).size !== fs.statSync(right).size) return false;
  return await hashFile(left) === await hashFile(right);
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

function requiredName(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`electron-builder did not resolve a safe ${label}`);
  }
  return value;
}

function assertDirectory(directory, label) {
  try {
    if (!fs.statSync(directory).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${label} is missing: ${directory}`);
  }
}

function assertFile(filePath, label) {
  try {
    if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
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

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function shellDoubleQuote(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

module.exports = {
  assertMachOArchitecture,
  assertNotUniversalIntermediate,
  getMacArchitecture,
  readMachOArchitectures,
  removeMacElectronRuntimeFiles,
  replaceMacExecutable,
  resolveMacBundlePaths,
  resolveMacElectronBundle,
  validateMacElectronVersion,
  writeMacUninstaller,
};

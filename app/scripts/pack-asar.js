#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");
const yazl = require("yazl");

const TOOL_ROOT = path.resolve(__dirname, "..");
const PACKAGING_GLOBS = ["**/*.{node,dll,dylib,so}"];
const COPY_ENTRIES = ["main.js", "preload.js", "renderer", "ffi", "resources", "assets"];
const ZIP_MTIME = new Date("1980-01-01T00:00:00.000Z");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      values.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!["runtime-version", "version", "out", "zip-out", "platform", "arch", "source"].includes(key)) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (values[key] !== undefined) throw new Error(`Option ${token} was specified more than once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Option ${token} requires a value`);
    values[key] = value;
    index += 1;
  }

  if (values.help) return values;
  for (const required of ["runtime-version", "version", "out"]) {
    if (!values[required]) throw new Error(`Missing required option --${required}`);
  }
  validateVersion(values["runtime-version"], "runtime version");
  validateVersion(values.version, "application version");
  return values;
}

function validateVersion(version, label) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label} must be an exact x.y.z version; received ${version}`);
  }
}

function targetFor(options) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `Native modules can only be rebuilt for the current host (${process.platform}-${process.arch}); requested ${platform}-${arch}`,
    );
  }
  return { platform, arch };
}

function normalizeRelativeEntry(entry, label) {
  if (typeof entry !== "string" || entry.trim() === "") {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const portable = entry.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    /^[a-zA-Z]:/.test(portable) ||
    portable.includes(":") ||
    portable.includes("\0") ||
    /[*?\[\]{}!]/.test(portable)
  ) {
    throw new Error(`${label} must be a relative path without glob syntax: ${entry}`);
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`${label} must not refer to the source root or escape it: ${entry}`);
  }
  return segments.join(path.sep);
}

function canonicalPath(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...suffix);
}

function validateCopyTree(sourcePath, sourceRoot, outDir) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in application sources: ${sourcePath}`);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported application source entry: ${sourcePath}`);

  const realPath = fs.realpathSync(sourcePath);
  if (!isWithin(sourceRoot, realPath)) {
    throw new Error(`Application source entry escapes --source: ${sourcePath}`);
  }
  if (outDir && pathsOverlap(realPath, outDir)) {
    throw new Error(`Application source entry overlaps --out: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      validateCopyTree(path.join(sourcePath, entry.name), sourceRoot, outDir);
    }
  }
}

function resolveApplicationEntries(manifest, sourceDir, outDir) {
  const main = normalizeRelativeEntry(manifest.main || "index.js", "package.main");
  const mainSegments = main.split(path.sep);
  const mainTopLevel = mainSegments.length > 1 ? mainSegments[0] : main;
  const explicit = manifest.runtimePackaging && manifest.runtimePackaging.files;
  if (explicit !== undefined && (!Array.isArray(explicit) || explicit.some((entry) => typeof entry !== "string"))) {
    throw new Error("runtimePackaging.files must be an array of explicit relative file or directory paths");
  }

  const root = fs.realpathSync(sourceDir);
  const canonicalOut = outDir ? canonicalPath(outDir) : null;
  const defaults = [...new Set([...COPY_ENTRIES, mainTopLevel])];
  const entries = new Map();
  for (const [entry, isExplicit] of [
    ...defaults.map((entry) => [entry, false]),
    ...(explicit || []).map((entry) => [entry, true]),
  ]) {
    const relative = normalizeRelativeEntry(entry, isExplicit ? "runtimePackaging.files entry" : "default application entry");
    const sourcePath = path.resolve(root, relative);
    if (!isWithin(root, sourcePath)) throw new Error(`Application source entry escapes --source: ${entry}`);
    if (!fs.existsSync(sourcePath)) {
      if (isExplicit) throw new Error(`runtimePackaging.files entry does not exist: ${entry}`);
      continue;
    }
    validateCopyTree(sourcePath, root, canonicalOut);
    entries.set(relative, sourcePath);
  }
  return { entries: [...entries.entries()], main };
}

function copyApplicationSources(stageDir, manifest, sourceDir, outDir) {
  const { entries, main } = resolveApplicationEntries(manifest, sourceDir, outDir);
  fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lockPath = path.join(sourceDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) throw new Error(`package-lock.json is required in --source directory: ${sourceDir}`);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.version !== undefined) lock.version = manifest.version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = manifest.version;
  fs.writeFileSync(path.join(stageDir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  for (const [entry, source] of entries) {
    const target = path.join(stageDir, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  }

  const stagedMain = path.join(stageDir, main);
  if (!fs.existsSync(stagedMain) || !fs.statSync(stagedMain).isFile()) {
    throw new Error(`package.main was not copied as a file: ${manifest.main || "index.js"}`);
  }
}

function installProductionDependencies(stageDir) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stageDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci --omit=dev failed with exit code ${result.status}`);
}

async function rebuildNativeModules(stageDir, runtimeVersion, platform, arch) {
  const { rebuild } = await import("@electron/rebuild");
  await rebuild({
    buildPath: stageDir,
    electronVersion: runtimeVersion,
    platform,
    arch,
    force: true,
    mode: "sequential",
  });
}

function asarUnpackExpression(manifest) {
  const custom = manifest.runtimePackaging && manifest.runtimePackaging.asarUnpack;
  if (custom !== undefined && (!Array.isArray(custom) || custom.some((pattern) => typeof pattern !== "string" || !pattern))) {
    throw new Error("runtimePackaging.asarUnpack must be an array of non-empty glob strings");
  }
  const patterns = [...PACKAGING_GLOBS, ...(custom || [])];
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

function walkFiles(root, relativeDir = "") {
  const current = path.join(root, relativeDir);
  return fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in unpacked resources: ${relativePath}`);
    if (entry.isDirectory()) return walkFiles(root, relativePath);
    if (entry.isFile()) return [relativePath];
    throw new Error(`Unsupported entry in unpacked resources: ${relativePath}`);
  });
}

function addZipFile(zipFile, source, entryName) {
  zipFile.addFile(source, entryName.replaceAll(path.sep, "/"), {
    compress: false,
    mtime: ZIP_MTIME,
  });
}

async function writeZip(archivePath, unpackedDir, zipPath) {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  const zipFile = new yazl.ZipFile();
  addZipFile(zipFile, archivePath, "app.asar");
  if (fs.existsSync(unpackedDir)) {
    for (const relativePath of walkFiles(unpackedDir)) {
      addZipFile(zipFile, path.join(unpackedDir, relativePath), path.join("app.asar.unpacked", relativePath));
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    output.once("error", reject);
    output.once("close", resolve);
    zipFile.outputStream.once("error", reject);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
}

async function createArtifacts(stageDir, outDir, options) {
  const { runtimeVersion, appVersion, platform, arch, zipPath } = options;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ers-asar-"));
  const archivePath = path.join(temporaryRoot, "app.asar");
  const generatedUnpacked = `${archivePath}.unpacked`;
  const outputUnpacked = path.join(outDir, "app.asar.unpacked");
  const outputArchive = path.join(outDir, "app.asar");

  try {
    await asar.createPackageWithOptions(stageDir, archivePath, {
      dot: true,
      unpack: asarUnpackExpression(options.manifest),
      unpackDir: "ffi",
    });
    await fs.promises.mkdir(outDir, { recursive: true });
    const stagedZip = path.join(temporaryRoot, path.basename(zipPath));
    await writeZip(archivePath, generatedUnpacked, stagedZip);

    fs.copyFileSync(archivePath, outputArchive);
    fs.rmSync(outputUnpacked, { recursive: true, force: true });
    if (fs.existsSync(generatedUnpacked)) fs.cpSync(generatedUnpacked, outputUnpacked, { recursive: true });
    await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
    fs.copyFileSync(stagedZip, zipPath);

    return { archive: outputArchive, unpacked: fs.existsSync(outputUnpacked) ? outputUnpacked : null, zip: zipPath };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertNoElectronRuntime(stageDir) {
  const modulesDir = path.join(stageDir, "node_modules");
  if (!fs.existsSync(modulesDir)) return;

  function inspectPackage(packageDir) {
    const packageJson = path.join(packageDir, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        if (JSON.parse(fs.readFileSync(packageJson, "utf8")).name === "electron") {
          throw new Error(`Application staging must not contain the Electron runtime package: ${packageDir}`);
        }
      } catch (error) {
        if (error.message.includes("must not contain the Electron runtime package")) throw error;
        throw new Error(`Unable to inspect staged dependency manifest: ${packageJson}: ${error.message}`);
      }
    }
    const nestedModules = path.join(packageDir, "node_modules");
    if (fs.existsSync(nestedModules)) inspectModules(nestedModules);
  }

  function inspectModules(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          if (scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) inspectPackage(path.join(entryPath, scopedEntry.name));
        }
      } else {
        inspectPackage(entryPath);
      }
    }
  }

  inspectModules(modulesDir);
}

function assertNoElectronRuntimeDependency(manifest, sourceDir) {
  if (manifest.dependencies && Object.hasOwn(manifest.dependencies, "electron")) {
    throw new Error("electron must not be a production dependency; the shared runtime supplies Electron");
  }

  const lockPath = path.join(sourceDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.packages) {
    for (const [packagePath, entry] of Object.entries(lock.packages)) {
      if (
        packagePath !== "" &&
        (packagePath === "node_modules/electron" || packagePath.endsWith("/node_modules/electron")) &&
        entry.dev !== true
      ) {
        throw new Error(`Electron runtime is present in production lockfile dependencies: ${packagePath}`);
      }
    }
  }

  function inspectLegacyDependencies(dependencies, parentIsDev = false) {
    for (const [name, entry] of Object.entries(dependencies || {})) {
      const isDev = parentIsDev || entry.dev === true;
      if (name === "electron" && !isDev) {
        throw new Error("Electron runtime is present in production lockfile dependencies");
      }
      inspectLegacyDependencies(entry.dependencies, isDev);
    }
  }
  inspectLegacyDependencies(lock.dependencies);
}

function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name));
  }
  if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function showHelp() {
  console.log(
    "Usage: npm run pack:asar -- --runtime-version <x.y.z> --version <x.y.z> --out <resources-dir> [--source <app-source-dir>] [--zip-out <file>] [--platform <host-platform> --arch <host-arch>]",
  );
  console.log("Reads package.json and package-lock.json from --source (defaults to app/), then writes app.asar, optional app.asar.unpacked, and a versioned ZIP.");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const { platform, arch } = targetFor(options);
  const outDir = path.resolve(options.out);
  const sourceDir = path.resolve(options.source || TOOL_ROOT);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`--source must be an existing directory: ${sourceDir}`);
  }
  const sourceManifestPath = path.join(sourceDir, "package.json");
  if (!fs.existsSync(sourceManifestPath)) throw new Error(`package.json is required in --source directory: ${sourceDir}`);
  if (pathsOverlap(sourceDir, outDir)) {
    throw new Error("--out must be outside the --source directory and must not contain the --source directory");
  }

  const appVersion = options.version;
  const runtimeVersion = options["runtime-version"];
  const zipName = `app-${appVersion}-${platform}-${arch}-electron-${runtimeVersion}.zip`;
  const zipPath = options["zip-out"] ? path.resolve(options["zip-out"]) : path.join(path.dirname(outDir), zipName);
  if (pathOverlapsFile(outDir, zipPath)) {
    throw new Error("--zip-out must be outside the resources directory");
  }
  if (pathOverlapsFile(sourceDir, zipPath)) {
    throw new Error("--zip-out must be outside the --source directory");
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ers-stage-"));
  const stageDir = path.join(temporaryRoot, "app");

  try {
    fs.mkdirSync(stageDir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
    manifest.version = appVersion;
    copyApplicationSources(stageDir, manifest, sourceDir, outDir);
    assertNoElectronRuntimeDependency(manifest, sourceDir);
    installProductionDependencies(stageDir);
    await rebuildNativeModules(stageDir, runtimeVersion, platform, arch);
    assertNoElectronRuntime(stageDir);

    const packagedManifest = JSON.parse(fs.readFileSync(path.join(stageDir, "package.json"), "utf8"));
    delete packagedManifest.devDependencies;
    delete packagedManifest.scripts;
    delete packagedManifest.engines;
    delete packagedManifest.runtimePackaging;
    fs.writeFileSync(path.join(stageDir, "package.json"), `${JSON.stringify(packagedManifest, null, 2)}\n`);
    fs.rmSync(path.join(stageDir, "package-lock.json"), { force: true });
    fs.rmSync(path.join(stageDir, "node_modules", ".bin"), { recursive: true, force: true });
    fs.rmSync(path.join(stageDir, "node_modules", ".package-lock.json"), { force: true });
    removeEmptyDirectories(path.join(stageDir, "node_modules"));

    const artifacts = await createArtifacts(stageDir, outDir, {
      runtimeVersion,
      appVersion,
      platform,
      arch,
      zipPath,
      manifest,
    });
    console.log(`PACK_RESULT:${JSON.stringify({ ...artifacts, runtimeVersion, appVersion, platform, arch })}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

function pathsOverlap(directory, candidate) {
  return isWithin(directory, candidate) || isWithin(candidate, directory);
}

function pathOverlapsFile(directory, filePath) {
  return isWithin(directory, filePath);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

module.exports = {
  parseArgs,
  targetFor,
  asarUnpackExpression,
  resolveApplicationEntries,
  copyApplicationSources,
  assertNoElectronRuntime,
  assertNoElectronRuntimeDependency,
  createArtifacts,
  pathsOverlap,
};

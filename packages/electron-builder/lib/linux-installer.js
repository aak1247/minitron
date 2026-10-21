"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDirectories = new Set();
const TEMPLATE_PATH = path.join(__dirname, "linux", "before-remove.sh.tpl");
const LINUX_INSTALL_PREFIX = "/opt";

function withLinuxInstallers(config, options) {
  if (!isRecord(config)) {
    throw new TypeError("withLinuxInstallers(config, options) requires a builder configuration object");
  }
  if (!isRecord(options)) {
    throw new TypeError("withLinuxInstallers(config, options) requires an options object");
  }

  const projectDirOption = options.projectDir === undefined ? config.projectDir : options.projectDir;
  if (projectDirOption !== undefined && (typeof projectDirOption !== "string" || projectDirOption.trim() === "")) {
    throw new TypeError("options.projectDir or config.projectDir must be a non-empty path when provided");
  }
  const projectDir = path.resolve(projectDirOption || process.cwd());
  const linux = isRecord(config.linux) ? { ...config.linux } : {};
  const packageJson = readPackageManifest(projectDir);
  const installDir = resolveInstallDir(config, packageJson, projectDir, options);
  const executableName = resolveExecutableName(config, packageJson, projectDir);

  if (linux.target === undefined && config.target === undefined) {
    linux.target = ["deb", "rpm"];
  }
  assertSupportedTargets(linux.target);

  const clonedConfig = { ...config, linux };
  for (const target of ["deb", "rpm"]) {
    const targetOptions = isRecord(config[target]) ? { ...config[target] } : {};
    const scriptPath = createBeforeRemoveScript(target, installDir, executableName);
    const configuredFpm = Object.prototype.hasOwnProperty.call(targetOptions, "fpm")
      ? targetOptions.fpm
      : linux.fpm;
    const fpmArgs = normalizeFpmArgs(configuredFpm, `config.${target}.fpm`);
    assertNoConflictingBeforeRemove(fpmArgs, target);
    targetOptions.fpm = [...fpmArgs, "--before-remove", scriptPath];
    clonedConfig[target] = targetOptions;
  }

  return { config: clonedConfig, afterPack: null };
}

function resolveInstallDir(config, packageJson, projectDir, options) {
  if (options.installDir !== undefined) {
    if (typeof options.installDir !== "string" || !path.posix.isAbsolute(options.installDir)) {
      throw new TypeError("options.installDir must be an absolute POSIX path when provided");
    }
    return normalizeInstallDir(options.installDir);
  }

  const productName = firstString(
    config.productName,
    packageJson.build && packageJson.build.productName,
    packageJson.productName,
    packageJson.name,
  );
  if (!productName) {
    throw new Error(`Cannot determine the electron-builder productName from ${path.join(projectDir, "package.json")}`);
  }

  const sanitized = sanitizeProductName(productName, projectDir);
  if (!sanitized || sanitized === "." || sanitized === ".." || /[\\/]/.test(sanitized)) {
    throw new Error(`Cannot derive a safe Linux install directory from productName: ${productName}`);
  }
  return path.posix.join(LINUX_INSTALL_PREFIX, sanitized);
}

function normalizeInstallDir(value) {
  const normalized = path.posix.normalize(value);
  if (normalized === "/opt" || !normalized.startsWith("/opt/")) {
    throw new Error(`options.installDir must match electron-builder's /opt/<productName> package location: ${value}`);
  }
  return normalized;
}

function resolveExecutableName(config, packageJson, projectDir) {
  const configured = firstString(
    config.linux && config.linux.executableName,
    config.executableName,
  );
  const sourceName = configured || packageJson.name;
  if (!sourceName) {
    throw new Error(`Cannot determine the electron-builder Linux executable name from ${path.join(projectDir, "package.json")}`);
  }

  const executableName = sanitizeFileName(sourceName, projectDir).toLowerCase();
  if (!executableName || executableName === "." || executableName === ".." || /[\\/]/.test(executableName)) {
    throw new Error(`Cannot derive a safe Linux executable name from: ${sourceName}`);
  }
  return executableName;
}

function sanitizeProductName(value, projectDir) {
  return sanitizeFileName(value, projectDir);
}

function sanitizeFileName(value, projectDir) {
  try {
    const resolved = require.resolve("sanitize-filename", { paths: [projectDir, __dirname] });
    return require(resolved)(value);
  } catch {
    // electron-builder depends on sanitize-filename. This conservative fallback
    // keeps config-only tests and unusual module resolvers usable as well.
    return String(value)
      .replace(/[\x00-\x1f\x80-\x9f<>:"/\\|?*]/g, "")
      .replace(/[. ]+$/g, "")
      .slice(0, 255);
  }
}

function createBeforeRemoveScript(target, installDir, executableName) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-linux-"));
  tempDirectories.add(tempDir);
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const script = template
    .replaceAll("@@PACKAGE_KIND@@", shellQuote(target))
    .replaceAll("@@INSTALL_DIR@@", shellQuote(installDir))
    .replaceAll("@@EXECUTABLE_NAME@@", shellQuote(executableName));
  const scriptPath = path.join(tempDir, `${target}-before-remove.sh`);
  fs.writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o700, flag: "wx" });
  return scriptPath;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeFpmArgs(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of FPM arguments`);
  }
  return value.map((argument, index) => {
    if (typeof argument !== "string") {
      throw new TypeError(`${label}[${index}] must be a string`);
    }
    return argument;
  });
}

function assertNoConflictingBeforeRemove(args, target) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--before-remove" || argument === "--pre-uninstall" ||
        argument.startsWith("--before-remove=") || argument.startsWith("--pre-uninstall=")) {
      throw new Error(`config.${target}.fpm already defines a before-remove script; combine it with Minitron's generated lifecycle hook explicitly`);
    }
  }
}

function assertSupportedTargets(target) {
  if (target === undefined || target === null) return;
  const entries = Array.isArray(target) ? target : [target];
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.target : undefined;
    if (typeof name !== "string") {
      throw new TypeError("config.linux.target entries must be target names or objects with a target name");
    }
    const normalized = name.toLowerCase();
    if (normalized === "dir") continue;
    if (normalized !== "deb" && normalized !== "rpm") {
      throw new Error(`Minitron Linux package lifecycle currently supports only deb and rpm targets; ${name} has no managed install/uninstall integration`);
    }
  }
}

function readPackageManifest(projectDir) {
  const packagePath = path.join(projectDir, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read the electron-builder project package.json at ${packagePath}: ${error.message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`The electron-builder project package.json must contain an object: ${packagePath}`);
  }
  return parsed;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanupTempDirectories() {
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
}

process.once("exit", cleanupTempDirectories);

module.exports = { withLinuxInstallers, cleanupTempDirectories };

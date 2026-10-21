"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGING_MARKER = ".minitron-generated-pkg-scripts.json";
const generatedDirectories = new Set();
let cleanupRegistered = false;

function composeMacPkgLifecycle(context, bundlePaths, appInfo) {
  const targets = Array.isArray(context.targets) ? context.targets : [];
  const pkgTargets = targets.filter((target) => target && target.name === "pkg" && target.options && typeof target.options === "object");
  if (pkgTargets.length > 1) {
    throw new Error("Minitron found more than one electron-builder pkg target; cannot safely compose installer scripts");
  }
  if (pkgTargets.length === 0) return undefined;

  const target = pkgTargets[0];
  const buildResourcesDir = context.packager.info && context.packager.info.buildResourcesDir;
  if (typeof buildResourcesDir !== "string" || buildResourcesDir.trim() === "") {
    throw new Error("electron-builder pkg lifecycle composition requires packager.info.buildResourcesDir");
  }
  if (!Object.prototype.hasOwnProperty.call(target, "__minitronOriginalScripts")) {
    Object.defineProperty(target, "__minitronOriginalScripts", {
      value: target.options.scripts,
      configurable: true,
    });
  }
  const scriptsOption = target.__minitronOriginalScripts;
  if (scriptsOption !== undefined && scriptsOption !== null && typeof scriptsOption !== "string") {
    throw new Error("electron-builder pkg.scripts must resolve to a directory path");
  }
  const userScriptsDir = scriptsOption === null
    ? undefined
    : path.resolve(buildResourcesDir, scriptsOption === undefined ? "pkg-scripts" : scriptsOption);
  if (userScriptsDir && fs.existsSync(userScriptsDir) && !fs.statSync(userScriptsDir).isDirectory()) {
    throw new Error(`electron-builder pkg.scripts is not a directory: ${userScriptsDir}`);
  }

  const preinstall = userScriptsDir && fs.existsSync(userScriptsDir)
    ? fs.readdirSync(userScriptsDir).filter((name) => name.includes("preinstall"))
    : [];
  if (preinstall.length > 1) {
    throw new Error(`Minitron cannot safely compose multiple PKG preinstall hooks in ${userScriptsDir}: ${preinstall.join(", ")}`);
  }
  const sourceHook = preinstall[0];
  const key = crypto.createHash("sha256").update(`${appInfo.id}\0${bundlePaths.bundlePath}`).digest("hex").slice(0, 16);
  const generatedDir = path.join(os.tmpdir(), `minitron-pkg-scripts-${process.pid}-${key}`);
  prepareGeneratedDirectory(generatedDir, { appId: appInfo.id, bundlePath: bundlePaths.bundlePath });
  registerGeneratedDirectoryCleanup(generatedDir);
  if (userScriptsDir && fs.existsSync(userScriptsDir)) {
    for (const entry of fs.readdirSync(userScriptsDir, { withFileTypes: true })) {
      if (entry.name === STAGING_MARKER || entry.name === ".minitron-user-hook") {
        throw new Error(`Minitron reserves ${entry.name} in PKG script directories`);
      }
      const source = path.join(userScriptsDir, entry.name);
      const destinationName = entry.name === sourceHook ? ".minitron-user-hook" : entry.name;
      const destination = path.join(generatedDir, destinationName);
      fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: true });
      if (entry.name === sourceHook) {
        if (!fs.statSync(destination).isFile()) {
          throw new Error(`Minitron cannot compose a non-file PKG preinstall hook: ${source}`);
        }
        const sourceMode = fs.statSync(source).mode & 0o777;
        fs.chmodSync(destination, sourceMode | 0o111);
      }
    }
  }

  const preinstallName = sourceHook || "preinstall";
  const script = makePreinstallScript(bundlePaths, target.options.installLocation, sourceHook !== undefined);
  const scriptPath = path.join(generatedDir, preinstallName);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  target.options.scripts = generatedDir;
  return generatedDir;
}

function makePreinstallScript(bundlePaths, configuredInstallLocation, hasUserHook) {
  const installLocation = normalizeInstallLocation(configuredInstallLocation);
  const appRelativePath = `${installLocation === "/" ? "" : installLocation}/${path.posix.basename(bundlePaths.bundlePath)}`;
  const launcherName = bundlePaths.productFilename;
  const userHook = hasUserHook
    ? [
      'if [ -x "$SCRIPT_DIR/.minitron-user-hook" ]; then',
      '  "$SCRIPT_DIR/.minitron-user-hook" "$@"',
      "fi",
    ]
    : [];
  return [
    "#!/bin/sh",
    "set -eu",
    'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"',
    'TARGET_VOLUME="${3:-/}"',
    `APP_PATH="${'${TARGET_VOLUME%/}'}"${shellSingleQuote(appRelativePath)}`,
    `LAUNCHER="$APP_PATH/Contents/MacOS/"${shellSingleQuote(launcherName)}`,
    'if [ -x "$LAUNCHER" ] && [ -d "$APP_PATH" ]; then',
    '  USER_LIST="$(/usr/bin/dscl /Search -list /Users UniqueID)"',
    '  if [ -z "$USER_LIST" ]; then echo "Minitron could not enumerate local users before replacing the app" >&2; exit 1; fi',
    '  while read -r USER_NAME USER_ID; do',
    '    case "$USER_ID" in ""|*[!0-9]*) continue ;; esac',
    '    [ "$USER_ID" -ge 500 ] || continue',
    '    HOME_RECORD="$(/usr/bin/dscl /Search -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null || true)"',
    '    USER_HOME="${HOME_RECORD#NFSHomeDirectory: }"',
    '    case "$USER_HOME" in /*) ;; *) continue ;; esac',
    '    [ -d "$USER_HOME" ] || continue',
    '    if ! RUNTIME_ROOT="$(/usr/bin/sudo -u "$USER_NAME" -- /usr/bin/env HOME="$USER_HOME" USER="$USER_NAME" LOGNAME="$USER_NAME" "$LAUNCHER" --app-dir "$APP_PATH" --runtime-root 2>/dev/null)"; then continue; fi',
    '    case "$RUNTIME_ROOT" in /*) ;; *) echo "Minitron returned an invalid runtime root for $USER_NAME" >&2; exit 1 ;; esac',
    '    if /bin/launchctl asuser "$USER_ID" /usr/bin/sudo -u "$USER_NAME" -- /usr/bin/env HOME="$USER_HOME" USER="$USER_NAME" LOGNAME="$USER_NAME" ELECTRON_RUNTIME_ROOT="$RUNTIME_ROOT" "$LAUNCHER" --app-dir "$APP_PATH" --stop; then',
    '      :',
    '    elif /usr/bin/sudo -u "$USER_NAME" -- /usr/bin/env HOME="$USER_HOME" USER="$USER_NAME" LOGNAME="$USER_NAME" ELECTRON_RUNTIME_ROOT="$RUNTIME_ROOT" "$LAUNCHER" --app-dir "$APP_PATH" --stop; then',
    '      :',
    '    else',
    '      echo "Minitron could not stop the running installation for $USER_NAME" >&2',
    '      exit 1',
    '    fi',
    '  done <<EOF',
    '$USER_LIST',
    'EOF',
    "fi",
    ...userHook,
    "",
  ].join("\n");
}

function normalizeInstallLocation(value) {
  const configured = value === undefined || value === null || value === "" ? "/Applications" : value;
  if (typeof configured !== "string" || configured.includes("\0") || configured.includes("\\")) {
    throw new Error("electron-builder pkg.installLocation must be an absolute path");
  }
  if (!configured.startsWith("/")) {
    throw new Error(`electron-builder pkg.installLocation must be an absolute path: ${configured}`);
  }
  if (configured.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error(`electron-builder pkg.installLocation must not traverse parent directories: ${configured}`);
  }
  return path.posix.normalize(configured);
}

function prepareGeneratedDirectory(directory, metadata) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Minitron PKG script staging path is not an owned directory: ${directory}`);
    }
    const markerPath = path.join(directory, STAGING_MARKER);
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {
      throw new Error(`Refusing to overwrite an unrecognized PKG script staging directory: ${directory}`);
    }
    if (existing.format !== 1 || existing.appId !== metadata.appId || existing.bundlePath !== metadata.bundlePath) {
      throw new Error(`Refusing to overwrite an unrecognized PKG script staging directory: ${directory}`);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, STAGING_MARKER), `${JSON.stringify({ format: 1, ...metadata })}\n`, { flag: "wx", mode: 0o644 });
}

function registerGeneratedDirectoryCleanup(directory) {
  generatedDirectories.add(directory);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const generated of generatedDirectories) {
      try {
        fs.rmSync(generated, { recursive: true, force: true });
      } catch {
        // Cleanup during process exit must not mask the builder's result.
      }
    }
  });
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

module.exports = {
  composeMacPkgLifecycle,
  makePreinstallScript,
  normalizeInstallLocation,
};

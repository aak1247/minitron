"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const packageJson = require("./package.json");
const originalMain = resolveOriginalMain(packageJson.minitronOriginalMain);
const launcherPath = nonEmptyString(process.env.MINITRON_LAUNCHER);

if (launcherPath) {
  process.env.ELECTRON_FORCE_IS_PACKAGED = "1";
  const { app } = require("electron");
  configureMinitronRuntime(app, packageJson, launcherPath);
}

loadOriginalMain(originalMain, packageJson);

function resolveOriginalMain(value) {
  if (!nonEmptyString(value)) {
    throw new Error("Minitron bootstrap requires package.json minitronOriginalMain to contain the original application entry point");
  }

  const portable = value.replaceAll("\\", "/");
  if (path.isAbsolute(portable) || /^[a-zA-Z]:/.test(portable) || portable.startsWith("/") || portable.includes("\0")) {
    throw new Error(`Minitron original application entry point must be relative: ${value}`);
  }

  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new Error(`Minitron original application entry point must stay inside the application: ${value}`);
  }

  const resolved = path.resolve(__dirname, ...segments);
  if (samePath(resolved, __filename)) {
    throw new Error("Minitron bootstrap cannot load itself as the original application entry point");
  }
  return resolved;
}

function configureMinitronRuntime(app, packageManifest, launcher) {
  const metadata = packageManifest.metadata?.minitron || {};
  const resourcesDir = getResourcesDirectory(app);
  if (resourcesDir) defineResourcesPath(resourcesDir);

  const productName = firstNonEmptyString(
    packageManifest.productName,
    packageManifest.name,
    metadata.executableName,
  );
  if (productName && typeof app.setName === "function") {
    tryCall(() => app.setName(productName));
  }

  const appId = nonEmptyString(metadata.appId);
  const iconPath = resourcesDir && resolveResourceAsset(resourcesDir, metadata.iconRelativePath);

  if (process.platform === "win32" && appId && typeof app.setAppUserModelId === "function") {
    tryCall(() => app.setAppUserModelId(appId));
  }

  if (process.platform === "linux" && appId && typeof app.setDesktopName === "function") {
    const desktopName = firstNonEmptyString(packageManifest.desktopName);
    if (desktopName) tryCall(() => app.setDesktopName(desktopName));
  }

  if (isSafePathSegment(appId)) configureUserDataPath(app, appId);
  configureLauncherRouting(app, launcher);

  if (process.platform === "darwin" && iconPath && app.dock && typeof app.dock.setIcon === "function") {
    const setDockIcon = () => tryCall(() => app.dock.setIcon(iconPath));
    if (typeof app.isReady === "function" && app.isReady()) {
      setDockIcon();
    } else if (typeof app.once === "function") {
      app.once("ready", setDockIcon);
    }
  }

  if (typeof app.on === "function") {
    app.on("browser-window-created", (_event, window) => {
      applyWindowIdentity(window, {
        appId,
        iconPath,
        launcher,
        productName,
      });
    });
  }
}

function getResourcesDirectory(app) {
  const configured = nonEmptyString(process.env.MINITRON_RESOURCES_DIR);
  if (configured) return path.resolve(configured);

  if (app && typeof app.getAppPath === "function") {
    try {
      const appPath = app.getAppPath();
      if (nonEmptyString(appPath)) return path.resolve(path.dirname(appPath));
    } catch {
      // The packaged runtime normally exposes getAppPath before the app is ready.
    }
  }
  return null;
}

function defineResourcesPath(resourcesDir) {
  const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  if (previous && !previous.configurable) return;

  try {
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      enumerable: previous ? previous.enumerable : true,
      value: resourcesDir,
      writable: false,
    });
  } catch {
    // Keep startup working on Electron versions that expose a fixed descriptor.
  }
}

function configureUserDataPath(app, appId) {
  if (
    hasExplicitUserDataArgument(process.argv) ||
    !app ||
    typeof app.getPath !== "function" ||
    typeof app.setPath !== "function"
  ) {
    return;
  }

  try {
    const appData = app.getPath("appData");
    if (!nonEmptyString(appData)) return;
    const userData = path.join(appData, appId);
    fs.mkdirSync(userData, { recursive: true });
    app.setPath("userData", userData);
  } catch {
    // A custom appData location may be unavailable; Electron can retain its default.
  }
}

function hasExplicitUserDataArgument(argv) {
  return Array.isArray(argv) && argv.some((argument) =>
    typeof argument === "string" &&
    (argument === "--user-data-dir" || argument.startsWith("--user-data-dir=")),
  );
}

function configureLauncherRouting(app, launcher) {
  patchAppMethod(app, "relaunch", (args) => {
    const options = args[0];
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return [{ execPath: launcher }, ...args.slice(1)];
    }
    if (nonEmptyString(options.execPath)) return args;
    return [{ ...options, execPath: launcher }, ...args.slice(1)];
  });

  if (process.platform !== "win32") return;

  patchAppMethod(app, "setLoginItemSettings", (args) => [withDefaultPath(args[0], launcher), ...args.slice(1)]);
  patchAppMethod(app, "getLoginItemSettings", (args) => [withDefaultPath(args[0], launcher), ...args.slice(1)]);
  patchAppMethod(app, "setAsDefaultProtocolClient", (args) => withProtocolPath(args, launcher));
  patchAppMethod(app, "removeAsDefaultProtocolClient", (args) => withProtocolPath(args, launcher));
  patchAppMethod(app, "isDefaultProtocolClient", (args) => withProtocolPath(args, launcher));
}

function withDefaultPath(options, launcher) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return { path: launcher };
  }
  if (nonEmptyString(options.path)) return options;
  return { ...options, path: launcher };
}

function withProtocolPath(args, launcher) {
  if (args.length === 0) return args;
  if (nonEmptyString(args[1])) return args;
  const routed = [...args];
  routed[1] = launcher;
  return routed;
}

function patchAppMethod(app, methodName, transformArgs) {
  if (!app || typeof app[methodName] !== "function") return;
  const original = app[methodName];
  try {
    app[methodName] = function (...args) {
      return original.apply(this, transformArgs(args));
    };
  } catch {
    // Some Electron surfaces may expose methods through non-writable bindings.
  }
}

function applyWindowIdentity(window, { appId, iconPath, launcher, productName }) {
  if (!window || typeof window !== "object") return;

  if (process.platform === "win32" && appId && typeof window.setAppDetails === "function") {
    const details = { appId };
    if (launcher) {
      details.appIconPath = launcher;
      details.appIconIndex = 0;
      details.relaunchCommand = quoteWindowsPath(launcher);
      details.relaunchDisplayName = productName || appId;
    }
    tryCall(() => window.setAppDetails(details));
  }

  if (
    iconPath &&
    (process.platform === "win32" || process.platform === "linux") &&
    typeof window.setIcon === "function"
  ) {
    tryCall(() => window.setIcon(iconPath));
  }
}

function resolveResourceAsset(resourcesDir, relativePath) {
  if (!nonEmptyString(relativePath)) return null;
  const portable = relativePath.replaceAll("\\", "/");
  if (path.isAbsolute(portable) || /^[a-zA-Z]:/.test(portable) || portable.startsWith("/") || portable.includes("\0")) return null;
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;

  const candidate = path.resolve(resourcesDir, ...segments);
  const relative = path.relative(resourcesDir, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function loadOriginalMain(entryPath, packageManifest) {
  const extension = path.extname(entryPath).toLowerCase();
  const isModule = extension === ".mjs" || (extension === ".js" && packageManifest.type === "module");

  if (isModule) {
    import(pathToFileURL(entryPath).href).catch((error) => {
      setImmediate(() => {
        throw error;
      });
    });
    return;
  }

  const Module = require("node:module");
  Module._load(entryPath, null, true);
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function firstNonEmptyString(...values) {
  return values.map(nonEmptyString).find(Boolean) || null;
}

function isSafePathSegment(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== "..";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function quoteWindowsPath(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function tryCall(callback) {
  try {
    return callback();
  } catch {
    return undefined;
  }
}

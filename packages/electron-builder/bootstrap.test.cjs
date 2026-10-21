"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const BOOTSTRAP_PATH = path.join(__dirname, "__minitron_bootstrap__.cjs");

test("loads a CommonJS application entry unchanged when Minitron is not active", (t) => {
  const fixture = createFixture(t, { main: "dist/main.js" });
  writeAppFile(fixture, "dist/helper.cjs", `module.exports = "relative-helper";\n`);
  writeAppFile(
    fixture,
    "dist/main.js",
    `globalThis.__electronMockCalls.push({ type: "entry", helper: require("./helper.cjs"), mainFilename: require.main.filename, mainIsEntry: require.main === module, cwd: process.cwd() });\n`,
  );

  const result = runFixture(fixture, { platform: "win32" });

  assert.equal(result.exitCode, 0, result.stderr);
  const record = readRecord(fixture);
  assert.equal(record.calls.filter((call) => call.type === "entry").length, 1);
  assert.equal(record.calls.find((call) => call.type === "entry").helper, "relative-helper");
  assert.equal(record.calls.find((call) => call.type === "entry").mainFilename, fixture.mainPath);
  assert.equal(record.calls.find((call) => call.type === "entry").mainIsEntry, true);
  assert.equal(record.calls.find((call) => call.type === "entry").cwd, fixture.cwd);
  assert.equal(record.calls.some((call) => call.type === "setName"), false);
  assert.equal(record.resourcesPath, undefined);
  assert.equal(record.forceIsPackaged, undefined);
  assert.equal(record.execPath, process.execPath);
});

test("activates runtime identity and routes Windows relaunch integrations through the launcher", (t) => {
  const fixture = createFixture(t, { main: "dist/main.js" });
  writeAppFile(fixture, "dist/main.js", `
    const { app } = require("electron");
    globalThis.__electronMockCalls.push({ type: "entry", mainFilename: require.main.filename, cwd: process.cwd() });
    app.relaunch();
    app.relaunch({ args: ["--keep-default-path"] });
    app.relaunch({ args: ["--keep-this"], execPath: "C:/developer/custom.exe" });
    app.setLoginItemSettings({ openAtLogin: true, args: ["--login-flag"] });
    app.setLoginItemSettings({ openAtLogin: true, path: "C:/developer/login.exe", args: ["--custom-login"] });
    app.getLoginItemSettings({ args: ["--login-flag"] });
    app.setAsDefaultProtocolClient("sample");
    app.setAsDefaultProtocolClient("custom", "C:/developer/protocol.exe", ["--custom-protocol"]);
    app.removeAsDefaultProtocolClient("sample");
    app.isDefaultProtocolClient("sample");
    const window = {
      setAppDetails(details) { globalThis.__electronMockCalls.push({ type: "windowDetails", details }); },
      setIcon(iconPath) { globalThis.__electronMockCalls.push({ type: "windowIcon", iconPath }); },
    };
    app.emit("browser-window-created", {}, window);
  `);
  fs.writeFileSync(path.join(fixture.resourcesDir, "minitron-icon.png"), "icon");

  const launcher = path.join(fixture.root, "Program Files", "Acme", "Minitron.exe");
  const result = runFixture(fixture, {
    launcher,
    platform: "win32",
    resourcesDir: fixture.resourcesDir,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const record = readRecord(fixture);
  assert.equal(record.resourcesPath, fixture.resourcesDir);
  assert.equal(record.resourcesDescriptor.writable, false);
  assert.equal(record.resourcesDescriptor.configurable, true);
  assert.equal(record.forceIsPackaged, "1");
  assert.equal(record.execPath, process.execPath);
  assert.deepEqual(findCall(record, "setName").args, ["Acme Desktop"]);
  assert.deepEqual(findCall(record, "setAppUserModelId").args, ["com.acme.desktop"]);
  assert.deepEqual(findCall(record, "setPath").args, ["userData", path.join(fixture.appDataDir, "com.acme.desktop")]);
  assert.equal(fs.existsSync(path.join(fixture.appDataDir, "com.acme.desktop")), true);

  assert.deepEqual(findCall(record, "relaunch").args, [{ execPath: launcher }]);
  assert.deepEqual(findCalls(record, "relaunch")[1].args, [{ args: ["--keep-default-path"], execPath: launcher }]);
  assert.deepEqual(findCalls(record, "relaunch")[2].args, [{ args: ["--keep-this"], execPath: "C:/developer/custom.exe" }]);
  assert.deepEqual(findCall(record, "setLoginItemSettings").args, [{ openAtLogin: true, args: ["--login-flag"], path: launcher }]);
  assert.deepEqual(findCalls(record, "setLoginItemSettings")[1].args, [{ openAtLogin: true, path: "C:/developer/login.exe", args: ["--custom-login"] }]);
  assert.deepEqual(findCall(record, "getLoginItemSettings").args, [{ args: ["--login-flag"], path: launcher }]);
  assert.deepEqual(findCall(record, "setAsDefaultProtocolClient").args, ["sample", launcher]);
  assert.deepEqual(findCalls(record, "setAsDefaultProtocolClient")[1].args, ["custom", "C:/developer/protocol.exe", ["--custom-protocol"]]);
  assert.deepEqual(findCall(record, "removeAsDefaultProtocolClient").args, ["sample", launcher]);
  assert.deepEqual(findCall(record, "isDefaultProtocolClient").args, ["sample", launcher]);

  const details = findCall(record, "windowDetails").details;
  assert.equal(details.appId, "com.acme.desktop");
  assert.equal(details.appIconPath, path.join(fixture.resourcesDir, "minitron-icon.png"));
  assert.equal(details.relaunchCommand, `"${launcher}"`);
  assert.equal(details.relaunchDisplayName, "Acme Desktop");
  assert.deepEqual(findCall(record, "windowIcon").iconPath, path.join(fixture.resourcesDir, "minitron-icon.png"));
});

test("loads ESM entries and uses the app path for resources when no resource override is set", (t) => {
  const fixture = createFixture(t, { main: "dist/main.mjs", type: "module" });
  writeAppFile(
    fixture,
    "dist/main.mjs",
    `globalThis.__electronMockCalls.push({ type: "entry", url: import.meta.url, cwd: process.cwd() });\n`,
  );

  const result = runFixture(fixture, {
    launcher: path.join(fixture.root, "minitron"),
    platform: "linux",
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const record = readRecord(fixture);
  assert.equal(record.resourcesPath, fixture.resourcesDir);
  assert.equal(record.calls.some((call) => call.type === "setDesktopName"), false);
  const entry = findCall(record, "entry");
  assert.equal(entry.url, pathToFileURL(fixture.mainPath).href);
  assert.equal(entry.cwd, fixture.cwd);
});

test("sets a configured Linux desktop identity and preserves an explicit user data directory", (t) => {
  const fixture = createFixture(t, { main: "dist/main.js", desktopName: "com.acme.desktop.desktop" });
  writeAppFile(fixture, "dist/main.js", `
    globalThis.__electronMockCalls.push({ type: "entry" });
  `);
  const result = runFixture(fixture, {
    args: ["--user-data-dir", path.join(fixture.root, "custom-data")],
    launcher: path.join(fixture.root, "minitron.exe"),
    platform: "linux",
    resourcesDir: fixture.resourcesDir,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const record = readRecord(fixture);
  assert.deepEqual(findCall(record, "setDesktopName").args, ["com.acme.desktop.desktop"]);
  assert.equal(record.calls.some((call) => call.type === "setPath"), false);
});

test("rejects a bootstrap loop", (t) => {
  const fixture = createFixture(t, { main: "__minitron_bootstrap__.cjs" });
  const result = runFixture(fixture, {
    launcher: path.join(fixture.root, "minitron.exe"),
    platform: "win32",
    resourcesDir: fixture.resourcesDir,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /cannot load itself/);
});

test("sets the macOS dock icon when the app exposes the dock API", (t) => {
  const fixture = createFixture(t, { main: "dist/main.js" });
  writeAppFile(fixture, "dist/main.js", `
    const { app } = require("electron");
    globalThis.__electronMockCalls.push({ type: "entry" });
    app.emit("ready");
  `);
  fs.writeFileSync(path.join(fixture.resourcesDir, "minitron-icon.png"), "icon");

  const result = runFixture(fixture, {
    launcher: path.join(fixture.root, "Minitron.app"),
    platform: "darwin",
    resourcesDir: fixture.resourcesDir,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const record = readRecord(fixture);
  assert.deepEqual(findCall(record, "dockIcon").args, [path.join(fixture.resourcesDir, "minitron-icon.png")]);
});

function createFixture(t, { main, type = "commonjs", desktopName }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-bootstrap-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resourcesDir = path.join(root, "resources");
  const appDir = path.join(resourcesDir, "app.asar");
  const cwd = path.join(root, "working-directory");
  const appDataDir = path.join(root, "app-data");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.copyFileSync(BOOTSTRAP_PATH, path.join(appDir, "__minitron_bootstrap__.cjs"));
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "acme-desktop",
      productName: "Acme Desktop",
      type,
      ...(desktopName ? { desktopName } : {}),
      main: "__minitron_bootstrap__.cjs",
      minitronOriginalMain: main,
      metadata: {
        other: { keep: true },
        minitron: {
          appId: "com.acme.desktop",
          executableName: "Acme Desktop",
          iconRelativePath: "minitron-icon.png",
        },
      },
    }),
  );
  fs.mkdirSync(resourcesDir, { recursive: true });
  const preloadPath = path.join(root, "electron-mock.cjs");
  fs.writeFileSync(preloadPath, createElectronMockPreload());

  return {
    appDataDir,
    appDir,
    cwd,
    mainPath: path.resolve(appDir, main.replaceAll("\\", "/")),
    preloadPath,
    recordPath: path.join(root, "record.json"),
    resourcesDir,
    root,
  };
}

function writeAppFile(fixture, relativePath, contents) {
  const target = path.join(fixture.appDir, ...relativePath.split(/[\\/]+/));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function createElectronMockPreload() {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const Module = require("node:module");
    const { EventEmitter } = require("node:events");
    const calls = [];
    const originalLoad = Module._load;
    const appDataDir = process.env.TEST_APP_DATA;
    let userDataPath = path.join(appDataDir, "default");
    let appName = "Original Name";
    const app = new EventEmitter();
    const record = (type) => (...args) => { calls.push({ type, args }); return true; };
    app.getAppPath = () => path.join(process.env.TEST_RESOURCES_DIR, "app.asar");
    app.getPath = (name) => name === "appData" ? appDataDir : userDataPath;
    app.setPath = (name, value) => { calls.push({ type: "setPath", args: [name, value] }); if (name === "userData") userDataPath = value; };
    app.setName = (name) => { appName = name; calls.push({ type: "setName", args: [name] }); };
    app.getName = () => appName;
    app.setAppUserModelId = record("setAppUserModelId");
    app.setDesktopName = record("setDesktopName");
    app.relaunch = record("relaunch");
    app.setLoginItemSettings = record("setLoginItemSettings");
    app.getLoginItemSettings = record("getLoginItemSettings");
    app.setAsDefaultProtocolClient = record("setAsDefaultProtocolClient");
    app.removeAsDefaultProtocolClient = record("removeAsDefaultProtocolClient");
    app.isDefaultProtocolClient = record("isDefaultProtocolClient");
    app.isReady = () => false;
    app.dock = { setIcon: record("dockIcon") };
    globalThis.__electronMockCalls = calls;
    if (process.env.TEST_PLATFORM) Object.defineProperty(process, "platform", { value: process.env.TEST_PLATFORM });
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return { app };
      return originalLoad.call(this, request, parent, isMain);
    };
    process.once("exit", () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
      fs.writeFileSync(process.env.TEST_RECORD, JSON.stringify({
        calls,
        resourcesPath: process.resourcesPath,
        resourcesDescriptor: descriptor && { writable: descriptor.writable, configurable: descriptor.configurable },
        forceIsPackaged: process.env.ELECTRON_FORCE_IS_PACKAGED,
        execPath: process.execPath,
      }));
    });
  `;
}

function runFixture(fixture, { args = [], launcher, platform, resourcesDir } = {}) {
  const env = { ...process.env };
  for (const name of ["MINITRON_LAUNCHER", "MINITRON_RESOURCES_DIR", "ELECTRON_FORCE_IS_PACKAGED"]) delete env[name];
  env.TEST_APP_DATA = fixture.appDataDir;
  env.TEST_PLATFORM = platform;
  env.TEST_RECORD = fixture.recordPath;
  env.TEST_RESOURCES_DIR = fixture.resourcesDir;
  if (launcher) env.MINITRON_LAUNCHER = launcher;
  if (resourcesDir) env.MINITRON_RESOURCES_DIR = resourcesDir;

  const result = spawnSync(
    process.execPath,
    ["--require", fixture.preloadPath, path.join(fixture.appDir, "__minitron_bootstrap__.cjs"), ...args],
    { cwd: fixture.cwd, encoding: "utf8", env },
  );
  return { exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
}

function readRecord(fixture) {
  return JSON.parse(fs.readFileSync(fixture.recordPath, "utf8"));
}

function findCall(record, type) {
  const call = record.calls.find((entry) => entry.type === type);
  assert.ok(call, `Expected a ${type} call; got ${JSON.stringify(record.calls)}`);
  return call;
}

function findCalls(record, type) {
  const calls = record.calls.filter((entry) => entry.type === type);
  assert.ok(calls.length > 0, `Expected ${type} calls; got ${JSON.stringify(record.calls)}`);
  return calls;
}

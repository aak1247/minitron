// 标准 Electron 主进程——业务代码对「共享运行时」完全无感知，
// 壳把本应用 app.asar 的路径作为位置参数传给全局 electron 即可加载。
// （此时 process.defaultApp === true，属预期行为）
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("path");

const smokeMode = process.env.MYAPP_SMOKE === "1";
const readyFile = process.env.ERS_READY_FILE;
const releaseTxid = process.env.ERS_RELEASE_TXID || "";
let smokeTimer;
let readyReported = false;

if (smokeMode) {
  // Hosted Windows runners may have no usable accelerated graphics device.
  // Smoke coverage exercises the real page, preload and IPC with software GPU.
  app.disableHardwareAcceleration();
  console.error("SMOKE_BOOTSTRAP: waiting for Electron and renderer readiness");
  smokeTimer = setTimeout(() => {
    console.error("Timed out waiting for Electron/renderer/preload IPC readiness");
    app.exit(1);
  }, 30000);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    show: !smokeMode,
    icon: path.join(__dirname, "renderer/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html")).catch((error) => {
    console.error("Failed to load application page:", error);
    if (smokeMode) app.exit(1);
  });
}

// 示例：ffi / 原生 dll 的取路径方式。
// 注意：共享 runtime 模式下 process.resourcesPath 指向的是 runtime 目录，
// 不是本应用目录！正确做法是从 app.getAppPath()（即本应用的 app.asar 路径）
// 推导旁边的 app.asar.unpacked。
function ffiLibPath(name) {
  const ext = { win32: ".dll", darwin: ".dylib", linux: ".so" }[process.platform];
  const unpackedDir = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
  return path.join(unpackedDir, "ffi", name + ext);
}

ipcMain.handle("app:info", () => ({
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  appPath: app.getAppPath(),
  defaultApp: process.defaultApp === true,
  ffiExample: ffiLibPath("mylib"),
}));

function writeReadyFile() {
  if (!readyFile) return;

  const readyPath = path.resolve(readyFile);
  fs.mkdirSync(path.dirname(readyPath), { recursive: true });
  const tempPath = `${readyPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ txid: releaseTxid, ready: true }));
  fs.renameSync(tempPath, readyPath);
}

ipcMain.handle("app:report-ready", (event) => {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("readiness can only be reported by the main frame");
  }
  if (readyReported) return { ready: true };
  readyReported = true;

  const info = {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    appPath: app.getAppPath(),
    defaultApp: process.defaultApp === true,
    ipc: true,
    txid: releaseTxid,
  };

  try {
    writeReadyFile();
  } catch (error) {
    console.error("Failed to write readiness file:", error);
    if (smokeMode) app.exit(1);
    throw error;
  }

  if (smokeMode) {
    clearTimeout(smokeTimer);
    console.log(`SMOKE:${JSON.stringify(info)}`);
    if (process.env.ERS_SMOKE_RESULT_FILE) {
      fs.writeFileSync(process.env.ERS_SMOKE_RESULT_FILE, JSON.stringify(info));
    }
    const holdMs = Number.parseInt(process.env.ERS_SMOKE_HOLD_MS || "0", 10);
    if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 600000) {
      console.error("ERS_SMOKE_HOLD_MS must be between 0 and 600000");
      app.exit(1);
      return { ready: false };
    }
    smokeTimer = setTimeout(() => app.quit(), holdMs);
  }
  return { ready: true };
});

ipcMain.handle("app:report-error", (_event, message) => {
  console.error("Renderer failed:", String(message));
  if (smokeMode) app.exit(1);
  return { ok: false };
});

app.whenReady().then(() => {
  if (process.env.MYAPP_FAIL_START === "1") {
    console.error("MYAPP_FAIL_START requested a startup failure");
    app.exit(42);
    return;
  }

  createWindow();
});
app.on("window-all-closed", () => app.quit());

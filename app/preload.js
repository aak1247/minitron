const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("myapp", {
  info: () => ipcRenderer.invoke("app:info"),
  readinessEnabled: Boolean(process.env.MYAPP_SMOKE || process.env.ERS_READY_FILE),
  reportReady: () => ipcRenderer.invoke("app:report-ready"),
  reportError: (message) => ipcRenderer.invoke("app:report-error", String(message)),
});

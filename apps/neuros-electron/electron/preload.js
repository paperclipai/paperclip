const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("neurOSDesktop", {
  meta: () => ipcRenderer.invoke("desktop:meta"),
  loadConfig: () => ipcRenderer.invoke("desktop:config:load"),
  saveConfig: (partialConfig) => ipcRenderer.invoke("desktop:config:save", partialConfig),
  probeConnection: (baseUrl) => ipcRenderer.invoke("desktop:probe", baseUrl),
  detectConnection: () => ipcRenderer.invoke("desktop:detect"),
  openExternal: (targetUrl) => ipcRenderer.invoke("desktop:openExternal", targetUrl),
});

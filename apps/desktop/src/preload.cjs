const { contextBridge, ipcRenderer } = require("electron");

// No arbitrary filesystem, commands, IPC channels or management secrets reach the renderer.
contextBridge.exposeInMainWorld(
  "loopmarshalDesktop",
  Object.freeze({
    customTitleBar: process.platform === "win32",
    setWindowTheme: (theme) =>
      ipcRenderer.invoke("desktop:window-theme", theme),
    getInfo: () => ipcRenderer.invoke("desktop:info"),
    selectProjectDirectory: () => ipcRenderer.invoke("desktop:select-project"),
    openDataDirectory: () => ipcRenderer.invoke("desktop:open-data"),
    copyCliPath: () => ipcRenderer.invoke("desktop:copy-cli"),
    openActivityWindow: (sessionId, memberId) =>
      ipcRenderer.invoke("desktop:observe", sessionId, memberId),
    openConversationHistory: (sessionId, memberId) =>
      ipcRenderer.invoke("desktop:history", sessionId, memberId),
  }),
);

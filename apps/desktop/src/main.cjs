const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  clipboard,
} = require("electron");
const {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  appendFileSync,
  renameSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");
const { CoreSupervisor } = require("./core-supervisor.cjs");

app.setName("LoopMarshal");
const dataDirectory = resolve(
  process.env.LOOPMARSHAL_DESKTOP_DATA_DIR ||
    (process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "loopmarshal",
        )
      : join(homedir(), ".local", "share", "loopmarshal")),
);
const desktopDirectory = join(dataDirectory, "desktop");
const resourceDirectory = app.isPackaged
  ? join(process.resourcesPath, "loopmarshal")
  : resolve(__dirname, "../staging");
const cliPath = join(resourceDirectory, "bin", "loopmarshal.cmd");
mkdirSync(desktopDirectory, { recursive: true });
mkdirSync(join(dataDirectory, "logs"), { recursive: true });
const chromiumDataDirectory = join(desktopDirectory, "chromium");
mkdirSync(chromiumDataDirectory, { recursive: true });
app.setPath("userData", chromiumDataDirectory);
app.setPath("logs", join(dataDirectory, "logs"));
const logPath = join(dataDirectory, "logs", "desktop.log");
if (
  existsSync(logPath) &&
  require("node:fs").statSync(logPath).size > 5 * 1024 * 1024
) {
  try {
    renameSync(logPath, logPath + ".1");
  } catch {
    /* Keep startup available. */
  }
}
const log = (message) => {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* Error dialogs remain available. */
  }
};
const endpointPath = join(desktopDirectory, "endpoint.json");
const supervisor = new CoreSupervisor({
  resourceDirectory,
  dataDirectory,
  port: Number(process.env.LOOPMARSHAL_DESKTOP_PORT || 42688),
});
let mainWindow;
let shuttingDown = false;
let canQuit = false;
let baseUrl = "";
let startupComplete = false;
const observationWindows = new Map();

function removeEndpoint() {
  try {
    const metadata = JSON.parse(readFileSync(endpointPath, "utf8"));
    if (metadata.desktopPid === process.pid) unlinkSync(endpointPath);
  } catch {
    /* Missing is normal. */
  }
}
function allowedFrame(event) {
  return [mainWindow, ...observationWindows.values()].some(
    (window) =>
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url.startsWith(baseUrl + "/"),
  );
}
function observationQuery(sessionId, memberId) {
  const validId = (id) =>
    typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (!validId(sessionId) || (memberId !== undefined && !validId(memberId)))
    throw new Error("Invalid conversation or member");
  return new URLSearchParams({ sessionId, ...(memberId ? { memberId } : {}) });
}
function focusWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function windowChrome() {
  return process.platform === "win32"
    ? {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#ffffff",
          symbolColor: "#202c40",
          height: 36,
        },
      }
    : {};
}
function secureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        void shell.openExternal(url);
    } catch {
      /* Invalid target. */
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== baseUrl) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    try {
      if (new URL(url).origin !== baseUrl) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
}
async function openObservation(sessionId, memberId) {
  const query = observationQuery(sessionId, memberId);
  const key = query.toString();
  const previous = observationWindows.get(key);
  if (previous && !previous.isDestroyed()) {
    focusWindow(previous);
    return true;
  }
  const window = new BrowserWindow({
    width: 850,
    height: 780,
    minWidth: 440,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    ...windowChrome(),
    title: "LoopMarshal · 运行观察",
    backgroundColor: "#111827",
    icon: join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  observationWindows.set(key, window);
  secureNavigation(window);
  window.on("closed", () => observationWindows.delete(key));
  window.once("ready-to-show", () => focusWindow(window));
  try {
    await window.loadURL(`${baseUrl}/activity?${query}`);
  } catch (error) {
    window.destroy();
    throw error;
  }
  return true;
}
function publicInfo() {
  return {
    version: app.getVersion(),
    dataDirectory,
    cliPath,
    baseUrl,
    nodeVersion: supervisor.info?.nodeVersion ?? "",
    packaged: app.isPackaged,
  };
}
function installIpc() {
  ipcMain.handle("desktop:window-theme", (event, theme) => {
    if (!allowedFrame(event)) throw new Error("Untrusted desktop caller");
    if (!["light", "dark"].includes(theme))
      throw new Error("Invalid window theme");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === "win32")
      window.setTitleBarOverlay({
        color: theme === "dark" ? "#1b2434" : "#ffffff",
        symbolColor: theme === "dark" ? "#e5ebf7" : "#202c40",
        height: 36,
      });
    return true;
  });
  for (const [channel, action] of [
    ["desktop:info", () => publicInfo()],
    [
      "desktop:select-project",
      async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: "选择项目目录",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    ],
    ["desktop:open-data", () => shell.openPath(dataDirectory)],
    [
      "desktop:copy-cli",
      () => {
        clipboard.writeText(cliPath);
        return true;
      },
    ],
    ["desktop:observe", openObservation],
    [
      "desktop:history",
      async (sessionId, memberId) => {
        const query = observationQuery(sessionId, memberId);
        query.set("view", "messages");
        if (!mainWindow || mainWindow.isDestroyed())
          throw new Error("Main window is unavailable");
        await mainWindow.loadURL(`${baseUrl}/?${query}`);
        focusWindow(mainWindow);
        return true;
      },
    ],
  ])
    ipcMain.handle(channel, (event, ...args) => {
      if (!allowedFrame(event)) throw new Error("Untrusted desktop caller");
      return action(...args);
    });
}
function installMenu() {
  Menu.setApplicationMenu(null);
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: "LoopMarshal",
    backgroundColor: "#111827",
    ...windowChrome(),
    icon: join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  secureNavigation(mainWindow);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.on("will-download", (event) =>
    event.preventDefault(),
  );
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      if (new URL(details.url).origin !== baseUrl)
        return callback({ responseHeaders: details.responseHeaders });
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ],
          "X-Content-Type-Options": ["nosniff"],
        },
      });
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log(`renderer exit: ${details.reason}`);
    if (!shuttingDown)
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        message: "界面进程已退出",
        detail:
          "后台任务仍由 Core 管理。请重新打开应用恢复界面；关闭应用会停止后台服务。",
      });
  });
  mainWindow.on("close", (event) => {
    if (!canQuit) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  await mainWindow.loadURL(baseUrl + "/");
}
async function quitCleanly() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("stopping core");
  await supervisor.stop();
  removeEndpoint();
  canQuit = true;
  app.quit();
}
app.on("before-quit", (event) => {
  if (!canQuit) {
    event.preventDefault();
    void quitCleanly();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
supervisor.on("unexpected-exit", async ({ code, signal }) => {
  log(`core exit: ${code ?? signal}`);
  removeEndpoint();
  if (!startupComplete || shuttingDown) return;
  await dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "后台服务已停止",
    message: "后台服务意外退出，任务不会自动重发。",
    detail: "请重新打开客户端，并核对未完成任务。日志和用户数据已保留。",
  });
  app.quit();
});
process.on("uncaughtException", (error) => {
  log(error.stack || String(error));
  if (!shuttingDown) {
    dialog.showErrorBox(
      "LoopMarshal",
      "客户端遇到错误，请检查日志后重新打开。用户数据已保留。",
    );
    app.quit();
  }
});
process.on("unhandledRejection", (error) => {
  log(error?.stack || String(error));
});

if (!app.requestSingleInstanceLock()) {
  canQuit = true;
  app.quit();
} else
  app.whenReady().then(async () => {
    if (process.platform === "win32")
      app.setAppUserModelId("com.loopmarshal.desktop");
    try {
      log(`starting ${app.getVersion()}`);
      const info = await supervisor.start();
      baseUrl = info.baseUrl;
      writeFileSync(
        endpointPath,
        JSON.stringify({
          ...info,
          desktopPid: process.pid,
          version: app.getVersion(),
        }),
        { mode: 0o600 },
      );
      installIpc();
      installMenu();
      await createWindow();
      startupComplete = true;
      log("ready");
    } catch (error) {
      log(error.stack || String(error));
      dialog.showErrorBox(
        "LoopMarshal 启动失败",
        `${error.message}\n\n日志：${join(dataDirectory, "logs")}\n数据会保留，请勿删除数据库。`,
      );
      app.quit();
    }
  });

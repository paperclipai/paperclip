import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from "electron";
import { setupTitlebarAndAttachToWindow } from "custom-electron-titlebar/main";
import {
  DESKTOP_APP_ID,
  DESKTOP_WINDOW_TITLE,
  buildWorkerEnvironment,
  formatChildExit,
  getDesktopTitlebarOverlay,
  getDesktopWindowBackground,
  isDesktopTheme,
  resolveDesktopAppRoot,
  resolveDesktopPreferencesPath,
  resolveDesktopRepoRoot,
  resolveDesktopTheme,
  resolveDesktopUserDataDir,
  resolvePackagedRuntimeRoot,
  resolveTitlebarThemePath,
  shouldOpenExternalNavigation,
  type DesktopMode,
  type DesktopTheme,
  writeDesktopThemePreference,
} from "./runtime.js";
import { createSplashDataUrl, type SplashState } from "./splash.js";

type WorkerReadyMessage = {
  type: "ready";
  payload: {
    apiUrl: string;
  };
};

type WorkerFatalMessage = {
  type: "fatal";
  error: string;
};

type WorkerMessage = WorkerReadyMessage | WorkerFatalMessage;
type NativeTitlebarSyncPayload = {
  backgroundColor: string;
  overlay: {
    color: string;
    symbolColor: string;
    height: number;
  };
};

const __filename = fileURLToPath(import.meta.url);
const desktopAppRoot = resolveDesktopAppRoot(__filename);
const repoRoot = resolveDesktopRepoRoot(desktopAppRoot);
const workerScript = path.resolve(desktopAppRoot, "dist", "server-worker.js");
const tsxLoaderImport = pathToFileURL(
  path.resolve(desktopAppRoot, "node_modules", "tsx", "dist", "loader.mjs"),
).href;

app.setName(DESKTOP_WINDOW_TITLE);
app.setAppUserModelId(DESKTOP_APP_ID);
Menu.setApplicationMenu(null);

const desktopMode: DesktopMode =
  process.env.PAPERCLIP_DESKTOP_DEV === "true" ? "development" : "packaged";
const startupTimeoutMs = 60_000;
const waitingSplashDelayMs = 1_800;
const defaultUserDataDir = app.getPath("userData");
const configuredUserDataDir = resolveDesktopUserDataDir(defaultUserDataDir);

if (configuredUserDataDir !== defaultUserDataDir) {
  app.setPath("userData", configuredUserDataDir);
}

const desktopUserDataDir = app.getPath("userData");
const desktopPreferencesPath = resolveDesktopPreferencesPath(desktopUserDataDir);

let mainWindow: BrowserWindow | null = null;
let workerProcess: ChildProcess | null = null;
let currentAppUrl: string | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let waitingSplashTimer: NodeJS.Timeout | null = null;
let appIsQuitting = false;
let shutdownPromise: Promise<void> | null = null;
let startupSequence = 0;
let detachTitlebar: (() => void) | null = null;
let currentDesktopTheme: DesktopTheme = resolveDesktopTheme(
  desktopUserDataDir,
  nativeTheme.shouldUseDarkColors,
);
const expectedExitPids = new Set<number>();

function getLocale(): string {
  try {
    return app.getLocale();
  } catch {
    return "en";
  }
}

function clearStartupTimers(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (waitingSplashTimer) {
    clearTimeout(waitingSplashTimer);
    waitingSplashTimer = null;
  }
}

async function loadSplashState(state: SplashState, detail?: string): Promise<void> {
  await ensureWindow().loadURL(
    createSplashDataUrl({
      locale: getLocale(),
      theme: currentDesktopTheme,
      state,
      detail,
    }),
  );
}

function attachCustomTitlebar(win: BrowserWindow): void {
  void setupTitlebarAndAttachToWindow(win, {
    themeConfigPath: resolveTitlebarThemePath(desktopAppRoot),
  })
    .then((detach) => {
      detachTitlebar = detach;
    })
    .catch((error) => {
      console.warn("[desktop-main] Failed to attach custom title bar:", error);
    });
}

function syncNativeTitlebar(
  win: BrowserWindow,
  payload: NativeTitlebarSyncPayload,
): boolean {
  try {
    win.setBackgroundColor(payload.backgroundColor);

    if (process.platform === "darwin") {
      return false;
    }

    win.setTitleBarOverlay(payload.overlay);
    return true;
  } catch (error) {
    console.warn("[desktop-main] Failed to sync native title bar theme:", error);
    return false;
  }
}

function ensureWindow(): BrowserWindow {
  if (mainWindow) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: DESKTOP_WINDOW_TITLE,
    backgroundColor: getDesktopWindowBackground(currentDesktopTheme),
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin"
      ? false
      : getDesktopTitlebarOverlay(currentDesktopTheme),
    icon:
      process.platform === "darwin" || desktopMode !== "development"
        ? undefined
        : path.resolve(desktopAppRoot, "assets", "icon.png"),
    webPreferences: {
      additionalArguments: [`--paperclip-desktop-initial-theme=${currentDesktopTheme}`],
      preload: path.resolve(desktopAppRoot, "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachCustomTitlebar(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    detachTitlebar?.();
    detachTitlebar = null;
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternalNavigation(url, currentAppUrl)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }

    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!shouldOpenExternalNavigation(url, currentAppUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  return mainWindow;
}

async function showStartupError(detail: string): Promise<void> {
  await loadSplashState("error", detail);
}

async function stopWorkerProcess(): Promise<void> {
  const child = workerProcess;
  if (!child) return;

  workerProcess = null;
  clearStartupTimers();
  currentAppUrl = null;

  if (child.pid) {
    expectedExitPids.add(child.pid);
  }

  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (!alreadyExited) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone by the time we attempt shutdown.
    }
  }

  await new Promise<void>((resolve) => {
    if (alreadyExited) {
      resolve();
      return;
    }

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore follow-up kill failures.
      }
    }, 5_000);

    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

function attachWorkerLogging(child: ChildProcess): void {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[desktop-worker] ${String(chunk)}`);
  });

  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[desktop-worker] ${String(chunk)}`);
  });
}

async function startWorkerProcess(reason: string): Promise<void> {
  const sequence = ++startupSequence;
  await stopWorkerProcess();
  await loadSplashState("starting");

  const env = buildWorkerEnvironment({
    appRoot: desktopAppRoot,
    repoRoot,
    userDataDir: desktopUserDataDir,
    mode: desktopMode,
  });

  const child = fork(workerScript, [], {
    cwd: desktopMode === "development" ? repoRoot : resolvePackagedRuntimeRoot(desktopAppRoot),
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    execPath: process.execPath,
    execArgv: desktopMode === "development" ? ["--import", tsxLoaderImport] : [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  workerProcess = child;
  attachWorkerLogging(child);

  waitingSplashTimer = setTimeout(() => {
    if (workerProcess !== child || sequence !== startupSequence) return;
    void loadSplashState("waiting");
  }, waitingSplashDelayMs);

  startupTimer = setTimeout(() => {
    if (workerProcess !== child || sequence !== startupSequence) return;
    void showStartupError(
      getLocale().toLowerCase().startsWith("zh")
        ? "打开时间比平时更久。你可以再试一次；如果还是不行，再查看终端日志。"
        : "Startup is taking longer than usual. Try again once, then check the terminal logs if it still fails.",
    );
    void stopWorkerProcess();
  }, startupTimeoutMs);

  child.on("message", (message: WorkerMessage) => {
    if (workerProcess !== child || sequence !== startupSequence) return;

    if (message?.type === "ready") {
      clearStartupTimers();
      currentAppUrl = message.payload.apiUrl.replace(/\/api\/?$/, "");
      void ensureWindow().loadURL(currentAppUrl);
      return;
    }

    if (message?.type === "fatal") {
      clearStartupTimers();
      void showStartupError(message.error);
      void stopWorkerProcess();
    }
  });

  child.once("error", (error) => {
    if (workerProcess !== child || sequence !== startupSequence) return;
    clearStartupTimers();
    void showStartupError(error.message);
  });

  child.once("exit", (code, signal) => {
    clearStartupTimers();
    const wasExpected = child.pid ? expectedExitPids.delete(child.pid) : false;
    if (workerProcess === child) {
      workerProcess = null;
    }
    if (appIsQuitting || wasExpected) return;

    void showStartupError(
      getLocale().toLowerCase().startsWith("zh")
        ? `本地控制平面意外退出：${formatChildExit(code, signal)}。`
        : `The local control plane exited unexpectedly with ${formatChildExit(code, signal)}.`,
    );
  });

  console.log(`[desktop-main] Started worker for ${reason}.`);
}

function focusExistingWindow(): void {
  const win = ensureWindow();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
}

async function terminateApplication(signal: NodeJS.Signals): Promise<void> {
  appIsQuitting = true;
  await stopWorkerProcess();
  app.exit(signal === "SIGINT" ? 130 : 143);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusExistingWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (shutdownPromise || !workerProcess) {
      appIsQuitting = true;
      return;
    }

    event.preventDefault();
    appIsQuitting = true;
    shutdownPromise = stopWorkerProcess().finally(() => {
      shutdownPromise = null;
      app.quit();
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void startWorkerProcess("activate");
      return;
    }
    focusExistingWindow();
  });

  ipcMain.handle("desktop-shell:retry-start", async () => {
    await startWorkerProcess("manual-retry");
  });

  ipcMain.handle("desktop-shell:update-titlebar", (event, payload: NativeTitlebarSyncPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return false;
    }

    return syncNativeTitlebar(win, payload);
  });

  ipcMain.handle("desktop-shell:set-theme-preference", (_event, theme: unknown) => {
    if (!isDesktopTheme(theme)) {
      return false;
    }

    currentDesktopTheme = theme;

    try {
      writeDesktopThemePreference(desktopPreferencesPath, theme);
      return true;
    } catch (error) {
      console.warn("[desktop-main] Failed to persist theme preference:", error);
      return false;
    }
  });

  process.once("SIGINT", () => {
    void terminateApplication("SIGINT");
  });

  process.once("SIGTERM", () => {
    void terminateApplication("SIGTERM");
  });

  void app
    .whenReady()
    .then(async () => {
      ensureWindow();
      await startWorkerProcess("initial-start");
    })
    .catch(async (error) => {
      await showStartupError(error.message);
    });
}

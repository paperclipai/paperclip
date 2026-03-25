import { app, BrowserWindow, dialog, shell } from "electron";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import treeKill from "tree-kill";

// __dirname is available natively in CommonJS

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFERRED_PORT = 3100;
const SERVER_STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 400;
const PID_FILE_NAME = "paperclip-electron.pid";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Resolve the monorepo root (one level up from electron/) */
function getMonorepoRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-server");
  }
  return path.resolve(app.getAppPath(), "..");
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

/**
 * Check if a TCP port is already in use.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

/**
 * Find a free port starting from the preferred port.
 */
async function findFreePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + 99}`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let serverPort: number = PREFERRED_PORT;

/**
 * Wait for a TCP port to accept connections.
 */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryConnect = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not start within ${timeoutMs}ms`));
        return;
      }

      const sock = net.createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });

      sock.on("error", () => {
        setTimeout(tryConnect, POLL_INTERVAL_MS);
      });
    };

    tryConnect();
  });
}

/**
 * Find the Node.js binary.
 *
 * In packaged mode we ship a bundled Node binary inside the app resources.
 * Falls back to probing well-known install locations.
 */
function findNodeBinary(): string {
  if (!app.isPackaged) return "node";

  const isWin = process.platform === "win32";
  const bundledNode = path.join(
    process.resourcesPath,
    "app-server",
    "node-bin",
    isWin ? "node.exe" : "node",
  );
  try {
    fs.accessSync(bundledNode, fs.constants.X_OK);
    return bundledNode;
  } catch { /* bundled binary not found, fall back */ }

  // Fallback: probe well-known install locations
  const candidates: string[] = [];
  const home = process.env.HOME ?? "";
  const nvmDir = process.env.NVM_DIR ?? path.join(home, ".nvm");
  try {
    const ver = fs.readFileSync(path.join(nvmDir, "alias", "default"), "utf8").trim();
    candidates.push(path.join(nvmDir, "versions", "node", ver, "bin", "node"));
  } catch { /* nvm not present */ }

  candidates.push(
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
  );

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* not here */ }
  }

  return "node";
}

/**
 * Resolve the user's full login-shell PATH.
 *
 * Electron apps launched from Finder / Dock inherit a minimal PATH that
 * excludes directories like ~/.nvm, /opt/homebrew/bin, and npm global bin.
 * Uses -lc (login, non-interactive) to avoid .bashrc/.zshrc side effects.
 */
function resolveShellPath(): string {
  const fallbackDirs = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const home = process.env.HOME ?? "";
  if (home) {
    fallbackDirs.unshift(
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
    );
    const nvmDir = process.env.NVM_DIR ?? path.join(home, ".nvm");
    try {
      const ver = fs.readFileSync(path.join(nvmDir, "alias", "default"), "utf8").trim();
      fallbackDirs.unshift(path.join(nvmDir, "versions", "node", ver, "bin"));
    } catch { /* nvm not present */ }
  }

  try {
    const userShell = process.env.SHELL || "/bin/zsh";
    // Use -lc (login, non-interactive) to avoid .bashrc/.zshrc side effects
    const shellPath = execSync(`${userShell} -lc 'echo $PATH'`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (shellPath) return shellPath;
  } catch { /* shell probe failed */ }

  const sep = path.delimiter;
  const current = process.env.PATH ?? "";
  const existing = new Set(current.split(sep));
  const missing = fallbackDirs.filter((d) => !existing.has(d));
  return missing.length > 0 ? current + sep + missing.join(sep) : current;
}

// ---------------------------------------------------------------------------
// PID file for orphan protection
// ---------------------------------------------------------------------------

function getPidFilePath(): string {
  return path.join(app.getPath("userData"), PID_FILE_NAME);
}

function writePidFile(pid: number): void {
  try {
    fs.writeFileSync(getPidFilePath(), String(pid), "utf8");
  } catch { /* best-effort */ }
}

function cleanupPidFile(): void {
  try {
    fs.unlinkSync(getPidFilePath());
  } catch { /* best-effort */ }
}

function killOrphanedServer(): void {
  try {
    const pidStr = fs.readFileSync(getPidFilePath(), "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && pid > 0) {
      process.kill(pid, 0); // test if alive
      treeKill(pid, "SIGTERM");
      console.log(`Killed orphaned server process (pid=${pid})`);
    }
  } catch { /* no orphan or already dead */ }
  cleanupPidFile();
}

/**
 * Spawn the Paperclip server as a child process.
 */
function startServer(port: number): ChildProcess {
  const root = getMonorepoRoot();
  const isWin = process.platform === "win32";

  let child: ChildProcess;

  if (app.isPackaged) {
    const serverEntry = path.join(root, "server", "dist", "index.js");
    const enrichedPath = resolveShellPath();
    child = spawn(findNodeBinary(), [serverEntry], {
      cwd: root,
      env: {
        ...process.env,
        PATH: enrichedPath,
        NODE_ENV: "production",
        PORT: String(port),
        PAPERCLIP_HOME: app.getPath("userData"),
        // Always auto-apply pending migrations on startup — Electron spawns the
        // server with stdin ignored (not a TTY) so the TTY heuristic in the
        // server would auto-apply anyway, but this makes the intent explicit and
        // ensures it works even if the heuristic changes.
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
    });
  } else {
    const pnpmBin = isWin ? "pnpm.cmd" : "pnpm";
    child = spawn(pnpmBin, ["dev:once"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      detached: !isWin,
    });
  }

  // Write PID file for orphan protection
  if (child.pid) {
    writePidFile(child.pid);
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  return child;
}

/**
 * Kill the server and all of its child processes using tree-kill.
 */
function killServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!serverProcess?.pid) {
      resolve();
      return;
    }

    const pid = serverProcess.pid;
    serverProcess = null;

    treeKill(pid, "SIGTERM", (err) => {
      if (err) {
        try {
          treeKill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      cleanupPidFile();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Splash window with step-by-step status
// ---------------------------------------------------------------------------

let splashWindow: BrowserWindow | null = null;

function sendSplashStatus(step: string, detail: string, progress: number) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("status-update", { step, detail, progress });
  }
}

async function createSplashWindow(): Promise<BrowserWindow> {
  const splash = new BrowserWindow({
    width: 480,
    height: 380,
    frame: false,
    resizable: false,
    transparent: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "splash-preload.js"),
    },
  });

  splash.center();

  const paperclipSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    height: 100vh;
    background: #0a0a0a;
    color: #e4e4e7;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    user-select: none;
    -webkit-app-region: drag;
    overflow: hidden;
  }

  .logo {
    width: 56px;
    height: 56px;
    margin-bottom: 20px;
    opacity: 0;
    animation: fadeIn 0.5s ease-out forwards;
  }

  .title {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 32px;
    opacity: 0;
    animation: fadeIn 0.5s ease-out 0.15s forwards;
  }

  .progress-track {
    width: 240px;
    height: 3px;
    background: #27272a;
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 24px;
    opacity: 0;
    animation: fadeIn 0.5s ease-out 0.3s forwards;
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: #a1a1aa;
    border-radius: 2px;
    transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 280px;
    opacity: 0;
    animation: fadeIn 0.5s ease-out 0.4s forwards;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: #52525b;
    transition: color 0.3s ease;
  }
  .step.active { color: #e4e4e7; }
  .step.done { color: #71717a; }

  .step-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .step-icon .pending {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3f3f46;
  }

  .step-icon .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #3f3f46;
    border-top-color: #a1a1aa;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .step-icon .check {
    color: #71717a;
    font-size: 14px;
    line-height: 1;
  }

  .step-label { flex: 1; }

  .step-detail {
    font-size: 11px;
    color: #52525b;
    margin-top: 2px;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body>

  <div class="logo">${paperclipSvg}</div>
  <div class="title">Paperclip</div>

  <div class="progress-track">
    <div class="progress-bar" id="progressBar"></div>
  </div>

  <div class="steps" id="steps">
    <div class="step" id="step-init" data-key="init">
      <div class="step-icon"><div class="pending"></div></div>
      <div><div class="step-label">Initializing</div></div>
    </div>
    <div class="step" id="step-database" data-key="database">
      <div class="step-icon"><div class="pending"></div></div>
      <div><div class="step-label">Starting database</div></div>
    </div>
    <div class="step" id="step-server" data-key="server">
      <div class="step-icon"><div class="pending"></div></div>
      <div><div class="step-label">Starting server</div></div>
    </div>
    <div class="step" id="step-ready" data-key="ready">
      <div class="step-icon"><div class="pending"></div></div>
      <div><div class="step-label">Loading interface</div></div>
    </div>
  </div>

  <script>
    const progressBar = document.getElementById('progressBar');
    const stepElements = {
      init: document.getElementById('step-init'),
      database: document.getElementById('step-database'),
      server: document.getElementById('step-server'),
      ready: document.getElementById('step-ready'),
    };

    const stepOrder = ['init', 'database', 'server', 'ready'];

    function setStepState(key, state, detail) {
      const el = stepElements[key];
      if (!el) return;

      const iconContainer = el.querySelector('.step-icon');
      el.classList.remove('active', 'done');

      if (state === 'active') {
        el.classList.add('active');
        iconContainer.innerHTML = '<div class="spinner"></div>';
      } else if (state === 'done') {
        el.classList.add('done');
        iconContainer.innerHTML = '<span class="check">&#10003;</span>';
      } else {
        iconContainer.innerHTML = '<div class="pending"></div>';
      }

      let detailEl = el.querySelector('.step-detail');
      if (detail) {
        if (!detailEl) {
          detailEl = document.createElement('div');
          detailEl.className = 'step-detail';
          el.querySelector('.step-label').parentElement.appendChild(detailEl);
        }
        detailEl.textContent = detail;
      } else if (detailEl) {
        detailEl.remove();
      }
    }

    window.electronSplash.onStatusUpdate(({ step, detail, progress }) => {
      progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';

      const currentIdx = stepOrder.indexOf(step);
      stepOrder.forEach((key, idx) => {
        if (idx < currentIdx) {
          setStepState(key, 'done');
        } else if (idx === currentIdx) {
          setStepState(key, 'active', detail);
        } else {
          setStepState(key, 'pending');
        }
      });
    });
  </script>

</body>
</html>`;

  // Write HTML to a temp file — data: URLs block preload scripts in Electron 35+
  const splashDir = path.join(app.getPath("temp"), "paperclip-splash");
  fs.mkdirSync(splashDir, { recursive: true });
  const splashPath = path.join(splashDir, "splash.html");
  fs.writeFileSync(splashPath, html, "utf8");
  await splash.loadFile(splashPath);

  splashWindow = splash;
  return splash;
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Paperclip",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // Block navigation to non-localhost URLs to prevent preload script exposure
  win.webContents.on("will-navigate", (e, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        e.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      e.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only allow opening external http/https links in the system browser
    try {
      const parsed = new URL(url);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1"
      ) {
        shell.openExternal(url);
      }
    } catch { /* malformed URL, ignore */ }
    return { action: "deny" };
  });

  return win;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

let isQuitting = false;

app.setName("Paperclip");

app.whenReady().then(async () => {
  // Clean up any orphaned server from a previous crash
  killOrphanedServer();

  const splash = await createSplashWindow();

  try {
    // Step 1: Initializing
    sendSplashStatus("init", "Preparing environment\u2026", 5);

    // Step 1b: Find a free port before spawning the server
    serverPort = await findFreePort(PREFERRED_PORT);
    if (serverPort !== PREFERRED_PORT) {
      console.log(`Port ${PREFERRED_PORT} in use, using ${serverPort} instead`);
    }
    sendSplashStatus("init", "Preparing environment\u2026", 10);

    // Step 2: Starting database
    sendSplashStatus("database", "Launching embedded PostgreSQL\u2026", 15);

    serverProcess = startServer(serverPort);

    // Track progress — only allow forward movement to prevent visual regression
    let dbReady = false;
    let serverListening = false;
    let lastProgress = 15;

    const updateProgress = (step: string, detail: string, progress: number) => {
      if (progress > lastProgress) {
        lastProgress = progress;
        sendSplashStatus(step, detail, progress);
      }
    };

    // Accumulate output for error reporting; also write to a log file
    const serverOutputLines: string[] = [];
    const logFile = path.join(app.getPath("userData"), "server.log");
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.write(`\n--- Server start ${new Date().toISOString()} (port=${serverPort}) ---\n`);

    const onServerData = (chunk: Buffer) => {
      const text = chunk.toString();
      serverOutputLines.push(...text.split("\n").filter(Boolean));
      if (serverOutputLines.length > 200) serverOutputLines.splice(0, serverOutputLines.length - 200);
      logStream.write(text);

      // Match specific Paperclip server log markers
      if (!dbReady && (text.includes("PostgreSQL ready") || text.includes("migration"))) {
        dbReady = true;
        updateProgress("database", "Running migrations\u2026", 35);
      }

      if (!serverListening && text.includes("Server listening on")) {
        serverListening = true;
        updateProgress("server", "Server is starting\u2026", 55);
      }
    };

    serverProcess.stdout?.on("data", onServerData);
    serverProcess.stderr?.on("data", onServerData);

    serverProcess.on("exit", (code, signal) => {
      logStream.end();
      if (serverProcess) {
        const tail = serverOutputLines.slice(-30).join("\n");
        console.error(`Server exited unexpectedly (code=${code}, signal=${signal})\n${tail}`);
        dialog
          .showMessageBox({
            type: "error",
            title: "Server Error",
            message: "The Paperclip server stopped unexpectedly.",
            detail: `Exit code: ${code}, signal: ${signal}\n\nLog: ${logFile}\n\n${tail}`,
            buttons: ["Quit"],
          })
          .then(() => app.quit());
      }
    });

    // Animate progress while waiting for the port
    const progressInterval = setInterval(() => {
      if (!dbReady) {
        updateProgress("database", "Launching embedded PostgreSQL\u2026", 20);
      } else if (!serverListening) {
        updateProgress("server", "Waiting for server\u2026", 50);
      }
    }, 2000);

    updateProgress("server", "Waiting for server\u2026", 45);

    // Step 3: Wait for server
    await waitForPort(serverPort, SERVER_STARTUP_TIMEOUT_MS);

    clearInterval(progressInterval);
    sendSplashStatus("server", "Server is ready", 70);

    // Step 4: Loading interface
    sendSplashStatus("ready", "Loading the UI\u2026", 80);

    mainWindow = createWindow(serverPort);
    mainWindow.loadURL(`http://localhost:${serverPort}`);

    mainWindow.webContents.once("did-finish-load", () => {
      sendSplashStatus("ready", "Almost there\u2026", 95);
    });

    mainWindow.once("ready-to-show", () => {
      sendSplashStatus("ready", "Ready!", 100);
      setTimeout(() => {
        if (splash && !splash.isDestroyed()) {
          splash.destroy();
        }
        splashWindow = null;
      }, 400);
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  } catch (err) {
    if (splash && !splash.isDestroyed()) {
      splash.destroy();
    }
    splashWindow = null;
    await dialog.showMessageBox({
      type: "error",
      title: "Startup Error",
      message: "Failed to start the Paperclip server.",
      detail: String(err),
      buttons: ["Quit"],
    });
    await killServer();
    app.quit();
  }
});

// macOS: re-create window when dock icon clicked
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
    mainWindow = createWindow(serverPort);
    mainWindow.loadURL(`http://localhost:${serverPort}`);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (e) => {
  if (isQuitting) return;
  if (serverProcess) {
    isQuitting = true;
    e.preventDefault();
    await killServer();
    app.quit();
  }
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    // Use app.quit() for graceful Electron shutdown instead of process.exit()
    // which can leave GPU/helper processes alive.
    isQuitting = true;
    void killServer().then(() => app.quit());
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

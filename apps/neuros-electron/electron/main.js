const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const packageJson = require("../package.json");

const DEFAULT_BASE_URLS = ["http://127.0.0.1:3100", "http://localhost:3100"];
const DEFAULT_CONFIG = {
  baseUrl: "http://127.0.0.1:3100",
  workspacePrefix: "",
  lastLaunchUrl: "",
};

let mainWindow = null;

function normalizeBaseUrl(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) {
    return DEFAULT_CONFIG.baseUrl;
  }

  const withProtocol = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function configFilePath() {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

async function loadConfig() {
  try {
    const raw = await fsp.readFile(configFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? DEFAULT_CONFIG.baseUrl),
      workspacePrefix: String(parsed.workspacePrefix ?? "").trim().toUpperCase(),
      lastLaunchUrl: String(parsed.lastLaunchUrl ?? "").trim(),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(partialConfig) {
  const previous = await loadConfig();
  const next = {
    ...previous,
    ...partialConfig,
  };

  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  next.workspacePrefix = String(next.workspacePrefix ?? "").trim().toUpperCase();
  next.lastLaunchUrl = String(next.lastLaunchUrl ?? "").trim();

  await fsp.mkdir(path.dirname(configFilePath()), { recursive: true });
  await fsp.writeFile(configFilePath(), JSON.stringify(next, null, 2));
  return next;
}

function previewText(value) {
  return String(value ?? "").slice(0, 400);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": `NeurOSElectron/${app.getVersion()}`,
      "X-NeurOS-Client": "electron",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${previewText(text)}`);
  }

  return text ? JSON.parse(text) : null;
}

async function probeConnection(rawBaseUrl) {
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  const checkedAt = new Date().toISOString();

  try {
    const health = await fetchJson(`${baseUrl}/api/health`);
    let companies = [];
    try {
      const result = await fetchJson(`${baseUrl}/api/companies`);
      companies = Array.isArray(result) ? result : [];
    } catch {
      companies = [];
    }

    return {
      ok: true,
      baseUrl,
      checkedAt,
      health,
      companies: companies.map((company) => ({
        id: String(company.id ?? ""),
        name: String(company.name ?? "Unknown"),
        status: String(company.status ?? "unknown"),
        issuePrefix: company.issuePrefix ? String(company.issuePrefix).toUpperCase() : "",
      })),
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      checkedAt,
      companies: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function detectConnection() {
  const stored = await loadConfig();
  const candidates = [stored.baseUrl, ...DEFAULT_BASE_URLS]
    .map((value) => normalizeBaseUrl(value))
    .filter((value, index, array) => array.indexOf(value) === index);

  let lastFailure = null;
  for (const candidate of candidates) {
    const result = await probeConnection(candidate);
    if (result.ok) {
      return result;
    }
    lastFailure = result;
  }

  return (
    lastFailure ?? {
      ok: false,
      baseUrl: stored.baseUrl,
      checkedAt: new Date().toISOString(),
      companies: [],
      error: "No reachable Paperclip server found.",
    }
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1660,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    backgroundColor: "#0e1116",
    title: "neurOS Electron",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "build", "index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("desktop:meta", () => ({
  productName: packageJson.productName ?? app.getName(),
  version: app.getVersion(),
  platform: process.platform,
}));

ipcMain.handle("desktop:config:load", async () => loadConfig());

ipcMain.handle("desktop:config:save", async (_event, partialConfig) => saveConfig(partialConfig));

ipcMain.handle("desktop:probe", async (_event, baseUrl) => probeConnection(baseUrl));

ipcMain.handle("desktop:detect", async () => detectConnection());

ipcMain.handle("desktop:openExternal", async (_event, targetUrl) => {
  if (typeof targetUrl === "string" && targetUrl.trim()) {
    await shell.openExternal(targetUrl);
  }
});

import { BrowserWindow } from "electron";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function showSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashPath = resolve(__dirname, "../../resources/splash.html");
  if (existsSync(splashPath)) {
    void splash.loadFile(splashPath);
  } else {
    // Fallback: render inline HTML if splash.html not found
    void splash.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head><style>
          body {
            margin: 0; display: flex; align-items: center; justify-content: center;
            height: 100vh; background: #1a1a2e; color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            border-radius: 12px; flex-direction: column; gap: 16px;
            -webkit-app-region: drag;
          }
          h1 { font-size: 24px; font-weight: 600; margin: 0; }
          .spinner {
            width: 32px; height: 32px; border: 3px solid #333;
            border-top-color: #6c63ff; border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
          p { font-size: 13px; color: #888; margin: 0; }
        </style></head>
        <body>
          <h1>Paperclip</h1>
          <div class="spinner"></div>
          <p>Starting server...</p>
        </body>
        </html>
      `)}`,
    );
  }

  return splash;
}

export function closeSplash(splash: BrowserWindow): void {
  if (!splash.isDestroyed()) {
    splash.close();
  }
}

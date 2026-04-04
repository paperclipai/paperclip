import { app } from "electron";
import { createMainWindow } from "./window.js";
import { createTray } from "./tray.js";
import { setupLifecycle } from "./lifecycle.js";
import { showSplash, closeSplash } from "./splash.js";
import { setupAutoUpdater } from "./auto-updater.js";
import type { StartedServer } from "@paperclipai/server";

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Set environment variables before server startup
process.env.SERVE_UI = "true";
process.env.PAPERCLIP_MIGRATION_AUTO_APPLY = "true";
process.env.PAPERCLIP_MIGRATION_PROMPT = "never";

let startedServer: StartedServer | undefined;

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const splash = showSplash();

  // Dynamically import server — tsx/esm must be registered first (see dev script)
  const { startServer } = await import("@paperclipai/server");
  startedServer = await startServer();

  closeSplash(splash);

  const mainWindow = createMainWindow(startedServer.apiUrl);
  createTray(mainWindow);
  setupLifecycle(mainWindow, startedServer);
  setupAutoUpdater();

  // Handle second instance: focus existing window
  app.on("second-instance", () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

bootstrap().catch((err) => {
  console.error("Paperclip desktop failed to start:", err);
  app.exit(1);
});

import { app, type BrowserWindow } from "electron";
import type { StartedServer } from "@paperclipai/server";

export function setupLifecycle(
  mainWindow: BrowserWindow,
  startedServer: StartedServer,
): void {
  let isQuitting = false;

  // Hide to tray instead of closing (unless app is quitting)
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Graceful shutdown: stop the server before quitting
  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();

    void startedServer
      .shutdown()
      .catch((err) => {
        console.error("Error during server shutdown:", err);
      })
      .finally(() => {
        app.exit(0);
      });
  });

  // macOS: re-show window when dock icon clicked
  app.on("activate", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Ensure app quits on all platforms when all windows are destroyed
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

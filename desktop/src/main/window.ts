import { BrowserWindow, shell } from "electron";

export function createMainWindow(serverUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Paperclip",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show window once content is ready
  win.once("ready-to-show", () => {
    win.show();
  });

  // Open external links in system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Prevent navigation away from the app
  win.webContents.on("will-navigate", (event, url) => {
    const serverOrigin = new URL(serverUrl).origin;
    if (!url.startsWith(serverOrigin)) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
      }
    }
  });

  void win.loadURL(serverUrl);

  return win;
}

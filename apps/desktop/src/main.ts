import { app, BrowserWindow } from "electron";
import * as path from "node:path";

// Dev mode: load the Vite dev server. Otherwise load the built static files.
// `app.isPackaged` is false when running from source (e.g. via `electron .`),
// and ELECTRON_DEV=1 is set explicitly by the `dev` script.
const isDev = !app.isPackaged || process.env.ELECTRON_DEV === "1";

const DEV_SERVER_URL = "http://localhost:5173";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Loose",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Compiled main lives in apps/desktop/dist; the web build is at apps/web/dist.
    const indexHtml = path.join(__dirname, "..", "..", "web", "dist", "index.html");
    void win.loadFile(indexHtml);
  }
}

app.whenReady().then(() => {
  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS where apps stay active
// until the user explicitly quits with Cmd+Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

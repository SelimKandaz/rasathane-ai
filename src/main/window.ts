import { BrowserWindow } from "electron";
import path from "path";

function resolveRendererEntry(): { mode: "url" | "file"; target: string } {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    return {
      mode: "url",
      target: devServerUrl
    };
  }

  return {
    mode: "file",
    target: path.join(__dirname, "..", "..", "dist", "renderer", "index.html")
  };
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const smokeTest = process.env.RASATHANE_SMOKE_TEST === "1";

  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: "#0b1220",
    title: "Rasathane AI",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "preload", "index.js")
    }
  });

  window.once("ready-to-show", () => {
    if (!smokeTest) {
      window.show();
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Rasathane renderer failed to load (${errorCode}): ${errorDescription}`);
  });

  const rendererEntry = resolveRendererEntry();
  if (rendererEntry.mode === "url") {
    await window.loadURL(rendererEntry.target);
  } else {
    await window.loadFile(rendererEntry.target);
  }

  if (smokeTest) {
    console.log("SMOKE_TEST_WINDOW_LOADED");
  }

  return window;
}

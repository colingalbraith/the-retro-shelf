// Renders build/icon.svg to build/icon.png (1024x1024) with Electron, so no extra image tools are needed.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "build");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(dir, "icon.png"), img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log("wrote build/icon.png", img.getSize());
  app.quit();
});

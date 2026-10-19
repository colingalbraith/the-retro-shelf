"use strict";
// The Retro Shelf desktop app: one window showing index.html over the arcade:// protocol, a backend in this
// process, and RetroArch (bundled in Resources/emulators) launched for each game.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { Backend } = require("./backend");

protocol.registerSchemesAsPrivileged([
  { scheme: "arcade", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ARCADE_HOME keeps everything (settings, games, saves) in one folder: handy for testing. Set before the
// single-instance lock, which lives in the data folder, so a test copy can run next to the real one.
const HOME = process.env.ARCADE_HOME;
if (HOME) app.setPath("userData", path.join(HOME, "data"));
const DOCS = HOME ? path.join(HOME, "The Retro Shelf") : path.join(app.getPath("documents"), "The Retro Shelf");
// The app used to be called Arcade: the first time, move its settings and games folders to the new name
// (before the single-instance lock below creates the new settings folder)
if (!HOME) {
  const move = (from, to, signs) => {
    try { if (signs.some(f => fs.existsSync(path.join(from, f))) && !fs.existsSync(to)) fs.renameSync(from, to); } catch {}
  };
  move(path.join(app.getPath("appData"), "Arcade"), app.getPath("userData"), ["settings.json", "state.json", "covers", "retroarch"]);
  move(path.join(app.getPath("documents"), "Arcade"), DOCS, ["Games"]);
}
if (!app.requestSingleInstanceLock()) app.quit();
const EMU = app.isPackaged ? path.join(process.resourcesPath, "emulators")
  : path.join(__dirname, "..", "vendor", { darwin: "mac", win32: "win" }[process.platform] || "linux");
const WINDOW = () => path.join(app.getPath("userData"), "window.json");

let win = null, backend = null, quitting = false;

async function fetchUrl(url, timeout) {
  const r = await net.fetch(url, { headers: { "User-Agent": "TheRetroShelf/1.0" }, signal: AbortSignal.timeout(timeout || 20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(WINDOW(), "utf8")); } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = { ...loadBounds(), fullscreen: win.isFullScreen() };
  if (!win.isFullScreen() && !win.isMaximized() && !win.isMinimized()) b.bounds = win.getBounds();
  b.maximized = win.isMaximized();
  try { fs.writeFileSync(WINDOW(), JSON.stringify(b)); } catch {}
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: 1280, height: 820, ...(saved.bounds || {}), minWidth: 720, minHeight: 520,
    title: "The Retro Shelf", backgroundColor: "#1e1c1a", show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, sandbox: true, spellcheck: false,
      // keep polling and the gamepad loop running while a game has the screen
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (saved.maximized) win.maximize();
  if (saved.fullscreen) win.setFullScreen(true);
  win.once("ready-to-show", () => win.show());
  for (const ev of ["resize", "move", "enter-full-screen", "leave-full-screen"]) win.on(ev, () => { clearTimeout(win._st); win._st = setTimeout(saveBounds, 500); });
  win.on("close", saveBounds);
  win.on("closed", () => { win = null; });
  win.loadURL("arcade://app/");
}

function focusApp() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
}

function menu() {
  const mac = process.platform === "darwin";
  const tpl = [
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Add Games…", accelerator: "CmdOrCtrl+O", click: () => win && win.webContents.send("menu", "add-games") },
      { label: "Where to Get Games…", click: () => win && win.webContents.send("menu", "get-games") },
      { label: "Show Games Folder", click: () => shell.openPath(backend.romsRoot()) },
      { type: "separator" },
      mac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }])] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Where to Get Games…", click: () => win && win.webContents.send("menu", "get-games") }, { label: "Licenses", click: openLicenses }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

let licWin = null;
function openLicenses() {
  if (licWin) return licWin.focus();
  licWin = new BrowserWindow({ width: 760, height: 720, title: "The Retro Shelf · Licenses", backgroundColor: "#ece6d6", parent: win || undefined, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true } });
  licWin.setMenuBarVisibility(false);
  licWin.on("closed", () => { licWin = null; });
  licWin.loadURL("arcade://app/licenses.html");
}

/** right-click a box: play, rename, change its pictures, move it to another console, hide it, or trash it */
function gameMenu(id) {
  const g = backend.games.get(id);
  if (!g || !win) return;
  const send = what => win.webContents.send("menu", what), title = backend.state.names[g.id] || g.title;
  const pickPicture = async kind => {
    const r = await dialog.showOpenDialog(win, { title: "Choose a picture", buttonLabel: "Use Picture", properties: ["openFile"],
      filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (r.canceled || !r.filePaths[0]) return;
    const [code, res] = backend.setArt(g.id, kind, r.filePaths[0]);
    send(code === 200 ? { cmd: "refresh" } : { cmd: "error", text: res.error });
  };
  const ext = path.extname(g.path).toLowerCase(), sys = backend.cfg.systems;
  const others = Object.keys(sys).filter(s => s !== g.system && (sys[s].exts || []).includes(ext));
  const saves = backend.savesOf(g, {}), hidden = backend.state.hidden.includes(g.id);
  const tpl = [
    { label: saves && saves.resume ? "Continue" : "Play", click: () => send({ cmd: "play", id: g.id }) },
    ...(saves && saves.resume ? [{ label: "Start Fresh", click: () => send({ cmd: "play", id: g.id, fresh: true }) }] : []),
    { type: "separator" },
    { label: "Rename…", click: () => send({ cmd: "rename", id: g.id }) },
    { label: "Change Cover…", click: () => pickPicture("cover") },
    { label: "Change Logo…", click: () => pickPicture("logo") },
    { label: "Change Screenshot…", click: () => pickPicture("snap") },
    ...(others.length ? [{ label: "Move to", submenu: others.map(s => ({ label: s, click: () => {
      const [code, res] = backend.moveTo(g.id, s);
      send(code === 200 ? { cmd: "refresh", focus: res.id } : { cmd: "error", text: res.error });
    } })) }] : []),
    { type: "separator" },
    { label: hidden ? "Show on Shelf" : "Hide from Shelf", click: () => { backend.hide(g.id, !hidden); send({ cmd: "refresh" }); } },
    { label: process.platform === "darwin" ? "Show in Finder" : "Show in Folder", click: () => shell.showItemInFolder(g.path) },
    { type: "separator" },
    { label: "Move to Trash…", click: async () => {
      const r = await dialog.showMessageBox(win, { type: "warning", buttons: ["Move to Trash", "Cancel"], defaultId: 1, cancelId: 1,
        message: `Move “${title}” to the Trash?`, detail: "You can get it back from the Trash. Its saves stay where they are." });
      if (r.response !== 0) return;
      // a disc game with its own folder goes as a whole; otherwise the file and any pictures saved beside it
      const dir = path.dirname(g.path), sysDir = path.join(backend.romsRoot(), sys[g.system].folder || g.system);
      const targets = [".cue", ".gdi", ".m3u"].includes(ext) && path.resolve(dir) !== path.resolve(sysDir) ? [dir]
        : fs.readdirSync(dir).filter(f => f === path.basename(g.path) || f.startsWith(path.parse(g.path).name + ".") && /\.(png|jpe?g|webp)$/i.test(f)).map(f => path.join(dir, f));
      try { for (const t of targets) await shell.trashItem(t); } catch (e) { send({ cmd: "error", text: "Couldn't move it to the Trash: " + e.message }); }
      backend.scan(); send({ cmd: "refresh" });
    } },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function ipc() {
  ipcMain.handle("pick-games", async () => {
    const props = ["openFile", "multiSelections"];
    if (process.platform === "darwin") props.push("openDirectory");
    const r = await dialog.showOpenDialog(win, { title: "Add games", buttonLabel: "Add", properties: props });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("open-folder", (_, which) => {
    const f = { games: backend.romsRoot(), saves: backend.folders.saves, bios: backend.folders.bios, logs: backend.folders.logs }[which];
    if (!f) return false;
    fs.mkdirSync(f, { recursive: true });
    return shell.openPath(f).then(err => !err);
  });
  ipcMain.handle("licenses", () => openLicenses());
  ipcMain.handle("reveal-game", (_, id) => { const g = backend.games.get(String(id)); if (g) shell.showItemInFolder(g.path); });
  ipcMain.handle("game-menu", (_, id) => gameMenu(String(id)));
  ipcMain.handle("open-url", (_, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(String(url)); });
}

app.on("second-instance", focusApp);

app.on("web-contents-created", (_, wc) => {
  // the UI only ever lives at arcade://app; anything else opens in the browser (https) or nowhere
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!url.startsWith("arcade://app/")) e.preventDefault(); });
});

app.whenReady().then(() => {
  backend = new Backend({ app: __dirname, data: app.getPath("userData"), docs: DOCS, emu: EMU, version: app.getVersion() }, fetchUrl);
  backend.init();
  backend.on("exit", () => setTimeout(focusApp, 150));
  protocol.handle("arcade", req => {
    const u = new URL(req.url);
    if (u.host !== "app") return new Response("not found", { status: 404 });
    return backend.handle(req);
  });
  ipc();
  menu();
  createWindow();
  if (backend.ui.autoCovers) backend.coverJob([...backend.games.keys()]);
});

app.on("activate", () => { if (!win) createWindow(); else focusApp(); });
app.on("window-all-closed", () => app.quit());

// Quitting mid-game: let RetroArch save and close first.
app.on("before-quit", e => {
  if (quitting || !backend || !backend.running || !backend.running.alive) return;
  e.preventDefault();
  quitting = true;
  backend.stop().finally(() => app.quit());
});

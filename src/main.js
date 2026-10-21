"use strict";
// The Retro Shelf desktop app: one window showing index.html over the arcade:// protocol, a backend in this
// process, and RetroArch (bundled in Resources/emulators) launched for each game.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, screen, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const { Backend, GAME_CHOICES } = require("./backend");
const { Updater } = require("./updater");
const { zipFolder, unzipInto, filesIn } = require("./zip");

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
let OLD_GAMES = null;
if (!HOME) {
  const move = (from, to, signs) => {
    try { if (signs.some(f => fs.existsSync(path.join(from, f))) && !fs.existsSync(to)) { fs.renameSync(from, to); return true; } } catch {}
    return false;
  };
  move(path.join(app.getPath("appData"), "Arcade"), app.getPath("userData"), ["settings.json", "state.json", "covers", "retroarch"]);
  // games are known by their path, so their play history is moved over to the new paths once the backend is up
  if (move(path.join(app.getPath("documents"), "Arcade"), DOCS, ["Games"])) OLD_GAMES = path.join(app.getPath("documents"), "Arcade", "Games");
}
if (!app.requestSingleInstanceLock()) app.quit();
const EMU = app.isPackaged ? path.join(process.resourcesPath, "emulators")
  : path.join(__dirname, "..", "vendor", { darwin: "mac", win32: "win" }[process.platform] || "linux");
const WINDOW = () => path.join(app.getPath("userData"), "window.json");

let win = null, backend = null, updater = null, quitting = false;

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

const DEV_ICON = path.join(__dirname, "..", "build", "icon.png");

/** the saved window spot, unless the screen it was on is gone (a monitor unplugged) */
function onScreen(b) {
  if (!b || !b.width || !b.height) return {};
  const area = screen.getDisplayMatching(b).workArea;
  const seen = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x) >= 120 && Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y) >= 60;
  return seen ? b : { width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) };
}

/** TV mode: everything a quarter bigger, and fullscreen */
function tvMode(on) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(on ? 1.25 : 1);
  if (win.isFullScreen() !== on) win.setFullScreen(on);
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: 1280, height: 820, ...onScreen(saved.bounds), minWidth: 720, minHeight: 520,
    title: "The Retro Shelf", backgroundColor: "#1e1c1a", show: false, autoHideMenuBar: true,
    // installed builds get their icon from the installer; running from source would otherwise show Electron's
    ...(app.isPackaged ? {} : { icon: DEV_ICON }),
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
  win.once("ready-to-show", () => { win.show(); if (backend && backend.ui.tv) tvMode(true); });
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
    { label: "View", submenu: [{ label: "Your Play", accelerator: "CmdOrCtrl+P", click: () => win && win.webContents.send("menu", "your-play") },
      { label: "Collections", accelerator: "CmdOrCtrl+L", click: () => win && win.webContents.send("menu", "collections") }, { type: "separator" },
      { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
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
    send(code === 200 ? { cmd: "refresh", focus: g.id } : { cmd: "error", text: res.error });
  };
  const ext = path.extname(g.path).toLowerCase(), sys = backend.cfg.systems;
  const others = Object.keys(sys).filter(s => s !== g.system && (sys[s].exts || []).includes(ext));
  const saves = backend.savesOf(g, {}), hidden = backend.state.hidden.includes(g.id);
  const tpl = [
    { label: saves && saves.resume ? "Continue" : "Play", click: () => send({ cmd: "play", id: g.id }) },
    ...(saves && saves.resume ? [{ label: "Start Fresh", click: () => send({ cmd: "play", id: g.id, fresh: true }) }] : []),
    { type: "separator" },
    { label: "Add to Shelf", submenu: [
      ...backend.state.shelves.map(sh => ({ label: sh.name, type: "checkbox", checked: sh.ids.includes(g.id), click: () => {
        backend.shelfOp({ op: sh.ids.includes(g.id) ? "remove" : "add", name: sh.name, id: g.id });
        send({ cmd: "refresh", focus: g.id });
      } })),
      ...(backend.state.shelves.length ? [{ type: "separator" }] : []),
      { label: "New Shelf…", click: () => send({ cmd: "new-shelf", id: g.id }) },
    ] },
    // this game's own picture and screen shape, over the ones in Settings
    ...Object.entries({ picture: "Picture", shape: "Screen Shape" }).map(([k, label]) => ({ label, submenu: [
      { label: "Same as Settings", type: "radio", checked: !(backend.state.gameOpts[g.id] || {})[k], click: () => { backend.setGameOpts(g.id, { [k]: null }); send({ cmd: "refresh", focus: g.id }); } },
      { type: "separator" },
      ...GAME_CHOICES[k].map(([v, name]) => ({ label: name, type: "radio", checked: (backend.state.gameOpts[g.id] || {})[k] === v,
        click: () => { backend.setGameOpts(g.id, { [k]: v }); send({ cmd: "refresh", focus: g.id }); } })),
    ] })),
    { label: "Rename…", click: () => send({ cmd: "rename", id: g.id }) },
    { label: "Find Cover…", click: () => send({ cmd: "find-cover", id: g.id }) },
    { label: "Use My Own Cover…", click: () => pickPicture("cover") },
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
      // the game's own files: a disc game's tracks too, and its whole folder when nothing else is in it
      try {
        const { folder, files } = backend.gameFiles(g);
        for (const t of folder ? [folder] : files) await shell.trashItem(t);
      } catch (e) { send({ cmd: "error", text: "Couldn't move it to the Trash: " + e.message }); }
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
  ipcMain.handle("backup-saves", async () => {
    const saves = backend.folders.saves;
    // folders RetroArch makes on the first launch don't count: only actual save files
    let any = false;
    try { any = filesIn(saves).length > 0; } catch {}
    if (!any) return { ok: false, error: "There are no saves to back up yet." };
    const r = await dialog.showSaveDialog(win, { title: "Back up saves", buttonLabel: "Back Up",
      defaultPath: path.join(app.getPath("documents"), `Retro Shelf saves ${new Date().toISOString().slice(0, 10)}.zip`), filters: [{ name: "Zip archive", extensions: ["zip"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    try { const count = await zipFolder(saves, r.filePath); backend.event("backup"); return { ok: true, count, path: r.filePath }; }
    catch (e) { return { ok: false, error: "Couldn't make the backup: " + e.message }; }
  });
  ipcMain.handle("restore-saves", async () => {
    // a running game would write its save over the restored one when it closes
    if (backend.running && backend.running.alive) return { ok: false, error: "Close the game first, then restore." };
    const r = await dialog.showOpenDialog(win, { title: "Restore saves", buttonLabel: "Restore", properties: ["openFile"], filters: [{ name: "Zip archive", extensions: ["zip"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try { fs.mkdirSync(backend.folders.saves, { recursive: true }); return { ok: true, ...(await unzipInto(r.filePaths[0], backend.folders.saves)) }; }
    catch (e) { return { ok: false, error: "Couldn't restore from that file: " + e.message }; }
  });
  ipcMain.handle("tv-mode", (_, on) => tvMode(!!on));
  ipcMain.handle("copy-report", () => { clipboard.writeText(backend.report(app.getVersion())); return true; });
  ipcMain.handle("update", (_, what) => {
    if (what === "check") return updater.check(true);
    if (what === "restart") return updater.restart();
    if (what === "page") return shell.openExternal(updater.page());
    return updater.state;
  });
}

app.on("second-instance", focusApp);

app.on("web-contents-created", (_, wc) => {
  // the UI only ever lives at arcade://app; anything else opens in the browser (https) or nowhere
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (!url.startsWith("arcade://app/")) e.preventDefault(); });
});

app.whenReady().then(() => {
  if (!app.isPackaged && process.platform === "darwin") app.dock.setIcon(DEV_ICON);
  backend = new Backend({ app: __dirname, data: app.getPath("userData"), docs: DOCS, emu: EMU, version: app.getVersion() }, fetchUrl);
  backend.init();
  if (OLD_GAMES) backend.remapIds(OLD_GAMES);
  backend.on("exit", () => setTimeout(focusApp, 150));
  protocol.handle("arcade", req => {
    const u = new URL(req.url);
    if (u.host !== "app") return new Response("not found", { status: 404 });
    return backend.handle(req);
  });
  ipc();
  menu();
  createWindow();
  if (backend.setupError) {
    win.once("ready-to-show", () => dialog.showMessageBox(win, { type: "warning", message: "The Retro Shelf couldn't set up its games folder",
      detail: `It needs to create "The Retro Shelf" in your Documents folder (${backend.setupError}). Check that it's allowed to use Documents: on a Mac in System Settings → Privacy & Security → Files and Folders, on Windows under Virus & threat protection → Controlled folder access.` }));
  }
  if (backend.ui.autoCovers) backend.coverJob([...backend.games.keys()]);
  updater = new Updater();
  updater.on("change", s => { if (win && !win.isDestroyed()) win.webContents.send("menu", { cmd: "update", state: s }); });
  updater.start(() => backend.ui.updates !== false, () => !!backend.ui.beta);
});

app.on("activate", () => { if (!win) createWindow(); else focusApp(); });
app.on("window-all-closed", () => app.quit());
// a downloaded Mac update takes the old app's place once this one has quit
app.on("will-quit", () => { if (updater) updater.applyOnQuit(); });

// Quitting mid-game: let RetroArch save and close first.
app.on("before-quit", e => {
  if (quitting || !backend || !backend.running || !backend.running.alive) return;
  e.preventDefault();
  quitting = true;
  backend.stop().finally(() => app.quit());
});

"use strict";
// The Retro Shelf desktop app: one window showing index.html over the arcade:// protocol, a backend in this
// process, and RetroArch (bundled in Resources/emulators) launched for each game.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, screen, clipboard } = require("electron");
const fs = require("fs");
const path = require("path");
const { Backend, GAME_CHOICES } = require("./backend");
const { Updater } = require("./updater");
const { zipFolder, zipFiles, unzipInto, filesIn } = require("./zip");

protocol.registerSchemesAsPrivileged([
  { scheme: "arcade", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ARCADE_HOME keeps everything (settings, games, saves) in one folder: handy for testing. Set before the
// single-instance lock, which lives in the data folder, so a test copy can run next to the real one.
const HOME = process.env.ARCADE_HOME;
if (HOME) { app.setPath("userData", path.join(HOME, "data")); app.setPath("pictures", path.join(HOME, "Pictures")); }
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

// the app's own tests (scripts/*-test.mjs) open it without taking focus, almost all off the bottom right of the
// screen, so they keep out of the way of whoever is using the computer while they run
const TESTING = process.env.RETRO_SHELF_TEST === "1";
function testBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 48, y: area.y + area.height - 48, width: 1280, height: 820 };
}

function createWindow() {
  const saved = loadBounds();
  win = new BrowserWindow({
    width: 1280, height: 820, ...(TESTING ? testBounds() : onScreen(saved.bounds)), minWidth: 720, minHeight: 520,
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
  if (saved.maximized && !TESTING) win.maximize();
  if (saved.fullscreen && !TESTING) win.setFullScreen(true);
  win.once("ready-to-show", () => {
    if (TESTING) { win.setBounds(testBounds()); win.showInactive(); return; }
    win.show(); if (backend && backend.ui.tv) tvMode(true);
  });
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
  // hardcore achievements: every game starts from the beginning
  if (saves && backend.ui.hardcore && backend.state.cheevos.user) saves.resume = 0;
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
    ...(!sys[g.system].emulator && !backend.ownEmu() ? [{ label: "Cheats…", click: () => send({ cmd: "cheats", id: g.id }) }] : []),
    // how far you are with it, how good it is, and a note
    { label: "Progress", submenu: [["", "Not Set"], ["backlog", "Backlog"], ["playing", "Playing"], ["beaten", "Beaten"], ["complete", "100%"]].map(([v, label]) => ({ label, type: "radio",
      checked: (backend.state.progress[g.id] || "") === v, click: () => { backend.setGameInfo(g.id, { progress: v || null }); send({ cmd: "refresh", focus: g.id }); } })) },
    { label: "Rating", submenu: [0, 5, 4, 3, 2, 1].map(n => ({ label: n ? "★".repeat(n) + "☆".repeat(5 - n) : "No Rating", type: "radio",
      checked: (backend.state.rating[g.id] || 0) === n, click: () => { backend.setGameInfo(g.id, { rating: n || null }); send({ cmd: "refresh", focus: g.id }); } })) },
    { label: backend.state.notes[g.id] ? "Edit Note…" : "Add a Note…", click: () => send({ cmd: "note", id: g.id }) },
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
  // where automatic backups go
  ipcMain.handle("backup-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Where should backups go?", buttonLabel: "Back Up Here", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    backend.paths.backup_dir = r.filePaths[0]; backend.saveSettings();
    return { ok: true, dir: r.filePaths[0] };
  });
  // the saves into a folder of your own (to share them through iCloud Drive, Dropbox or OneDrive), or back
  ipcMain.handle("move-saves", async (_, home) => {
    let dir = "";
    if (!home) {
      const r = await dialog.showOpenDialog(win, { title: "Share saves through a cloud folder", message: "Choose a folder in iCloud Drive, Dropbox or OneDrive.", buttonLabel: "Keep Saves Here", properties: ["openDirectory", "createDirectory"] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
    }
    const [code, res] = await backend.moveSaves(dir);
    return code === 200 ? { ok: true, ...res } : { ok: false, error: res.error };
  });
  // the games to another drive; then the old copy to the Trash, if you say so
  ipcMain.handle("move-library", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Move the games to…", buttonLabel: "Move Them Here", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const [code, res] = await backend.moveLibrary(r.filePaths[0]);
    if (code !== 200) return { ok: false, error: res.error };
    const a = await dialog.showMessageBox(win, { type: "question", buttons: ["Move to Trash", "Keep It"], defaultId: 0, cancelId: 1,
      message: `Moved ${res.files} files to ${res.to}.`, detail: `The old copy is still in ${res.from}. Move it to the Trash? Nothing is deleted for good: it stays in the Trash until you empty it.` });
    if (a.response === 0) await shell.trashItem(res.from).catch(() => {});
    return { ok: true, ...res, trashed: a.response === 0 };
  });
  // one game's saves, in one .zip
  // a picture of part of the window (a recap, the time card), saved where you choose; with a controller, straight into
  // Pictures/The Retro Shelf. Nothing leaves the computer
  ipcMain.handle("save-picture", async (_, rect, name, quick) => {
    const z = win.webContents.getZoomFactor(), [W, H] = win.getContentSize(), n = v => Number.isFinite(v) ? v : 0;
    const x = Math.max(0, Math.floor(n(rect && rect.x) * z)), y = Math.max(0, Math.floor(n(rect && rect.y) * z));
    const r = { x, y, width: Math.min(W - x, Math.ceil(n(rect && rect.width) * z)), height: Math.min(H - y, Math.ceil(n(rect && rect.height) * z)) };
    if (!(r.width > 0 && r.height > 0)) return { ok: false, error: "There's nothing to save." };
    const img = await win.webContents.capturePage(r);
    const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 80) || "The Retro Shelf";
    let file;
    if (quick) {
      const dir = path.join(app.getPath("pictures"), "The Retro Shelf");
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, safe + ".png");
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe} ${i}.png`);
    } else {
      const out = await dialog.showSaveDialog(win, { title: "Save as a picture", defaultPath: path.join(app.getPath("pictures"), safe + ".png"), filters: [{ name: "PNG picture", extensions: ["png"] }] });
      if (out.canceled || !out.filePath) return { ok: false };
      file = out.filePath;
    }
    try { fs.writeFileSync(file, img.toPNG()); } catch (e) { return { ok: false, error: "Couldn't save the picture: " + e.message }; }
    return { ok: true, file };
  });
  ipcMain.handle("export-saves", async (_, id) => {
    const g = backend.games.get(String(id));
    if (!g) return { ok: false, error: "Unknown game." };
    const files = backend.gameSaves(g);
    if (!files.length) return { ok: false, error: "This game has no saves yet." };
    const r = await dialog.showSaveDialog(win, { title: "Export saves", buttonLabel: "Export",
      defaultPath: path.join(app.getPath("documents"), `${g.title.replace(/[\\/:*?"<>|]/g, "")} saves.zip`), filters: [{ name: "Zip archive", extensions: ["zip"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    const list = files.flatMap(s => [s.file, ...(s.pic ? [s.file + ".png"] : [])]).map(f => ({ name: path.basename(f), full: f }));
    try { return { ok: true, count: await zipFiles(list, r.filePath) }; } catch (e) { return { ok: false, error: "Couldn't export them: " + e.message }; }
  });
  // a folder of games to show where it is, without copying
  ipcMain.handle("watch-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Watch a folder of games", buttonLabel: "Watch", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const [code, res] = backend.addWatch(r.filePaths[0]);
    return code === 200 ? { ok: true, games: res.games } : { ok: false, error: res.error };
  });
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
  backend = new Backend({ app: __dirname, data: app.getPath("userData"), docs: DOCS, emu: EMU, version: app.getVersion(), watch: true }, fetchUrl);
  backend.trash = p => shell.trashItem(p);
  // backups by themselves: weekly, when that's on, never while a game is open; the last five kept, older ones to the Trash
  const autoBackup = async () => {
    if (!backend.backupDue() || (backend.running && backend.running.alive)) return;
    const saves = backend.folders.saves;
    let any = false;
    try { any = filesIn(saves).length > 0; } catch {}
    if (!any) return;
    const dir = backend.backupDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      await zipFolder(saves, path.join(dir, `Retro Shelf saves ${new Date().toISOString().slice(0, 10)}.zip`));
    } catch { return; }
    backend.state.lastAutoBackup = Math.floor(Date.now() / 1000); backend.saveState(); backend.event("backup");
    const mine = fs.readdirSync(dir).filter(f => /^Retro Shelf saves \d{4}-\d{2}-\d{2}\.zip$/.test(f)).map(f => path.join(dir, f))
      .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
    for (const f of mine.slice(5)) await shell.trashItem(f).catch(() => {});
  };
  setTimeout(autoBackup, 90000);
  setInterval(autoBackup, 3600000);
  backend.init();
  if (OLD_GAMES) backend.remapIds(OLD_GAMES);
  backend.on("exit", () => setTimeout(focusApp, 150));
  // games appeared or went (a watched folder, or the games folder): the shelf looks again
  backend.on("changed", () => { if (win && !win.isDestroyed()) win.webContents.send("menu", { cmd: "refresh" }); });
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

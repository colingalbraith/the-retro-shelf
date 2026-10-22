"use strict";
// The Retro Shelf desktop app: one window showing index.html over the arcade:// protocol, a backend in this
// process, and RetroArch (bundled in Resources/emulators) launched for each game.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, screen, clipboard } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Backend, GAME_CHOICES, within } = require("./backend");
const { Updater } = require("./updater");
const { zipFolder, zipFiles, unzipInto, filesIn } = require("./zip");

protocol.registerSchemesAsPrivileged([
  { scheme: "arcade", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Ubuntu 24.04 and later don't let an app make the sandbox Chromium uses unless it's installed with its own AppArmor
// profile, which an AppImage can't bring: there it runs without it, as other AppImages do. The page it shows is its own.
if (process.platform === "linux") {
  try { if (fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1") app.commandLine.appendSwitch("no-sandbox"); } catch {}
}

// ARCADE_HOME keeps everything (settings, games, saves) in one folder: handy for testing. Set before the
// single-instance lock, which lives in the data folder, so a test copy can run next to the real one.
// The portable Windows copy (portable.txt beside the app) does the same with a Data folder beside it, for a USB stick.
const PORTABLE = process.platform === "win32" && fs.existsSync(path.join(path.dirname(process.execPath), "portable.txt"));
const HOME = process.env.ARCADE_HOME || (PORTABLE ? path.join(path.dirname(process.execPath), "Data") : "");
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
  // only folders that are surely this app's: its settings (with their ui.accent), or the README it puts in its games
  // folder. Someone else's "Arcade" folder stays where it is
  const oldData = path.join(app.getPath("appData"), "Arcade"), oldDocs = path.join(app.getPath("documents"), "Arcade");
  let ours = false, oursDocs = false;
  try { const st = JSON.parse(fs.readFileSync(path.join(oldData, "settings.json"), "utf8")); ours = !!(st && st.ui && "accent" in st.ui); } catch {}
  try { oursDocs = fs.readFileSync(path.join(oldDocs, "Games", "README.txt"), "utf8").startsWith("Your games go here, one folder per system"); } catch {}
  if (ours) move(oldData, app.getPath("userData"), ["settings.json", "state.json", "covers", "retroarch"]);
  // games are known by their path, so their play history is moved over to the new paths once the backend is up
  if ((ours || oursDocs) && move(oldDocs, DOCS, ["Games"])) OLD_GAMES = path.join(oldDocs, "Games");
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

/** how big everything is: a quarter bigger in TV mode, times the text size from Settings */
function setZoom(tv, size) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor((tv ? 1.25 : 1) * ([100, 115, 130].includes(size) ? size : 100) / 100);
}
/** TV mode: everything a quarter bigger, and fullscreen */
function tvMode(on, size) {
  if (!win || win.isDestroyed()) return;
  setZoom(on, size);
  if (win.isFullScreen() !== on) win.setFullScreen(on);
}

// the app's own tests (scripts/*-test.mjs) open it without taking focus, almost all off the bottom right of the
// screen, so they keep out of the way of whoever is using the computer while they run
const TESTING = process.env.RETRO_SHELF_TEST === "1";

// the app's words in the chosen language (src/words/<lang>.json, keyed by the English) for the menus and dialogs made
// here; the page translates its own. The language is the one chosen in Settings, or the computer's
const LANGUAGES = ["es", "fr", "de", "it", "pl", "pt", "ru", "ja", "ko", "zh", "zh-Hant"];
let chosenLang = null, words = {}, wordsLang = "";
function tm(text, vars) {
  const pick = chosenLang || (backend && backend.ui.lang) || "auto", lang = pick === "auto" ? (/^zh-(hant|tw|hk|mo)/i.test(app.getLocale()) ? "zh-Hant" : app.getLocale().slice(0, 2).toLowerCase()) : pick;
  if (lang !== wordsLang) { wordsLang = lang; try { words = LANGUAGES.includes(lang) ? JSON.parse(fs.readFileSync(path.join(__dirname, "words", lang + ".json"), "utf8")) : {}; } catch { words = {}; } }
  const out = words[text] || text;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m) : out;
}
/** a menu with each label in the chosen language (names of shelves and consoles aren't in the word list, so stay) */
const trMenu = items => items.map(i => ({ ...i, ...(i.label ? { label: tm(i.label) } : {}), ...(Array.isArray(i.submenu) ? { submenu: trMenu(i.submenu) } : {}) }));
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
    win.show(); if (backend && backend.ui.tv) tvMode(true, backend.ui.textSize); else if (backend) setZoom(false, backend.ui.textSize);
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
    { role: "help", submenu: [{ label: "Buttons and Keys", click: () => win && win.webContents.send("menu", "keys") }, { label: "Where to Get Games…", click: () => win && win.webContents.send("menu", "get-games") }, { label: "Licenses", click: openLicenses }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(trMenu(tpl)));
}

let licWin = null;
function openLicenses() {
  if (licWin) return licWin.focus();
  licWin = new BrowserWindow({ width: 760, height: 720, title: tm("The Retro Shelf · Licenses"), backgroundColor: "#ece6d6", parent: win || undefined, autoHideMenuBar: true,
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
    const r = await dialog.showOpenDialog(win, { title: tm("Choose a picture"), buttonLabel: tm("Use Picture"), properties: ["openFile"],
      filters: [{ name: tm("Pictures"), extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (r.canceled || !r.filePaths[0]) return;
    const [code, res] = await backend.setArt(g.id, kind, r.filePaths[0]);
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
    // this game's own picture, screen shape and fast-forward speed (the app's own emulators), over the ones in Settings
    ...Object.entries({ picture: "Picture", shape: "Screen Shape", ...(!backend.standalone(g.system) && !backend.ownEmu() ? { ffSpeed: "Fast-Forward Speed" } : {}) }).map(([k, label]) => ({ label, submenu: [
      { label: "Same as Settings", type: "radio", checked: !(backend.state.gameOpts[g.id] || {})[k], click: () => { backend.setGameOpts(g.id, { [k]: null }); send({ cmd: "refresh", focus: g.id }); } },
      { type: "separator" },
      ...GAME_CHOICES[k].map(([v, name]) => ({ label: name, type: "radio", checked: (backend.state.gameOpts[g.id] || {})[k] === v,
        click: () => { backend.setGameOpts(g.id, { [k]: v }); send({ cmd: "refresh", focus: g.id }); } })),
    ] })),
    ...(!backend.standalone(g.system) && !backend.ownEmu() ? [{ label: "Cheats…", click: () => send({ cmd: "cheats", id: g.id }) }] : []),
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
      const r = await dialog.showMessageBox(win, { type: "warning", buttons: [tm("Move to Trash"), tm("Cancel")], defaultId: 1, cancelId: 1,
        message: tm("Move “{title}” to the Trash?", { title }), detail: tm("You can get it back from the Trash. Its saves stay where they are.") });
      if (r.response !== 0) return;
      // the game's own files: a disc game's tracks too, and its whole folder when nothing else is in it
      try {
        const { folder, files } = backend.gameFiles(g);
        for (const t of folder ? [folder] : files) await shell.trashItem(t);
      } catch (e) { send({ cmd: "error", text: "Couldn't move it to the Trash: " + e.message }); }
      backend.scan(); send({ cmd: "refresh" });
    } },
  ];
  Menu.buildFromTemplate(trMenu(tpl)).popup({ window: win });
}

function ipc() {
  ipcMain.handle("pick-games", async () => {
    const props = ["openFile", "multiSelections"];
    if (process.platform === "darwin") props.push("openDirectory");
    const r = await dialog.showOpenDialog(win, { title: tm("Add games"), buttonLabel: tm("Add"), properties: props });
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
    const r = await dialog.showOpenDialog(win, { title: tm("Where should backups go?"), buttonLabel: tm("Back Up Here"), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    // backups kept among the saves would each hold the ones before, growing every week
    if (within(r.filePaths[0], backend.folders.saves)) return { ok: false, error: "That's inside the saves folder: choose a folder outside it." };
    backend.paths.backup_dir = r.filePaths[0]; backend.saveSettings();
    return { ok: true, dir: r.filePaths[0] };
  });
  // the saves into a folder of your own (to share them through iCloud Drive, Dropbox or OneDrive), or back
  ipcMain.handle("move-saves", async (_, home) => {
    let dir = "";
    if (!home) {
      const r = await dialog.showOpenDialog(win, { title: tm("Share saves through a cloud folder"), message: tm("Choose a folder in iCloud Drive, Dropbox or OneDrive."), buttonLabel: tm("Keep Saves Here"), properties: ["openDirectory", "createDirectory"] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      dir = r.filePaths[0];
    }
    const [code, res] = await backend.moveSaves(dir);
    return code === 200 ? { ok: true, ...res } : { ok: false, error: res.error };
  });
  // the games to another drive; then the old copy to the Trash, if you say so
  ipcMain.handle("move-library", async () => {
    const r = await dialog.showOpenDialog(win, { title: tm("Move the games to…"), buttonLabel: tm("Move Them Here"), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const [code, res] = await backend.moveLibrary(r.filePaths[0]);
    if (code !== 200) return { ok: false, error: res.error };
    const a = await dialog.showMessageBox(win, { type: "question", buttons: [tm("Move to Trash"), tm("Keep It")], defaultId: 0, cancelId: 1,
      message: tm("Moved {n} files to {to}.", { n: res.files, to: res.to }), detail: tm("The old copy is still in {from}. Move it to the Trash? Nothing is deleted for good: it stays in the Trash until you empty it.", { from: res.from }) });
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
      const out = await dialog.showSaveDialog(win, { title: tm("Save as a picture"), defaultPath: path.join(app.getPath("pictures"), safe + ".png"), filters: [{ name: tm("PNG picture"), extensions: ["png"] }] });
      if (out.canceled || !out.filePath) return { ok: false };
      file = out.filePath;
    }
    try { fs.writeFileSync(file, img.toPNG()); } catch (e) { return { ok: false, error: "Couldn't save the picture: " + e.message }; }
    backend.event("picture");
    return { ok: true, file };
  });
  ipcMain.handle("export-saves", async (_, id, quick) => {
    const g = backend.games.get(String(id));
    if (!g) return { ok: false, error: "Unknown game." };
    const files = backend.gameSaves(g);
    if (!files.length) return { ok: false, error: "This game has no saves yet." };
    const r = quick ? { filePath: freeName(app.getPath("documents"), `${g.title.replace(/[\\/:*?"<>|]/g, "")} saves`) }
      : await dialog.showSaveDialog(win, { title: tm("Export saves"), buttonLabel: tm("Export"),
        defaultPath: path.join(app.getPath("documents"), `${g.title.replace(/[\\/:*?"<>|]/g, "")} saves.zip`), filters: [{ name: tm("Zip archive"), extensions: ["zip"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    // laid out like a backup (Saves/<emulator>/…, Saves/States/…), so Restore can put it back
    const list = files.flatMap(s => [s.file, ...(s.pic ? [s.file + ".png"] : [])])
      .map(f => ({ name: "Saves/" + path.relative(backend.folders.saves, f).split(path.sep).join("/"), full: f }));
    try { return { ok: true, count: await zipFiles(list, r.filePath), path: r.filePath }; } catch (e) { return { ok: false, error: "Couldn't export them: " + e.message }; }
  });
  // the list of games as a spreadsheet; with only a controller, straight into Documents
  ipcMain.handle("export-list", async (_, quick) => {
    const name = `The Retro Shelf games ${new Date().toISOString().slice(0, 10)}`;
    const r = quick ? { filePath: freeName(app.getPath("documents"), name, ".csv") }
      : await dialog.showSaveDialog(win, { title: tm("Export the list"), buttonLabel: tm("Export"),
        defaultPath: path.join(app.getPath("documents"), name + ".csv"), filters: [{ name: tm("Spreadsheet (CSV)"), extensions: ["csv"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    try { fs.writeFileSync(r.filePath, backend.listCsv()); } catch (e) { return { ok: false, error: "Couldn't save the list: " + e.message }; }
    backend.event("export");
    return { ok: true, count: backend.games.size, path: r.filePath };
  });
  // opening when you sign in to the computer. Linux: a file in ~/.config/autostart, for the AppImage only (its place
  // stays put across updates); Mac and Windows: the system's own list
  const autostart = path.join(os.homedir(), ".config", "autostart", "the-retro-shelf.desktop");
  ipcMain.handle("login-item", (_, on) => {
    // not the portable copy: its USB stick may not be there next time
    if (!app.isPackaged || PORTABLE) return { supported: false };
    if (process.platform === "linux") {
      if (!process.env.APPIMAGE) return { supported: false };
      if (on === true || on === false) {
        try {
          if (on) { fs.mkdirSync(path.dirname(autostart), { recursive: true });
            fs.writeFileSync(autostart, `[Desktop Entry]\nType=Application\nName=The Retro Shelf\nExec="${process.env.APPIMAGE.replace(/"/g, "")}"\nX-GNOME-Autostart-enabled=true\n`); }
          else fs.rmSync(autostart, { force: true });
        } catch (e) { return { supported: true, on: fs.existsSync(autostart), error: e.message }; }
      }
      return { supported: true, on: fs.existsSync(autostart) };
    }
    if (on === true || on === false) { try { app.setLoginItemSettings({ openAtLogin: on }); } catch (e) { return { supported: true, on: false, error: e.message }; } }
    const st = app.getLoginItemSettings();
    // macOS can ask for an OK first, in System Settings → General → Login Items
    return { supported: true, on: !!st.openAtLogin || st.status === "enabled", approve: st.status === "requires-approval" };
  });
  // a folder of games to show where it is, without copying
  ipcMain.handle("watch-folder", async () => {
    const r = await dialog.showOpenDialog(win, { title: tm("Watch a folder of games"), buttonLabel: tm("Watch"), properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const [code, res] = backend.addWatch(r.filePaths[0]);
    return code === 200 ? { ok: true, games: res.games } : { ok: false, error: res.error };
  });
  /** a file name in dir that isn't taken yet: "name.zip", then "name 2.zip"… */
  const freeName = (dir, name, ext = ".zip") => { let f = path.join(dir, name + ext); for (let i = 2; fs.existsSync(f); i++) f = path.join(dir, `${name} ${i}${ext}`); return f; };
  // quick: from a controller, which can't work the save window: straight into the backups folder
  ipcMain.handle("backup-saves", async (_, quick) => {
    const saves = backend.folders.saves;
    // folders RetroArch makes on the first launch don't count: only actual save files
    let any = false;
    try { any = filesIn(saves).length > 0; } catch {}
    if (!any) return { ok: false, error: "There are no saves to back up yet." };
    let r;
    if (quick) { fs.mkdirSync(backend.backupDir(), { recursive: true }); r = { filePath: freeName(backend.backupDir(), `Retro Shelf saves ${new Date().toISOString().slice(0, 10)}`) }; }
    else r = await dialog.showSaveDialog(win, { title: tm("Back up saves"), buttonLabel: tm("Back Up"),
      defaultPath: path.join(app.getPath("documents"), `Retro Shelf saves ${new Date().toISOString().slice(0, 10)}.zip`), filters: [{ name: tm("Zip archive"), extensions: ["zip"] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    try { const count = await zipFolder(saves, r.filePath); backend.event("backup"); return { ok: true, count, path: r.filePath }; }
    catch (e) { return { ok: false, error: "Couldn't make the backup: " + e.message }; }
  });
  ipcMain.handle("restore-saves", async () => {
    // a running game would write its save over the restored one when it closes
    if (backend.running && backend.running.alive) return { ok: false, error: "Close the game first, then restore." };
    const r = await dialog.showOpenDialog(win, { title: tm("Restore saves"), buttonLabel: tm("Restore"), properties: ["openFile"], filters: [{ name: tm("Zip archive"), extensions: ["zip"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try { fs.mkdirSync(backend.folders.saves, { recursive: true }); return { ok: true, ...(await unzipInto(r.filePaths[0], backend.folders.saves)) }; }
    catch (e) { return { ok: false, error: "Couldn't restore from that file: " + e.message }; }
  });
  ipcMain.handle("tv-mode", (_, on, size) => tvMode(!!on, size));
  ipcMain.handle("text-size", (_, tv, size) => setZoom(!!tv, size));
  // a new language from Settings: the menus follow
  ipcMain.handle("lang", (_, code) => { chosenLang = ["auto", "en", ...LANGUAGES].includes(code) ? code : "auto"; menu(); });
  ipcMain.handle("copy-report", () => { clipboard.writeText(backend.report(app.getVersion())); return true; });
  ipcMain.handle("update", (_, what) => {
    if (what === "check") return updater.check(true);
    // a game still open is closed properly first (saving), not left running while the new version goes in
    if (what === "restart") return (backend.running && backend.running.alive ? backend.stop() : Promise.resolve()).finally(() => updater.restart());
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
  backend = new Backend({ app: __dirname, data: app.getPath("userData"), docs: DOCS, emu: EMU, version: app.getVersion(), watch: true, locale: app.getLocale() }, fetchUrl);
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
      await zipFolder(saves, path.join(dir, `Retro Shelf saves ${new Date().toISOString().slice(0, 10)} (weekly).zip`));
    } catch { return; }
    backend.state.lastAutoBackup = Math.floor(Date.now() / 1000); backend.saveState(); backend.event("backup");
    // only the weekly ones are pruned: a backup made by hand into the same folder stays
    const mine = fs.readdirSync(dir).filter(f => /^Retro Shelf saves \d{4}-\d{2}-\d{2} \(weekly\)\.zip$/.test(f)).map(f => path.join(dir, f))
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
    win.once("ready-to-show", () => dialog.showMessageBox(win, { type: "warning", message: tm("The Retro Shelf couldn't set up its games folder"),
      detail: tm("It needs to create “The Retro Shelf” in your Documents folder ({error}). Check that it's allowed to use Documents: on a Mac in System Settings → Privacy & Security → Files and Folders, on Windows under Virus & threat protection → Controlled folder access.", { error: backend.setupError }) }));
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
  // the games half moved to another drive: quitting would leave a partial copy there
  if (!quitting && backend && backend.moving && win && !win.isDestroyed()) {
    const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: [tm("Keep Moving"), tm("Quit Anyway")], defaultId: 0, cancelId: 0,
      message: tm("The games are still being moved."), detail: tm("Quitting now leaves a partial copy in the new place. Your games stay where they were.") });
    if (r === 0) { e.preventDefault(); return; }
  }
  if (updater) updater.dropUnwanted();
  if (quitting || !backend || !backend.running || !backend.running.alive) return;
  e.preventDefault();
  quitting = true;
  backend.stop().finally(() => app.quit());
});

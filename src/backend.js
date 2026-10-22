"use strict";
// The Retro Shelf's backend inside the app: library scan, emulator launch, cover art, settings and imports.
// index.html talks to it with fetch("/api/...") over the arcade:// protocol, so nothing listens on a network port.
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const ra = require("./retroarch");
const { Importer, sheetFiles } = require("./importer");
const { biosDest, biosSize, biosStatus, biosByContent } = require("./bios");
const pins = require("./pins");
const { compare, isTest } = require("./version");
const cheatFiles = require("./cheats");
const zip = require("./zip");
const sync = require("./sync");
const playImport = require("./playimport");

const IMG = [".png", ".jpg", ".jpeg", ".webp"];
const SHEETS = [".cue", ".gdi", ".m3u"];
// box art and game logos, both from the libretro thumbnails project
const ART = {
  cover: { dir: "Named_Boxarts", sub: "", misses: ".misses.json" },
  logo: { dir: "Named_Logos", sub: "logos", misses: ".logo-misses-3.json" },
  snap: { dir: "Named_Snaps", sub: "snaps", misses: ".snap-misses.json" },
};
// the thumbnails site doesn't mirror every logo folder; the project's GitHub repos have them all
const GITHUB_ART = "https://raw.githubusercontent.com/libretro-thumbnails";
const GITHUB_API = "https://api.github.com/repos/libretro-thumbnails";
const repoOf = thumb => thumb.replace(/ /g, "_");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".bmp": "image/bmp" };
const DEFAULT_UI = { accent: "#e2582b", tint: true, spine: "cover", fx: "full", sound: true, card: 170, hints: false, autoCovers: true, hidden: [], shelf: "spines",
                     fullscreen: true, resume: true, ownEmu: false, welcomed: false, showHidden: false, updates: true, beta: false, rewind: true, lessLag: true, hardcore: false,
                     picture: "auto", sort: "title", buttons: "auto", arrange: "console", wood: "walnut", wall: "dark", saver: 5, music: false, musicVol: "medium", textSize: 100, lang: "auto", ffSpeed: 3, ffTrigger: "hold" };
const REGIONS = ["usa", "europe", "japan", "world", "germany", "france", "spain", "italy", "australia", "korea", "brazil", "china"];
// standalone emulators named in config.json, and where their installers usually put them
const KNOWN_APPS = {
  "pcsx2-qt": { darwin: ["/Applications/PCSX2.app/Contents/MacOS/PCSX2"], win32: ["%ProgramFiles%\\PCSX2\\pcsx2-qt.exe", "%LOCALAPPDATA%\\Programs\\PCSX2\\pcsx2-qt.exe"] },
  "dolphin-emu": { darwin: ["/Applications/Dolphin.app/Contents/MacOS/Dolphin"], win32: ["%ProgramFiles%\\Dolphin\\Dolphin.exe", "%ProgramFiles%\\Dolphin-x64\\Dolphin.exe"] },
};

// ---------------------------------------------------------------- storage
/** whether p is the folder dir or inside it. On Windows a path on another drive isn't (path.relative gives it whole,
    without ".."), and neither is a sibling whose name starts with two dots */
/** whether f is one of this game's own pictures: Name.png, Name.logo.png, Name.snap.png (not "Name 3.png", whose
    name only starts the same) */
function ownPic(f, stem) {
  if (!f.startsWith(stem + ".") || !IMG.includes(path.extname(f).toLowerCase())) return false;
  return /^(\.(logo|snap))?$/i.test(f.slice(stem.length, f.length - path.extname(f).length));
}
function within(p, dir, pp = path) {
  const r = pp.relative(pp.resolve(dir), pp.resolve(p));
  return r === "" || (!pp.isAbsolute(r) && r !== ".." && !r.startsWith(".." + pp.sep));
}

/**
 * A JSON file, or def when there's none. One that can't be read (cut short by a crash or a full disk, or not an object
 * when an object is wanted) is set aside as name.broken-<time>, never overwritten, and the copy before it (name.bak,
 * kept by jsave) is used instead: play history isn't lost to one bad save.
 */
function jload(p, def) {
  const parse = f => {
    const v = JSON.parse(fs.readFileSync(f, "utf8"));
    if (def && typeof def === "object" && !Array.isArray(def) && (!v || typeof v !== "object" || Array.isArray(v))) throw new Error("not an object");
    return v;
  };
  try { return parse(p); } catch (e) {
    if (e.code !== "ENOENT") { try { fs.renameSync(p, `${p}.broken-${Date.now()}`); } catch {} }
    try { return parse(p + ".bak"); } catch { return def; }
  }
}
/** written whole before it takes the old one's place, which is kept as name.bak; a file another program has open for a
    moment (Windows) gets a few tries */
function jsave(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = JSON.stringify(obj, null, 2), fd = fs.openSync(p + ".tmp", "w");
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // read back whole before it takes the old one's place: a full disk can cut a write short without saying so, and a
  // short one must never become the file (or, the save after, its .bak)
  if (fs.readFileSync(p + ".tmp", "utf8") !== text) { try { fs.rmSync(p + ".tmp", { force: true }); } catch {} throw new Error("Couldn't save " + path.basename(p) + ": the disk may be full."); }
  for (let i = 0; ; i++) {
    try {
      if (fs.existsSync(p)) fs.copyFileSync(p, p + ".bak");
      fs.renameSync(p + ".tmp", p);
      return;
    } catch (e) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}
/** a name for setting a file aside that no file has yet: name.old, then name.old 2, name.old 3… */
function freeName(p) {
  if (!fs.existsSync(p)) return p;
  for (let i = 2; ; i++) if (!fs.existsSync(`${p} ${i}`)) return `${p} ${i}`;
}
/** a short name for a file being written next to dest (a game's name can be near the longest a name can be) */
const partFor = dest => path.join(path.dirname(dest), `.retro-shelf-${crypto.randomBytes(4).toString("hex")}.part`);

/** emulators whose own name (what RetroArch names their saves, states, remaps and cheats folders) isn't the .info's */
const BUILT_IN_NAMES = { dolphin_libretro: "dolphin-emu", vecx_libretro: "VecX", freeintv_libretro: "freeintv" };
// RetroArch's names for the RetroPad's buttons, by number (remap files say input_player1_btn_<name>)
const RETROPAD = ["b", "y", "select", "start", "up", "down", "left", "right", "a", "x", "l", "r", "l2", "r2", "l3", "r3"];
const CHEAT_MARK = "# Cheats chosen in The Retro Shelf (a game's options → Cheats)";
const REMAP_MARK = "# Buttons changed in The Retro Shelf (Settings → Playing → Buttons)";

// how far you are with a game (setGameInfo): not started yet, playing it, beaten, or done everything there is (100%)
const PROGRESS = ["backlog", "playing", "beaten", "complete"];

// What each person who plays on this computer has of their own; everything else in the state (games' names and
// settings, button layouts, watched folders, the backup clock) is the computer's. The first person's is in state.json
// with the rest, as it always was, so one person sees no change; others' are in people/<id>.json
const PERSONAL = ["fav", "last", "plays", "time", "sessions", "events", "pins", "pinKeys", "progress", "rating", "notes", "shelves", "cheevos", "recapSeen", "edited", "imported",
  "journalLast", "journalBase", "former", "consoleSaves"];
const STATE_DEFAULTS = [["fav", []], ["last", {}], ["plays", {}], ["time", {}], ["names", {}], ["hidden", []], ["shelves", []], ["sessions", []], ["events", {}], ["gameOpts", {}], ["cheats", {}], ["cheevos", {}], ["progress", {}], ["rating", {}], ["notes", {}], ["remaps", {}], ["notCounted", {}]];

// what one game can have of its own (setGameOpts): each setting's choices, with the words menus show for them
const GAME_CHOICES = {
  picture: [["sharp", "Sharp"], ["smooth", "Smooth"], ["crt", "Old TV"], ["lcd", "Handheld"]],
  shape: [["core", "As the console showed it"], ["4:3", "4:3"], ["pixel", "Pixel-perfect"], ["stretch", "Stretch to fill"]],
  ffSpeed: [["2", "2×"], ["3", "3×"], ["4", "4×"], ["max", "Fastest"]],
};
const GAME_OPTS = Object.fromEntries(Object.entries(GAME_CHOICES).map(([k, v]) => [k, v.map(c => c[0])]));

function cleanUi(d) {
  const out = { ...DEFAULT_UI, hidden: [] };
  if (!d || typeof d !== "object") return out;
  if (typeof d.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(d.accent)) out.accent = d.accent;
  if (["full", "reduced", "off"].includes(d.fx)) out.fx = d.fx;
  if (["spines", "covers"].includes(d.shelf)) out.shelf = d.shelf;
  if (["cover", "printed"].includes(d.spine)) out.spine = d.spine;
  else if (["art", "color"].includes(d.spine)) out.spine = "cover";
  if (["auto", "sharp", "smooth", "crt", "lcd"].includes(d.picture)) out.picture = d.picture;
  if (["title", "year", "played", "most", "rating"].includes(d.sort)) out.sort = d.sort;
  if (["walnut", "oak", "cherry", "white", "black"].includes(d.wood)) out.wood = d.wood;
  if (["dark", "light", "green", "blue"].includes(d.wall)) out.wall = d.wall;
  if ([0, 5, 10, 20].includes(d.saver)) out.saver = d.saver;
  if ([100, 115, 130].includes(d.textSize)) out.textSize = d.textSize;
  if ([0, 2, 3, 4].includes(d.ffSpeed)) out.ffSpeed = d.ffSpeed;
  if (["hold", "toggle"].includes(d.ffTrigger)) out.ffTrigger = d.ffTrigger;
  if (["auto", "en", "es", "fr", "de", "it", "pl", "pt", "ru", "ja", "ko", "zh", "zh-Hant"].includes(d.lang)) out.lang = d.lang;
  if (["quiet", "medium", "loud"].includes(d.musicVol)) out.musicVol = d.musicVol;
  if (["auto", "xbox", "nintendo"].includes(d.buttons)) out.buttons = d.buttons;
  if (["console", "genre", "decade", "status"].includes(d.arrange)) out.arrange = d.arrange;
  if (Array.isArray(d.hiddenSeries)) out.hiddenSeries = d.hiddenSeries.map(String).slice(0, 1000);
  for (const k of ["sound", "hints", "autoCovers", "tint", "fullscreen", "resume", "ownEmu", "welcomed", "showHidden", "updates", "beta", "tv", "rewind", "lessLag", "hardcore", "autoBackup", "music", "pcsx2"]) if (typeof d[k] === "boolean") out[k] = d[k];
  if (typeof d.card === "number" && isFinite(d.card)) out.card = Math.max(110, Math.min(280, Math.round(d.card)));
  if (Array.isArray(d.hidden)) out.hidden = d.hidden.map(String).slice(0, 100);
  return out;
}
const safe = s => s.replace(/[\\/:*?"<>|]+/g, "_");
/** a screenshot as RetroArch names it: the game's file name, then when (Game-251021-203015.png) */
const SHOT = /^(.+)-(\d{6})-(\d{6})\.(png|jpe?g|bmp)$/i;
const asList = v => !v ? [] : typeof v === "string" ? [v] : [...v];
const now = () => Date.now() / 1000;
function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const d of (process.env.PATH || "").split(path.delimiter)) for (const e of exts) {
    const p = path.join(d, cmd + e);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
function splitArgs(s) {
  const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ---------------------------------------------------------------- titles
const TAG = /[([]([^)\]]*)[)\]]/g;
/** a typed or pasted path, without the quotes Windows' "Copy as path" puts around it */
const unquote = v => String(v).trim().replace(/^(["'])(.*)\1$/, "$2").trim();
/** a path as the file system compares it: Windows and macOS ignore letter case */
const pathKey = p => process.platform === "linux" ? path.resolve(p) : path.resolve(p).normalize("NFC").toLowerCase();
function gid(p) { return crypto.createHash("sha1").update(p).digest("hex").slice(0, 12); }
/** what scanning skips: hidden folders, and the files macOS leaves around (._Game.iso, .DS_Store). A game whose name
    starts with a dot (.hack//Infection) still counts */
const recapKey = (year, month) => month === null || month === undefined ? String(year) : `${year}-${String(month + 1).padStart(2, "0")}`;
const hiddenEntry = e => e.name.startsWith("._") || e.name === ".DS_Store" || (e.isDirectory() && e.name.startsWith("."));
// "Legend of Zelda, The - A Link to the Past (USA)" -> "The Legend of Zelda: A Link to the Past"
function cleanTitle(stem) {
  const t = stem.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || stem;
  const parts = t.split(" - ").map(p => { const m = /^(.*), (The|A|An)$/.exec(p); return m ? `${m[2]} ${m[1]}` : p; });
  return parts.length > 1 ? parts[0] + ": " + parts.slice(1).join(" – ") : parts[0];
}
function tags(s) { return [...s.matchAll(TAG)].map(m => m[1]); }
const words = t => t.toLowerCase().split(/[,\s]+/);
function regionTag(stem) { return tags(stem).find(t => words(t).some(w => REGIONS.includes(w))) || ""; }
function regions(s) { return new Set(tags(s).flatMap(words).filter(w => REGIONS.includes(w))); }
function norm(s) {
  s = s.replace(/[([][^)\]]*[)\]]/g, " ").toLowerCase().replace(/&/g, "and").trim();
  s = s.replace(/^(.*?),\s*(the|a|an)$/, "$2 $1");
  return s.replace(/[^a-z0-9]+/g, "");
}
function pick(cands, stem) {
  const want = regions(stem);
  const score = n => {
    const r = regions(n);
    let s = [...r].some(x => want.has(x)) ? 4 : 0;
    s += r.has("usa") ? 3 : r.has("world") ? 2 : r.has("europe") ? 1 : 0;
    if (/\((beta|proto|demo|sample)/i.test(n)) s -= 5;
    return s - n.length / 1000;
  };
  return cands.reduce((a, b) => (score(b) > score(a) ? b : a));
}

class Backend extends EventEmitter {
  /**
   * dirs: { app: folder with index.html/config.json, data: private app data, docs: the user-visible The Retro Shelf
   * folder in Documents, emu: bundled emulators }. fetchUrl(url, timeoutMs) -> Promise<Buffer>.
   */
  constructor(dirs, fetchUrl) {
    super();
    this.dirs = dirs;
    this.fetchUrl = fetchUrl;
    this.files = {
      cfg: path.join(dirs.data, "config.json"),
      state: path.join(dirs.data, "state.json"),
      settings: path.join(dirs.data, "settings.json"),
      covers: path.join(dirs.data, "covers"),
      raCfg: path.join(dirs.data, "retroarch", "retroarch.cfg"),
      raLog: path.join(dirs.data, "logs", "retroarch.log"),
    };
    this.folders = {
      games: path.join(dirs.docs, "Games"),
      saves: path.join(dirs.docs, "Saves"),
      states: path.join(dirs.docs, "Saves", "States"),
      screenshots: path.join(dirs.docs, "Screenshots"),
      bios: path.join(dirs.data, "system"),
      logs: path.join(dirs.data, "logs"),
    };
    this.games = new Map();
    this.running = null;
    this.lastExit = null;
    // moving a file to the system Trash: the app hands this in (Electron's shell), so nothing is ever deleted for good
    this.trash = async () => { throw new Error("there's no Trash to move it to"); };
    this.cov = { running: false, done: 0, total: 0, found: 0, error: "" };
    this.imp = { running: false, done: 0, total: 0, current: "", added: 0, already: 0, failed: 0, error: "", seq: 0 };
    this.pending = new Map();
    this._idx = new Map();
    this._bad = new Map();
  }

  init() {
    // config.json in the app has the systems; one in the data folder (if any) can add or change them
    const base = jload(path.join(this.dirs.app, "config.json"), {});
    const user = jload(this.files.cfg, {});
    this.cfg = { ...base, ...user, systems: { ...base.systems, ...(user.systems || {}) }, retroarch: { ...(user.retroarch || {}) } };
    this.state = this._base = jload(this.files.state, {});
    // names: titles people gave games; hidden: games taken off the shelves; shelves: ones people made ({name, ids})
    // sessions: each time a game was played, as [id, started (unix seconds), seconds played], oldest first
    for (const [k, v] of STATE_DEFAULTS) if (!this.state[k]) this.state[k] = structuredClone(v);
    const st = jload(this.files.settings, {});
    this.ui = cleanUi(st.ui);
    this.paths = { roms_dir: "", ...(st.paths || {}) };
    // saves somewhere of your own (a cloud folder, to share them between computers)
    // kept even while it isn't there (a cloud drive not started yet): games wait for it, rather than playing on with old
    // saves from before it was shared. Whoever's playing has theirs in it (savesRoot, personFolder)
    this.loadPeople();
    this.peopleFolders();
    if (this.people.active !== "p1") this.state = this.personState(this.people.active);
    this.applyFolders();
    this.ra = ra.bundled(this.dirs.emu);
    this.names = { arcade: jload(path.join(this.dirs.app, "data", "arcade-names.json"), {}) };
    this.importer = new Importer(this.cfg.systems);
    // a Documents folder the app may not write to (Windows' Controlled folder access, a declined macOS prompt)
    // shouldn't stop it from opening: it says so instead
    this.setupError = "";
    try { this.firstRun(); } catch (e) { this.setupError = e.message; }
    try { fs.rmSync(path.join(this.files.covers, ".previews"), { recursive: true, force: true }); } catch {}
    if (!this.state.ggShelf) { try { this.moveGameGear(); } catch {} this.state.ggShelf = 1; this.saveState(); }
    // a password left behind by a game that never finished (the app was force-quit) goes
    try { if (ra.readConfigKey(this.files.raCfg, "cheevos_password")) ra.writeConfig(this.files.raCfg, { cheevos_password: "" }); } catch {}
    this.scan();
    this.checkPins();
    // a new install starts with the welcome card, not a list of changes it never had
    if (!this.state.seenVersion && !this.ui.welcomed) { this.state.seenVersion = this.dirs.version; this.saveState(); }
  }

  /**
   * Every game as a row of a spreadsheet (CSV, which Excel, Numbers and Google Sheets open): its name, console, year,
   * progress, rating and play. UTF-8 with a mark at the start, so Excel reads accents right; a cell starting with = + -
   * or @ gets a ' in front, so a spreadsheet never runs one as a formula
   */
  listCsv() {
    const st = this.state, fav = new Set(st.fav || []);
    // a cell a spreadsheet won't take for a formula (one starting with =, even after spaces, isn't run)
    const cell = v => { let s = String(v ?? ""); if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    // the day where you are, not in London
    const day = t => { if (!t) return ""; const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    // play on other computers too, as the shelves count it
    const far = this.remote().add, plays = id => (st.plays[id] || 0) + ((far.get(id) || {}).plays || 0), time = id => (st.time[id] || 0) + ((far.get(id) || {}).time || 0);
    const last = id => Math.max(st.last[id] || 0, (far.get(id) || {}).last || 0);
    const rows = [["Title", "Console", "Year", "Publisher", "Genre", "Progress", "Rating", "Favorite", "Times played", "Hours played", "Last played", "Hidden", "Note", "File"]];
    const games = [...this.games.values()].map(g => ({ g, title: st.names[g.id] || g.title }))
      .sort((a, b) => a.g.system.localeCompare(b.g.system) || a.title.localeCompare(b.title));
    for (const { g, title } of games) rows.push([title, g.system, g.year || "", g.pub || "", g.genre || "",
      { backlog: "Backlog", playing: "Playing", beaten: "Beaten", complete: "100%" }[st.progress[g.id]] || "", st.rating[g.id] || "",
      fav.has(g.id) ? "Yes" : "", plays(g.id), (time(g.id) / 3600).toFixed(1), day(last(g.id)),
      st.hidden.includes(g.id) ? "Yes" : "", st.notes[g.id] || "", path.basename(g.path)]);
    return "\ufeff" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  /**
   * What changed since the version this person last used, from CHANGELOG.md: [{version, items: [[bold, text]]}], newest
   * first. Empty when they've seen this version (or it's a new install).
   */
  whatsNew() {
    const seen = this.state.seenVersion || "0.2.0", cur = this.dirs.version;
    if (!cur || seen === cur) return [];
    let text = "";
    try { text = fs.readFileSync(path.join(this.dirs.app, "..", "CHANGELOG.md"), "utf8"); } catch { return []; }
    const out = [];
    let cur2 = null;
    for (const line of text.split(/\r?\n/)) {
      const h = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(line);
      // test versions' notes show to people on test versions; a release has its own full notes
      if (h) { cur2 = compare(h[1], seen) > 0 && compare(h[1], cur) <= 0 && (isTest(cur) || !isTest(h[1])) ? { version: h[1], items: [] } : null; if (cur2) out.push(cur2); continue; }
      if (!cur2) continue;
      const it = /^- (?:\*\*(.+?)\*\*\s*)?(.*)$/.exec(line);
      if (it) cur2.items.push([it[1] || "", it[2]]);
      else if (/^\s+\S/.test(line) && cur2.items.length) cur2.items[cur2.items.length - 1][1] += " " + line.trim();
    }
    return out;
  }

  /**
   * Which pins are earned. A newly earned one gets today's date and waits in newPins until the shelf shows it. The first
   * time (an update from before pins) everything already earned is dated 0, "earned earlier", and nothing pops up.
   */
  checkPins() {
    const st = this.state, first = !st.pins;
    if (first) st.pins = {};
    let series = [], bios = false;
    try { series = this.collections()[1].series; } catch {}
    try { bios = biosStatus(this.folders.bios, null, this.cfg.systems).some(c => c.state === "ok" || c.state === "partial"); } catch {}
    const res = pins.evaluate(pins.context([...this.games.values()], this.withRemote(), series, pins.genreGroup, { bios, now: now() }), Object.keys(this.cfg.systems));
    // a pin added in a newer version that was already earned also counts as earned earlier, without popping up
    const known = new Set(st.pinKeys || []), fresh = [];
    let changed = first || res.length !== known.size;
    for (const r of res) {
      if (!r.earned || r.key in st.pins) continue;
      const quiet = first || !known.has(r.key);
      st.pins[r.key] = quiet ? 0 : Math.floor(now()); changed = true;
      if (!quiet) fresh.push(r.key);
    }
    st.pinKeys = res.map(r => r.key);
    if (changed) this.saveState();
    this.newPins = [...(this.newPins || []), ...fresh];
    return res;
  }

  /** a first worth a pin (the first CRT game, backup, cover picked by hand…): remembered once */
  event(kind) {
    if (this.state.events[kind]) return;
    this.state.events[kind] = Math.floor(now());
    this.saveState();
    try { this.checkPins(); } catch {}
  }

  /** the games folder moved (the app used to be called Arcade): ids come from paths, so each game's stats follow */
  /** the games folder somewhere other than last time, by itself (a portable copy whose USB stick came back as another
      drive letter): their play history follows the games. One chosen in Settings moves with its own steps */
  followRoot() {
    const root = path.resolve(this.romsRoot()), last = this._base.gamesRoot;
    if (last && last !== root && !this.paths.roms_dir) this.remapIds(last);
    if (last !== root) { this.state.gamesRoot = this._base.gamesRoot = root; this.saveState(true); }
  }
  remapIds(fromRoot) {
    const toRoot = this.romsRoot();
    for (const g of this.games.values()) {
      const rel = path.relative(toRoot, g.path);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) this.moveStats(gid(path.join(fromRoot, rel)), g.id);
    }
    this.saveState();
  }

  /**
   * Everything on disk that belongs to a game: its file, the files a .cue/.gdi/.m3u lists (and theirs), and pictures
   * saved beside it under the same name. folder is set when the game has a folder of its own holding nothing else.
   */
  gameFiles(g) {
    const dir = path.dirname(g.path), stem = path.parse(g.path).name, own = new Set();
    const add = f => {
      const r = path.resolve(f);
      if (own.has(r) || !fs.existsSync(r) || !within(r, dir)) return;
      own.add(r);
      if (SHEETS.includes(path.extname(r).toLowerCase())) for (const x of sheetFiles(r)) add(x);
    };
    add(g.path);
    for (const f of fs.readdirSync(dir)) if (ownPic(f, stem)) own.add(path.resolve(dir, f));
    const sysDir = path.join(this.romsRoot(), this.cfg.systems[g.system].folder || g.system);
    if (path.resolve(dir) !== path.resolve(sysDir) && within(dir, sysDir)) {
      const rest = [], walk = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (hiddenEntry(e) || /^(desktop\.ini|thumbs\.db)$/i.test(e.name)) continue;
          const p = path.resolve(d, e.name);
          if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); else rest.push(p); } else if (!own.has(p)) rest.push(p);
        }
      };
      walk(dir, 0);
      if (!rest.length) return { folder: dir, files: [...own] };
    }
    return { folder: null, files: [...own] };
  }

  firstRun() {
    const root = this.romsRoot();
    if (root !== this.folders.games) return;
    fs.mkdirSync(root, { recursive: true });
    const readme = path.join(root, "README.txt");
    if (!fs.existsSync(readme)) {
      const lines = Object.entries(this.cfg.systems).map(([n, s]) => `  ${(s.folder || n).padEnd(11)} ${n}  (${(s.exts || []).join(" ")})`);
      fs.writeFileSync(readme, ["Your games go here, one folder per system. The easiest way to add them is to drag",
        "the files onto the The Retro Shelf window: it sorts them into the right folder for you.", "",
        "The Retro Shelf doesn't come with any games. Use copies of games you own.", "", ...lines, ""].join(process.platform === "win32" ? "\r\n" : "\n"));
    }
    for (const s of Object.values(this.cfg.systems)) fs.mkdirSync(path.join(root, s.folder), { recursive: true });
  }

  /** quiet: not a change of play (the journal's own bookkeeping), so no journal is written for it */
  saveState(quiet) {
    if (!quiet) this.journalSoon();
    if (this.state === this._base) return jsave(this.files.state, this._base);
    // someone other than the first person: the computer's part goes to state.json, theirs to their own file
    for (const [k, v] of Object.entries(this.state)) if (!PERSONAL.includes(k)) this._base[k] = v;
    jsave(this.files.state, this._base);
    jsave(this.personFile(this.people.active), Object.fromEntries(PERSONAL.filter(k => this.state[k] !== undefined).map(k => [k, this.state[k]])));
  }

  // ---------------------------------------------------------------- play on more than one computer
  /** with saves in a cloud folder, play goes along too (sync.js): this computer's journal there, the others' read */
  syncOn() { return !!this.paths.saves_dir && !this.paths.oldSaves; }
  journalFile() {
    const p = this.people.list.find(x => x.id === this.people.active);
    return path.join(sync.journalDir(this.savesRoot(), p ? p.name : "player"), this.machine() + ".json");
  }
  /** written a moment after a change (a burst of changes is one write) */
  journalSoon() {
    if (!this.syncOn() || !this.people) return;
    clearTimeout(this._journalT);
    this._journalT = setTimeout(() => this.writeJournalNow(), 3000);
    if (this._journalT.unref) this._journalT.unref();
  }
  writeJournalNow() {
    clearTimeout(this._journalT); this._journalT = null;
    // a cloud folder that isn't there right now isn't made again here: games wait for it (launch) rather than starting
    // with no saves
    if (!this.syncOn() || !this.people || !fs.existsSync(this.savesRoot())) return false;
    try {
      const file = this.journalFile(), st = this.state;
      // another computer writing as this one: its app data was copied from here (a new computer, with the old one
      // still in use). This one takes a new name (splitMachine)
      if (st.journalLast) {
        let cur = null;
        try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        if (cur && cur.machine === this.machine() && cur.at > st.journalLast.at) return this.splitMachine();
      }
      const at = Math.floor(now()), j = sync.minus(sync.journal(st, this.keysKnown(), this.machine(), os.hostname(), at), st.journalBase);
      if (!sync.writeJournal(file, j)) return false;
      st.journalLast = { at, games: sync.totals(j) };
      this.saveState(true);
      return true;
    } catch { return false; }
  }
  /**
   * Two computers with one name (one's app data copied from the other): this one takes a new name. The journal they
   * shared is the other's from now on; what this one last wrote there (the play they have in common, from before the
   * copy) is taken off what it writes under its new name, and off what it reads in the other's, so it counts once
   */
  splitMachine() {
    const old = this.machine();
    const mark = st => {
      if (!st.journalLast) return;
      st.former = { ...(st.former || {}), [old]: st.journalLast };
      st.journalBase = { at: st.journalLast.at, games: sync.addTotals(st.journalBase && st.journalBase.games, st.journalLast.games) };
      delete st.journalLast;
    };
    mark(this.state); this.otherPeople(mark);
    this._base.machine = this.state.machine = crypto.randomBytes(8).toString("hex");
    this.saveState(true);
    this._remote = null;
    return this.writeJournalNow();
  }
  /** every game's key for other computers, by id: the games here now, and ones that were (on a drive that isn't plugged
      in, or deleted), so their play still counts there */
  keysKnown() {
    const known = this._base.gameKeys = this._base.gameKeys || {}, now = sync.keysFor(this.games.values());
    let added = false;
    for (const [id, k] of now) if (known[id] !== k) { known[id] = k; added = true; }
    if (added) { try { jsave(this.files.state, this._base); } catch {} }
    return new Map([...Object.entries(known), ...now]);
  }
  /**
   * What the other computers add for whoever's playing (cached a little while): play totals by game, sittings, and
   * which computers. What they set later than this one (a rating, progress) is taken into this one's state
   */
  remote(fresh) {
    if (!this.syncOn() || !this.people) return { add: new Map(), sessions: [], hosts: [] };
    const dir = path.dirname(this.journalFile());
    if (!fresh && this._remote && this._remote.dir === dir && Date.now() - this._remote.t < 20000) return this._remote.v;
    // a journal this computer used to share (see splitMachine): less what it had put there itself
    const former = this.state.former || {};
    const js = sync.readJournals(dir, this.machine()).map(x => former[x.j.machine] ? { ...x, j: sync.minus(structuredClone(x.j), former[x.j.machine]) } : x);
    const sig = this.journalSig(dir), v = sync.combine(js, sync.keysFor(this.games.values()));
    this._remote = { dir, t: Date.now(), v, sig: sig.sig };
    if (sync.adopt(this.state, v.set)) { this.saveState(); try { this.checkPins(); } catch {} }
    return v;
  }
  /** when another computer last wrote down its play (0 without a shared saves folder): the page shows the shelves again
      when it changes. A look at a folder of a few files, every second or two */
  farAt() {
    if (!this.syncOn() || !this.people) return 0;
    const { at, sig } = this.journalSig(path.dirname(this.journalFile()));
    // any change at all: a cloud drive keeps a file's own time, so one written before the last look can arrive after it
    if (this._remote && this._remote.sig !== sig) this._remote = null;
    return Math.floor(at);
  }
  /** the other computers' journals as they are now: the newest one's time, and every one's name, size and time */
  journalSig(dir) {
    const mine = this.machine() + ".json", parts = [];
    let at = 0;
    try {
      for (const n of fs.readdirSync(dir).sort()) {
        if (!n.endsWith(".json") || n === mine) continue;
        const st = fs.statSync(path.join(dir, n));
        at = Math.max(at, st.mtimeMs); parts.push(n + ":" + st.size + ":" + st.mtimeMs);
      }
    } catch {}
    return { at, sig: parts.join("|") };
  }
  /** every sitting, this computer's and the others' */
  allSessions() {
    const r = this.remote();
    return r.sessions.length ? [...this.state.sessions, ...r.sessions].sort((a, b) => a[1] - b[1]) : this.state.sessions;
  }
  /** the state with the other computers' play added: what pins and recaps count */
  withRemote() {
    const r = this.remote();
    if (!r.add.size && !r.sessions.length) return this.state;
    const st = this.state, plays = { ...st.plays }, time = { ...st.time }, last = { ...st.last };
    for (const [id, a] of r.add) { plays[id] = (plays[id] || 0) + a.plays; time[id] = (time[id] || 0) + a.time; last[id] = Math.max(last[id] || 0, a.last); }
    return { ...st, plays, time, last, sessions: this.allSessions() };
  }

  // ---------------------------------------------------------------- people
  /** who plays on this computer ({active, list: [{id, name}]}): just the first person until someone's added */
  loadPeople() {
    const p = jload(path.join(this.dirs.data, "people.json"), null) || {};
    const list = (Array.isArray(p.list) ? p.list : []).filter(x => x && /^p\d+$/.test(x.id) && typeof x.name === "string" && x.name.trim());
    if (!list.some(x => x.id === "p1")) list.unshift({ id: "p1", name: "Player 1" });
    this.people = { active: list.some(x => x.id === p.active) ? p.active : "p1", list };
  }
  savePeople() { jsave(path.join(this.dirs.data, "people.json"), this.people); }
  personFile(id) { return path.join(this.dirs.data, "people", id + ".json"); }
  /** the saves folder (the usual one, or one of your own), with everyone's saves: the first person's in it, others' in
      People/<their name>: by name, as other computers sharing the folder know them too, never by this computer's own
      numbering */
  savesRoot() { return this.paths.saves_dir || path.join(this.dirs.docs, "Saves"); }
  personFolder(id) {
    if (id === "p1") return this.savesRoot();
    const p = this.people && this.people.list.find(x => x.id === id);
    return path.join(this.savesRoot(), "People", sync.personKey(p ? p.name : id));
  }
  /** saves kept by this computer's numbering (People/p2, before 0.5.0-beta.4, or from a backup made then) go to the
      name's folder: moved whole, or file by file where a save is newer than the one there */
  peopleFolders() {
    for (const p of this.people.list) {
      if (p.id === "p1") continue;
      const old = path.join(this.savesRoot(), "People", p.id), to = this.personFolder(p.id);
      if (old === to || !fs.existsSync(old)) continue;
      try {
        if (!fs.existsSync(to)) { fs.renameSync(old, to); continue; }
        for (const rel of zip.filesIn(old)) {
          const a = path.join(old, ...rel.split("/")), b = path.join(to, ...rel.split("/"));
          let newer = true;
          try { newer = fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs; } catch {}
          if (!newer) continue;
          fs.mkdirSync(path.dirname(b), { recursive: true });
          fs.copyFileSync(a, b);
        }
      } catch {}
    }
  }
  applyFolders() { this.folders.saves = this.personFolder(this.people.active); this.folders.states = path.join(this.folders.saves, "States"); }
  /**
   * Where a console's saves and states go, in a person's saves folder (base). Consoles that share their emulator with
   * another (Master System, Game Gear and SG-1000 use Genesis's) keep theirs in a folder of their own, Consoles/<it>:
   * a Game Gear game and a Genesis game of the same name never share one save
   */
  saveDirs(system, base = this.folders.saves) {
    const s = this.cfg.systems[system] || {}, saves = s.ownSaves ? path.join(base, "Consoles", safe(s.folder || system)) : base;
    return { saves, states: path.join(saves, "States") };
  }
  /** once for each person: saves of consoles with a folder of their own (above) go there from the emulator's shared one.
      Moved, or copied where another console's game of the same name could be using it too */
  consoleSaves() {
    // (with the built-in emulators, whose folder names it knows)
    if (this.state.consoleSaves || !this.games.size || this.ownEmu() || !this.ra) return;
    const games = [...this.games.values()], base = this.saveDirs("", this.folders.saves);
    for (const g of games) {
      const s = this.cfg.systems[g.system] || {};
      if (!s.ownSaves) continue;
      this.resumeAt(g);
      const cn = s.core && this._coreNames && this._coreNames[s.core];
      if (!cn) continue;
      const stem = path.parse(g.path).name, sd = this.saveDirs(g.system);
      const shared = games.some(x => x !== g && x.system !== g.system && (this.cfg.systems[x.system] || {}).core === s.core && path.parse(x.path).name === stem);
      for (const [from, to] of [[path.join(base.saves, cn), path.join(sd.saves, cn)], [path.join(base.states, cn), path.join(sd.states, cn)]]) {
        let names = [];
        try { names = fs.readdirSync(from).filter(f => f.startsWith(stem + ".") && /^(\.[^.\s]+)+$/.test(f.slice(stem.length))); } catch {}
        for (const f of names) {
          const a = path.join(from, f), b = path.join(to, f);
          if (fs.existsSync(b)) continue;
          try { fs.mkdirSync(to, { recursive: true }); if (shared) fs.copyFileSync(a, b); else fs.renameSync(a, b); } catch {}
        }
      }
    }
    this.state.consoleSaves = 1;
    this.saveState(true);
  }
  /** the state as someone other than the first person has it: the computer's part and their own */
  personState(id) {
    const own = jload(this.personFile(id), {}), st = {};
    for (const [k, v] of Object.entries(this._base)) if (!PERSONAL.includes(k)) st[k] = v;
    for (const [k, v] of STATE_DEFAULTS) if (PERSONAL.includes(k)) st[k] = own[k] !== undefined ? own[k] : structuredClone(v);
    for (const k of PERSONAL) if (st[k] === undefined && own[k] !== undefined) st[k] = own[k];
    return st;
  }
  /** what changes for a game (its id moves, discs join a list) changes for everyone: fn gets each other person's own
      part, and it's saved */
  otherPeople(fn) {
    for (const p of this.people ? this.people.list : []) {
      if (p.id === this.people.active) continue;
      if (p.id === "p1") { fn(this._base); jsave(this.files.state, this._base); continue; }
      if (!fs.existsSync(this.personFile(p.id))) continue;
      const own = jload(this.personFile(p.id), {});
      fn(own);
      jsave(this.personFile(p.id), own);
    }
  }
  peopleJson() { return { active: this.people.active, list: this.people.list.map(p => ({ id: p.id, name: p.name })) }; }
  /** someone else plays now: their play, pins and saves */
  usePerson(id) {
    if (!this.people.list.some(p => p.id === id)) return [404, { error: "There's no one by that name here." }];
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "Close the game first." }];
    if (id === this.people.active) return [200, this.peopleJson()];
    // the one stopping: everything theirs saved, and in their own journal, before anything changes
    this.saveState();
    this.writeJournalNow();
    this.people.active = id;
    this.savePeople();
    this.state = id === "p1" ? this._base : this.personState(id);
    this.applyFolders();
    try { this.consoleSaves(); } catch {}
    this._remote = null;
    this.raPending = null; this.raFailed = false;
    this.newPins = [];
    try { this.checkPins(); } catch {}
    return [200, this.peopleJson()];
  }
  addPerson(name) {
    name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!name) return [400, { error: "Give them a name." }];
    if (this.people.list.length >= 8) return [400, { error: "That's as many people as one computer keeps (8)." }];
    if (this.people.list.some(p => sync.personKey(p.name) === sync.personKey(name))) return [409, { error: "There's someone with that name already." }];
    let n = 2;
    while (this.people.list.some(p => p.id === "p" + n) || fs.existsSync(this.personFile("p" + n))) n++;
    this.people.list.push({ id: "p" + n, name });
    this.savePeople();
    return [200, { ...this.peopleJson(), added: "p" + n }];
  }
  renamePerson(id, name) {
    const p = this.people.list.find(x => x.id === id);
    if (!p) return [404, { error: "There's no one by that name here." }];
    name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!name) return [400, { error: "Give them a name." }];
    if (this.people.list.some(x => x !== p && sync.personKey(x.name) === sync.personKey(name))) return [409, { error: "There's someone with that name already." }];
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "Close the game first." }];
    // this computer's journal of their play, and their saves folder (not the first person's: theirs is the saves folder
    // itself), go by the new name
    const moves = [[path.join(sync.journalDir(this.savesRoot(), p.name), this.machine() + ".json"), path.join(sync.journalDir(this.savesRoot(), name), this.machine() + ".json")]];
    if (id !== "p1") moves.push([this.personFolder(id), path.join(this.savesRoot(), "People", sync.personKey(name))]);
    for (const [a, b] of moves) {
      try { if (a !== b && fs.existsSync(a) && !fs.existsSync(b)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); } } catch {}
    }
    p.name = name;
    this.savePeople();
    if (this.people.active === id) { this.applyFolders(); this._remote = null; }
    return [200, this.peopleJson()];
  }
  /** someone who doesn't play here anymore: their play and saves go to the Trash (never deleted for good). The first
      person stays */
  async removePerson(id) {
    if (id === "p1") return [400, { error: "The first person stays: rename them instead." }];
    const i = this.people.list.findIndex(x => x.id === id);
    if (i < 0) return [404, { error: "There's no one by that name here." }];
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "Close the game first." }];
    if (this.people.active === id) this.usePerson("p1");
    // saves in a folder shared with other computers stay: the same person may play on those
    const shared = this.syncOn(), keep = shared && fs.existsSync(this.personFolder(id));
    for (const f of [this.personFile(id), ...(shared ? [] : [this.personFolder(id)])]) {
      if (!fs.existsSync(f)) continue;
      try { await this.trash(f); } catch (e) { return [500, { error: "Couldn't move their things to the Trash: " + e.message }]; }
    }
    // found again: someone else may have been taken off meanwhile
    const at = this.people.list.findIndex(x => x.id === id);
    if (at >= 0) this.people.list.splice(at, 1);
    this.savePeople();
    return [200, { ...this.peopleJson(), ...(keep ? { savesKept: true } : {}) }];
  }

  /** details for a bug report: versions, setup, BIOS, the last game's exit and RetroArch's log. Paths say ~ for home */
  report(version) {
    const ui = this.ui, by = {};
    for (const g of this.games.values()) by[g.system] = (by[g.system] || 0) + 1;
    let log = "";
    try { log = fs.readFileSync(this.files.raLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-60).join("\n"); } catch {}
    const arcade = path.join(this.romsRoot(), (this.cfg.systems.Arcade || {}).folder || "arcade");
    const text = [
      `The Retro Shelf ${version}`,
      `System: ${os.type()} ${os.release()}, ${process.platform} ${process.arch}, Electron ${process.versions.electron}`,
      `Emulator: ${this.ownEmu() ? "own RetroArch (" + (this.cfg.retroarch.exe || "not set") + ")" : "built-in RetroArch " + (this.ra ? this.ra.version : "missing")}`,
      `Settings: picture ${ui.picture}, fullscreen ${ui.fullscreen}, resume ${ui.resume}, covers ${ui.autoCovers}, shelf ${ui.shelf}`,
      `Games: ${this.games.size} (${Object.entries(by).map(([k, v]) => k + " " + v).join(", ") || "none"})`,
      `BIOS: ${biosStatus(this.folders.bios, arcade, this.cfg.systems).map(c => c.label + " " + c.state).join(", ")}`,
      `Last game exit: ${this.lastExit ? JSON.stringify(this.lastExit) : "none this session"}`,
      ...(this.setupError ? [`Setup problem: ${this.setupError}`] : []),
      "", "RetroArch log (last 60 lines):", log || "(empty)",
    ].join("\n");
    return text.split(os.homedir()).join("~");
  }
  saveSettings() { jsave(this.files.settings, { ui: this.ui, paths: this.paths }); }
  romsRoot() {
    const p = (this.paths.roms_dir || "").trim();
    if (!p) return this.folders.games;
    const x = p.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.isAbsolute(x) ? x : path.join(this.dirs.docs, x);
  }
  ownEmu() { return this.ui.ownEmu || !this.ra; }
  /** whether a console's games go to an emulator installed on its own (PCSX2) rather than a built-in one: when this
      build has no built-in one for it, with your own RetroArch (which won't have the built-in one's core), or when it's
      chosen in Settings and still installed (once it's gone, the built-in one plays them again) */
  standalone(system) {
    const s = this.cfg.systems[system] || {};
    if (!s.emulator) return false;
    const builtIn = s.core && this.ra && fs.existsSync(ra.corePath(this.ra.cores, s.core));
    return !builtIn || this.ownEmu() || (system === "PS2" && !!this.ui.pcsx2 && !!this.resolveApp(s.emulator[0]));
  }

  // ---------------------------------------------------------------- scanning
  findCover(rom, root, folder) {
    const stem = path.parse(rom).name;
    for (const d of [path.dirname(rom), path.join(root, "_covers", folder), path.join(this.files.covers, safe(folder))])
      for (const e of IMG) { const c = path.join(d, stem + e); if (fs.existsSync(c)) return c; }
    return null;
  }
  /** a game's logo (for its spine) or screenshot (for the back): "Game.logo.png" / "Game.snap.png" next to the
      game wins over a downloaded one */
  findExtra(rom, folder, kind) {
    const stem = path.parse(rom).name;
    for (const e of IMG) { const c = path.join(path.dirname(rom), `${stem}.${kind}${e}`); if (fs.existsSync(c)) return c; }
    const c = path.join(this.files.covers, safe(folder), ART[kind].sub, stem + ".png");
    return fs.existsSync(c) ? c : null;
  }
  findLogo(rom, folder) { return this.findExtra(rom, folder, "logo"); }

  /** year, publisher, developer, genre for a game, from data/meta (by its file name, as covers are matched) */
  metaFor(folder, look) {
    this._meta = this._meta || {};
    if (!this._meta[folder]) {
      const m = jload(path.join(this.dirs.app, "data", "meta", folder + ".json"), {}), byNorm = new Map();
      for (const k of Object.keys(m)) { const n = norm(k); if (!byNorm.has(n)) byNorm.set(n, []); byNorm.get(n).push(k); }
      this._meta[folder] = { m, byNorm };
    }
    const { m, byNorm } = this._meta[folder];
    // own entries only: a game file called "constructor" or "toString" isn't a lookup into the object itself
    if (Object.hasOwn(m, look)) return m[look];
    const c = byNorm.get(norm(look));
    return c ? m[pick(c, look)] : null;
  }

  /**
   * Multi-disc games without a disc list get one: "Final Fantasy VII (USA).m3u" next to its "(Disc 1)…(Disc 3)", so
   * they're one box, share one memory card, and the emulator can change discs. Returns the lists made now:
   * [{m3u, discs}]. A folder that can't be written to keeps its discs as they are.
   */
  makeDiscLists(dir) {
    const made = [], DISC = /\s*\((?:Disc|Disk|CD) ?(\d+)(?: of \d+)?\)/i, KINDS = [".chd", ".cue", ".gdi", ".cdi", ".iso", ".pbp"];
    // discs any list already has, wherever the list sits (one in a parent folder can list discs in a subfolder)
    const listed = new Set(), lists = (d, depth) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (hiddenEntry(e)) continue;
        if (e.isDirectory()) { if (depth < 8) lists(path.join(d, e.name), depth + 1); }
        else if (e.name.toLowerCase().endsWith(".m3u")) for (const f of sheetFiles(path.join(d, e.name))) listed.add(pathKey(f));
      }
    };
    lists(dir, 0);
    const walk = (d, depth) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      const groups = new Map();
      for (const e of ents) {
        if (hiddenEntry(e)) continue;
        if (e.isDirectory()) { if (depth < 8) walk(path.join(d, e.name), depth + 1); continue; }
        const ext = path.extname(e.name).toLowerCase(), m = DISC.exec(e.name);
        if (!e.isFile() || !KINDS.includes(ext) || !m || listed.has(pathKey(path.join(d, e.name)))) continue;
        const base = path.parse(e.name).name.replace(DISC, "").trim(), discs = groups.get(base) || groups.set(base, new Map()).get(base);
        // the same disc as both .chd and .cue: one is enough, the first kind in KINDS
        const cur = discs.get(+m[1]);
        if (!cur || KINDS.indexOf(ext) < KINDS.indexOf(cur.ext)) discs.set(+m[1], { name: e.name, ext });
      }
      for (const [base, discs] of groups) {
        if (discs.size < 2) continue;
        const m3u = path.join(d, base + ".m3u");
        if (fs.existsSync(m3u)) continue;
        const list = [...discs].sort((a, b) => a[0] - b[0]).map(([, x]) => x.name);
        try { fs.writeFileSync(m3u, list.join("\n") + "\n"); made.push({ m3u, discs: list.map(n => path.join(d, n)) }); } catch {}
      }
    };
    walk(dir, 0);
    return made;
  }
  /**
   * A new disc list takes over its discs' boxes: their play history goes to it (time and plays added up), and the
   * first disc's saves are copied to the list's name, which the emulator saves under from now on.
   */
  adoptDiscs(system, m3u, discs) {
    const to = gid(m3u), from = discs.map(gid);
    // everyone's play (st: whoever's playing now, or another person's own part, which has only theirs)
    const adopt = st => {
      for (const id of from) {
        if (id === from[0]) { this.moveStats(id, to, st); continue; }
        if (st.time) st.time[to] = (st.time[to] || 0) + (st.time[id] || 0);
        if (st.plays) st.plays[to] = (st.plays[to] || 0) + (st.plays[id] || 0);
        if (st.last && (st.last[id] || 0) > (st.last[to] || 0)) st.last[to] = st.last[id];
        for (const k of ["progress", "rating", "notes"]) if (st[k] && st[k][id] && !st[k][to]) st[k][to] = st[k][id];
        for (const k of ["time", "plays", "last", "names", "gameOpts", "cheats", "progress", "rating", "notes"]) if (st[k]) delete st[k][id];
        for (const k of ["fav", "hidden"]) { if (!st[k]) continue; const i = st[k].indexOf(id); if (i >= 0) { st[k].splice(i, 1); if (!st[k].includes(to)) st[k].push(to); } }
        for (const sh of st.shelves || []) { const i = sh.ids.indexOf(id); if (i >= 0) { sh.ids.splice(i, 1); if (!sh.ids.includes(to)) sh.ids.push(to); } }
        for (const ses of st.sessions || []) if (ses[0] === id) ses[0] = to;
      }
      for (const sh of st.shelves || []) sh.ids = [...new Set(sh.ids)];
      for (const k of ["fav", "hidden"]) if (st[k]) st[k] = [...new Set(st[k])];
    };
    adopt(this.state);
    this.otherPeople(adopt);
    const st = this.state;
    const core = this.cfg.systems[system].core;
    this.resumeAt({ system, path: discs[0] });          // looks up the emulator's name, which names its save folders
    const cn = core && this._coreNames && this._coreNames[core];
    if (cn) {
      const a = path.parse(discs[0]).name, b = path.parse(m3u).name;
      // everyone's saves for it
      for (const dir of this.people.list.flatMap(p => { const sd = this.saveDirs(system, this.personFolder(p.id)); return [path.join(sd.saves, cn), path.join(sd.states, cn)]; })) {
        let files = [];
        try { files = fs.readdirSync(dir); } catch {}
        for (const f of files) if (f.startsWith(a + ".")) {
          const dest = path.join(dir, b + f.slice(a.length));
          if (!fs.existsSync(dest)) try { fs.copyFileSync(path.join(dir, f), dest); } catch {}
        }
      }
    }
  }

  /** what the shelf knows about one game file: its title, region, year, maker, genre, and pictures */
  gameRecord(p, system, root) {
    const s = this.cfg.systems[system], folder = s.folder || system, stem = path.parse(p).name, id = gid(p);
    // arcade files are short codes ("sf2"); the full name is the title and what art is looked up by
    const names = s.names && this.names[s.names];
    let full = names && Object.hasOwn(names, stem.toLowerCase()) ? names[stem.toLowerCase()] : undefined, year = "", pub = "", dev = "", genre = "";
    if (Array.isArray(full)) [full, year, pub] = full;
    const look = full || stem;
    if (!full) { const md = this.metaFor(folder, look); if (md) [year, pub, dev, genre] = md; }
    let added = 0, size = 0;
    try { const st = fs.statSync(p); added = Math.floor((st.birthtimeMs || st.mtimeMs) / 1000); size = st.size; } catch {}
    return { id, title: cleanTitle(full ? full.split(" / ")[0] : stem), tag: regionTag(look), system, path: p, look, year, pub, dev, genre, added, size,
             cover: this.findCover(p, root, folder), logo: this.findLogo(p, folder), snap: this.findExtra(p, folder, "snap") };
  }

  // ---------------------------------------------------------------- watched folders
  /**
   * Folders whose games show on the shelves where they are, without being copied (paths.watch). Each is gone through
   * the way dropped files are (a file's console from its extension, or from what's in it), once, and again when
   * something in it changes. The console decided for a file is remembered (state.watchSys), so it isn't read twice.
   */
  watchedDirs() { return (this.paths.watch || []).filter(d => typeof d === "string" && fs.existsSync(d)); }
  watchedItems(dir) {
    this._watched = this._watched || new Map();
    let c = this._watched.get(dir);
    if (!c || c.dirty) {
      const hints = this.state.watchSys = this.state.watchSys || {};
      const { items } = this.importer.inspect([dir], hints);
      for (const it of items) if (it.system) hints[it.src] = it.system;
      c = { items: items.filter(it => it.system), unsure: items.filter(it => !it.system).map(it => ({ src: it.src, name: it.name, choices: it.choices })), dirty: false };
      this._watched.set(dir, c);
      this.watchDir(dir);
    }
    return c;
  }
  /** after files change in a folder (a watched one, or the games folder): look again, a moment after the last change */
  watchDir(dir) {
    // only the app itself watches (dirs.watch); tests and tools look once
    if (!this.dirs.watch) return;
    this._watchers = this._watchers || new Map();
    if (this._watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, (ev, name) => {
        if (name && /(^|[\\/])\.|\.(part|tmp)$/i.test(String(name))) return;
        const c = this._watched && this._watched.get(dir);
        if (c) c.dirty = true;
        clearTimeout(this._watchT);
        // while games are being added or moved, files arrive one at a time: a look halfway would make a disc list with
        // only the first discs. Adding and moving look again when they're done
        this._watchT = setTimeout(() => { if (this.imp.running || this.moving) return; try { this.scan(); this.emit("changed"); } catch {} }, 1500);
        if (this._watchT.unref) this._watchT.unref();
      });
      // watching doesn't keep the app (or a test) running on its own
      w.unref();
      w.on("error", () => {});
      this._watchers.set(dir, w);
    } catch {}
  }
  addWatch(dir) {
    dir = path.resolve(String(dir || ""));
    let st;
    try { st = fs.statSync(dir); } catch { return [404, { error: "That folder isn't there." }]; }
    if (!st.isDirectory()) return [400, { error: "Choose a folder." }];
    // compared where they really are: a folder reached another way (Macintosh HD in /Volumes, a link) is the same folder
    const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    const rdir = real(dir);
    if (rdir === real(os.homedir()) || path.dirname(rdir) === rdir) return [400, { error: "That's too big a folder to watch: choose the one your games are in." }];
    const root = real(this.romsRoot()), inside = (a, b) => within(real(a), real(b));
    if (inside(dir, root) || inside(root, dir)) return [400, { error: "That's the games folder, or part of it: its games are on the shelves already." }];
    const list = this.paths.watch || [];
    if (list.some(d => inside(dir, d) || inside(d, dir))) return [409, { error: "That folder, or one around it, is watched already." }];
    this.paths.watch = [...list, dir]; this.saveSettings();
    this.scan();
    this.event("watch");
    return [200, { ok: true, games: this.watchedItems(dir).items.length }];
  }
  /**
   * Folders to choose from with a controller, where the system's folder dialog needs a mouse: the places to start
   * (home, its usual folders, other drives), then one folder's own folders with how many games are right in each.
   */
  browse(dir) {
    const exts = new Set(Object.values(this.cfg.systems).flatMap(s => s.exts || []).map(e => e.toLowerCase()));
    const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return null; } };
    const home = os.homedir(), places = [];
    const add = (label, p) => { try { if (fs.statSync(p).isDirectory() && !places.some(x => x.path === p)) places.push({ label, path: p }); } catch {} };
    add("Home", home);
    for (const n of ["Desktop", "Documents", "Downloads"]) add(n, path.join(home, n));
    if (process.platform === "darwin") for (const v of ls("/Volumes") || []) add(v.name, path.join("/Volumes", v.name));
    else if (process.platform === "win32") for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") add(l + ":", l + ":\\");
    else {
      let user = ""; try { user = os.userInfo().username; } catch {}
      for (const base of [`/media/${user}`, `/run/media/${user}`, "/mnt"]) for (const v of ls(base) || []) if (v.isDirectory()) add(v.name, path.join(base, v.name));
    }
    if (!dir) return [200, { places }];
    dir = path.resolve(String(dir));
    const here = ls(dir);
    if (!here) return [404, { error: "That folder can't be opened." }];
    const games = list => (list || []).filter(e => e.isFile() && !hiddenEntry(e) && exts.has(path.extname(e.name).toLowerCase())).length;
    const folders = here.filter(e => e.isDirectory() && !hiddenEntry(e) && !/^\$|^System Volume Information$/i.test(e.name))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })).slice(0, 400);
    for (const f of folders) f.games = games(ls(f.path));
    return [200, { dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, games: games(here), folders, places }];
  }
  // ---------------------------------------------------------------- buttons
  /**
   * A console's buttons, changed: {physical: what the console gets}, both RetroPad numbers (B 0, Y 1, Select 2,
   * Start 3, the d-pad 4–7, A 8, X 9, L 10, R 11, L2 12, R2 13, L3 14, R3 15). Kept as swaps, so every button still
   * does something. An empty map puts them back.
   */
  setRemap(system, map) {
    if (!this.cfg.systems[system]) return [404, { error: "Unknown console." }];
    const m = {}, seen = new Set();
    for (const [k, v] of Object.entries(map && typeof map === "object" ? map : {})) {
      const a = Number(k), b = Number(v);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 15 || b < 0 || b > 15) return [400, { error: "Not a button." }];
      if (seen.has(b)) return [400, { error: "Two buttons can't do the same thing." }];
      seen.add(b);
      if (a !== b) m[a] = b;
    }
    if (Object.keys(m).length) this.state.remaps[system] = m; else delete this.state.remaps[system];
    this.saveState();
    return [200, { ok: true, map: m }];
  }
  /**
   * Before a game starts: its console's buttons as RetroArch's remap file for that game
   * (config/remaps/<emulator>/<game>.rmp), for players 1 to 4. A file of ours that's no longer wanted goes; one
   * made in RetroArch's own menu is left alone.
   */
  writeRemap(g) {
    const core = this.cfg.systems[g.system].core;
    this.resumeAt(g);
    const cn = core && this._coreNames && this._coreNames[core];
    if (!cn) return false;
    const file = path.join(path.dirname(this.files.raCfg), "config", "remaps", cn, path.parse(g.path).name + ".rmp");
    const m = this.state.remaps[g.system], ours = () => { try { return fs.readFileSync(file, "utf8").startsWith(REMAP_MARK); } catch { return false; } };
    if (!m || !Object.keys(m).length) { if (ours()) fs.rmSync(file, { force: true }); return false; }
    if (fs.existsSync(file) && !ours()) return false;
    let out = REMAP_MARK + "\n";
    for (let p = 1; p <= 4; p++) for (let j = 0; j < 16; j++) out += `input_player${p}_btn_${RETROPAD[j]} = "${m[j] ?? j}"\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out);
    return true;
  }

  // ---------------------------------------------------------------- saves in a folder of your own, and backups
  /**
   * Puts the saves in another folder (in iCloud Drive, Dropbox or OneDrive, to share them between computers): into
   * "The Retro Shelf Saves" there. Copied first, keeping whichever copy of a save is newer, then used from there; the
   * old copy stays where it was. dir "" goes back to the usual place.
   */
  async moveSaves(dir) {
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "Close the game first." }];
    if (/["\r\n]/.test(String(dir || ""))) return [400, { error: "RetroArch can't use a folder with quotation marks in its name. Choose or rename another." }];
    return this.busyWith("saves", () => this.moveSavesNow(dir));
  }
  async moveSavesNow(dir) {
    const to = dir ? path.join(path.resolve(String(dir)), "The Retro Shelf Saves") : path.join(this.dirs.docs, "Saves"), from = this.savesRoot();
    if (path.resolve(to) === path.resolve(from)) { if (!dir && this.paths.saves_dir) { this.paths.saves_dir = ""; delete this.paths.oldSaves; this.applyFolders(); this.saveSettings(); } return [200, { ok: true, copied: 0 }]; }
    if (within(to, from)) return [400, { error: "That's inside the saves folder already." }];
    let copied = 0, kept = 0;
    try {
      await fsp.mkdir(to, { recursive: true });
      for (const rel of fs.existsSync(from) ? zip.filesIn(from) : []) {
        const a = path.join(from, ...rel.split("/")), b = path.join(to, ...rel.split("/"));
        let there = null;
        try { there = fs.statSync(b); } catch {}
        if (there) {
          const sa = fs.statSync(a);
          if (sa.size === there.size && fs.readFileSync(a).equals(fs.readFileSync(b))) continue;
          // a different save there already. In a folder being joined it stays: another computer may be playing from it
          // (this computer's copy stays where it was). Back home, the newer one is kept and the other goes to the Trash
          if (dir || !(sa.mtimeMs > there.mtimeMs + 1000)) { kept++; continue; }
          try { await this.trash(b); } catch { kept++; continue; }
        }
        await fsp.mkdir(path.dirname(b), { recursive: true });
        await fsp.copyFile(a, b + ".part"); await fsp.rename(b + ".part", b);
        const st = fs.statSync(a); fs.utimesSync(b, st.atime, st.mtime);
        copied++;
      }
    } catch (e) { return [500, { error: "Couldn't copy the saves there: " + e.message }]; }
    this.paths.saves_dir = dir ? to : ""; delete this.paths.oldSaves;
    this.applyFolders();
    this.saveSettings();
    this._remote = null;
    this.writeJournalNow();
    if (dir) this.event("cloud");
    return [200, { ok: true, copied, kept, to }];
  }
  /** saves shared between computers: which one has a game open. A note in the saves folder, gone when the game closes */
  inPlayDir() { return this.syncOn() ? path.join(this.savesRoot(), ".in-play") : null; }
  /** this computer, for in-play notes: an id kept in its state (a Mac's network name can change from place to place) */
  machine() {
    if (!this.state.machine) { this.state.machine = crypto.randomBytes(8).toString("hex"); try { this.saveState(); } catch {} }
    return this.state.machine;
  }
  markInPlay(g, on) {
    const dir = this.inPlayDir(); if (!dir) return;
    const f = path.join(dir, this.machine() + ".json");
    try {
      if (on) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ host: os.hostname(), id: this.machine(), person: this.personSaves(), system: g.system, game: path.parse(g.path).name, since: Math.floor(now()) })); }
      else fs.rmSync(f, { force: true });
    } catch {}
  }
  /** whose saves are in use, as other computers know it: the saves folder's own, or a person's folder by name */
  personSaves() { return this.people.active === "p1" ? "" : path.basename(this.personFolder(this.people.active)); }
  inPlayElsewhere(g) {
    const dir = this.inPlayDir(); if (!dir) return null;
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { return null; }
    for (const f of files) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      // a computer that went off with the game open: its note counts for half a day
      // (and only someone playing from the same saves: each person's are their own; a note from before notes said
      // whose is anyone's)
      if ((m.id ? m.id !== this.machine() : m.host !== os.hostname()) && m.system === g.system && m.game === path.parse(g.path).name && now() - m.since < 12 * 3600
        && (m.person === undefined || m.person === this.personSaves())) return m;
    }
    return null;
  }
  /** a weekly backup is due: on, and a week since the last one */
  backupDue() { return !!this.ui.autoBackup && now() - (this.state.lastAutoBackup || 0) > 7 * 86400; }
  backupDir() { return this.paths.backup_dir && fs.existsSync(this.paths.backup_dir) ? this.paths.backup_dir : path.join(this.dirs.docs, "Backups"); }

  // ---------------------------------------------------------------- moving the games
  /**
   * Moves the games folder to another place (another drive): every file copied, and checked, into a "Games" folder
   * there; then used from there, with play history kept. The old copy stays until you decide (the app offers the
   * Trash). Progress is in status (moving: {done, total}).
   */
  async moveLibrary(dest) {
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "Close the game first." }];
    if (this.moving) return [409, { error: "The games are being moved already." }];
    // games being added go where the games folder was when they started: they'd be left behind
    if (this.imp.running) return [409, { error: "Games are being added. Move them when that's done." }];
    if (/["\r\n]/.test(String(dest || ""))) return [400, { error: "RetroArch can't use a folder with quotation marks in its name. Choose or rename another." }];
    return this.busyWith("library", () => this.moveLibraryNow(dest));
  }
  async moveLibraryNow(dest) {
    const from = path.resolve(this.romsRoot()), to = path.join(path.resolve(String(dest || "")), "Games");
    if (within(to, from)) return [400, { error: "That's inside the games folder." }];
    if (fs.existsSync(to) && fs.readdirSync(to).length) return [409, { error: "There's a Games folder there already, with things in it." }];
    // every file, a link to a game included (the shelf shows those): what it links to is copied
    const isFileLink = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    const listAll = () => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() || (e.isSymbolicLink() && isFileLink(p))) out.push([p, fs.statSync(p).size]); } }; walk(from); return out; };
    let files;
    try { files = listAll(); } catch (e) { return [500, { error: e.message }]; }
    const total = files.reduce((t, f) => t + f[1], 0);
    // room for them all, with a little to spare
    try { const fsInfo = fs.statfsSync(path.dirname(to)); if (fsInfo.bavail * fsInfo.bsize < total + 50 * 1048576) return [507, { error: `There isn't room there: the games need ${(total / 1073741824).toFixed(1)} GB.` }]; } catch {}
    const existed = fs.existsSync(to);
    // nothing else writes into the games folder until it's done (adding games, moving one, new art)
    this.moving = { done: 0, total, files: files.length };
    const copy = async ([p, size]) => {
      const q = path.join(to, path.relative(from, p));
      await fsp.mkdir(path.dirname(q), { recursive: true });
      await fsp.copyFile(p, q);
      if (fs.statSync(q).size !== size) throw new Error(`${path.basename(p)} didn't copy whole`);
    };
    try {
      for (const f of files) { await copy(f); this.moving.done += f[1]; }
      // anything that arrived or changed meanwhile comes too
      for (const f of listAll()) { const q = path.join(to, path.relative(from, f[0])); let st = null; try { st = fs.statSync(q); } catch {} if (!st || st.size !== f[1]) await copy(f); }
    } catch (e) {
      this.moving = null;
      // the half-made copy goes (only the copy: the games themselves never moved), so trying again works
      try { if (existed) for (const n of fs.readdirSync(to)) fs.rmSync(path.join(to, n), { recursive: true, force: true }); else fs.rmSync(to, { recursive: true, force: true }); } catch {}
      return [500, { error: "Couldn't move the games: " + e.message + ". Nothing changed: they're still where they were." }];
    }
    this.paths.roms_dir = to; this.saveSettings();
    this.moving = null;
    // the games are known by their path: look in the new place, then move their history over
    this.scan();
    this.remapIds(from);
    return [200, { ok: true, from, to, files: files.length }];
  }

  // ---------------------------------------------------------------- importing from RetroArch
  /** where a RetroArch installed on this computer keeps its playlists (not the one that comes with the app) */
  retroArchPlaylistDirs() {
    const home = os.homedir(), env = process.env, dirs = [];
    if (process.platform === "darwin") dirs.push(path.join(home, "Library", "Application Support", "RetroArch", "playlists"), path.join(home, "Documents", "RetroArch", "playlists"));
    else if (process.platform === "win32") dirs.push(path.join(env.APPDATA || "", "RetroArch", "playlists"), "C:\\RetroArch-Win64\\playlists", "C:\\RetroArch\\playlists");
    else dirs.push(path.join(home, ".config", "retroarch", "playlists"), path.join(home, ".var", "app", "org.libretro.RetroArch", "config", "retroarch", "playlists"));
    const own = this.cfg.retroarch && this.cfg.retroarch.exe;
    if (own) dirs.push(path.join(path.dirname(own), "playlists"));
    return [...new Set(dirs)].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  }
  /**
   * The games in those playlists that this app can show: [{path, system}]. A playlist names its console the way the
   * box art does ("Nintendo - Super Nintendo Entertainment System.lpl"), so no guessing. Games already in the games
   * folder are left out.
   */
  retroArchGames() {
    const bySys = new Map(), root = path.resolve(this.romsRoot()), out = new Map();
    for (const [name, s] of Object.entries(this.cfg.systems)) for (const t of asList(s.thumbs)) bySys.set(t.toLowerCase(), name);
    for (const dir of this.retroArchPlaylistDirs()) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".lpl")); } catch {}
      for (const f of files) {
        let list;
        try { list = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
        for (const it of (list && list.items) || []) {
          const p = String(it.path || "").split("#")[0], system = bySys.get(String(it.db_name || f).replace(/\.lpl$/i, "").toLowerCase());
          if (!p || !system || out.has(p) || !path.isAbsolute(p) || !fs.existsSync(p)) continue;
          if (within(p, root)) continue;
          out.set(p, system);
        }
      }
    }
    return [...out].map(([p, system]) => ({ path: p, system }));
  }
  /** brings them in: the folders they're in become watched folders, and each game goes on its playlist's console */
  importRetroArch() {
    const games = this.retroArchGames();
    if (!games.length) return [404, { error: "No RetroArch playlists with games were found on this computer." }];
    const hints = this.state.watchSys = this.state.watchSys || {};
    for (const g of games) hints[g.path] = g.system;
    // the fewest folders that hold them all
    const dirs = [...new Set(games.map(g => path.dirname(g.path)))].sort((a, b) => a.length - b.length), keep = [];
    for (const d of dirs) if (!keep.some(k => within(d, k))) keep.push(d);
    let added = 0;
    for (const d of keep) if (this.addWatch(d)[0] === 200) added++;
    this.saveState(); this.scan();
    return [200, { ok: true, games: games.length, folders: added }];
  }

  /** watched files whose console couldn't be told from what's in them: [{src, name, choices}] */
  watchUnsure() { return this.watchedDirs().flatMap(d => this.watchedItems(d).unsure); }
  /** your choice of console for one of them */
  assignWatched(src, system) {
    const it = this.watchUnsure().find(x => x.src === src);
    if (!it) return [404, { error: "That file isn't waiting for a console." }];
    if (!it.choices.includes(system)) return [400, { error: `${path.basename(src)} can't be a ${system} game.` }];
    (this.state.watchSys = this.state.watchSys || {})[src] = system;
    for (const c of this._watched.values()) c.dirty = true;
    this.saveState(); this.scan();
    return [200, { ok: true }];
  }
  removeWatch(dir) {
    const list = this.paths.watch || [];
    if (!list.includes(dir)) return [404, { error: "That folder isn't watched." }];
    this.paths.watch = list.filter(d => d !== dir); this.saveSettings();
    const w = this._watchers && this._watchers.get(dir); if (w) { try { w.close(); } catch {} this._watchers.delete(dir); }
    if (this._watched) this._watched.delete(dir);
    // the consoles remembered for its files go; play history stays, for if the folder comes back
    const hints = this.state.watchSys || {};
    for (const f of Object.keys(hints)) if (within(f, dir)) delete hints[f];
    this.saveState(); this.scan();
    return [200, { ok: true }];
  }

  scan() {
    const found = new Map(), root = this.romsRoot(), adopt = [];
    // the games folder watched, and a previous one (before it was changed or moved) not any more
    if (this._root && this._root !== root && this._watchers && !(this.paths.watch || []).includes(this._root)) {
      const w = this._watchers.get(this._root); if (w) { try { w.close(); } catch {} this._watchers.delete(this._root); }
    }
    this._root = root;
    this.watchDir(root);
    for (const [name, s] of Object.entries(this.cfg.systems)) {
      const exts = (s.exts || []).map(e => e.toLowerCase()), folder = s.folder || name;
      // disc lists made for a console whose emulator can play them (one it can't would hide its discs for nothing)
      if (s.discLists && exts.includes(".m3u")) for (const x of this.makeDiscLists(path.join(root, folder))) adopt.push([name, x]);
      // files a list on the shelf names show up once, as the list: discs in an .m3u, a .cue's .iso, wherever they sit
      // and however their names are written. A list this console can't show (an .m3u for Saturn) hides nothing
      const listed = new Set(), ids = [], sheets = [".m3u", ".cue", ".gdi"].filter(x => exts.includes(x));
      const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) if (e.isFile() && sheets.some(x => e.name.toLowerCase().endsWith(x)))
          for (const f of sheetFiles(path.join(dir, e.name))) listed.add(pathKey(f));
        for (const e of ents) {
          if (hiddenEntry(e)) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 8) walk(p, depth + 1); continue; }
          const lower = e.name.toLowerCase();
          if (!exts.some(x => lower.endsWith(x)) || biosDest(lower, this.cfg.systems)) continue;
          const g = this.gameRecord(p, name, root);
          ids.push(g.id); found.set(g.id, g);
        }
      };
      walk(path.join(root, folder), 0);
      for (const id of ids) if (listed.has(pathKey(found.get(id).path))) found.delete(id);
    }
    // games in watched folders, where they are
    for (const dir of this.watchedDirs()) for (const it of this.watchedItems(dir).items) {
      const id = gid(it.src);
      if (!found.has(id) && this.cfg.systems[it.system]) found.set(id, { ...this.gameRecord(it.src, it.system, root), watched: dir });
    }
    this.games = found;
    if (adopt.length) { for (const [system, x] of adopt) this.adoptDiscs(system, x.m3u, x.discs); this.saveState(); }
    try { this.consoleSaves(); } catch {}
  }

  // ---------------------------------------------------------------- launching
  resolveApp(cmd) {
    if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
    const w = which(cmd);
    if (w) return w;
    for (const c of (KNOWN_APPS[cmd] || {})[process.platform] || []) {
      const p = c.replace(/%([^%]+)%/g, (_, v) => process.env[v] || "");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  buildCmd(g, opts = {}) {
    const s = this.cfg.systems[g.system];
    if (this.standalone(g.system)) {
      // a function, so a path with "$$" or "$&" in it is put in as it is
      const args = s.emulator.map(a => a.replace("{rom}", () => g.path));
      const exe = this.resolveApp(args[0]);
      if (!exe) throw new Error(`${g.system} games need ${path.basename(args[0])}, which isn't included. Install it, then try again.`
        + (g.system === "PS2" ? " PS2 games also need a BIOS from your own console." : ""));
      return { cmd: [exe, ...args.slice(1)], builtIn: false };
    }
    if (!this.ownEmu()) {
      const core = ra.corePath(this.ra.cores, s.core);
      if (!fs.existsSync(core)) throw new Error(`There's no emulator for ${g.system} included yet.`);
      const sd = this.saveDirs(g.system), dirs = { saves: sd.saves, states: sd.states, screenshots: this.folders.screenshots, system: this.folders.bios, private: path.dirname(this.files.raCfg) };
      // RetroArch ignores (and falls back from) any directory setting that doesn't exist yet
      for (const d of ra.neededDirs(dirs)) fs.mkdirSync(d, { recursive: true });
      const slot = Number.isInteger(opts.slot) && opts.slot >= 0 && opts.slot <= 9 ? opts.slot : null;
      const play = this.playOpts(g);
      // RetroAchievements as whoever's playing: their own sign-in (the token RetroArch gave them), never the last person's
      const cv = this.state.cheevos;
      if (cv.user && !cv.token) {
        // signed in before tokens were kept for each person: the one in RetroArch's settings, when it's theirs
        try { if (ra.readConfigKey(this.files.raCfg, "cheevos_username") === cv.user) cv.token = ra.readConfigKey(this.files.raCfg, "cheevos_token") || undefined; } catch {}
      }
      const cheevos = this.raPending || (cv.user && cv.token ? { user: cv.user, token: cv.token } : null);
      // RetroArch's menu and messages in the app's language: the one chosen, or the computer's
      const loc = this.dirs.locale || "", lang = this.ui.lang && this.ui.lang !== "auto" ? this.ui.lang : /^zh-(hant|tw|hk|mo)/i.test(loc) ? "zh-Hant" : loc.slice(0, 2).toLowerCase();
      const triggers = play.freeTriggers ? ra.triggerProfiles(this.ra, dirs.private, play.ffTrigger === "toggle") : null;
      ra.writeConfig(this.files.raCfg, ra.enforced(this.ra, dirs, { ...play, cheats: !!opts.cheats, cheevos, discs: /\.m3u$/i.test(g.path), load: !(opts.fresh || slot !== null), pads: opts.pads, triggers, lang }));
      ra.linkSystemData(this.ra, this.folders.bios, s.core);
      // PS2: memory cards for each game, in the Saves folder (where the saves list and backups find them), not one
      // shared card in the BIOS folder; on a Mac, the renderer that's quick there (through Vulkan), until changed
      if (s.core === "pcsx2_libretro") ra.coreOptions(dirs.private, "LRPS2", { pcsx2_shared_memory_cards: "disabled" }, process.platform === "darwin" ? { pcsx2_renderer: "paraLLEl-GS" } : {});
      fs.mkdirSync(path.dirname(this.files.raLog), { recursive: true });
      fs.writeFileSync(this.files.raLog, "");
      const shader = { crt: this.ra.crt, lcd: this.ra.lcd }[play.picture], crt = shader && fs.existsSync(shader) ? ["--set-shader", shader] : [];
      return { cmd: [this.ra.exe, "-L", core, g.path, "--config", this.files.raCfg, "--log-file", this.files.raLog, "--verbose", ...crt, ...(slot !== null ? ["-e", String(slot)] : [])], builtIn: true };
    }
    const r = this.cfg.retroarch;
    const exe = r.exe && this.resolveApp(r.exe.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!exe) throw new Error("Couldn't find your RetroArch. Check the path in Settings → Emulator, or switch back to the built-in one.");
    const cores = (r.cores_dir || "").replace(/^~(?=$|[\\/])/, os.homedir());
    return { cmd: [exe, "-L", ra.corePath(cores, s.core), g.path, ...(r.args || ["-f"])], builtIn: false };
  }

  async launch(id, opts = {}) {
    const g = this.games.get(id);
    if (!g) return [404, { error: "Unknown game. Rescan the library." }];
    // a second press while the first is still starting (cheats can take a while) doesn't start a second emulator
    if ((this.running && this.running.alive) || this.launching) return [409, { error: "A game is already running." }];
    // the saves or games moving, or saves coming back from a backup: a game now would save where they were, or over them
    if (this.busy) return [409, { error: "Wait for the saves or games to finish moving, then play." }];
    // saves shared with another computer: playing a game that's open there too would overwrite its progress
    const there = this.inPlayElsewhere(g);
    if (there && !opts.force) return [409, { error: `This game is open on ${there.host} (since ${new Date(there.since * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}). Playing it here too can overwrite its progress.`, elsewhere: there.host }];
    this.launching = true;
    let r;
    try { return (r = await this.launchNow(g, id, opts)); } finally {
      this.launching = false;
      // a launch that didn't happen leaves no RetroAchievements password in RetroArch's settings
      if (!r || r[0] !== 200) { try { if (ra.readConfigKey(this.files.raCfg, "cheevos_password")) ra.writeConfig(this.files.raCfg, { cheevos_password: "" }); } catch {} }
    }
  }
  /** something long that no game may start during (the saves or games moving, a restore): fn's result */
  async busyWith(kind, fn) {
    if (this.busy) return [409, { error: "Wait for the saves or games to finish moving, then play." }];
    this.busy = kind;
    try { return await fn(); } finally { this.busy = null; }
  }
  async launchNow(g, id, opts) {
    // saves shared through a cloud folder that isn't there right now: playing would start from old saves, or none
    if (this.paths.saves_dir && !fs.existsSync(this.paths.saves_dir))
      return [409, { error: `Your saves folder isn't there right now (${this.paths.saves_dir}). Open iCloud Drive, Dropbox or OneDrive so it's back, then play.` }];
    let built;
    // chosen cheats, written for the built-in RetroArch to switch on as the game starts
    const cheats = !this.ownEmu() && !this.standalone(g.system) ? await this.writeCheats(g).catch(() => false) : false;
    if (!this.ownEmu() && !this.standalone(g.system)) try { this.writeRemap(g); } catch {}
    try { built = this.buildCmd(g, { ...opts, cheats }); } catch (e) { return [400, { error: e.message }]; }
    const [exe, ...args] = built.cmd;
    const cwd = path.isAbsolute(exe) && fs.existsSync(path.dirname(exe)) ? path.dirname(exe) : undefined;
    let proc;
    try {
      proc = spawn(exe, args, { cwd, stdio: ["pipe", "ignore", "ignore"], windowsHide: false });
      await new Promise((ok, bad) => { proc.once("spawn", ok); proc.once("error", bad); });
    } catch (e) {
      return [500, { error: `Couldn't start the emulator: ${e.message}` }];
    }
    proc.stdin.on("error", () => {});
    // t0: a clock that doesn't jump when the computer's time is changed, for how long it was played
    const rec = { id, since: now(), t0: performance.now(), proc, alive: true, builtIn: built.builtIn, stopping: false, lastBefore: this.state.last[id] || 0,
      cheevos: built.builtIn && this.raPending ? this.raPending : null };
    // RetroArch reads the password as it starts and keeps it in memory: it isn't left in the file while the game runs
    if (rec.cheevos) setTimeout(() => { try { ra.writeConfig(this.files.raCfg, { cheevos_password: "" }); } catch {} }, 5000).unref();
    // known as running, and watched for its end, before anything else can go wrong (a full disk, say)
    this.running = rec;
    proc.once("exit", (code, signal) => this.onExit(rec, { code, signal }));
    try {
      this.markInPlay(g, true);
      if (built.builtIn && this.playOpts(g).picture === "crt") this.event("crt");
      if (this.ui.tv) this.event("tv");
      this.state.last[id] = Math.floor(rec.since);
      this.state.plays[id] = (this.state.plays[id] || 0) + 1;
      this.saveState();
    } catch {}
    this.emit("launch", g);
    return [200, { ok: true, since: rec.since, now: now() }];
  }

  onExit(rec, how = {}) {
    rec.alive = false;
    if (this.running === rec) this.running = null;
    this.markInPlay(null, false);
    // never less than nothing, and no more than half a day: a game left open overnight isn't 20 hours of play
    const dt = Math.min(12 * 3600, Math.max(0, rec.t0 != null ? (performance.now() - rec.t0) / 1000 : now() - rec.since));
    rec.dt = dt;
    try {
      this.state.time[rec.id] = (this.state.time[rec.id] || 0) + Math.floor(dt);
      // a game that closed right away wasn't really played
      if (dt >= 10) {
        this.state.sessions.push([rec.id, Math.floor(rec.since), Math.floor(dt)]);
        if (this.state.sessions.length > 20000) this.state.sessions.splice(0, this.state.sessions.length - 20000);
      }
      try { this.checkPins(); } catch {}
      this.saveState();
    } catch {} finally {
      // whatever else failed, a password RetroArch was handed doesn't stay behind
      try { this.cheevosAfter(rec); } catch {}
      try { this.sortShots(rec); } catch {}
    }
    let error = "";
    if (dt < 4 && !rec.stopping) error = (rec.builtIn && ra.explain(this.files.raLog, how)) || "";
    // a game that didn't start (a missing BIOS, a broken file) wasn't played: its play and "last played" go back
    if (error) {
      try {
        if (this.state.plays[rec.id] > 0) this.state.plays[rec.id]--;
        if (rec.lastBefore) this.state.last[rec.id] = rec.lastBefore; else delete this.state.last[rec.id];
        this.saveState();
      } catch {}
    }
    this.lastExit = { id: rec.id, at: now(), dt, error, code: how.code ?? null, signal: how.signal || null };
    this.emit("exit", this.lastExit);
  }

  /** Ask the emulator to quit. Built-in RetroArch gets a QUIT command so it saves first. */
  stop() {
    const r = this.running;
    if (!r || !r.alive) return Promise.resolve();
    r.stopping = true;
    return new Promise(done => {
      r.proc.once("exit", done);
      if (r.builtIn) {
        try { r.proc.stdin.write("QUIT\n"); } catch {}
        setTimeout(() => { if (r.alive) r.proc.kill(); }, 5000);
      } else r.proc.kill();
      setTimeout(done, 7000);
    });
  }

  // ---------------------------------------------------------------- per-game changes
  /** stats belong to a game's id (its path); when the file moves they move with it */
  moveStats(from, to, st) {
    if (from === to) return;
    // everyone's: whoever's playing now, then the others' own parts
    if (!st) { this.moveStats(from, to, this.state); this.otherPeople(o => this.moveStats(from, to, o)); return; }
    // added to what the game already has there, never over it: plays and time add up, the latest play counts, and
    // its own name, settings and notes stay
    for (const k of ["last", "plays", "time", "names", "gameOpts", "cheats", "progress", "rating", "notes"]) {
      if (!st[k] || !(from in st[k])) continue;
      if (!(to in st[k])) st[k][to] = st[k][from];
      else if (k === "plays" || k === "time") st[k][to] += st[k][from];
      else if (k === "last") st[k][to] = Math.max(st[k][to], st[k][from]);
      delete st[k][from];
    }
    for (const k of ["fav", "hidden"]) { if (!st[k]) continue; const i = st[k].indexOf(from); if (i >= 0) { if (st[k].includes(to)) st[k].splice(i, 1); else st[k][i] = to; } }
    for (const sh of st.shelves || []) { const i = sh.ids.indexOf(from); if (i >= 0) { if (sh.ids.includes(to)) sh.ids.splice(i, 1); else sh.ids[i] = to; } }
    for (const ses of st.sessions || []) if (ses[0] === from) ses[0] = to;
    // when each choice was made (for other computers): the later one, under the new id
    for (const f of sync.FIELDS) {
      const a = st.edited && st.edited[f + ":" + from];
      if (a === undefined) continue;
      st.edited[f + ":" + to] = Math.max(a, st.edited[f + ":" + to] || 0);
      delete st.edited[f + ":" + from];
    }
    this._remote = null;
  }

  /**
   * Settings for one game, over the app's own when it starts (GAME_OPTS lists what can be set). A value of null or ""
   * goes back to the app's setting.
   */
  setGameOpts(id, opts) {
    if (!this.games.has(id)) return [404, { error: "Unknown game." }];
    const cur = { ...(this.state.gameOpts[id] || {}) };
    for (const [k, v] of Object.entries(opts && typeof opts === "object" ? opts : {})) {
      if (!(k in GAME_OPTS)) continue;
      if (v === null || v === "") delete cur[k];
      else if (GAME_OPTS[k].includes(v)) cur[k] = v;
      else return [400, { error: `"${v}" isn't a choice for ${k}.` }];
    }
    if (Object.keys(cur).length) this.state.gameOpts[id] = cur; else delete this.state.gameOpts[id];
    this.saveState();
    return [200, { ok: true, opts: cur }];
  }
  // ---------------------------------------------------------------- RetroAchievements
  /**
   * Signing in: the password stays in memory (never in a file of ours) until the next game, when RetroArch signs in
   * with it and keeps a token instead. After that game, cheevosAfter() checks for the token.
   */
  cheevosSignIn(user, pass) {
    user = String(user || "").trim(); pass = String(pass || "");
    if (!/^[A-Za-z0-9_]{2,32}$/.test(user)) return [400, { error: "That isn't a RetroAchievements user name." }];
    if (!pass || pass.length > 256) return [400, { error: "Type your password." }];
    // RetroArch's settings file can't hold quotation marks or line breaks in a value
    if (/["\x00-\x1f]/.test(pass)) return [400, { error: "RetroArch can't take a password with quotation marks in it. Sign in from RetroArch's own menu instead, or change the password on retroachievements.org." }];
    this.raPending = { user, pass }; this.raFailed = false;
    return [200, { ok: true }];
  }
  cheevosSignOut() {
    this.raPending = null; this.raFailed = false;
    delete this.state.cheevos.user; delete this.state.cheevos.token; this.saveState();
    if (fs.existsSync(this.files.raCfg)) ra.writeConfig(this.files.raCfg, { cheevos_enable: "false", cheevos_username: "", cheevos_password: "", cheevos_token: "" });
    return [200, { ok: true }];
  }
  /** after a game that was handed the password: signed in if RetroArch kept a token; the password left in its settings
      is wiped either way. A game that wasn't handed it (another emulator, your own RetroArch) leaves the sign-in waiting */
  cheevosAfter(rec) {
    try { if (ra.readConfigKey(this.files.raCfg, "cheevos_password")) ra.writeConfig(this.files.raCfg, { cheevos_password: "" }); } catch {}
    // signed in already: a token RetroArch renewed in that game is theirs to keep
    const cv = this.state.cheevos;
    // signed in from RetroArch's own menu in that game (what the app says to do for a password it can't pass on): kept
    if (!this.raPending && !cv.user && rec && rec.builtIn) {
      const u = ra.readConfigKey(this.files.raCfg, "cheevos_username"), t = ra.readConfigKey(this.files.raCfg, "cheevos_token");
      if (u && t && ra.readConfigKey(this.files.raCfg, "cheevos_enable") === "true") { cv.user = u; cv.token = t; this.saveState(); }
    }
    if (!this.raPending && cv.user && cv.token && ra.readConfigKey(this.files.raCfg, "cheevos_username") === cv.user) {
      const t = ra.readConfigKey(this.files.raCfg, "cheevos_token");
      if (t && t !== cv.token) { cv.token = t; this.saveState(); }
    }
    if (!this.raPending || !rec || rec.cheevos !== this.raPending) return;
    const user = this.raPending.user, token = ra.readConfigKey(this.files.raCfg, "cheevos_token");
    // a game that closed before RetroArch could sign in (it didn't start) says nothing about the password: it's tried
    // again with the next game
    if (!token && (rec.dt || 0) < 15) return;
    this.raPending = null;
    if (token) { this.state.cheevos.user = user; this.state.cheevos.token = token; this.raFailed = false; } else this.raFailed = true;
    try { ra.writeConfig(this.files.raCfg, { cheevos_password: "" }); } catch {}
    this.saveState();
  }

  // ---------------------------------------------------------------- cheats
  /** libretro's cheat collection: downloaded the first time it's wanted (37 MB), then its index kept in memory */
  async cheatIndex() {
    const file = path.join(this.dirs.data, "cheats.zip"), read = async f => new Map((await zip.entries(f)).map(e => [e.name, e]));
    if (this._cheats) return this._cheats;
    // a copy that isn't a zip (a Wi-Fi sign-in page saved in its place) is fetched again
    if (fs.existsSync(file)) { try { return (this._cheats = { file, entries: await read(file) }); } catch { fs.rmSync(file, { force: true }); } }
    if (!this._cheatGet) this._cheatGet = (async () => {
      const data = await this.fetchUrl("https://buildbot.libretro.com/assets/frontend/cheats.zip", 300000);
      fs.writeFileSync(file + ".part", data);
      try { await read(file + ".part"); } catch (e) { fs.rmSync(file + ".part", { force: true }); throw e; }
      fs.renameSync(file + ".part", file);
    })().finally(() => { this._cheatGet = null; });
    await this._cheatGet;
    return (this._cheats = { file, entries: await read(file) });
  }
  /** a game's cheats: [{key, desc, src, on}], from its files in the collection; key is "file#number" */
  async cheatList(id) {
    const g = this.games.get(id);
    if (!g) return [404, { error: "Unknown game." }];
    let idx;
    try { idx = await this.cheatIndex(); } catch { return [502, { error: "Couldn't get the cheat lists. Check your internet connection." }]; }
    const on = new Set(this.state.cheats[id] || []), out = [];
    for (const f of cheatFiles.gameFiles([...idx.entries.keys()], asList(this.cfg.systems[g.system].thumbs), path.parse(g.path).name, norm)) {
      const list = cheatFiles.parse((await zip.readEntry(idx.file, idx.entries.get(f.name))).toString("utf8"));
      list.forEach((c, i) => { const key = f.name + "#" + i; out.push({ key, desc: cheatFiles.unquote(c.get("desc")) || "Cheat " + (i + 1), src: f.label, on: on.has(key) }); });
    }
    return [200, { cheats: out }];
  }
  setCheats(id, keys) {
    if (!this.games.has(id)) return [404, { error: "Unknown game." }];
    const list = (Array.isArray(keys) ? keys : []).filter(k => typeof k === "string" && /^[^#]+\.cht#\d+$/i.test(k)).slice(0, 200);
    if (list.length) this.state.cheats[id] = list; else delete this.state.cheats[id];
    this.saveState();
    return [200, { ok: true, count: list.length }];
  }
  /**
   * Before a game starts: its chosen cheats go where RetroArch finds them (cheats/<emulator>/<game>.cht), switched
   * on; with none chosen that file goes. True when there are cheats to turn on.
   */
  async writeCheats(g) {
    const core = this.cfg.systems[g.system].core;
    this.resumeAt(g);                                    // looks up the emulator's name, which names its cheats folder
    const cn = core && this._coreNames && this._coreNames[core];
    if (!cn) return false;
    const target = path.join(path.dirname(this.files.raCfg), "cheats", cn, path.parse(g.path).name + ".cht");
    const keys = this.state.cheats[g.id] || [];
    let chosen = [];
    if (keys.length && !(this.ui.hardcore && this.state.cheevos.user)) {
      try {
        const idx = await this.cheatIndex(), byFile = new Map();
        for (const k of keys) { const i = k.lastIndexOf("#"), f = k.slice(0, i); if (idx.entries.has(f)) (byFile.get(f) || byFile.set(f, []).get(f)).push(+k.slice(i + 1)); }
        for (const [f, nums] of byFile) { const list = cheatFiles.parse((await zip.readEntry(idx.file, idx.entries.get(f))).toString("utf8")); for (const n of nums) if (list[n]) chosen.push(list[n]); }
      } catch { chosen = []; }
    }
    // the app's own file says so on its first line. One without it (made in RetroArch's menu, or from before the mark)
    // is never deleted: it's left as it is, or set aside as .cht.before-retro-shelf when cheats chosen here take its place
    let mine = true;
    try { mine = fs.readFileSync(target, "utf8").startsWith(CHEAT_MARK); } catch {}
    if (!chosen.length) { if (mine) fs.rmSync(target, { force: true }); return false; }
    if (!mine) { const aside = target + ".before-retro-shelf"; if (fs.existsSync(aside)) return false; fs.renameSync(target, aside); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, CHEAT_MARK + "\n" + cheatFiles.write(chosen));
    return true;
  }

  /**
   * What you've noted about a game: how far you are (backlog, playing, beaten, complete: 100%), a rating from 1 to 5,
   * and a short note. Each can be set alone; null or "" clears it.
   */
  setGameInfo(id, d) {
    if (!this.games.has(id)) return [404, { error: "Unknown game." }];
    const st = this.state, set = (k, v) => { if (v === null || v === "" || v === 0) delete st[k][id]; else st[k][id] = v; (st.edited = st.edited || {})[k + ":" + id] = Math.floor(now()); };
    if ("progress" in d) {
      if (d.progress && !PROGRESS.includes(d.progress)) return [400, { error: "Not a choice: " + d.progress }];
      set("progress", d.progress || null);
    }
    if ("rating" in d) {
      const r = d.rating === null ? 0 : Number(d.rating);
      if (!Number.isInteger(r) || r < 0 || r > 5) return [400, { error: "A rating goes from 1 to 5." }];
      set("rating", r);
    }
    if ("note" in d) set("notes", String(d.note || "").replace(/\s+/g, " ").trim().slice(0, 280));
    this.saveState();
    return [200, { ok: true }];
  }

  /** the settings a game plays with: the app's, then its own. "By console" pictures become that console's own */
  playOpts(g) {
    const o = { ...this.ui, ...(this.state.gameOpts[g.id] || {}) };
    const s = this.cfg.systems[g.system] || {};
    if (o.picture === "auto") o.picture = s.picture || "sharp";
    // a game's own fast-forward speed is kept as a word ("max" for as fast as it goes)
    if (typeof o.ffSpeed === "string") o.ffSpeed = o.ffSpeed === "max" ? 0 : parseInt(o.ffSpeed, 10);
    return { ...o, light: !!s.light, freeTriggers: !!s.freeTriggers };
  }

  /** shelves people make ("Couch co-op", "To finish"): create, rename, delete, and put games on them or take them off */
  shelfOp(d) {
    const st = this.state, op = String(d.op || ""), name = String(d.name || "").trim().slice(0, 40);
    const find = n => st.shelves.find(s => s.name.toLowerCase() === n.toLowerCase());
    if (op === "create") {
      if (!name) return [400, { error: "Give the shelf a name." }];
      if (find(name)) return [409, { error: "There's already a shelf called that." }];
      st.shelves.push({ name, ids: this.games.has(String(d.id || "")) ? [String(d.id)] : [] });
    } else {
      const sh = find(name);
      if (!sh) return [404, { error: "There's no shelf called that." }];
      if (op === "want" || op === "unwant") {
        const sys = String(d.system || ""), look = String(d.look || "").slice(0, 300);
        if (!this.cfg.systems[sys] || !look) return [400, { error: "Unknown game." }];
        sh.wanted = (sh.wanted || []).filter(([s2, l2]) => !(s2 === sys && l2 === look));
        if (op === "want") sh.wanted.push([sys, look]);
      } else if (op === "add" || op === "remove") {
        const id = String(d.id || "");
        sh.ids = sh.ids.filter(x => x !== id);
        if (op === "add" && this.games.has(id)) sh.ids.push(id);
      } else if (op === "rename") {
        const to = String(d.to || "").trim().slice(0, 40), other = find(to);
        if (!to) return [400, { error: "Give the shelf a name." }];
        if (other && other !== sh) return [409, { error: "There's already a shelf called that." }];
        sh.name = to;
      } else if (op === "delete") st.shelves = st.shelves.filter(s => s !== sh);
      else return [400, { error: "Unknown change." }];
    }
    this.saveState();
    this.checkPins();
    return [200, { shelves: st.shelves }];
  }

  rename(id, title) {
    if (!this.games.has(id)) return [404, { error: "Unknown game." }];
    const t = String(title || "").trim().slice(0, 200);
    if (t) this.state.names[id] = t; else delete this.state.names[id];
    this.saveState();
    if (t) this.event("rename");
    return [200, { ok: true }];
  }

  hide(id, hidden) {
    const h = this.state.hidden, i = h.indexOf(id);
    if (hidden && i < 0) h.push(id);
    if (!hidden && i >= 0) h.splice(i, 1);
    this.saveState();
    if (hidden) this.event("hide");
    return [200, { ok: true }];
  }

  /** use a picture of your own as a game's cover, logo or screenshot: saved next to the game, where it wins */
  async setArt(id, kind, src) {
    if (this.moving) return [409, { error: "The games are being moved. Try again when that's done." }];
    const g = this.games.get(id);
    if (!g || !["cover", "logo", "snap"].includes(kind)) return [404, { error: "Unknown game." }];
    const ext = path.extname(src).toLowerCase();
    if (!IMG.includes(ext)) return [400, { error: "Choose a PNG, JPEG or WebP picture." }];
    const stem = path.parse(g.path).name, dir = path.dirname(g.path), name = kind === "cover" ? stem : `${stem}.${kind}`;
    const dest = path.join(dir, name + ext), tmp = partFor(dest);
    try {
      // copied first: the picture chosen may be one of the ones it replaces. The ones it replaces may be someone's own
      // (a scan of their box): they go to the Trash, or failing that are renamed aside, never deleted
      fs.copyFileSync(src, tmp);
      for (const e of IMG) {
        const old = path.join(dir, name + e);
        if (!fs.existsSync(old)) continue;
        try { await this.trash(old); } catch { fs.renameSync(old, freeName(old + ".replaced")); }
      }
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return [500, { error: "Couldn't save the picture: " + e.message }];
    }
    g[kind] = dest;
    if (kind === "cover") this.event("cover");
    return [200, { ok: true }];
  }

  /** move a game to another console's folder (its disc files and pictures go with it) */
  moveTo(id, system) {
    const g = this.games.get(id), s = this.cfg.systems[system];
    if (!g || !s) return [404, { error: "Unknown game or system." }];
    if (this.moving) return [409, { error: "The games are being moved. Try again when that's done." }];
    if (this.launching || (this.running && this.running.alive && this.running.id === id)) return [409, { error: "Close the game first." }];
    // a game in a watched folder stays where it is in that folder: only which console it's for changes (its history
    // stays, as it's known by its path)
    if (g.watched) {
      this.state.watchSys = this.state.watchSys || {}; this.state.watchSys[g.path] = system;
      for (const c of (this._watched || new Map()).values()) c.dirty = true;
      this.saveState(); this.scan();
      return [200, { ok: true, id }];
    }
    const destDir = path.join(this.romsRoot(), s.folder || system), srcDir = path.dirname(g.path);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const { folder, files } = this.gameFiles(g);
      let newPath;
      if (folder) {
        // a game with a folder of its own takes the folder
        const to = path.join(destDir, path.basename(folder));
        if (fs.existsSync(to)) return [409, { error: "There's already a game with that name there." }];
        fs.renameSync(folder, to);
        newPath = path.join(to, path.relative(folder, g.path));
      } else {
        const moves = files.map(f => [f, path.join(destDir, path.relative(srcDir, f))]), done = [];
        if (moves.some(([, to]) => fs.existsSync(to))) return [409, { error: "There's already a game with that name there." }];
        try {
          for (const [from, to] of moves) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); done.push([from, to]); }
        } catch (e) {
          // one file that wouldn't move (another program has it open): the ones that did go back, so it stays whole
          for (const [from, to] of done.reverse()) { try { fs.renameSync(to, from); } catch {} }
          throw e;
        }
        newPath = path.join(destDir, path.basename(g.path));
      }
      this.moveStats(id, gid(newPath));
      this.saveState();
      this.scan();
      return [200, { ok: true, id: gid(newPath) }];
    } catch (e) {
      this.scan();
      return [500, { error: "Couldn't move it: " + e.message }];
    }
  }

  /**
   * Game Gear games used to sit with the Master System's; now they have a shelf of their own. Once, .gg files in the
   * Master System folder move to the Game Gear one (with pictures beside them), keeping their play history. Their
   * saves stay where they are: the same emulator saves under the same name.
   */
  moveGameGear() {
    const root = this.romsRoot(), sms = this.cfg.systems["Master System"], gg = this.cfg.systems["Game Gear"];
    if (!sms || !gg) return;
    const from = path.join(root, sms.folder || "Master System"), to = path.join(root, gg.folder || "Game Gear");
    const walk = (dir, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 8 && !hiddenEntry(e)) walk(p, depth + 1); continue; }
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".gg")) continue;
        const rel = path.relative(from, dir), destDir = path.join(to, rel), stem = path.parse(e.name).name, dest = path.join(destDir, e.name);
        if (fs.existsSync(dest)) continue;
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(p, dest);
          for (const f of ents) if (f.isFile() && ownPic(f.name, stem))
            try { fs.renameSync(path.join(dir, f.name), path.join(destDir, f.name)); } catch {}
          this.moveStats(gid(p), gid(dest));
        } catch {}
      }
    };
    walk(from, 0);
  }

  toggleFav(id) {
    const f = this.state.fav, i = f.indexOf(id);
    i >= 0 ? f.splice(i, 1) : f.push(id);
    (this.state.edited = this.state.edited || {})["fav:" + id] = Math.floor(now());
    this.saveState();
    this.checkPins();
    return [200, { fav: [...f] }];
  }

  // ---------------------------------------------------------------- covers
  coverBase() { return String(this.cfg.cover_base_url || "https://thumbnails.libretro.com").replace(/\/+$/, ""); }

  /** file names available for one system and kind of art. No logos for a system is fine; no box art is an error.
      Asked for many times at once (Collections' boxes), the list is still downloaded once */
  indexFor(thumb, kind) {
    const key = kind + "|" + thumb;
    if (this._idx.has(key)) return Promise.resolve(this._idx.get(key));
    this._idxWait = this._idxWait || new Map();
    if (!this._idxWait.has(key)) this._idxWait.set(key, this.loadIndex(thumb, kind, key).finally(() => this._idxWait.delete(key)));
    return this._idxWait.get(key);
  }
  async loadIndex(thumb, kind, key) {
    const cp = path.join(this.files.covers, ".index", safe(thumb) + (kind === "cover" ? "" : "." + kind) + ".json");
    let names = null;
    try { if (now() - fs.statSync(cp).mtimeMs / 1000 < 7 * 86400) names = jload(cp, null); } catch {}
    let src = "site";
    if (names && names.src) { src = names.src; names = names.names; }
    // a list kept from before "&amp;" was read as "&"
    if (Array.isArray(names) && names.some(n => typeof n === "string" && n.includes("&amp;"))) names = names.map(n => n.replace(/&amp;/g, "&"));
    if (!Array.isArray(names) || (!names.length && kind === "cover")) {
      let html = "";
      try { html = (await this.fetchUrl(`${this.coverBase()}/${encodeURIComponent(thumb)}/${ART[kind].dir}/`, 60000)).toString("utf8"); }
      catch (e) { if (kind === "cover" || !/HTTP 404/.test(e.message)) throw e; }
      const set = new Set();
      for (const m of html.matchAll(/href="([^"?#]+\.png)"/gi)) {
        // the page's links are HTML: "&amp;" in one is an "&" in the file's name
        try { set.add(decodeURIComponent(m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').split("/").pop())); } catch {}
      }
      names = [...set].sort();
      if (!names.length && kind === "cover") throw new Error("empty index");
      if (!names.length && kind === "logo") { names = await this.githubList(thumb, ART[kind].dir); src = "github"; }
      jsave(cp, { src, names });
    }
    const nm = new Map();
    for (const n of names) { const k = norm(path.parse(n).name); (nm.get(k) || nm.set(k, []).get(k)).push(n); }
    const idx = { names: new Set(names), nm, src };
    this._idx.set(key, idx);
    return idx;
  }

  /** file names in one folder of a libretro-thumbnails GitHub repo (two API calls; [] when unavailable) */
  async githubList(thumb, dir) {
    try {
      const root = JSON.parse((await this.fetchUrl(`${GITHUB_API}/${encodeURIComponent(repoOf(thumb))}/git/trees/master`, 30000)).toString("utf8"));
      const node = (root.tree || []).find(t => t.path === dir && t.type === "tree");
      if (!node) return [];
      const sub = JSON.parse((await this.fetchUrl(`${GITHUB_API}/${encodeURIComponent(repoOf(thumb))}/git/trees/${node.sha}`, 30000)).toString("utf8"));
      return (sub.tree || []).map(t => t.path).filter(n => n.toLowerCase().endsWith(".png")).sort();
    } catch { return []; }
  }

  /** A file from a GitHub repo. Regional duplicates there are symlinks, which come back as the target's name */
  async githubFile(thumb, dir, name, hops = 0) {
    const data = await this.fetchUrl(`${GITHUB_ART}/${encodeURIComponent(repoOf(thumb))}/master/${dir}/${encodeURIComponent(name)}`, 20000);
    if (data.subarray(0, 4).toString("latin1") === "\x89PNG") return data;
    const target = data.length < 400 ? data.toString("utf8").trim() : "";
    if (hops < 3 && /\.png$/i.test(target) && !target.includes("..")) return this.githubFile(thumb, dir, target.split("/").pop(), hops + 1);
    throw new Error("not an image");
  }

  /** the file in an index that best matches a game's name, or null */
  matchName(idx, look) {
    if (!idx) return null;
    // the thumbnail site writes &*/:`<>?\| as _ in its file names ("Sonic _ Knuckles" for "Sonic & Knuckles")
    const site = look.replace(/[&*/:`<>?\\|]/g, "_");
    for (const n of [look, site]) if (idx.names.has(n + ".png")) return n + ".png";
    const c = idx.nm.get(norm(look)) || idx.nm.get(norm(site));
    return c ? pick(c, look) : null;
  }

  saveArt(g, kind, data) {
    const s = this.cfg.systems[g.system], dest = path.join(this.files.covers, safe(s.folder || g.system), ART[kind].sub, path.parse(g.path).name + ".png");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + ".tmp", data);
    fs.renameSync(dest + ".tmp", dest);
    g[kind] = dest;
    // a rescan during a download replaces the library's game records; keep the current one up to date too
    const cur = this.games.get(g.id);
    if (cur && cur !== g) cur[kind] = dest;
  }

  // ---------------------------------------------------------------- choosing a cover by hand
  /** box art on the thumbnails site for the game's console whose name has every word of the search */
  async coverSearch(id, q) {
    const g = this.games.get(id);
    if (!g) return [404, { error: "Unknown game." }];
    const text = String(q || "").trim() || g.title;
    const words = text.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(w => w && !["the", "a", "an", "of"].includes(w));
    const want = norm(text), results = [];
    let err = "";
    for (const th of asList(this.cfg.systems[g.system].thumbs)) {
      let idx;
      try { idx = await this.indexFor(th, "cover"); } catch (e) { err = e.message; continue; }
      for (const name of idx.names) {
        const low = name.toLowerCase();
        if (!words.every(w => low.includes(w))) continue;
        const n = norm(path.parse(name).name);
        results.push({ thumb: th, name, score: (n === want ? 1000 : 0) + (n.startsWith(want) ? 200 : 0) - Math.abs(n.length - want.length) + (/\((usa|world)/i.test(name) ? 5 : 0) });
      }
    }
    if (!results.length && err) return [502, { error: "Couldn't load the list of covers. Check your internet connection." }];
    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return [200, { results: results.slice(0, 60).map(({ thumb, name }) => ({ thumb, name })) }];
  }

  /** one cover from the site's list, downloaded once: kept while the picker browses (.previews, cleared each launch) or
      for good (.ghosts, the boxes of games a collection is missing) */
  async coverFile(thumb, name, keep = ".previews") {
    const idx = this._idx.get("cover|" + thumb);
    if (!idx || !idx.names.has(name)) return null;
    const f = path.join(this.files.covers, keep, crypto.createHash("sha1").update(thumb + "/" + name).digest("hex") + ".png");
    if (!fs.existsSync(f)) {
      const data = await this.fetchUrl(`${this.coverBase()}/${encodeURIComponent(thumb)}/${ART.cover.dir}/${encodeURIComponent(name)}`, 20000);
      if (data.subarray(0, 4).toString("latin1") !== "\x89PNG") return null;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    }
    return f;
  }

  /** the box of a game you don't have, for a collection: found by name like any cover, shown faded */
  async ghostCover(system, look) {
    const s = this.cfg.systems[system];
    if (!s) return null;
    for (const th of asList(s.thumbs)) {
      let idx;
      try { idx = await this.indexFor(th, "cover"); } catch { continue; }
      const name = this.matchName(idx, look);
      if (name) { try { const f = await this.coverFile(th, name, ".ghosts"); if (f) return f; } catch {} }
    }
    return null;
  }

  // ---------------------------------------------------------------- collections
  /** the library's games by console and name, the way collections look them up */
  ownedIndex() {
    const idx = new Map();
    for (const g of this.games.values()) for (const n of [g.look, g.title, this.state.names[g.id]]) if (n) { const k = g.system + "|" + norm(n); if (!idx.has(k)) idx.set(k, g.id); }
    return idx;
  }
  /**
   * Series (from libretro-database's franchise lists) with at least one game in the library, every game marked with the
   * library's id when it's there; and the shelves people made, their own games plus the ones they want.
   */
  collections() {
    this.franchises = this.franchises || jload(path.join(this.dirs.app, "data", "franchises.json"), {});
    const own = this.ownedIndex(), item = ([system, look]) => ({ system, look, title: cleanTitle(look), id: own.get(system + "|" + norm(look)) || null });
    const series = [];
    for (const [name, games] of Object.entries(this.franchises)) {
      if (!games.some(([sys, look]) => own.has(sys + "|" + norm(look)))) continue;
      // a game marked as not counting (an odd regional release) stays in the series but out of finishing it
      const skip = new Set(this.state.notCounted[name] || []);
      const items = games.filter(([sys]) => this.cfg.systems[sys]).map(item).map(i => skip.has(i.system + "|" + norm(i.look)) ? { ...i, counts: false } : i);
      const counted = items.filter(i => i.counts !== false);
      series.push({ name, have: counted.filter(i => i.id).length, total: counted.length, items });
    }
    series.sort((a, b) => b.have - a.have || b.have / (b.total || 1) - a.have / (a.total || 1) || a.name.localeCompare(b.name));
    const mine = this.state.shelves.map(sh => {
      const ids = sh.ids.filter(id => this.games.has(id)), items = ids.map(id => { const g = this.games.get(id); return { system: g.system, look: g.look, title: this.state.names[id] || g.title, id }; });
      for (const w of sh.wanted || []) { const it = item(w); if (!it.id || !ids.includes(it.id)) items.push(it); }
      return { name: sh.name, have: items.filter(i => i.id).length, items };
    });
    return [200, { series, mine }];
  }
  /** a game in a series marked as counting or not toward having them all */
  setCounts(series, system, look, counts) {
    const games = (this.franchises || (this.collections(), this.franchises))[series];
    if (!games || !games.some(([s, l]) => s === system && l === look)) return [404, { error: "That game isn't in that series." }];
    const key = system + "|" + norm(look), list = new Set(this.state.notCounted[series] || []);
    if (counts) list.delete(key); else list.add(key);
    if (list.size) this.state.notCounted[series] = [...list]; else delete this.state.notCounted[series];
    this.saveState(); this.checkPins();
    return [200, { ok: true }];
  }
  // ---------------------------------------------------------------- recaps
  /**
   * A month (0-11) or, with month null, a whole year of play: time, sittings, days, games (and how many were new), the
   * most played, the longest sitting, the busiest day and the pins earned. Sittings count where they started, in the
   * computer's own days.
   */
  recap(year, month) {
    const from = new Date(year, month ?? 0, 1).getTime() / 1000, to = (month == null ? new Date(year + 1, 0, 1) : new Date(year, month + 1, 1)).getTime() / 1000;
    const all = this.allSessions(), firstOf = new Map();
    for (const [id, start] of all) if (!firstOf.has(id) || start < firstOf.get(id)) firstOf.set(id, start);
    const ses = all.filter(s => s[1] >= from && s[1] < to), perGame = new Map(), perDay = new Map();
    let total = 0, longest = null;
    for (const [id, start, dur] of ses) {
      total += dur; perGame.set(id, (perGame.get(id) || 0) + dur);
      const d = new Date(start * 1000), day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
      perDay.set(day, (perDay.get(day) || 0) + dur);
      if (this.games.has(id) && (!longest || dur > longest.time)) longest = { id, time: dur, at: start };
    }
    const busy = [...perDay].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return {
      year, month, from, to, total, sittings: ses.length, days: perDay.size, games: perGame.size,
      newGames: [...perGame.keys()].filter(id => firstOf.get(id) >= from).length,
      top: [...perGame].filter(([id]) => this.games.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, time]) => ({ id, time })),
      longest, busiest: busy ? { day: busy[0], time: busy[1] } : null,
      pins: Object.entries(this.state.pins || {}).filter(([, t]) => t >= from && t < to).sort((a, b) => a[1] - b[1]).map(([k]) => k),
      first: all.length ? all.reduce((m, s) => Math.min(m, s[1]), Infinity) : null,
    };
  }
  /** last month's recap the first time the app opens in a new month (January: the whole last year), if there was play */
  recapDue() {
    const d = new Date(now() * 1000), jan = d.getMonth() === 0;
    const year = jan ? d.getFullYear() - 1 : d.getFullYear(), month = jan ? null : d.getMonth() - 1;
    if (this.state.recapSeen === recapKey(year, month)) return null;
    const r = this.recap(year, month);
    return r.sittings ? r : null;
  }
  /** games in the metadata lists (every console's, ~38,000) whose names have all the words, for adding to a collection */
  gameSearch(q) {
    const words = String(q || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !["the", "a", "an", "of"].includes(w));
    if (!words.length) return [200, { results: [] }];
    const own = this.ownedIndex(), seen = new Map();
    for (const [system, s] of Object.entries(this.cfg.systems)) {
      if (s.names) continue;
      const folder = s.folder || system;
      this.metaFor(folder, "");
      for (const [look, md] of Object.entries(this._meta[folder].m)) {
        const low = look.toLowerCase();
        if (!words.every(w => low.includes(w))) continue;
        const k = system + "|" + norm(look), cur = seen.get(k), usa = /\bUSA\b/.test(look);
        if (!cur || (usa && !cur.usa)) seen.set(k, { system, look, title: cleanTitle(look), year: md[0] || "", id: own.get(k) || null, usa });
      }
    }
    const want = words.join("");
    const results = [...seen.values()].sort((a, b) => (norm(b.look) === want) - (norm(a.look) === want) || b.usa - a.usa || a.title.length - b.title.length || a.title.localeCompare(b.title));
    return [200, { results: results.slice(0, 40).map(({ usa, ...r }) => r) }];
  }

  async coverPick(id, thumb, name) {
    const g = this.games.get(id);
    if (!g) return [404, { error: "Unknown game." }];
    if (!asList(this.cfg.systems[g.system].thumbs).includes(thumb)) return [400, { error: "That cover is for another console." }];
    let f = null;
    try { f = await this.coverFile(thumb, String(name)); } catch { return [502, { error: "Couldn't download that cover. Check your internet connection." }]; }
    if (!f) return [404, { error: "That cover isn't available." }];
    // next to the game, like a picture of your own, so it wins over any image already there or in _covers; in the
    // app's covers folder when the games folder can't be written to
    if ((await this.setArt(id, "cover", f))[0] !== 200) { this.saveArt(g, "cover", fs.readFileSync(f)); this.event("cover"); }
    return [200, { ok: true }];
  }

  /** true = saved, false = no match, null = network trouble */
  async fetchArt(g, kind) {
    if (kind === "logo") return this.fetchLogo(g);
    let err = false;
    for (const th of asList(this.cfg.systems[g.system].thumbs)) {
      const key = kind + "|" + th;
      if (this._bad.has(key) || !this._idx.has(key)) { err = err || this._bad.has(key); continue; }
      const name = this.matchName(this._idx.get(key), g.look);
      if (!name) continue;
      let data;
      try { data = await this.fetchUrl(`${this.coverBase()}/${encodeURIComponent(th)}/${ART[kind].dir}/${encodeURIComponent(name)}`, 20000); } catch { err = true; continue; }
      if (data.subarray(0, 4).toString("latin1") !== "\x89PNG") continue;
      this.saveArt(g, kind, data);
      return true;
    }
    return err ? null : false;
  }

  /** Logos are named like box art. Try the logo the thumbnails site lists, then the box art's name, on the site and
      on GitHub (which has the logo folders the site doesn't mirror) */
  async fetchLogo(g) {
    let err = false;
    const tried = new Set();
    for (const th of asList(this.cfg.systems[g.system].thumbs)) {
      const li = this._idx.get("logo|" + th), names = [this.matchName(li, g.look), this.matchName(this._idx.get("cover|" + th), g.look)];
      for (const name of names) {
        if (!name) continue;
        const onSite = li && li.src === "site" && li.names.has(name);
        for (const where of [onSite ? "site" : null, "github"]) {
          // each thumbnail set is its own place to look (MAME's after FBNeo's, Game Boy Color's after Game Boy's)
          if (!where || tried.has(where + "|" + th + "|" + name)) continue;
          tried.add(where + "|" + th + "|" + name);
          let data;
          try {
            data = where === "site" ? await this.fetchUrl(`${this.coverBase()}/${encodeURIComponent(th)}/Named_Logos/${encodeURIComponent(name)}`, 20000)
                                    : await this.githubFile(th, "Named_Logos", name);
          } catch (e) { if (!/HTTP 404|not an image/.test(e.message)) err = true; continue; }
          if (data.subarray(0, 4).toString("latin1") !== "\x89PNG") continue;
          this.saveArt(g, "logo", data);
          return true;
        }
      }
    }
    return err ? null : false;
  }

  /** download missing box art and logos for these games, four at a time */
  coverJob(ids, force, queue) {
    if (this.cov.running) {
      // asked for while one is running (new games came in): runs after it
      if (queue) this._covNext = { ids: [...new Set([...(this._covNext ? this._covNext.ids : []), ...ids])], force: !!force || !!(this._covNext && this._covNext.force) };
      return false;
    }
    Object.assign(this.cov, { running: true, done: 0, total: 0, found: 0, error: "" });
    (async () => {
      const misses = {};
      try {
        for (const k of Object.keys(ART)) misses[k] = jload(path.join(this.files.covers, ART[k].misses), {});
        const todo = [];
        for (const i of ids) {
          const g = this.games.get(i);
          if (!g || !asList(this.cfg.systems[g.system].thumbs).length) continue;
          const kinds = Object.keys(ART).filter(k => !g[k] && (force || now() - (misses[k][i] || 0) >= 14 * 86400));
          if (kinds.length) todo.push({ g, kinds });
        }
        this.cov.total = todo.length;
        this._bad.clear();
        const thumbs = k => new Set(todo.filter(x => k === "cover" ? x.kinds.length : x.kinds.includes(k)).flatMap(x => asList(this.cfg.systems[x.g.system].thumbs)));
        for (const k of Object.keys(ART))
          for (const t of thumbs(k)) {
            try { await this.indexFor(t, k); } catch (e) { this._bad.set(k + "|" + t, e.message); }
          }
        const needCover = new Set(todo.filter(x => x.kinds.includes("cover")).flatMap(x => asList(this.cfg.systems[x.g.system].thumbs)));
        const bad = [...this._bad.keys()].filter(k => k.startsWith("cover|") && needCover.has(k.slice(6))).sort();
        if (bad.length) {
          const first = bad[0].slice(6);
          this.cov.error = `Couldn't load the cover list for ${first}` + (bad.length > 1 ? ` and ${bad.length - 1} more` : "")
            + ` (${this._bad.get(bad[0])}). Check your internet connection.`;
        }
        let next = 0;
        const worker = async () => {
          while (next < todo.length) {
            const { g, kinds } = todo[next++];
            let any = false;
            for (const k of kinds) {
              let r = null;
              try { r = await this.fetchArt(g, k); } catch {}
              if (r) { any = true; delete misses[k][g.id]; } else if (r === false) misses[k][g.id] = now();
            }
            this.cov.done++;
            if (any) this.cov.found++;
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        for (const k of Object.keys(ART)) jsave(path.join(this.files.covers, ART[k].misses), misses[k]);
      } catch (e) {
        this.cov.error = `Cover fetch failed: ${e.message}`;
      } finally {
        this.cov.running = false;
        const next = this._covNext; this._covNext = null;
        if (next) this.coverJob(next.ids, next.force);
      }
    })();
    return true;
  }

  // ---------------------------------------------------------------- importing
  importCheck(paths) {
    const { items, unknown, bios } = this.importer.inspect(Array.isArray(paths) ? paths : []);
    const biosAdded = [], biosFailed = [], biosKept = [];
    for (const b of bios) {
      const to = path.join(this.folders.bios, ...b.dest.split("/")), want = biosSize(b.name, this.cfg.systems);
      let size = -1;
      try { size = fs.statSync(b.src).size; } catch {}
      // empty, or not the size this BIOS is (a failed download, another file with the same name): not it
      if (size <= 0 || (want && size !== want)) { biosFailed.push(b.name); continue; }
      try {
        if (path.resolve(to) === path.resolve(b.src)) { biosAdded.push(b.name); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.existsSync(to)) {
          const cur = fs.statSync(to).size;
          if (cur === size && fs.readFileSync(to).equals(fs.readFileSync(b.src))) { biosAdded.push(b.name); continue; }
          // a different one there already that's good (the right size, or for a BIOS known by what's in it, one that
          // still looks like it) stays: another region's, say. One that isn't (cut short by a pulled USB stick) is set
          // aside as .old for the new one
          const good = want ? cur === want : !biosByContent(b.src, size, this.cfg.systems) || !!biosByContent(to, cur, this.cfg.systems);
          if (good) { biosKept.push(b.name); continue; }
          fs.renameSync(to, freeName(to + ".old"));
        }
        // whole or not at all: a copy cut short never sits there under the BIOS's name
        fs.copyFileSync(b.src, to + ".part"); fs.renameSync(to + ".part", to);
        biosAdded.push(b.name);
      } catch { biosFailed.push(b.name); }
    }
    this.pending = new Map(items.map(it => [it.id, it]));
    const root = this.romsRoot();
    return [200, {
      items: items.map(it => {
        // a game dropped from the games folder itself (or a copy already there) is there already
        let exists = within(it.src, root);
        if (!exists && it.system) { try { const d = this.importer.plan(it, root).main; exists = fs.existsSync(d); } catch {} }
        return { id: it.id, name: it.name, size: it.size, system: it.system, choices: it.choices, exists };
      }),
      unknown: unknown.slice(0, 50), unknownCount: unknown.length, biosAdded, biosFailed, biosKept,
    }];
  }

  importRun(picks) {
    if (this.imp.running) return [409, { error: "Already adding games." }];
    if (this.moving) return [409, { error: "The games are being moved. Add these when that's done." }];
    const items = [];
    for (const p of Array.isArray(picks) ? picks : []) {
      const it = this.pending.get(String(p.id));
      if (it && within(it.src, this.romsRoot())) continue;
      const sys = p.system ? String(p.system) : it && it.system;
      if (!it || !sys || !it.choices.includes(sys)) continue;
      items.push({ ...it, system: sys });
    }
    if (!items.length) return [200, { started: false }];
    Object.assign(this.imp, { running: true, done: 0, total: items.length, current: "", added: 0, already: 0, failed: 0, error: "", seq: this.imp.seq + 1 });
    (async () => {
      try {
        const r = await this.importer.copy(items, this.romsRoot(), p => Object.assign(this.imp, p));
        Object.assign(this.imp, r, { error: r.errors[0] || "" });
        this.scan();
        this.checkPins();
        if (this.ui.autoCovers) this.coverJob([...this.games.keys()], false, true);
      } catch (e) {
        this.imp.error = e.message;
      } finally {
        this.imp.running = false;
        this.pending.clear();
      }
    })();
    return [200, { started: true }];
  }

  // ---------------------------------------------------------------- settings / views
  exeOk() {
    const exe = this.cfg.retroarch.exe;
    return !!(exe && this.resolveApp(exe.replace(/^~(?=$|[\\/])/, os.homedir())));
  }
  coresOk() {
    const d = (this.cfg.retroarch.cores_dir || "").replace(/^~(?=$|[\\/])/, os.homedir());
    return !!d && fs.existsSync(d);
  }

  /** Find a separately installed RetroArch (for people who'd rather use their own). */
  autodetect() {
    const r = this.cfg.retroarch, home = os.homedir();
    if (!this.exeOk()) {
      const exes = [which("retroarch")].filter(Boolean);
      if (process.platform === "darwin") exes.push("/Applications/RetroArch.app/Contents/MacOS/RetroArch", path.join(home, "Applications/RetroArch.app/Contents/MacOS/RetroArch"));
      else if (process.platform === "win32")
        for (const b of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.APPDATA, process.env.LOCALAPPDATA, "C:\\"].filter(Boolean))
          exes.push(path.join(b, "RetroArch", "retroarch.exe"), path.join(b, "RetroArch-Win64", "retroarch.exe"));
      const e = exes.find(x => fs.existsSync(x));
      if (e) r.exe = e;
    }
    if (!this.coresOk()) {
      let c = [];
      if (process.platform === "darwin") c = [path.join(home, "Library/Application Support/RetroArch/cores"), "/Applications/RetroArch.app/Contents/Resources/cores"];
      else if (process.platform === "win32" && r.exe) c = [path.join(path.dirname(r.exe), "cores")];
      else c = [path.join(home, ".config/retroarch/cores"), "/usr/lib/libretro", "/usr/lib/x86_64-linux-gnu/libretro"];
      const d = c.find(x => fs.existsSync(x));
      if (d) r.cores_dir = d;
    }
    this.saveUserCfg();
  }
  saveUserCfg() {
    const user = jload(this.files.cfg, {});
    user.retroarch = this.cfg.retroarch;
    jsave(this.files.cfg, user);
  }

  settingsJson() {
    const r = this.cfg.retroarch, root = this.romsRoot();
    const systems = Object.values(this.cfg.systems).filter(s => s.core && this.ra && fs.existsSync(ra.corePath(this.ra.cores, s.core))).length;
    return { ui: this.ui, paths: {
      roms_dir: this.paths.roms_dir || root, exe: r.exe || "", cores_dir: r.cores_dir || "", args: (r.args || ["-f"]).join(" "),
      roms_ok: fs.existsSync(root), exe_ok: this.exeOk(), cores_ok: this.coresOk(),
      pcsx2: !!(this.cfg.systems.PS2 && this.cfg.systems.PS2.emulator && this.resolveApp(this.cfg.systems.PS2.emulator[0])),
      // the other computers sharing the saves folder, with when each last wrote down its play
      others: this.syncOn() ? this.remote().hosts : [],
      builtin: this.ra ? { version: this.ra.version, systems } : null, own: this.ownEmu(),
      folders: { games: root, saves: this.savesRoot(), bios: this.folders.bios },
      saves_dir: this.paths.saves_dir || "", backup_dir: this.backupDir(), last_backup: this.state.lastAutoBackup || 0,
      watch: this.watchedDirs().map(dir => { const c = this.watchedItems(dir); return { dir, games: c.items.length, unsure: c.unsure.length }; }),
    }, app: { version: this.dirs.version || "" },
    cheevos: { user: this.state.cheevos.user || "", pending: this.raPending ? this.raPending.user : "", failed: !!this.raFailed } };
  }

  applySettings(data) {
    if (data.ui && typeof data.ui === "object") {
      const before = this.ownEmu(), was = this.ui;
      this.ui = cleanUi({ ...this.ui, ...data.ui });
      this.saveSettings();
      if (this.ui.arrange !== "console") this.event("arrange");
      // firsts, for pins
      if (this.ui.wood !== was.wood || this.ui.wall !== was.wall) this.event("theme");
      if (this.ui.ffSpeed !== was.ffSpeed) this.event("ffspeed");
      if (this.ui.lang !== was.lang && this.ui.lang !== "auto") this.event("lang");
      if (before !== this.ownEmu() && this.ownEmu() && !this.exeOk()) this.autodetect();
    }
    const p = data.paths;
    if (p && typeof p === "object") {
      const r = this.cfg.retroarch, oldRoot = path.resolve(this.romsRoot());
      if ("roms_dir" in p) {
        const v = unquote(p.roms_dir);
        this.paths.roms_dir = !v || path.resolve(v) === this.folders.games ? "" : v;
        this.saveSettings();
      }
      if ("exe" in p) r.exe = unquote(p.exe);
      if ("cores_dir" in p) r.cores_dir = unquote(p.cores_dir);
      if ("args" in p) r.args = splitArgs(String(p.args));
      if ("exe" in p || "cores_dir" in p || "args" in p) this.saveUserCfg();
      this.scan();
      // a games folder moved by hand, or a drive back with another letter: games are known by their path, so their
      // history follows them by where they sit in the folder
      if (path.resolve(this.romsRoot()) !== oldRoot) this.remapIds(oldRoot);
    }
  }

  statusJson() {
    const r = this.running, live = !!(r && r.alive);
    return { running: live ? { id: r.id, since: r.since } : null, now: now(), covers: { ...this.cov },
             import: { ...this.imp }, exit: this.lastExit, newPins: this.newPins || [], moving: this.moving || null, far: this.farAt() };
  }

  artVer(p) {
    try { return p ? Math.floor(fs.statSync(p).mtimeMs / 1000) : 0; } catch { return 0; }
  }

  /** when the built-in RetroArch last saved this game's resume point, 0 if never */
  resumeAt(g) {
    if (this.ownEmu()) return 0;
    const core = this.cfg.systems[g.system].core;
    if (!core) return 0;
    if (!this._coreNames) this._coreNames = {};
    if (!(core in this._coreNames)) {
      // the name RetroArch gives its folders is the one built into the emulator: for a few it isn't the .info file's
      // (checked by asking each bundled emulator, retro_get_system_info)
      let name = BUILT_IN_NAMES[core] || "";
      if (!name) try { const m = /^corename\s*=\s*"(.*)"/m.exec(fs.readFileSync(path.join(this.ra.info, core + ".info"), "utf8")); if (m) name = m[1]; } catch {}
      this._coreNames[core] = name;
    }
    const cn = this._coreNames[core];
    if (!cn) return 0;
    try { return Math.floor(fs.statSync(path.join(this.saveDirs(g.system).states, cn, path.parse(g.path).name + ".state.auto")).mtimeMs / 1000); } catch { return 0; }
  }

  /** a game's saves: resume point and numbered slots, with when they were made and whether there's a picture */
  savesOf(g, dirCache) {
    if (this.ownEmu() || !this.ra) return null;
    const core = this.cfg.systems[g.system].core;
    if (!core) return null;
    this.resumeAt(g);                                  // looks up the core's name, which names its save folder
    const cn = this._coreNames[core];
    if (!cn) return null;
    const sdir = path.join(this.saveDirs(g.system).states, cn);
    if (!(sdir in dirCache)) {
      const files = new Map();
      try { for (const f of fs.readdirSync(sdir)) files.set(f, path.join(sdir, f)); } catch {}
      dirCache[sdir] = files;
    }
    const files = dirCache[sdir], stem = path.parse(g.path).name, at = f => { try { return Math.floor(fs.statSync(files.get(f)).mtimeMs / 1000); } catch { return 0; } };
    const out = { resume: 0, rpic: false, slots: [] };
    // what a launch can start from: no resume point with "pick up where you left off" off, and nothing but the start
    // with hardcore achievements (RetroArch won't load a save then)
    const hardcore = !!(this.ui.hardcore && this.state.cheevos.user), resume = this.playOpts(g).resume !== false;
    if (hardcore) return out;
    if (resume && files.has(stem + ".state.auto")) { out.resume = at(stem + ".state.auto"); out.rpic = files.has(stem + ".state.auto.png") && !this.blankPic(files.get(stem + ".state.auto.png")); }
    for (let n = 0; n <= 9; n++) {
      const f = stem + ".state" + (n || "");
      if (files.has(f)) out.slots.push({ n, at: at(f), pic: files.has(f + ".png") });
    }
    return out;
  }
  /** a picture that's all one color, near enough: a game left before it drew anything (the screen still black) */
  blankPic(file) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    // anything with something on it doesn't squeeze this small; only those are worth a look
    if (st.size > 4096) return false;
    this._blank = this._blank || new Map();
    const key = file + "|" + st.mtimeMs;
    if (!this._blank.has(key)) this._blank.set(key, flatPng(fs.readFileSync(file)));
    return this._blank.get(key);
  }
  /**
   * One game's saves, as files: its battery save (and whatever else its emulator keeps beside it), its resume point
   * and numbered saves, with their pictures. [{kind: battery|resume|slot, n, file, size, at, pic}], newest first
   * within each kind.
   */
  gameSaves(g) {
    this.resumeAt(g);                                    // looks up the emulator's name, which names its save folders
    const core = this.cfg.systems[g.system].core, cn = core && this._coreNames && this._coreNames[core];
    if (!cn) return [];
    const stem = path.parse(g.path).name, out = [];
    // this game's own: Name.srm, Name.state2.png — not "Name 3.srm", whose name only starts the same
    const list = dir => { try { return fs.readdirSync(dir).filter(f => f.startsWith(stem + ".") && /^(\.[^.\s]+)+$/.test(f.slice(stem.length))).map(f => path.join(dir, f)); } catch { return []; } };
    const info = f => { try { const st = fs.statSync(f); return { file: f, size: st.size, at: Math.floor(st.mtimeMs / 1000) }; } catch { return null; } };
    const sd = this.saveDirs(g.system);
    for (const f of list(path.join(sd.saves, cn))) { const i = info(f); if (i) out.push({ kind: "battery", n: null, ...i, pic: false }); }
    for (const f of list(path.join(sd.states, cn))) {
      const rest = f.slice(path.join(sd.states, cn, stem).length), m = /^\.state(\d?)(\.auto)?$/.exec(rest);
      if (!m) continue;
      const i = info(f); if (!i) continue;
      out.push({ kind: m[2] ? "resume" : "slot", n: m[2] ? null : +(m[1] || 0), ...i, pic: fs.existsSync(f + ".png") && !this.blankPic(f + ".png") });
    }
    return out.sort((a, b) => ["battery", "resume", "slot"].indexOf(a.kind) - ["battery", "resume", "slot"].indexOf(b.kind) || (a.n ?? 0) - (b.n ?? 0));
  }
  /** one of a game's save files to the Trash (with its picture): never deleted for good, so it can come back */
  async trashSave(id, file) {
    const g = this.games.get(id);
    if (!g) return [404, { error: "Unknown game." }];
    const s = this.gameSaves(g).find(x => x.file === file);
    if (!s) return [404, { error: "That isn't one of this game's saves." }];
    try {
      await this.trash(file);
      if (fs.existsSync(file + ".png")) await this.trash(file + ".png");
    } catch (e) { return [500, { error: "Couldn't move it to the Trash: " + e.message }]; }
    return [200, { ok: true }];
  }

  /** the picture RetroArch saved with a resume point ("auto") or slot */
  statePic(g, which) {
    const core = this.cfg.systems[g.system].core, cn = core && this._coreNames && this._coreNames[core];
    if (!cn) return null;
    const n = which === "auto" ? ".auto" : Number(which) > 0 ? String(Number(which)) : "";
    if (which !== "auto" && !/^\d$/.test(String(which))) return null;
    return path.join(this.saveDirs(g.system).states, cn, path.parse(g.path).name + ".state" + n + ".png");
  }

  // ---------------------------------------------------------------- your screenshots
  /** a console's screenshots: RetroArch names each after the game and when ("Game-251021-203015.png"), and after the
      game they're put in a folder for its console, so two consoles' games of the same name keep their own */
  shotDir(system) { return path.join(this.folders.screenshots, safe(system)); }
  /** the screenshots in a folder, by game (its file name without the extension, in lowercase), newest first. Read
      again only when the folder changes */
  shotsIn(dir, fresh) {
    this._shots = this._shots || new Map();
    if (fresh) this._shots.delete(dir);
    let mt = 0;
    try { mt = fs.statSync(dir).mtimeMs; } catch { this._shots.delete(dir); return new Map(); }
    // read again when the folder changes, and every half minute anyway (a USB stick's folder times can stay put, and
    // Windows' move in steps of about 15 ms)
    const c = this._shots.get(dir);
    if (c && c.mt === mt && Date.now() - c.t < 30000) return c.by;
    const by = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      const m = SHOT.exec(n);
      if (!m) continue;
      let at = 0;
      try { at = Math.floor(fs.statSync(path.join(dir, n)).mtimeMs / 1000); } catch { continue; }
      const k = m[1].toLowerCase();
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ file: path.join(dir, n), at });
    }
    for (const a of by.values()) a.sort((x, y) => y.at - x.at || (x.file < y.file ? 1 : -1));
    this._shots.set(dir, { mt, by, t: Date.now() });
    return by;
  }
  /** a game's screenshots, newest first: its console's folder, and older ones still loose in Screenshots when no other
      game here has its name (they could be from either) */
  shotsOf(g) {
    const k = path.parse(g.path).name.toLowerCase();
    if (this._stemsOf !== this.games || this._stemsN !== this.games.size) {
      this._stems = new Map(); this._stemsOf = this.games; this._stemsN = this.games.size;
      for (const x of this.games.values()) { const s = path.parse(x.path).name.toLowerCase(); this._stems.set(s, (this._stems.get(s) || 0) + 1); }
    }
    const loose = (this._stems.get(k) || 0) <= 1 ? this.shotsIn(this.folders.screenshots).get(k) || [] : [];
    return [...(this.shotsIn(this.shotDir(g.system)).get(k) || []), ...loose].sort((x, y) => y.at - x.at);
  }
  /** after a game: the screenshots taken in it go in its console's folder */
  sortShots(rec) {
    const g = this.games.get(rec.id);
    if (!g) return 0;
    const k = path.parse(g.path).name.toLowerCase(), dir = this.shotDir(g.system);
    let n = 0;
    for (const s of this.shotsIn(this.folders.screenshots, true).get(k) || []) {
      if (s.at < Math.floor(rec.since) - 5) continue;
      const to = path.join(dir, path.basename(s.file));
      try { if (fs.existsSync(to)) continue; fs.mkdirSync(dir, { recursive: true }); fs.renameSync(s.file, to); n++; } catch {}
    }
    if (n) { this._shots.delete(dir); this._shots.delete(this.folders.screenshots); }
    return n;
  }
  /** how many screenshots a game has, and when the newest was taken: it goes on the back of the box, unless a picture
      was chosen for it (Change Screenshot, kept next to the game) */
  shotsJson(g) {
    const a = this.shotsOf(g), chosen = g.snap && path.dirname(g.snap) === path.dirname(g.path);
    return a.length ? { shots: a.length, ...(chosen ? {} : { shv: a[0].at }) } : {};
  }
  /** take a screenshot of the game being played (built-in emulators: RetroArch takes it, as with F8) */
  takeShot() {
    const r = this.running;
    if (!r || !r.alive || !r.builtIn) return [409, { error: "No game is playing in a built-in emulator." }];
    try { r.proc.stdin.write("SCREENSHOT\n"); } catch (e) { return [500, { error: "Couldn't take a screenshot." }]; }
    this.event("screenshot");
    return [200, { ok: true }];
  }
  /** one of a game's screenshots to the Trash, never deleted for good */
  async trashShot(id, name) {
    const g = this.games.get(id), s = g && this.shotsOf(g).find(x => path.basename(x.file) === name);
    if (!s) return [404, { error: "That isn't one of this game's screenshots." }];
    try { await this.trash(s.file); } catch (e) { return [500, { error: "Couldn't move it to the Trash: " + e.message }]; }
    this._shots.delete(path.dirname(s.file));
    return [200, { ok: true }];
  }

  libraryJson() {
    // play on other computers too (with saves in a cloud folder)
    const far = this.remote().add, st = this.state, dirCache = {};
    return {
      games: [...this.games.values()].map(g => ({ id: g.id, title: g.title, tag: g.tag, system: g.system, cv: this.artVer(g.cover), lv: this.artVer(g.logo),
        plays: (st.plays[g.id] || 0) + ((far.get(g.id) || {}).plays || 0), time: (st.time[g.id] || 0) + ((far.get(g.id) || {}).time || 0), last: Math.max(st.last[g.id] || 0, (far.get(g.id) || {}).last || 0),
        added: g.added || 0, size: g.size || 0, file: path.basename(g.path), year: g.year || "", pub: g.pub || "", dev: g.dev || "", genre: g.genre || "", gg: pins.genreGroup(g.genre),
        sv: this.artVer(g.snap), saves: this.savesOf(g, dirCache), hidden: st.hidden.includes(g.id), named: !!st.names[g.id], opts: st.gameOpts[g.id] || null, cheats: (st.cheats[g.id] || []).length,
        progress: PROGRESS.includes(st.progress[g.id]) ? st.progress[g.id] : "", rating: Number.isInteger(st.rating[g.id]) && st.rating[g.id] >= 1 && st.rating[g.id] <= 5 ? st.rating[g.id] : 0,
        note: typeof st.notes[g.id] === "string" ? st.notes[g.id] : "",
        ...this.shotsJson(g), ...(st.names[g.id] ? { title: st.names[g.id] } : {}) })),
      fav: [...st.fav], systems: Object.keys(this.cfg.systems), gameChoices: GAME_CHOICES, people: this.peopleJson(),
      shelves: st.shelves.map(s => ({ name: s.name, ids: s.ids.filter(id => this.games.has(id)), wanted: s.wanted || [] })),
      // how each console's games look on the shelf: the kind of box, its short name, packaging and the color of its pile
      consoles: Object.fromEntries(Object.entries(this.cfg.systems).map(([k, v]) => [k, { media: v.media || "cart", abbr: v.abbr || "", look: v.look || null, pile: v.pile || null, light: !!v.light, freeTriggers: !!v.freeTriggers, builtin: !this.standalone(k), buttons: v.buttons || null, remap: st.remaps[k] || null }])),
      settings: this.settingsJson(), status: this.statusJson(),
    };
  }

  licenses() {
    const out = [];
    const dir = this.ra && this.ra.info;
    for (const [name, s] of Object.entries(this.cfg.systems)) {
      if (!s.core) continue;
      const info = {};
      try {
        for (const l of fs.readFileSync(path.join(dir, s.core + ".info"), "utf8").split(/\r?\n/)) {
          const m = /^(\w+)\s*=\s*"(.*)"/.exec(l);
          if (m) info[m[1]] = m[2];
        }
      } catch {}
      out.push({ system: name, core: s.core, name: info.corename || s.core, license: info.license || "", version: info.display_version || "", authors: (info.authors || "").replace(/\|/g, ", ") });
    }
    return { retroarch: this.ra ? this.ra.version : "", cores: out };
  }

  // ---------------------------------------------------------------- routes
  file(p, type, cache) {
    try { return { code: 200, body: fs.readFileSync(p), type, cache }; } catch { return { code: 404, body: { error: "not found" } }; }
  }

  async route(method, pathname, body) {
    if (method === "GET") {
      if (pathname === "/" || pathname === "/index.html") return this.file(path.join(this.dirs.app, "index.html"), "text/html; charset=utf-8");
      if (pathname === "/licenses.html") return this.file(path.join(this.dirs.app, "licenses.html"), "text/html; charset=utf-8");
      // the menu music and its list (src/music)
      const music = /^\/music\/([\w-]+)\.(ogg|wav|json)$/.exec(pathname);
      if (music) return this.file(path.join(this.dirs.app, "music", music[1] + "." + music[2]), { ogg: "audio/ogg", wav: "audio/wav", json: "application/json; charset=utf-8" }[music[2]], music[2] === "json" ? undefined : "public, max-age=31536000, immutable");
      const words = /^\/words\/(es|fr|de|it|pl|pt|ru|ja|ko|zh|zh-Hant)\.json$/.exec(pathname);
      if (words) return this.file(path.join(this.dirs.app, "words", words[1] + ".json"), "application/json; charset=utf-8");
      if (pathname === "/api/library") return { code: 200, body: this.libraryJson() };
      if (pathname === "/api/status") return { code: 200, body: this.statusJson() };
      if (pathname === "/api/people") return { code: 200, body: this.peopleJson() };
      if (pathname === "/api/sessions") return { code: 200, body: { sessions: this.allSessions(), now: now() } };
      if (pathname === "/api/collections") return { code: 200, body: this.collections()[1] };
      if (pathname === "/api/whatsnew") return { code: 200, body: { version: this.dirs.version, changes: this.whatsNew() } };
      if (pathname === "/api/pins") { const res = this.checkPins(); return { code: 200, body: { pins: pins.catalog(Object.keys(this.cfg.systems)), cats: pins.CATS, state: res, earned: this.state.pins } }; }
      if (pathname.startsWith("/ghost/")) {
        const rest = pathname.slice(7), i = rest.indexOf("/");
        let f = null;
        try { if (i > 0) f = await this.ghostCover(rest.slice(0, i), rest.slice(i + 1)); } catch {}
        if (f) return this.file(f, "image/png", "public, max-age=86400");
        return { code: 404, body: { error: "not found" } };
      }
      if (pathname === "/api/licenses") return { code: 200, body: this.licenses() };
      if (pathname.startsWith("/snap/")) {
        const g = this.games.get(pathname.slice(6));
        if (g && g.snap) return this.file(g.snap, MIME[path.extname(g.snap).toLowerCase()] || "image/png", "public, max-age=31536000, immutable");
      }
      const sh = /^\/shot\/([0-9a-f]{12})\/(\d{1,5})$/.exec(pathname);
      if (sh) {
        const g = this.games.get(sh[1]), f = g && this.shotsOf(g)[+sh[2]];
        if (f) return this.file(f.file, MIME[path.extname(f.file).toLowerCase()] || "image/png", "public, max-age=31536000, immutable");
      }
      const sp = /^\/state\/([0-9a-f]{12})\/(auto|\d)$/.exec(pathname);
      if (sp) {
        const g = this.games.get(sp[1]), f = g && this.statePic(g, sp[2]);
        if (f) return this.file(f, "image/png");
      }
      if (pathname.startsWith("/logo/")) {
        const g = this.games.get(pathname.slice(6));
        if (g && g.logo) return this.file(g.logo, "image/png", "public, max-age=31536000, immutable");
      }
      if (pathname.startsWith("/cover-preview/")) {
        const rest = pathname.slice(15), i = rest.indexOf("/");
        let f = null;
        try { if (i > 0) f = await this.coverFile(rest.slice(0, i), rest.slice(i + 1)); } catch {}
        if (f) return this.file(f, "image/png", "public, max-age=86400");
        return { code: 404, body: { error: "not found" } };
      }
      if (pathname.startsWith("/cover/")) {
        const g = this.games.get(pathname.slice(7));
        if (g && g.cover) return this.file(g.cover, MIME[path.extname(g.cover).toLowerCase()] || "image/png", "public, max-age=31536000, immutable");
      }
      const m = /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(pathname);
      if (m) return this.file(path.join(this.dirs.app, "fonts", m[1]), "font/woff2", "public, max-age=31536000, immutable");
      if (pathname === "/favicon.ico") return { code: 204, body: null };
      return { code: 404, body: { error: "not found" } };
    }
    if (method !== "POST") return { code: 405, body: { error: "method not allowed" } };
    const d = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const j = ([code, b]) => ({ code, body: b });
    switch (pathname) {
      case "/api/launch": return j(await this.launch(String(d.id || ""), { slot: d.slot, fresh: !!d.fresh, force: !!d.force, pads: Array.isArray(d.pads) ? d.pads : [] }));
      case "/api/game/rename": return j(this.rename(String(d.id || ""), d.title));
      case "/api/game/hide": return j(this.hide(String(d.id || ""), d.hidden !== false));
      case "/api/stop": await this.stop(); return j([200, { ok: true }]);
      case "/api/shot/take": return j(this.takeShot());
      case "/api/shots": { const g = this.games.get(String(d.id || "")); return j(g ? [200, { shots: this.shotsOf(g).map(x => ({ name: path.basename(x.file), at: x.at })) }] : [404, { error: "Unknown game." }]); }
      case "/api/shot/trash": return j(await this.trashShot(String(d.id || ""), String(d.name || "")));
      case "/api/fav": return j(this.toggleFav(String(d.id || "")));
      case "/api/shelves": return j(this.shelfOp(d));
      case "/api/games/search": return j(this.gameSearch(d.q));
      case "/api/game/opts": return j(this.setGameOpts(String(d.id || ""), d.opts));
      case "/api/game/info": return j(this.setGameInfo(String(d.id || ""), d));
      case "/api/remap": return j(this.setRemap(String(d.system || ""), d.map));
      case "/api/saves/list": { const g = this.games.get(String(d.id || "")); return j(g ? [200, { saves: this.gameSaves(g).map(({ file, ...x }) => ({ ...x, name: path.basename(file), file })) }] : [404, { error: "Unknown game." }]); }
      case "/api/saves/trash": return j(await this.trashSave(String(d.id || ""), String(d.file || "")));
      case "/api/retroarch/find": { const games = this.retroArchGames(); return j([200, { games: games.length, consoles: [...new Set(games.map(g => g.system))] }]); }
      case "/api/retroarch/import": return j(this.importRetroArch());
      case "/api/watch/add": return j(this.addWatch(String(d.dir || "")));
      case "/api/browse": return j(this.browse(d.dir ? String(d.dir) : ""));
      case "/api/watch/remove": return j(this.removeWatch(String(d.dir || "")));
      case "/api/watch/unsure": return j([200, { files: this.watchUnsure() }]);
      case "/api/watch/assign": return j(this.assignWatched(String(d.src || ""), String(d.system || "")));
      case "/api/cheats": return j(await this.cheatList(String(d.id || "")));
      case "/api/cheevos/signin": return j(this.cheevosSignIn(d.user, d.pass));
      case "/api/cheevos/signout": return j(this.cheevosSignOut());
      case "/api/cheats/set": return j(this.setCheats(String(d.id || ""), d.on));
      case "/api/recap": {
        const y = parseInt(d.year, 10), m = d.month === null || d.month === undefined ? null : parseInt(d.month, 10);
        if (!(y > 1970 && y < 3000) || (m !== null && !(m >= 0 && m <= 11))) return j([400, { error: "Choose a month or a year." }]);
        // looked at, for its pin (after: a recap doesn't list the pin it just earned)
        const r = this.recap(y, m);
        this.event("recap");
        return j([200, r]);
      }
      case "/api/recap/due": return j([200, { recap: this.recapDue() }]);
      case "/api/people/use": return j(this.usePerson(String(d.id || "")));
      // play from EmulationStation or LaunchBox (playimport.js): what would come in, then bringing it in
      case "/api/play-import": {
        const lists = await playImport.findLists((Array.isArray(d.paths) ? d.paths : []).map(String));
        // the lists as they are now (each one's size and time): what was read for the summary is used to bring it in,
        // unless something changed in between
        const key = JSON.stringify(lists.map(f => { try { const st = fs.statSync(f); return [f, st.size, st.mtimeMs]; } catch { return [f]; } })) + "|" + this.games.size + "|" + this.people.active;
        const c = this._importPlan, p = c && c.key === key && c.games === this.games && Date.now() - c.at < 600000 ? c.p : await playImport.plan(lists, [...this.games.values()]);
        this._importPlan = { key, games: this.games, at: Date.now(), p };
        const s = playImport.summary(p);
        if (!d.apply) return j([200, s]);
        this._importPlan = null;
        const n = playImport.apply(this.state, p);
        this.saveState();
        try { this.checkPins(); } catch {}
        return j([200, { ...s, added: n }]);
      }
      case "/api/people/add": return j(this.addPerson(d.name));
      case "/api/people/rename": return j(this.renamePerson(String(d.id || ""), d.name));
      case "/api/people/remove": return j(await this.removePerson(String(d.id || "")));
      case "/api/recap/seen": { const y = parseInt(d.year, 10), m = d.month === null || d.month === undefined ? null : parseInt(d.month, 10); this.state.recapSeen = recapKey(y, m); this.saveState(); return j([200, { ok: true }]); }
      case "/api/collections/count": return j(this.setCounts(String(d.series || ""), String(d.system || ""), String(d.look || ""), d.counts !== false));
      case "/api/whatsnew/seen": this.state.seenVersion = this.dirs.version; this.saveState(); return j([200, { ok: true }]);
      case "/api/pins/seen": { const seen = new Set(Array.isArray(d.keys) ? d.keys : []); this.newPins = (this.newPins || []).filter(k => !seen.has(k)); return j([200, { ok: true }]); }
      case "/api/rescan":
        this.scan();
        if (this.ui.autoCovers) this.coverJob([...this.games.keys()], false, true);
        return j([200, { count: this.games.size }]);
      case "/api/settings":
        this.applySettings(d);
        if (d.paths && this.ui.autoCovers) this.coverJob([...this.games.keys()], false, true);
        return j([200, this.settingsJson()]);
      case "/api/detect": this.autodetect(); return j([200, this.settingsJson()]);
      case "/api/covers/fetch": {
        let ids;
        if (d.id != null) {
          const g = this.games.get(String(d.id));
          if (!g) return j([404, { error: "Unknown game." }]);
          if (!asList(this.cfg.systems[g.system].thumbs).length)
            return j([200, { started: false, reason: "No cover source for this system. Add an image next to the game file instead." }]);
          ids = [g.id];
        } else ids = [...this.games.keys()];
        return j([200, { started: this.coverJob(ids, !!d.force) }]);
      }
      case "/api/import/check": return j(this.importCheck(d.paths));
      case "/api/covers/search": return j(await this.coverSearch(String(d.id || ""), d.q));
      case "/api/covers/pick": return j(await this.coverPick(String(d.id || ""), String(d.thumb || ""), String(d.name || "")));
      case "/api/bios": return j([200, { systems: biosStatus(this.folders.bios, path.join(this.romsRoot(), this.cfg.systems.Arcade ? this.cfg.systems.Arcade.folder || "arcade" : "arcade"), this.cfg.systems) }]);
      case "/api/import": return j(this.importRun(d.items));
    }
    return { code: 404, body: { error: "not found" } };
  }

  /** protocol.handle entry point: Request in, Response out. */
  async handle(req) {
    const url = new URL(req.url);
    let body = null;
    if (req.method === "POST") { try { body = JSON.parse((await req.text()) || "{}"); } catch { body = {}; } }
    let r;
    try { r = await this.route(req.method, decodeURIComponent(url.pathname), body); } catch (e) { r = { code: 500, body: { error: e.message } }; }
    const isBuf = Buffer.isBuffer(r.body);
    const headers = { "Content-Type": r.type || "application/json", "Cache-Control": r.cache || "no-store", "X-Content-Type-Options": "nosniff" };
    const payload = r.body === null ? null : isBuf ? r.body : JSON.stringify(r.body);
    return new Response(payload, { status: r.code, headers });
  }
}

/** true when a PNG (8-bit color, as RetroArch writes them) is one color all over, within a few shades */
function flatPng(b) {
  try {
    if (b.toString("latin1", 1, 4) !== "PNG") return false;
    let i = 8, w = 0, h = 0, bpp = 0;
    const idat = [];
    while (i + 8 <= b.length) {
      const n = b.readUInt32BE(i), t = b.toString("latin1", i + 4, i + 8), c = b.subarray(i + 8, i + 8 + n);
      if (t === "IHDR") { w = c.readUInt32BE(0); h = c.readUInt32BE(4); if (c[8] !== 8 || c[12]) return false; bpp = { 2: 3, 6: 4 }[c[9]]; if (!bpp) return false; }
      else if (t === "IDAT") idat.push(c);
      i += 12 + n;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)), row = w * bpp;
    if (raw.length < h * (row + 1)) return false;
    let prev = Buffer.alloc(row), lo = 255, hi = 0;
    for (let y = 0; y < h; y++) {
      const f = raw[y * (row + 1)], cur = Buffer.from(raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)));
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, up = prev[x], ul = x >= bpp ? prev[x - bpp] : 0;
        let v = cur[x];
        if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) { const p = a + up - ul, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
        cur[x] = v & 255;
        if (bpp === 3 || x % 4 !== 3) { if (cur[x] < lo) lo = cur[x]; if (cur[x] > hi) hi = cur[x]; if (hi - lo > 12) return false; }
      }
      prev = cur;
    }
    return true;
  } catch { return false; }
}

module.exports = { Backend, cleanTitle, regionTag, norm, pick, flatPng, GAME_CHOICES, within, jload, jsave };

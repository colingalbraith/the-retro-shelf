"use strict";
// The Retro Shelf's backend inside the app: library scan, emulator launch, cover art, settings and imports.
// index.html talks to it with fetch("/api/...") over the arcade:// protocol, so nothing listens on a network port.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const ra = require("./retroarch");
const { Importer, sheetFiles } = require("./importer");
const { biosDest, biosStatus } = require("./bios");
const pins = require("./pins");
const { compare, isTest } = require("./version");

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
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const DEFAULT_UI = { accent: "#e2582b", tint: true, spine: "cover", fx: "full", sound: true, card: 170, hints: false, autoCovers: true, hidden: [], shelf: "spines",
                     fullscreen: true, resume: true, ownEmu: false, welcomed: false, showHidden: false, updates: true, beta: false,
                     picture: "sharp", sort: "title", buttons: "auto", arrange: "console" };
const REGIONS = ["usa", "europe", "japan", "world", "germany", "france", "spain", "italy", "australia", "korea", "brazil", "china"];
// standalone emulators named in config.json, and where their installers usually put them
const KNOWN_APPS = {
  "pcsx2-qt": { darwin: ["/Applications/PCSX2.app/Contents/MacOS/PCSX2"], win32: ["%ProgramFiles%\\PCSX2\\pcsx2-qt.exe", "%LOCALAPPDATA%\\Programs\\PCSX2\\pcsx2-qt.exe"] },
  "dolphin-emu": { darwin: ["/Applications/Dolphin.app/Contents/MacOS/Dolphin"], win32: ["%ProgramFiles%\\Dolphin\\Dolphin.exe", "%ProgramFiles%\\Dolphin-x64\\Dolphin.exe"] },
};

// ---------------------------------------------------------------- storage
function jload(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
function jsave(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(obj, null, 2));
  fs.renameSync(p + ".tmp", p);
}
// what one game can have of its own (setGameOpts), and the choices for each
const GAME_OPTS = { picture: ["sharp", "smooth", "crt"] };

function cleanUi(d) {
  const out = { ...DEFAULT_UI, hidden: [] };
  if (!d || typeof d !== "object") return out;
  if (typeof d.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(d.accent)) out.accent = d.accent;
  if (["full", "reduced", "off"].includes(d.fx)) out.fx = d.fx;
  if (["spines", "covers"].includes(d.shelf)) out.shelf = d.shelf;
  if (["cover", "printed"].includes(d.spine)) out.spine = d.spine;
  if (["sharp", "smooth", "crt"].includes(d.picture)) out.picture = d.picture;
  if (["title", "year", "played"].includes(d.sort)) out.sort = d.sort;
  if (["auto", "xbox", "nintendo"].includes(d.buttons)) out.buttons = d.buttons;
  if (["console", "genre", "decade", "status"].includes(d.arrange)) out.arrange = d.arrange;
  if (Array.isArray(d.hiddenSeries)) out.hiddenSeries = d.hiddenSeries.map(String).slice(0, 1000);
  else if (["art", "color"].includes(d.spine)) out.spine = "cover";
  for (const k of ["sound", "hints", "autoCovers", "tint", "fullscreen", "resume", "ownEmu", "welcomed", "showHidden", "updates", "beta", "tv"]) if (typeof d[k] === "boolean") out[k] = d[k];
  if (typeof d.card === "number" && isFinite(d.card)) out.card = Math.max(110, Math.min(280, Math.round(d.card)));
  if (Array.isArray(d.hidden)) out.hidden = d.hidden.map(String).slice(0, 100);
  return out;
}
const safe = s => s.replace(/[\\/:*?"<>|]+/g, "_");
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
const pathKey = p => process.platform === "linux" ? path.resolve(p) : path.resolve(p).toLowerCase();
function gid(p) { return crypto.createHash("sha1").update(p).digest("hex").slice(0, 12); }
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
    this.state = jload(this.files.state, {});
    // names: titles people gave games; hidden: games taken off the shelves; shelves: ones people made ({name, ids})
    // sessions: each time a game was played, as [id, started (unix seconds), seconds played], oldest first
    for (const [k, v] of [["fav", []], ["last", {}], ["plays", {}], ["time", {}], ["names", {}], ["hidden", []], ["shelves", []], ["sessions", []], ["events", {}], ["gameOpts", {}]]) if (!this.state[k]) this.state[k] = v;
    const st = jload(this.files.settings, {});
    this.ui = cleanUi(st.ui);
    this.paths = { roms_dir: "", ...(st.paths || {}) };
    this.ra = ra.bundled(this.dirs.emu);
    this.names = { arcade: jload(path.join(this.dirs.app, "data", "arcade-names.json"), {}) };
    this.importer = new Importer(this.cfg.systems);
    // a Documents folder the app may not write to (Windows' Controlled folder access, a declined macOS prompt)
    // shouldn't stop it from opening: it says so instead
    this.setupError = "";
    try { this.firstRun(); } catch (e) { this.setupError = e.message; }
    fs.rmSync(path.join(this.files.covers, ".previews"), { recursive: true, force: true });
    this.scan();
    this.checkPins();
    // a new install starts with the welcome card, not a list of changes it never had
    if (!this.state.seenVersion && !this.ui.welcomed) { this.state.seenVersion = this.dirs.version; this.saveState(); }
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
    const res = pins.evaluate(pins.context([...this.games.values()], st, series, pins.genreGroup, { bios, now: now() }), Object.keys(this.cfg.systems));
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
      if (own.has(r) || !fs.existsSync(r) || path.relative(dir, r).startsWith("..")) return;
      own.add(r);
      if (SHEETS.includes(path.extname(r).toLowerCase())) for (const x of sheetFiles(r)) add(x);
    };
    add(g.path);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(stem + ".") && IMG.includes(path.extname(f).toLowerCase())) own.add(path.resolve(dir, f));
    const sysDir = path.join(this.romsRoot(), this.cfg.systems[g.system].folder || g.system);
    if (path.resolve(dir) !== path.resolve(sysDir) && !path.relative(sysDir, dir).startsWith("..")) {
      const rest = [], walk = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || /^(desktop\.ini|thumbs\.db)$/i.test(e.name)) continue;
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

  saveState() { jsave(this.files.state, this.state); }

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
    if (m[look]) return m[look];
    const c = byNorm.get(norm(look));
    return c ? m[pick(c, look)] : null;
  }

  scan() {
    const found = new Map(), root = this.romsRoot();
    for (const [name, s] of Object.entries(this.cfg.systems)) {
      const exts = (s.exts || []).map(e => e.toLowerCase()), folder = s.folder || name;
      // discs listed in an .m3u show up once, as the .m3u, wherever they sit and however their names are written
      const listed = new Set(), ids = [];
      const walk = (dir, depth) => {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) if (e.isFile() && e.name.toLowerCase().endsWith(".m3u"))
          for (const f of sheetFiles(path.join(dir, e.name))) listed.add(pathKey(f));
        for (const e of ents) {
          if (e.name.startsWith(".")) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 8) walk(p, depth + 1); continue; }
          const lower = e.name.toLowerCase();
          if (!exts.some(x => lower.endsWith(x)) || biosDest(lower, this.cfg.systems)) continue;
          const stem = path.parse(e.name).name, id = gid(p);
          // arcade files are short codes ("sf2"); the full name is the title and what art is looked up by
          let full = s.names && (this.names[s.names] || {})[stem.toLowerCase()], year = "", pub = "", dev = "", genre = "";
          if (Array.isArray(full)) [full, year, pub] = full;
          const look = full || stem;
          if (!full) { const md = this.metaFor(folder, look); if (md) [year, pub, dev, genre] = md; }
          let added = 0, size = 0;
          try { const st = fs.statSync(p); added = Math.floor((st.birthtimeMs || st.mtimeMs) / 1000); size = st.size; } catch {}
          ids.push(id);
          found.set(id, { id, title: cleanTitle(full ? full.split(" / ")[0] : stem), tag: regionTag(look), system: name, path: p, look, year, pub, dev, genre, added, size,
                          cover: this.findCover(p, root, folder), logo: this.findLogo(p, folder), snap: this.findExtra(p, folder, "snap") });
        }
      };
      walk(path.join(root, folder), 0);
      for (const id of ids) if (listed.has(pathKey(found.get(id).path))) found.delete(id);
    }
    this.games = found;
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
    if (s.emulator) {
      const args = s.emulator.map(a => a.replace("{rom}", g.path));
      const exe = this.resolveApp(args[0]);
      if (!exe) throw new Error(`${g.system} games need ${path.basename(args[0])}, which isn't included. Install it, then try again.`
        + (g.system === "PS2" ? " PS2 games also need a BIOS from your own console." : ""));
      return { cmd: [exe, ...args.slice(1)], builtIn: false };
    }
    if (!this.ownEmu()) {
      const core = ra.corePath(this.ra.cores, s.core);
      if (!fs.existsSync(core)) throw new Error(`There's no emulator for ${g.system} included yet.`);
      const dirs = { saves: this.folders.saves, states: this.folders.states, screenshots: this.folders.screenshots, system: this.folders.bios, private: path.dirname(this.files.raCfg) };
      // RetroArch ignores (and falls back from) any directory setting that doesn't exist yet
      for (const d of ra.neededDirs(dirs)) fs.mkdirSync(d, { recursive: true });
      const slot = Number.isInteger(opts.slot) && opts.slot >= 0 && opts.slot <= 9 ? opts.slot : null;
      const play = this.playOpts(g);
      ra.writeConfig(this.files.raCfg, ra.enforced(this.ra, dirs, { ...play, load: !(opts.fresh || slot !== null) }));
      ra.linkSystemData(this.ra, this.folders.bios, s.core);
      fs.mkdirSync(path.dirname(this.files.raLog), { recursive: true });
      fs.writeFileSync(this.files.raLog, "");
      const crt = play.picture === "crt" && fs.existsSync(this.ra.crt) ? ["--set-shader", this.ra.crt] : [];
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
    if (this.running && this.running.alive) return [409, { error: "A game is already running." }];
    let built;
    try { built = this.buildCmd(g, opts); } catch (e) { return [400, { error: e.message }]; }
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
    const rec = { id, since: now(), proc, alive: true, builtIn: built.builtIn, stopping: false };
    if (built.builtIn && this.playOpts(g).picture === "crt") this.event("crt");
    if (this.ui.tv) this.event("tv");
    this.running = rec;
    this.state.last[id] = Math.floor(rec.since);
    this.state.plays[id] = (this.state.plays[id] || 0) + 1;
    this.saveState();
    proc.once("exit", (code, signal) => this.onExit(rec, { code, signal }));
    this.emit("launch", g);
    return [200, { ok: true, since: rec.since, now: now() }];
  }

  onExit(rec, how = {}) {
    rec.alive = false;
    const dt = now() - rec.since;
    this.state.time[rec.id] = (this.state.time[rec.id] || 0) + Math.floor(dt);
    // a game that closed right away wasn't really played
    if (dt >= 10) {
      this.state.sessions.push([rec.id, Math.floor(rec.since), Math.floor(dt)]);
      if (this.state.sessions.length > 20000) this.state.sessions.splice(0, this.state.sessions.length - 20000);
    }
    try { this.checkPins(); } catch {}
    if (this.running === rec) this.running = null;
    this.saveState();
    let error = "";
    if (dt < 4 && !rec.stopping) error = (rec.builtIn && ra.explain(this.files.raLog, how)) || "";
    this.lastExit = { id: rec.id, at: now(), dt, error };
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
  moveStats(from, to) {
    const st = this.state;
    for (const k of ["last", "plays", "time", "names", "gameOpts"]) if (from in st[k]) { st[k][to] = st[k][from]; delete st[k][from]; }
    for (const k of ["fav", "hidden"]) { const i = st[k].indexOf(from); if (i >= 0) st[k][i] = to; }
    for (const sh of st.shelves) { const i = sh.ids.indexOf(from); if (i >= 0) sh.ids[i] = to; }
    for (const ses of st.sessions) if (ses[0] === from) ses[0] = to;
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
  /** the settings a game plays with: the app's, then its own */
  playOpts(g) { return { ...this.ui, ...(this.state.gameOpts[g.id] || {}) }; }

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
  setArt(id, kind, src) {
    const g = this.games.get(id);
    if (!g || !["cover", "logo", "snap"].includes(kind)) return [404, { error: "Unknown game." }];
    const ext = path.extname(src).toLowerCase();
    if (!IMG.includes(ext)) return [400, { error: "Choose a PNG, JPEG or WebP picture." }];
    const stem = path.parse(g.path).name, dir = path.dirname(g.path), name = kind === "cover" ? stem : `${stem}.${kind}`;
    const dest = path.join(dir, name + ext), tmp = dest + ".part";
    try {
      // copied first: the picture chosen may be one of the ones it replaces
      fs.copyFileSync(src, tmp);
      for (const e of IMG) fs.rmSync(path.join(dir, name + e), { force: true });
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
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
        const moves = files.map(f => [f, path.join(destDir, path.relative(srcDir, f))]);
        if (moves.some(([, to]) => fs.existsSync(to))) return [409, { error: "There's already a game with that name there." }];
        for (const [from, to] of moves) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
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

  toggleFav(id) {
    const f = this.state.fav, i = f.indexOf(id);
    i >= 0 ? f.splice(i, 1) : f.push(id);
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
    if (!Array.isArray(names) || (!names.length && kind === "cover")) {
      let html = "";
      try { html = (await this.fetchUrl(`${this.coverBase()}/${encodeURIComponent(thumb)}/${ART[kind].dir}/`, 60000)).toString("utf8"); }
      catch (e) { if (kind === "cover" || !/HTTP 404/.test(e.message)) throw e; }
      const set = new Set();
      for (const m of html.matchAll(/href="([^"?#]+\.png)"/gi)) {
        try { set.add(decodeURIComponent(m[1].split("/").pop())); } catch {}
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
      const items = games.filter(([sys]) => this.cfg.systems[sys]).map(item);
      series.push({ name, have: items.filter(i => i.id).length, items });
    }
    series.sort((a, b) => b.have - a.have || b.have / b.items.length - a.have / a.items.length || a.name.localeCompare(b.name));
    const mine = this.state.shelves.map(sh => {
      const ids = sh.ids.filter(id => this.games.has(id)), items = ids.map(id => { const g = this.games.get(id); return { system: g.system, look: g.look, title: this.state.names[id] || g.title, id }; });
      for (const w of sh.wanted || []) { const it = item(w); if (!it.id || !ids.includes(it.id)) items.push(it); }
      return { name: sh.name, have: items.filter(i => i.id).length, items };
    });
    return [200, { series, mine }];
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
    if (this.setArt(id, "cover", f)[0] !== 200) { this.saveArt(g, "cover", fs.readFileSync(f)); this.event("cover"); }
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
          if (!where || tried.has(where + name)) continue;
          tried.add(where + name);
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
    const biosAdded = [], biosFailed = [];
    for (const b of bios) {
      const to = path.join(this.folders.bios, ...b.dest.split("/"));
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (path.resolve(to) !== path.resolve(b.src)) fs.copyFileSync(b.src, to);
        biosAdded.push(b.name);
      } catch { biosFailed.push(b.name); }
    }
    this.pending = new Map(items.map(it => [it.id, it]));
    const root = this.romsRoot();
    return [200, {
      items: items.map(it => {
        let exists = false;
        if (it.system) { try { const d = this.importer.plan(it, root).main; exists = fs.existsSync(d); } catch {} }
        return { id: it.id, name: it.name, size: it.size, system: it.system, choices: it.choices, exists };
      }),
      unknown: unknown.slice(0, 50), unknownCount: unknown.length, biosAdded, biosFailed,
    }];
  }

  importRun(picks) {
    if (this.imp.running) return [409, { error: "Already adding games." }];
    const items = [];
    for (const p of Array.isArray(picks) ? picks : []) {
      const it = this.pending.get(String(p.id));
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
      builtin: this.ra ? { version: this.ra.version, systems } : null, own: this.ownEmu(),
      folders: { games: root, saves: this.folders.saves, bios: this.folders.bios },
    }, app: { version: this.dirs.version || "" } };
  }

  applySettings(data) {
    if (data.ui && typeof data.ui === "object") {
      const before = this.ownEmu();
      this.ui = cleanUi({ ...this.ui, ...data.ui });
      this.saveSettings();
      if (this.ui.arrange !== "console") this.event("arrange");
      if (before !== this.ownEmu() && this.ownEmu() && !this.exeOk()) this.autodetect();
    }
    const p = data.paths;
    if (p && typeof p === "object") {
      const r = this.cfg.retroarch;
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
    }
  }

  statusJson() {
    const r = this.running, live = !!(r && r.alive);
    return { running: live ? { id: r.id, since: r.since } : null, now: now(), covers: { ...this.cov },
             import: { ...this.imp }, exit: this.lastExit, newPins: this.newPins || [] };
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
      let name = "";
      try { const m = /^corename\s*=\s*"(.*)"/m.exec(fs.readFileSync(path.join(this.ra.info, core + ".info"), "utf8")); if (m) name = m[1]; } catch {}
      this._coreNames[core] = name;
    }
    const cn = this._coreNames[core];
    if (!cn) return 0;
    try { return Math.floor(fs.statSync(path.join(this.folders.states, cn, path.parse(g.path).name + ".state.auto")).mtimeMs / 1000); } catch { return 0; }
  }

  /** a game's saves: resume point and numbered slots, with when they were made and whether there's a picture */
  savesOf(g, dirCache) {
    if (this.ownEmu() || !this.ra) return null;
    const core = this.cfg.systems[g.system].core;
    if (!core) return null;
    this.resumeAt(g);                                  // looks up the core's name, which names its save folder
    const cn = this._coreNames[core];
    if (!cn) return null;
    if (!(cn in dirCache)) {
      const files = new Map();
      try { for (const f of fs.readdirSync(path.join(this.folders.states, cn))) files.set(f, path.join(this.folders.states, cn, f)); } catch {}
      dirCache[cn] = files;
    }
    const files = dirCache[cn], stem = path.parse(g.path).name, at = f => { try { return Math.floor(fs.statSync(files.get(f)).mtimeMs / 1000); } catch { return 0; } };
    const out = { resume: 0, rpic: false, slots: [] };
    if (files.has(stem + ".state.auto")) { out.resume = at(stem + ".state.auto"); out.rpic = files.has(stem + ".state.auto.png") && !this.blankPic(files.get(stem + ".state.auto.png")); }
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
  /** the picture RetroArch saved with a resume point ("auto") or slot */
  statePic(g, which) {
    const core = this.cfg.systems[g.system].core, cn = core && this._coreNames && this._coreNames[core];
    if (!cn) return null;
    const n = which === "auto" ? ".auto" : Number(which) > 0 ? String(Number(which)) : "";
    if (which !== "auto" && !/^\d$/.test(String(which))) return null;
    return path.join(this.folders.states, cn, path.parse(g.path).name + ".state" + n + ".png");
  }

  libraryJson() {
    const st = this.state, dirCache = {};
    return {
      games: [...this.games.values()].map(g => ({ id: g.id, title: g.title, tag: g.tag, system: g.system, cv: this.artVer(g.cover), lv: this.artVer(g.logo),
        plays: st.plays[g.id] || 0, time: st.time[g.id] || 0, last: st.last[g.id] || 0,
        added: g.added || 0, size: g.size || 0, file: path.basename(g.path), year: g.year || "", pub: g.pub || "", dev: g.dev || "", genre: g.genre || "", gg: pins.genreGroup(g.genre),
        sv: this.artVer(g.snap), saves: this.savesOf(g, dirCache), hidden: st.hidden.includes(g.id), named: !!st.names[g.id], opts: st.gameOpts[g.id] || null,
        ...(st.names[g.id] ? { title: st.names[g.id] } : {}) })),
      fav: [...st.fav], systems: Object.keys(this.cfg.systems),
      shelves: st.shelves.map(s => ({ name: s.name, ids: s.ids.filter(id => this.games.has(id)), wanted: s.wanted || [] })),
      // how each console's games look on the shelf: the kind of box, its short name, packaging and the color of its pile
      consoles: Object.fromEntries(Object.entries(this.cfg.systems).map(([k, v]) => [k, { media: v.media || "cart", abbr: v.abbr || "", look: v.look || null, pile: v.pile || null }])),
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
      if (pathname === "/api/library") return { code: 200, body: this.libraryJson() };
      if (pathname === "/api/status") return { code: 200, body: this.statusJson() };
      if (pathname === "/api/sessions") return { code: 200, body: { sessions: this.state.sessions, now: now() } };
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
      case "/api/launch": return j(await this.launch(String(d.id || ""), { slot: d.slot, fresh: !!d.fresh }));
      case "/api/game/rename": return j(this.rename(String(d.id || ""), d.title));
      case "/api/game/hide": return j(this.hide(String(d.id || ""), d.hidden !== false));
      case "/api/stop": await this.stop(); return j([200, { ok: true }]);
      case "/api/fav": return j(this.toggleFav(String(d.id || "")));
      case "/api/shelves": return j(this.shelfOp(d));
      case "/api/games/search": return j(this.gameSearch(d.q));
      case "/api/game/opts": return j(this.setGameOpts(String(d.id || ""), d.opts));
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

module.exports = { Backend, cleanTitle, regionTag, norm, pick, flatPng };

"use strict";
// Keeping the app up to date. New versions are GitHub releases.
// Windows: electron-updater downloads the new installer in the background and runs it when the app quits.
// Mac: the system updater only accepts apps signed with an Apple Developer ID, so this does the same job itself. It
// downloads the new app, checks it against the checksum published with the release, and swaps it in on quit.
// With test versions on, both also take GitHub prereleases (0.4.0-beta.1); otherwise only full releases.
const { app, net } = require("electron");
const { spawn, execFile } = require("child_process");
const run = require("util").promisify(execFile);
const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { compare, isTest } = require("./version");

const REPO = "colingalbraith/the-retro-shelf";
const PAGE = `https://github.com/${REPO}/releases/latest`;
// RETRO_SHELF_UPDATE_FEED points at a local folder server when testing updates
const FEED = (process.env.RETRO_SHELF_UPDATE_FEED || `https://github.com/${REPO}/releases/latest/download`).replace(/\/$/, "");
const EVERY = 6 * 3600 * 1000;

/** is version a newer than b ("0.2.1" > "0.2.0", "0.4.0-beta.2" > "0.4.0-beta.1") */
const newer = (a, b) => compare(a, b) > 0;

/** the parts of electron-builder's latest-mac.yml needed here: the version, and each file's name, checksum and size */
function parseFeed(text) {
  const version = (/^version:\s*['"]?([^'"\s]+)/m.exec(text) || [])[1] || "";
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^\s*-\s*url:\s*['"]?(.+?)['"]?\s*$/.exec(line))) files.push(cur = { url: m[1] });
    else if (cur && (m = /^\s+sha512:\s*['"]?(.+?)['"]?\s*$/.exec(line))) cur.sha512 = m[1];
    else if (cur && (m = /^\s+size:\s*(\d+)/.exec(line))) cur.size = +m[1];
    else if (/^\S/.test(line)) cur = null;
  }
  return { version, files };
}

/** the portable Windows copy (a folder with portable.txt beside the app): it keeps everything in its own folder, so it
    tells you about a new version rather than installing one */
const portable = () => process.platform === "win32" && fs.existsSync(path.join(path.dirname(process.execPath), "portable.txt"));

class Updater extends EventEmitter {
  constructor() {
    super();
    // status: idle | checking | current | downloading | ready | manual (a new version, but this copy can't
    // replace itself) | error
    this.state = { status: "idle", version: "", progress: 0, error: "", current: app.getVersion() };
    this.ready = null;
    this.applied = false;
    this.beta = () => false;
  }
  set(s) { Object.assign(this.state, s); this.emit("change", { ...this.state }); }
  /** where to download by hand: the test version's own page when that's what's waiting (the latest release isn't it) */
  page() { return this.state.status === "manual" && isTest(this.state.version) ? `https://github.com/${REPO}/releases/tag/v${this.state.version}` : PAGE; }

  /** a test version downloaded before test versions were turned off isn't put in place */
  unwanted() { return ["ready", "manual"].includes(this.state.status) && isTest(this.state.version) && !this.beta(); }
  dropUnwanted() {
    if (!this.unwanted()) return false;
    if (this.ready) { try { fs.rmSync(this.ready.work, { recursive: true, force: true }); } catch {} this.ready = null; }
    if (this.au) this.au.autoInstallOnAppQuit = false;
    this.set({ status: "idle", version: "", progress: 0 });
    return true;
  }

  /** checks shortly after launch and every few hours, while enabled() says so; beta() says whether test versions count */
  start(enabled, beta) {
    if (beta) this.beta = beta;
    if (!app.isPackaged && !process.env.RETRO_SHELF_UPDATE_FEED) return;
    const auto = () => { if (enabled()) this.check(false); };
    setTimeout(auto, 15000);
    setInterval(auto, EVERY).unref();
  }

  async check(manual) {
    this.dropUnwanted();
    if (["checking", "downloading", "ready"].includes(this.state.status)) return this.state;
    if (!app.isPackaged && !process.env.RETRO_SHELF_UPDATE_FEED) { this.set({ status: "error", error: "Updates only work in the installed app." }); return this.state; }
    this.set({ status: "checking", error: "" });
    try {
      if (process.platform === "darwin") await this.checkMac();
      else if (portable()) await this.checkOnly("latest.yml");
      else if (process.platform === "win32") await this.checkWindows();
      // Linux: the AppImage replaces itself; run any other way (unpacked, from a package), it only tells you
      else if (process.platform === "linux") await (process.env.APPIMAGE ? this.checkWindows() : this.checkOnly("latest-linux.yml"));
      else this.set({ status: "idle" });
    } catch (e) {
      // a check that runs by itself fails quietly (no internet, GitHub down); one asked for says why
      this.set(manual ? { status: "error", error: "Couldn't check for updates: " + e.message } : { status: "idle" });
    }
    return this.state;
  }

  // ---------------------------------------------------------------- Windows
  win() {
    if (this.au) return this.au;
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("update-available", i => this.set({ status: "downloading", version: i.version, progress: 0 }));
    autoUpdater.on("update-not-available", () => this.set({ status: "current" }));
    autoUpdater.on("download-progress", p => this.set({ progress: Math.round(p.percent || 0) }));
    // ready to go in on quit: this download, not one dropped before (a test version, once test versions are off), which
    // electron-updater would keep and put in when the app quits
    autoUpdater.on("update-downloaded", i => { autoUpdater.autoInstallOnAppQuit = true; this.set({ status: "ready", version: i.version }); });
    autoUpdater.on("error", e => this.set({ status: "error", error: "Update failed: " + (e && e.message || e) }));
    // Linux: an AppImage named after its version gets the new one's name; where the old one was (a Steam shortcut points
    // there), a link to the new one. Named without a version since 0.4.0, later ones are replaced in place
    autoUpdater.on("appimage-filename-updated", dest => {
      const old = process.env.APPIMAGE;
      if (old && old !== dest) { try { if (!fs.existsSync(old)) fs.symlinkSync(dest, old); } catch {} }
    });
    return (this.au = autoUpdater);
  }
  async checkWindows() {
    const au = this.win();
    if (process.env.RETRO_SHELF_UPDATE_FEED) au.setFeedURL({ provider: "generic", url: FEED });
    // test versions are GitHub prereleases; their update file has the same name as a release's (latest.yml)
    else au.allowPrerelease = !!this.beta();
    await au.checkForUpdates();
  }

  // ---------------------------------------------------------------- Mac
  /** the running .app, if it can be replaced where it is (not run from the disk image or a read-only place) */
  bundle() {
    const b = path.resolve(process.execPath, "..", "..", "..");
    if (!b.endsWith(".app") || /\/AppTranslocation\//.test(b) || b.startsWith("/Volumes/")) return null;
    try { fs.accessSync(path.dirname(b), fs.constants.W_OK); fs.accessSync(b, fs.constants.W_OK); return b; } catch { return null; }
  }

  /** a new version to download by hand: for copies that can't replace themselves */
  async checkOnly(name) {
    const r = await net.fetch(await this.macBase(name) + "/" + name, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const feed = parseFeed(await r.text());
    this.set(feed.version && newer(feed.version, app.getVersion()) ? { status: "manual", version: feed.version } : { status: "current" });
  }

  /** where an update comes from: the latest release, or with test versions on, the newest of any kind (name: the
      update file to look for, latest-mac.yml by default) */
  async macBase(name = "latest-mac.yml") {
    if (process.env.RETRO_SHELF_UPDATE_FEED || !this.beta()) return FEED;
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { cache: "no-store", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rel = (await r.json()).filter(x => !x.draft && (x.assets || []).some(a => a.name === name))
      .sort((a, b) => compare(b.tag_name, a.tag_name))[0];
    return rel ? `https://github.com/${REPO}/releases/download/${encodeURIComponent(rel.tag_name)}` : FEED;
  }

  async checkMac() {
    const base = await this.macBase();
    const r = await net.fetch(base + "/latest-mac.yml", { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const feed = parseFeed(await r.text());
    if (!feed.version || !newer(feed.version, app.getVersion())) return this.set({ status: "current" });
    const file = feed.files.find(f => f.url.endsWith(`-${process.arch}.zip`));
    const bundle = this.bundle();
    if (!file || !file.sha512 || !bundle) return this.set({ status: "manual", version: feed.version });

    this.set({ status: "downloading", version: feed.version, progress: 0 });
    // unpacked next to the app, so putting it in place is a rename on the same disk
    const work = path.join(path.dirname(bundle), ".The Retro Shelf update");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const zip = path.join(work, "update.zip");
      await this.download(base + "/" + encodeURIComponent(file.url), zip, file);
      // unpacked in the background: hundreds of MB, and the app stays usable meanwhile
      await run("ditto", ["-x", "-k", zip, work]);
      fs.rmSync(zip, { force: true });
      const next = fs.readdirSync(work).find(f => f.endsWith(".app"));
      if (!next) throw new Error("the download didn't contain the app");
      const v = (await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(work, next, "Contents", "Info.plist")])).stdout.toString().trim();
      if (v !== feed.version) throw new Error(`the download is version ${v}, not ${feed.version}`);
      this.ready = { bundle, next: path.join(work, next), work };
      this.set({ status: "ready", progress: 100 });
    } catch (e) {
      fs.rmSync(work, { recursive: true, force: true });
      throw e;
    }
  }

  /** downloads to a file, checking the size and the release's sha512 checksum */
  async download(url, to, file) {
    const r = await net.fetch(url, { cache: "no-store" });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const total = file.size || +r.headers.get("content-length") || 0, hash = crypto.createHash("sha512"), out = fs.createWriteStream(to);
    // a write that fails (a full disk) ends the download with that error, rather than leaving it waiting forever
    let failed = null;
    const fail = new Promise((_, bad) => out.once("error", e => { failed = e; bad(e); }));
    fail.catch(() => {});
    let got = 0, last = 0;
    try {
      for await (const chunk of r.body) {
        if (failed) throw failed;
        hash.update(chunk); got += chunk.length;
        if (!out.write(chunk)) await Promise.race([new Promise(res => out.once("drain", res)), fail]);
        const pct = total ? Math.floor(got * 100 / total) : 0;
        if (pct >= last + 2) { last = pct; this.set({ progress: Math.min(99, pct) }); }
      }
    } finally {
      if (failed) out.destroy();
      else await Promise.race([new Promise(res => out.end(res)), fail]).catch(() => {});
    }
    if (failed) throw failed;
    if (file.size && got !== file.size) throw new Error("the download was incomplete");
    if (hash.digest("base64") !== file.sha512) throw new Error("the download didn't match its checksum");
  }

  // ---------------------------------------------------------------- installing
  /** quit now and come back as the new version */
  restart() {
    // a test version, with test versions turned off since it came: it isn't put in place
    if (this.dropUnwanted() || this.state.status !== "ready") return;
    if (process.platform === "win32" || process.platform === "linux") return this.win().quitAndInstall(true, true);
    this.relaunch = true;
    app.quit();
  }

  /** on a Mac, as the app quits: once this process has exited, the new app takes the old one's place */
  applyOnQuit() {
    if (this.dropUnwanted()) return;
    if (process.platform !== "darwin" || !this.ready || this.applied) return;
    this.applied = true;
    const { bundle, next, work } = this.ready;
    const script = `
      while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
      old="$1.old"; rm -rf "$old"
      if mv "$1" "$old"; then
        if mv "$2" "$1"; then rm -rf "$old" "$3"; else mv "$old" "$1"; fi
      fi
      [ "$4" = 1 ] && open "$1"
      exit 0`;
    spawn("/bin/sh", ["-c", script, "sh", bundle, next, work, this.relaunch ? "1" : "0"], { detached: true, stdio: "ignore" }).unref();
  }
}

module.exports = { Updater, newer, parseFeed };

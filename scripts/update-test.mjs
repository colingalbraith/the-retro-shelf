#!/usr/bin/env node
// Checks that people on the last release get this build as an update: installs the published release (Windows: its
// installer; Mac: its app; Linux: its AppImage), points its updater at this build in dist/, and has it download, check
// and install the update the way it would from GitHub. Passes when the installed app is this build's version
// afterwards (Linux: and the new one opens by itself). Skipped when the last release isn't older than this build.
// CI runs it after each build (Linux: on a virtual screen).
//   node scripts/update-test.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.DIST_DIR || path.join(ROOT, "dist"), REPO = "colingalbraith/the-retro-shelf", PORT = 9341, FEED = 9342;
const require = createRequire(import.meta.url);
const { compare } = require("../src/version.js"), asar = require("@electron/asar");
const NEW = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = s => console.log("· " + s);
const win = process.platform === "win32", linux = process.platform === "linux";
const appimage = x => x.name.endsWith(".AppImage"), version = r => r.tag_name.replace(/^v/, "");
/** the version an installed app really is: the one in its own package.json (Windows file versions lose "-beta.1") */
const versionIn = resources => {
  const archive = path.join(resources, "app.asar");
  // the reader remembers an archive's index by its path, and the update put a different archive there
  try { asar.uncache(archive); return JSON.parse(asar.extractFile(archive, "package.json").toString()).version; } catch { return ""; }
};

async function github(p) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${REPO}/${p}`, { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${p}: HTTP ${r.status}`);
  return r.json();
}
async function download(url, to) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`);
  fs.writeFileSync(to, Buffer.from(await r.arrayBuffer()));
}

/** dist/ on a local web server, the way a release's files are on GitHub (ranges too, for partial downloads) */
function serve() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.join(DIST, name);
    if (name.includes("..") || name.includes("/") || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const a = +range[1], b = range[2] ? +range[2] : size - 1;
      res.writeHead(206, { "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": b - a + 1, "Accept-Ranges": "bytes" });
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(FEED, "127.0.0.1", () => r(server)));
}

/** evaluates in the app's page over DevTools */
async function page() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page" && x.url.startsWith("arcade://app"));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        let id = 0; const pending = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        ws.onclose = () => { for (const f of pending.values()) f({ result: { result: { value: null } } }); pending.clear(); };
        const evaluate = expr => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : null);
        return { ws, evaluate };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("the old app's window never opened");
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-update-")), work = path.join(home, "old");
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.mkdirSync(work, { recursive: true });
// no checks of its own: this test starts the one that matters
fs.writeFileSync(path.join(home, "data", "settings.json"), JSON.stringify({ ui: { welcomed: true, updates: false } }));

let app = null, server = null, failed = false;
try {
  let rel = await github("releases/latest");
  // Linux builds start with 0.4.0: until a release has one, the newest test version older than this build stands in
  if (linux && !rel.assets.some(appimage)) {
    const older = (await github("releases?per_page=50")).filter(r => !r.draft && r.assets.some(appimage) && compare(version(r), NEW) < 0);
    if (!older.length) { console.log(`skipped: no release older than ${NEW} has a Linux build to update from`); process.exit(0); }
    rel = older.sort((a, b) => compare(version(b), version(a)))[0];
  }
  const OLD = version(rel);
  if (compare(OLD, NEW) >= 0) { console.log(`skipped: the last release (${OLD}) isn't older than this build (${NEW})`); process.exit(0); }
  step(`updating ${OLD} → ${NEW}`);

  let exe, installed;
  if (win) {
    const a = rel.assets.find(x => /Setup.*\.exe$/.test(x.name));
    const setup = path.join(work, a.name);
    await download(a.browser_download_url, setup);
    step("installing " + a.name);
    if (spawnSync(setup, ["/S"], { stdio: "inherit" }).status !== 0) throw new Error("the old installer failed");
    const progs = path.join(process.env.LOCALAPPDATA, "Programs");
    exe = fs.readdirSync(progs).map(d => path.join(progs, d, "The Retro Shelf.exe")).find(f => fs.existsSync(f));
    if (!exe) throw new Error("the old version didn't install");
    installed = () => versionIn(path.join(path.dirname(exe), "resources"));
  } else if (linux) {
    const a = rel.assets.find(appimage);
    exe = path.join(work, a.name);
    await download(a.browser_download_url, exe);
    fs.chmodSync(exe, 0o755);
    // the version inside it: the AppImage takes out just its app archive. One named with its version (before
    // 0.4.0-beta.13) is replaced by one with the new name; since then they keep one name and are replaced in place
    const peek = path.join(home, "peek");
    installed = () => {
      const image = fs.existsSync(exe) ? exe : fs.readdirSync(work).filter(f => f.endsWith(".AppImage")).map(f => path.join(work, f))[0];
      if (!image) return "";
      fs.rmSync(peek, { recursive: true, force: true }); fs.mkdirSync(peek);
      spawnSync(image, ["--appimage-extract", "resources/app.asar"], { cwd: peek, stdio: "ignore" });
      return versionIn(path.join(peek, "squashfs-root", "resources"));
    };
  } else {
    const arch = process.arch === "arm64" ? "arm64" : "x64", a = rel.assets.find(x => x.name.endsWith(`-mac-${arch}.zip`));
    const zip = path.join(work, a.name);
    await download(a.browser_download_url, zip);
    execFileSync("ditto", ["-x", "-k", zip, work]);
    const bundle = path.join(work, "The Retro Shelf.app");
    exe = path.join(bundle, "Contents", "MacOS", "The Retro Shelf");
    installed = () => versionIn(path.join(bundle, "Contents", "Resources"));
  }
  const before = installed();
  if (compare(before, OLD) !== 0) throw new Error(`the old app says it's ${before}, not ${OLD}`);

  server = await serve();
  step("opening " + OLD);
  // Linux: GitHub's machines can't mount an AppImage the way a desktop does, so it unpacks itself and runs (the new one
  // the update opens does the same)
  app = spawn(exe, [`--remote-debugging-port=${PORT}`, ...(linux ? ["--no-sandbox"] : [])], {
    env: { ...process.env, ARCADE_HOME: home, RETRO_SHELF_UPDATE_FEED: `http://127.0.0.1:${FEED}`, ...(linux ? { APPIMAGE_EXTRACT_AND_RUN: "1", APPIMAGE: exe } : {}) }, stdio: "ignore" });
  const p = await page();
  await sleep(1500);
  // the old app answers once it has started (on a slow machine's first launch that's a while after the window opens)
  let s = null;
  for (let i = 0; i < 60 && !(s && s.status); i++) { s = await p.evaluate(`APP.update("check").catch(() => null)`); if (!(s && s.status)) await sleep(1000); }
  const end = Date.now() + 5 * 60000;
  while (s && ["checking", "downloading"].includes(s.status) && Date.now() < end) { await sleep(1000); s = await p.evaluate(`APP.update("state")`); }
  if (!s || s.status !== "ready") throw new Error(`the update didn't download: ${JSON.stringify(s)}`);
  step(`downloaded ${s.version}`);
  await p.evaluate(`APP.update("restart"), 1`);
  p.ws.close();

  // installed on the way out (Windows: the new installer runs; Mac: the new app takes the old one's place)
  let now = "";
  const done = Date.now() + 3 * 60000;
  while (Date.now() < done) { now = installed(); if (now === NEW) break; await sleep(2000); }
  if (now !== NEW) throw new Error(`after restarting, the installed app is ${now || "missing"}, not ${NEW}`);
  step(`the installed app is now ${now}`);
  if (!fs.existsSync(path.join(home, "data", "settings.json"))) throw new Error("the update lost the settings");
  // Linux: the AppImage opens the new version once it's in place; it should start and stay open
  if (linux) {
    const running = () => spawnSync("pgrep", ["-f", "appimage_extracted_.*/the-retro-shelf"], { encoding: "utf8" }).stdout.trim();
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { await sleep(2000); up = (app.exitCode !== null || app.signalCode !== null) && !!running(); }
    if (up) { await sleep(8000); up = !!running(); }
    if (!up) throw new Error("the new version didn't open after updating");
    step("the new version opened by itself");
  }
  console.log(`ok: ${OLD} updates itself to ${NEW}`);
} catch (e) {
  failed = true;
  console.error("FAILED: " + e.message);
} finally {
  if (server) server.close();
  // the old app if it's still open, and the new one the update opened
  // the update's installer carries on a little after the new files are in place, then opens the app again: wait for
  // it to finish, then close the app, so the next step's installer has the field to itself
  if (win) {
    const running = () => /The-Retro-Shelf-Setup/i.test(spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout || "");
    for (let i = 0; i < 90 && running(); i++) await sleep(2000);
    for (let i = 0; i < 6; i++) { spawnSync("taskkill", ["/IM", "The Retro Shelf.exe", "/T", "/F"], { stdio: "ignore" }); await sleep(1500); }
  }
  else {
    if (app) try { process.kill(app.pid, "SIGTERM"); } catch {}
    spawnSync("pkill", ["-f", work], { stdio: "ignore" });
    if (linux) spawnSync("pkill", ["-f", "appimage_extracted_.*/the-retro-shelf"], { stdio: "ignore" });
  }
  await sleep(1500);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

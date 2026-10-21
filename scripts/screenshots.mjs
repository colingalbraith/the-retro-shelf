#!/usr/bin/env node
// The README's pictures (docs/images): a demo shelf of well-known games with their box art (downloaded by the app,
// the way it does for anyone, and kept in dist/screenshots for the next run), a few months of made-up play, and the
// app opened on each screen. Also the moving picture at the top of the README (demo.gif), recorded while moving
// along the shelf. The games are empty files with the games' names: nothing to play, just boxes.
// Needs ffmpeg, and the internet the first time.
//   node scripts/screenshots.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "dist", "screenshots"), HOME = path.join(WORK, "home"), SHOTS = path.join(WORK, "shots");
const IMAGES = path.join(ROOT, "docs", "images"), PORT = 9345;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = s => console.log("· " + s);
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) { console.error("This needs ffmpeg (brew install ffmpeg)."); process.exit(1); }

// --- the demo shelf ----------------------------------------------------------------------------------------------
// each console's games, by name; a name is matched to the full one in the app's game details when it has them
const SHELF = {
  NES: ["Super Mario Bros. 3", "Legend of Zelda, The", "Metroid", "Mega Man 2", "Castlevania", "Punch-Out!!", "Kirby's Adventure"],
  SNES: ["Chrono Trigger", "Super Mario World", "Legend of Zelda, The - A Link to the Past", "Super Metroid", "Donkey Kong Country", "Super Mario Kart", "EarthBound"],
  "Game Boy": ["Kirby's Dream Land", "Pokemon - Red Version", "Super Mario Land 2 - 6 Golden Coins", "Legend of Zelda, The - Link's Awakening DX"],
  GBA: ["Pokemon - Emerald Version", "Metroid Fusion", "Legend of Zelda, The - The Minish Cap", "Mario Kart - Super Circuit"],
  Genesis: ["Sonic The Hedgehog 2", "Streets of Rage 2", "Gunstar Heroes", "Phantasy Star IV"],
  "Master System": ["Alex Kidd in Miracle World", "Phantasy Star", "Wonder Boy III - The Dragon's Trap"],
  "Game Gear": ["Sonic the Hedgehog - Triple Trouble", "Shinobi"],
  "PC Engine": ["Bonk's Adventure", "Blazing Lazers"],
  "Atari 2600": ["Pitfall! - Pitfall Harry's Jungle Adventure", "Adventure", "River Raid"],
  N64: ["Super Mario 64", "Legend of Zelda, The - Ocarina of Time", "Mario Kart 64", "GoldenEye 007"],
  PS1: ["Castlevania - Symphony of the Night", "Crash Bandicoot", "Spyro the Dragon", "Final Fantasy VII (USA) (Disc 1)"],
  Dreamcast: ["Sonic Adventure (USA)", "Jet Grind Radio (USA)", "Crazy Taxi (USA)"],
  "GameCube/Wii": ["Super Smash Bros. Melee (USA)", "Metroid Prime (USA)", "Legend of Zelda, The - The Wind Waker (USA)"],
  DS: ["New Super Mario Bros.", "Mario Kart DS"],
};
// what was played, for how long (hours), and how it's going
const PLAYED = [
  ["Pokemon - Emerald Version", 32, { fav: true, progress: "playing", rating: 5 }],
  ["Chrono Trigger", 21.2, { fav: true, progress: "beaten", rating: 5, note: "Get the Rainbow Shell before the Black Omen." }],
  ["Legend of Zelda, The - A Link to the Past", 11.1, { fav: true, progress: "playing", rating: 5 }],
  ["Super Mario 64", 7, { fav: true, progress: "beaten", rating: 4 }],
  ["Super Mario World", 6.7, { progress: "complete", rating: 5 }],
  ["Super Metroid", 4.2, { fav: true, progress: "playing" }],
  ["Sonic The Hedgehog 2", 3.1, { progress: "beaten", rating: 4 }],
  ["Mario Kart 64", 2.6, {}],
  ["Kirby's Dream Land", 1.6, { rating: 4 }],
  ["Castlevania - Symphony of the Night", 1.2, { progress: "playing" }],
  ["EarthBound", 0, { progress: "backlog" }],
  ["Metroid Prime (USA)", 0, { progress: "backlog" }],
];

const BAD = /\b(Beta|Proto|Sample|Demo|Kiosk|Virtual Console|Switch Online|Classic Mini|Arcade|Pirate|Unl)\b|\[b\]/i;
function fullName(system, want) {
  if (/\(.*\)$/.test(want)) return want;
  const s = cfg.systems[system];
  let names = [];
  try { names = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "meta", (s.folder || system) + ".json"), "utf8"))); } catch {}
  const ok = names.filter(n => n.startsWith(want + " (") && !BAD.test(n));
  const best = ok.filter(n => /\(USA/.test(n)).sort((a, b) => a.length - b.length)[0] || ok.sort((a, b) => a.length - b.length)[0];
  return best || want + " (USA)";
}

// the app's own game id: from the file's whole path
const gid = p => crypto.createHash("sha1").update(p).digest("hex").slice(0, 12);

function makeShelf() {
  const games = path.join(HOME, "The Retro Shelf", "Games");
  fs.rmSync(games, { recursive: true, force: true });
  const ids = {};
  for (const [system, wants] of Object.entries(SHELF)) {
    const s = cfg.systems[system], dir = path.join(games, s.folder || system.toLowerCase());
    const ext = s.exts.find(e => ![".zip", ".7z", ".cue", ".m3u"].includes(e)) || s.exts[0];
    fs.mkdirSync(dir, { recursive: true });
    for (const want of wants) {
      const file = path.join(dir, fullName(system, want).replace(/[\\/:*?"<>|]/g, "_") + ext);
      fs.writeFileSync(file, "");
      ids[want] = gid(file);
    }
  }
  return ids;
}

// a few months of play: evenings mostly, weekends longer, the same every run
function history(ids) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const end = Math.floor(Date.now() / 1000), day = 86400;
  const st = { fav: [], last: {}, plays: {}, time: {}, sessions: [], progress: {}, rating: {}, notes: {}, seenVersion: VERSION };
  for (const [want, hours, o] of PLAYED) {
    const id = ids[want];
    if (!id) throw new Error("not on the demo shelf: " + want);
    if (o.fav) st.fav.push(id);
    if (o.progress) st.progress[id] = o.progress;
    if (o.rating) st.rating[id] = o.rating;
    if (o.note) st.notes[id] = o.note;
    let left = hours * 3600;
    while (left > 600) {
      const len = Math.min(left, Math.round((20 + rnd() * 130) * 60));
      const d = Math.floor(rnd() * 110), date = new Date((end - d * day) * 1000);
      const weekend = [0, 6].includes(date.getDay()), hour = weekend && rnd() < 0.5 ? 10 + Math.floor(rnd() * 6) : 18 + Math.floor(rnd() * 4);
      date.setHours(hour, Math.floor(rnd() * 60), 0, 0);
      const at = Math.min(Math.floor(date.getTime() / 1000), end - len - 60);
      st.sessions.push([id, at, len]);
      left -= len;
    }
  }
  st.sessions.sort((a, b) => a[1] - b[1]);
  // last month's recap counts as offered already, so it doesn't open over the shelves
  const d = new Date(), jan = d.getMonth() === 0;
  st.recapSeen = jan ? String(d.getFullYear() - 1) : `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`;
  for (const [id, at, len] of st.sessions) {
    st.plays[id] = (st.plays[id] || 0) + 1;
    st.time[id] = (st.time[id] || 0) + len;
    st.last[id] = Math.max(st.last[id] || 0, at);
  }
  return st;
}

// --- the app, over DevTools --------------------------------------------------------------------------------------
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page" && x.url.startsWith("arcade://app"));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        let id = 0; const pending = new Map(), listeners = [];
        ws.onmessage = m => {
          const d = JSON.parse(m.data);
          if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          if (d.method) for (const f of listeners) f(d);
        };
        const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async expr => {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
          return r.result.result.value;
        };
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        return { ws, send, ev, on: f => listeners.push(f) };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("the app's window never opened");
}

const W = 1200, H = 750, SCALE = 2;
/** the window as a picture, cropped to a part of the page (CSS pixels) and saved at the README's size */
async function shot(p, name, rect = null, width = W) {
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  const png = path.join(SHOTS, name + ".png");
  fs.writeFileSync(png, Buffer.from(r.result.data, "base64"));
  const c = rect ? rect.map(v => Math.round(v * SCALE)) : [0, 0, W * SCALE, H * SCALE];
  const out = path.join(IMAGES, name + ".jpg");
  const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", `crop=${c[2]}:${c[3]}:${c[0]}:${c[1]},scale=${width}:-2:flags=lanczos`, "-q:v", "3", out]);
  if (res.status !== 0) throw new Error("ffmpeg: " + res.stderr);
  step(`${name}.jpg`);
}
/** where an element is on the page, with some room around it, as [x, y, width, height] */
const rectOf = (p, sel, pad = 0, tall = 0) => p.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  const x = Math.max(0, r.left - ${pad}), y = Math.max(0, r.top - ${pad}), h = ${tall} || r.height + ${pad} * 2;
  return [x, y, Math.min(innerWidth - x, r.width + ${pad} * 2), Math.min(innerHeight - y, h)]; })()`);
const key = async (p, k, hold = 60) => {
  const code = { ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, " ": 32, Escape: 27 }[k];
  const base = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k === " " ? { text: " " } : {}) });
  await sleep(hold);
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
// a game's box on its console's shelf (the last of its boxes: Favorites and Recently played come first)
const cardOf = (p, want) => `[...document.querySelectorAll('#shelves .card[data-id="' + ${JSON.stringify(want)} + '"]')].pop()`;

// --- run ---------------------------------------------------------------------------------------------------------
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(path.join(HOME, "data"), { recursive: true });
const ids = makeShelf();
// the box art stays from earlier runs (data/covers); the rest starts over
fs.writeFileSync(path.join(HOME, "data", "settings.json"), JSON.stringify({ ui: { welcomed: true, autoCovers: true, updates: false, sound: false, music: false, fx: "full" } }));
fs.writeFileSync(path.join(HOME, "data", "state.json"), JSON.stringify(history(ids)));
step(`${Object.keys(ids).length} games on the demo shelf`);

const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
let app = null, failed = false;
async function open() {
  app = spawn(electron, [".", `--remote-debugging-port=${PORT}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    { cwd: ROOT, env: { ...process.env, ARCADE_HOME: HOME, RETRO_SHELF_TEST: "1" }, stdio: "ignore", shell: process.platform === "win32" });
  const p = await connect();
  await p.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  for (let i = 0; i < 120 && !(await p.ev(`typeof G !== "undefined" && !document.querySelector("#splash") ? G.length : 0`)); i++) await sleep(500);
  return p;
}
async function close(p) {
  p.ws.close();
  const gone = new Promise(r => app.once("exit", r));
  try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"]) : process.kill(app.pid, "SIGTERM"); } catch {}
  await Promise.race([gone, sleep(10000)]);
  app = null;
  await sleep(1000);
}
try {
  // first, the box art (what earlier runs didn't get), and the pins the made-up play earns
  let p = await open();
  await p.ev(`api("/api/covers/fetch", {}).then(() => 1)`);
  for (let i = 0; i < 600; i++) {
    const c = await p.ev(`api("/api/status").then(r => r.data.covers)`);
    if (!c.running) break;
    if (i % 10 === 0) step(`box art: ${c.done} of ${c.total}`);
    await sleep(1000);
  }
  await close(p);
  // some of those pins earned last month, so its recap has them
  const stFile = path.join(HOME, "data", "state.json"), st = JSON.parse(fs.readFileSync(stFile, "utf8"));
  const lm = new Date(); lm.setDate(1); lm.setMonth(lm.getMonth() - 1); lm.setHours(20, 0, 0, 0);
  Object.keys(st.pins || {}).slice(0, 7).forEach((k, i) => { st.pins[k] = Math.floor(lm.getTime() / 1000) + i * 3 * 86400; });
  fs.writeFileSync(stFile, JSON.stringify(st));

  p = await open();
  await p.ev(`refresh(true).then(() => { for (const f of ["closeRecap", "closeNews"]) if (typeof window[f] === "function") window[f](); return 1; })`); await sleep(2500);
  const missing = await p.ev(`G.filter(g => !g.cv).map(g => g.title)`);
  step(missing.length ? `no box art for: ${missing.join(", ")}` : "every game has its box art");

  // the shelf, a box pulled out, and turned over
  const ct = ids["Chrono Trigger"];
  await p.ev(`(() => { $("#shelves").scrollTop = 0; const c = ${cardOf(p, ct)}; c.scrollIntoView({block: "center"}); select(c); return 1; })()`); await sleep(1500);
  await shot(p, "selected");
  await p.ev(`(flip(true), 1)`); await sleep(1800);
  await shot(p, "back");
  await p.ev(`(flip(false), 1)`); await sleep(600);

  // Your play: the trophy shelf, the time card and the pins
  await p.ev(`(openTrophy(), 1)`); await sleep(2200);
  const top = await p.ev(`(() => { const a = $("#trophy .thead").getBoundingClientRect(), b = $("#ttop").getBoundingClientRect(); return [0, Math.max(0, a.top - 30), innerWidth, b.bottom - a.top + 70]; })()`);
  await shot(p, "your-play", top);
  await p.ev(`($("#tcard").scrollIntoView({block: "center"}), 1)`); await sleep(1200);
  await shot(p, "time-card", await rectOf(p, "#tcard", 24), 727);
  await p.ev(`($("#cork").scrollIntoView({block: "start"}), 1)`); await sleep(1200);
  await shot(p, "pins", await rectOf(p, "#cork", 0, 680));
  await p.ev(`(closeTrophy(), 1)`); await sleep(800);

  // last month's recap
  await p.ev(`(() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return openRecap(d.getFullYear(), d.getMonth()).then(() => 1); })()`); await sleep(2200);
  await shot(p, "recap", await rectOf(p, "#rcard", 20), 800);
  await p.ev(`(closeRecap(), 1)`); await sleep(800);

  // Collections
  await p.ev(`(openColls("series"), 1)`); await sleep(2500);
  await shot(p, "collections", [0, 0, W, 679]);
  await p.ev(`(closeColls(), 1)`); await sleep(800);

  // the moving picture: along a shelf, a box turned over and back, down a shelf, and again
  await p.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }); await sleep(800);
  const first = ids["Super Mario Bros. 3"];
  await p.ev(`(() => { const c = ${cardOf(p, first)}; c.scrollIntoView({block: "center"}); select(c); return 1; })()`); await sleep(1200);
  const frames = [];
  p.on(d => { if (d.method === "Page.screencastFrame") { frames.push([d.params.metadata.timestamp, d.params.data]); p.send("Page.screencastFrameAck", { sessionId: d.params.sessionId }); } });
  await p.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: W, maxHeight: H });
  await sleep(700);
  for (let i = 0; i < 4; i++) { await key(p, "ArrowRight"); await sleep(650); }
  await key(p, " "); await sleep(2000); await key(p, " "); await sleep(800);
  await key(p, "ArrowDown"); await sleep(900);
  for (let i = 0; i < 3; i++) { await key(p, "ArrowRight"); await sleep(650); }
  await key(p, " "); await sleep(2000); await key(p, " "); await sleep(900);
  await p.send("Page.stopScreencast"); await sleep(300);
  const fdir = path.join(SHOTS, "frames"); fs.rmSync(fdir, { recursive: true, force: true }); fs.mkdirSync(fdir);
  const list = [];
  frames.forEach(([t, data], i) => {
    const f = path.join(fdir, String(i).padStart(5, "0") + ".jpg");
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    const next = frames[i + 1] ? frames[i + 1][0] : t + 1;
    list.push(`file '${f}'`, `duration ${Math.max(0.01, next - t).toFixed(3)}`);
  });
  list.push(`file '${path.join(fdir, String(frames.length - 1).padStart(5, "0") + ".jpg")}'`);
  fs.writeFileSync(path.join(fdir, "list.txt"), list.join("\n") + "\n");
  const gif = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(fdir, "list.txt"), "-vf",
    "fps=12,scale=840:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0", path.join(IMAGES, "demo.gif")]);
  if (gif.status !== 0) throw new Error("ffmpeg: " + gif.stderr);
  step(`demo.gif: ${frames.length} frames, ${(fs.statSync(path.join(IMAGES, "demo.gif")).size / 1048576).toFixed(1)} MB`);
  // the controller test, with A held down (last: its pretend controller would show controller hints in the rest)
  await p.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false }); await sleep(600);
  await p.ev(`(() => { window.FAKEPAD = {id: "Xbox Wireless Controller (STANDARD GAMEPAD)", index: 0, connected: true, mapping: "standard", axes: [0.6, 0, 0, 0],
    buttons: Array.from({length: 17}, (_, i) => ({pressed: i === 0, value: i === 0 ? 1 : 0}))}; navigator.getGamepads = () => [FAKEPAD]; openCtest(); return 1; })()`); await sleep(1800);
  await shot(p, "controller-test", await rectOf(p, "#ctest .slip", 16), 900);
  await p.ev(`(closeCtest(), navigator.getGamepads = () => [], 1)`); await sleep(800);

} catch (e) {
  failed = true;
  console.error("FAILED: " + e.message);
} finally {
  if (app) try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"]) : process.kill(app.pid, "SIGTERM"); } catch {}
  await sleep(500);
  process.exit(failed ? 1 : 0);
}

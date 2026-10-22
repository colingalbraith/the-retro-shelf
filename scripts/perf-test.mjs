#!/usr/bin/env node
// How the app copes with a big library: 5,000 games (real names on every console, then numbered ones) on an empty
// profile, and limits it has to stay within: how long until the shelf is on screen, frames while scrolling all the
// way down, how quickly a key press moves the selection, and memory. Prints the numbers either way.
//   node scripts/perf-test.mjs [the app's executable] [--games 5000]     (default: this checkout, run with Electron)
// On Linux, run it under xvfb-run. Without a graphics chip (GitHub's Linux machines) the 3D boxes are drawn in
// software, about ten times slower than on a real computer: there the frame limits are loose enough to still catch
// a real slowdown without failing on the machine itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9344, argv = process.argv.slice(2);
const N = +(argv[argv.indexOf("--games") + 1] || 0) || 5000, given = argv.find(a => !a.startsWith("--") && !/^\d+$/.test(a));
const LIMITS = { readyS: 15, scrollP95Ms: 100, keyMedianMs: 150, heapMB: 600, favMs: 1200, searchMs: 1200, coversMs: 2500 },
  SOFTWARE = { scrollP95Ms: 300, keyMedianMs: 300, favMs: 4000, searchMs: 4000, coversMs: 8000 };
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
const series = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "franchises.json"), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-perf-")), games = path.join(home, "The Retro Shelf", "Games");
const consoles = Object.entries(cfg.systems).filter(([, s]) => !s.names);
const real = Object.values(series).flat();
for (let i = 0; i < N; i++) {
  const [system, name] = i < real.length ? real[i] : [consoles[i % consoles.length][0], `Test Game ${String(i).padStart(5, "0")} (USA)`];
  const s = cfg.systems[system], dir = path.join(games, s.folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name.replace(/[\\/:*?"<>|]/g, "_") + (s.exts.find(e => ![".zip", ".7z"].includes(e)) || s.exts[0])), "");
}
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "data", "settings.json"), JSON.stringify({ ui: { welcomed: true, autoCovers: false, updates: false, sound: false } }));
fs.writeFileSync(path.join(home, "data", "state.json"), JSON.stringify({ seenVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version }));

const electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const t0 = Date.now();
const app = spawn(given || electron, [...(given ? [] : ["."]), `--remote-debugging-port=${PORT}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  { cwd: ROOT, env: { ...process.env, ARCADE_HOME: home, RETRO_SHELF_TEST: "1" }, stdio: "ignore", shell: !given && process.platform === "win32" });
const out = {}, over = [];
try {
  let ws = null;
  for (let i = 0; i < 240 && !ws; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page" && x.url.startsWith("arcade://app"));
      if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; }); }
    } catch { ws = null; }
    if (!ws) await sleep(250);
  }
  if (!ws) throw new Error("the window never opened");
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // whether pages are drawn with a graphics chip: the browser's own session knows, not the page's
  const gpu = await (async () => {
    try {
      const b = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
      await new Promise((ok, bad) => { b.onopen = ok; b.onerror = bad; });
      const r = await new Promise(res => { b.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) res(d); }; b.send(JSON.stringify({ id: 1, method: "SystemInfo.getInfo" })); });
      b.close();
      return ((r.result && r.result.gpu.featureStatus) || {}).gpu_compositing || "";
    } catch { return ""; }
  })();
  out.drawing = /^enabled/.test(gpu) ? "graphics chip" : "software";
  if (out.drawing === "software") Object.assign(LIMITS, SOFTWARE);
  for (let i = 0; i < 600; i++) { if (await ev(`typeof G !== "undefined" && !document.querySelector("#splash") && document.querySelectorAll("#shelves .card").length > 0 ? G.length : 0`)) break; await sleep(100); }
  out.games = await ev("G.length");
  out.readyS = +((Date.now() - t0) / 1000).toFixed(1);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Performance.enable");
  await sleep(1500);
  // scrolling all the way down, 40 pixels a frame, timing each frame
  out.scroll = await ev(`(async () => { const root = document.querySelector('#shelves'); root.scrollTop = 0; await new Promise(r => setTimeout(r, 300));
    const d = []; let last = performance.now(); const end = last + 6000;
    await new Promise(done => { const f = now => { d.push(now - last); last = now; root.scrollTop += 40; if (now < end && root.scrollTop + root.clientHeight < root.scrollHeight) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); });
    d.shift(); d.sort((a, b) => a - b);
    return { frames: d.length, avgMs: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1), p95Ms: +d[Math.floor(d.length * .95)].toFixed(1) }; })()`);
  // a key press: until the next two frames are drawn
  out.key = await ev(`(async () => { setKb(true); document.querySelector('#shelves').scrollTop = 0; focusById(null); await new Promise(r => setTimeout(r, 400)); const r = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); moveH(1); await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))); r.push(performance.now() - t); await new Promise(res => setTimeout(res, 120)); }
    r.sort((a, b) => a - b); return { medianMs: Math.round(r[10]), worstMs: Math.round(r[19]) }; })()`);
  // things that draw the wall again: a favorite (the Favorites shelf changes), a search, and the Covers style (every box
  // face-out), each until its next two frames are drawn
  const frames = "new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))";
  out.favMs = await ev(`(async () => { const g = G[Math.floor(G.length / 2)], t = performance.now(); await toggleFav(g.id); await ${frames}; const ms = performance.now() - t; await toggleFav(g.id); return Math.round(ms); })()`);
  out.searchMs = await ev(`(async () => { const t = performance.now(); setQ("mario"); await ${frames}; const ms = performance.now() - t; setQ(""); await ${frames}; return Math.round(ms); })()`);
  out.coversMs = await ev(`(async () => { const was = UI.shelf, t = performance.now(); UI.shelf = "covers"; renderShelves(focusId); await ${frames}; const ms = performance.now() - t;
    await new Promise(r => setTimeout(r, 1500)); const asked = [...document.querySelectorAll("#shelves .cv img")].length; UI.shelf = was; renderShelves(focusId); await ${frames}; return Math.round(ms); })()`);
  const m = Object.fromEntries((await send("Performance.getMetrics")).result.metrics.map(x => [x.name, x.value]));
  out.heapMB = Math.round(m.JSHeapUsedSize / 1048576); out.nodes = m.Nodes;
  ws.close();
  if (out.games !== N) over.push(`the shelf has ${out.games} games, not ${N}`);
  if (out.readyS > LIMITS.readyS) over.push(`the shelf took ${out.readyS} s (limit ${LIMITS.readyS})`);
  if (out.scroll.p95Ms > LIMITS.scrollP95Ms) over.push(`scrolling: 95% of frames within ${out.scroll.p95Ms} ms (limit ${LIMITS.scrollP95Ms})`);
  if (out.key.medianMs > LIMITS.keyMedianMs) over.push(`a key press takes ${out.key.medianMs} ms (limit ${LIMITS.keyMedianMs})`);
  if (out.heapMB > LIMITS.heapMB) over.push(`memory ${out.heapMB} MB (limit ${LIMITS.heapMB})`);
  for (const [k, what] of [["favMs", "a favorite"], ["searchMs", "a search"], ["coversMs", "the Covers style"]])
    if (out[k] > LIMITS[k]) over.push(`${what} takes ${out[k]} ms (limit ${LIMITS[k]})`);
} catch (e) {
  over.push("the test stopped: " + e.message);
} finally {
  try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"]) : process.kill(app.pid, "SIGTERM"); } catch {}
  await sleep(1500);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}
console.log(JSON.stringify(out));
if (over.length) { console.error("FAILED:\n  " + over.join("\n  ")); process.exit(1); }
console.log(`ok: ${N} games within every limit`);
process.exit(0);

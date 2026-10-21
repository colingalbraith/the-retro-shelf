#!/usr/bin/env node
// Opens the built app the way someone would and checks it works: on Windows it runs the installer first, then the
// app starts on an empty profile holding tiny test programs for NES, Game Boy, GBA, Genesis and Master System (made
// here: each loops on a blank screen, which is enough to see its emulator start), the shelf shows them, and each
// starts in the bundled RetroArch (with the old-TV picture, which needs the right graphics driver) and closes
// again. CI runs it after each build; a screenshot of the shelf and RetroArch's logs end up in dist/smoke.
//   node scripts/smoke.mjs [path to the app's executable]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist"), OUT = path.join(DIST, "smoke"), PORT = 9339;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const step = s => console.log("· " + s);
fs.mkdirSync(OUT, { recursive: true });

/** the app to run: the one given, the one the Windows installer puts in place, or the Mac .app in dist */
function findApp() {
  if (process.argv[2]) return process.argv[2];
  if (process.platform === "win32") {
    const setup = fs.readdirSync(DIST).find(f => /Setup.*\.exe$/.test(f));
    if (!setup) throw new Error("no installer in dist/");
    step("installing " + setup);
    // an installer can't run while the app is open or another installer is still going (an earlier step's): close the
    // app, and try again a little later
    let r = null;
    for (let i = 0; i < 3 && (!r || r.status !== 0); i++) {
      if (i) { console.log("  (the installer couldn't run yet; trying again)"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000); }
      spawnSync("taskkill", ["/IM", "The Retro Shelf.exe", "/T", "/F"], { stdio: "ignore" });
      r = spawnSync(path.join(DIST, setup), ["/S"], { stdio: "inherit" });
    }
    if (r.status !== 0) throw new Error("the installer failed (" + r.status + ")");
    // a one-click install goes in the user's Programs folder
    const progs = path.join(process.env.LOCALAPPDATA, "Programs");
    for (const d of fs.readdirSync(progs)) {
      const exe = path.join(progs, d, "The Retro Shelf.exe");
      if (fs.existsSync(exe)) return exe;
    }
    throw new Error("the installer finished, but The Retro Shelf.exe isn't in " + progs);
  }
  const dir = process.arch === "arm64" ? "mac-arm64" : "mac";
  return path.join(DIST, dir, "The Retro Shelf.app", "Contents", "MacOS", "The Retro Shelf");
}

/** NES: one 16 KB program bank, no graphics ROM, mapper 0; sei; cld; loop: jmp loop (and an rti for interrupts) */
function nes() {
  const b = Buffer.alloc(16 + 16384);
  Buffer.from("NES\x1a\x01\x00", "latin1").copy(b);
  Buffer.from([0x78, 0xd8, 0x4c, 0x02, 0x80, 0x40]).copy(b, 16);
  const vec = (at, to) => b.writeUInt16LE(to, 16 + at);
  vec(0x3ffa, 0x8005); vec(0x3ffc, 0x8000); vec(0x3ffe, 0x8005);       // NMI, reset, IRQ
  return b;
}
/** Game Boy: 32 KB, no mapper; at the entry point nop; jp $150, and there jr -2 */
function gb() {
  const b = Buffer.alloc(32768);
  Buffer.from([0x00, 0xc3, 0x50, 0x01]).copy(b, 0x100);
  Buffer.from("SMOKE TEST", "latin1").copy(b, 0x134);
  let x = 0; for (let i = 0x134; i <= 0x14c; i++) x = (x - b[i] - 1) & 0xff; b[0x14d] = x;   // header checksum
  Buffer.from([0x18, 0xfe]).copy(b, 0x150);
  return b;
}
/** GBA: 64 KB; the ARM entry branches past the header to b . */
function gba() {
  const b = Buffer.alloc(65536);
  b.writeUInt32LE(0xea00002e, 0);                                      // b $c0
  Buffer.from("SMOKETEST", "latin1").copy(b, 0xa0);
  b[0xb2] = 0x96;
  let c = 0; for (let i = 0xa0; i <= 0xbc; i++) c = (c - b[i]) & 0xff; b[0xbd] = (c - 0x19) & 0xff;   // header checksum
  b.writeUInt32LE(0xeafffffe, 0xc0);                                   // b .
  return b;
}
/** Genesis: 128 KB; the stack and reset vectors, every other vector at the same loop, and there bra.s * */
function md() {
  const b = Buffer.alloc(131072);
  b.writeUInt32BE(0x00fffe00, 0);
  for (let v = 4; v < 0x100; v += 4) b.writeUInt32BE(0x200, v);
  Buffer.from("SEGA MEGA DRIVE SMOKE TEST", "latin1").copy(b, 0x100);
  b.writeUInt16BE(0x60fe, 0x200);
  return b;
}
/** Master System: 32 KB; di; jr -2 */
function sms() {
  const b = Buffer.alloc(32768);
  Buffer.from([0xf3, 0x18, 0xfe]).copy(b, 0);
  Buffer.from("TMR SEGA", "latin1").copy(b, 0x7ff0);
  return b;
}
const GAMES = [["nes", "Smoke Test (World).nes", nes], ["gb", "Smoke Test GB (World).gb", gb], ["gba", "Smoke Test GBA (World).gba", gba],
  ["genesis", "Smoke Test MD (World).md", md], ["sms", "Smoke Test SMS (World).sms", sms], ["gg", "Smoke Test GG (World).gg", sms],
  ["sg1000", "Smoke Test SG (World).sg", sms]];
// each console's own picture (By console): old TV, handheld screen, or plain sharp pixels
const PICTURE = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8")).systems).map(([k, v]) => [k, v.picture]));

/** a DevTools session with the app's page */
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find(x => x.type === "page" && x.url.startsWith("arcade://app"));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        let id = 0;
        const pending = new Map(), errors = [];
        ws.onmessage = m => {
          const d = JSON.parse(m.data);
          if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
          if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
        };
        const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const evaluate = async expr => {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
          return r.result.result.value;
        };
        await send("Runtime.enable");
        return { ws, send, evaluate, errors };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("the app's window never opened");
}

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(what);
    await sleep(400);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-smoke-"));
const log = path.join(home, "data", "logs", "retroarch.log");
for (const [folder, file, make] of GAMES) {
  fs.mkdirSync(path.join(home, "The Retro Shelf", "Games", folder), { recursive: true });
  fs.writeFileSync(path.join(home, "The Retro Shelf", "Games", folder, file), make());
}
fs.mkdirSync(path.join(home, "data"), { recursive: true });
// pictures by console (old TV, or a handheld's screen for Game Boy and GBA), so the graphics driver has to be one that
// runs those shaders; no update checks, this is about the build
fs.writeFileSync(path.join(home, "data", "settings.json"), JSON.stringify({ ui: { picture: "auto", welcomed: true, updates: false } }));

let app = null, failed = false;
try {
  const exe = findApp();
  step("opening " + exe);
  const out = fs.openSync(path.join(OUT, "app.log"), "w");
  app = spawn(exe, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, ARCADE_HOME: home, RETRO_SHELF_TEST: "1" }, stdio: ["ignore", out, out] });
  app.once("exit", code => { if (app) console.log("  (the app closed, code " + code + ")"); });
  const page = await connect();

  const n = await until("the shelf never showed the games", () => page.evaluate(`typeof G !== "undefined" && !document.querySelector("#splash") && document.querySelectorAll(".card").length && G.length`), 60000);
  if (n !== GAMES.length) throw new Error(`the shelf has ${n} games, not ${GAMES.length}`);
  step(`the shelf shows all ${n} test games`);
  // the profile looks like one from before 0.3.0 (welcomed, no version seen), so what's new shows: the changelog is in the build
  await until("the What's new card didn't show", () => page.evaluate(`isOpen("news") && $$("#nlist li").length`), 10000);
  await page.evaluate(`closeNews()`);
  step("the What's new card showed");
  await sleep(1500);
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "shelf.png"), Buffer.from(shot.result.data, "base64"));

  // GitHub's Mac machines have a virtual graphics chip RetroArch's window can't open on (real Macs are fine): there,
  // the check of each game ends once it has loaded into its emulator
  let played = "runs them";
  for (const [, file] of GAMES) {
    const title = file.replace(/ \(World\).*$/, ""), system = await page.evaluate(`(G.find(g => g.title === ${JSON.stringify(title)}) || {}).system`);
    if (!system) throw new Error(`${title} isn't on the shelf`);
    const started = await page.evaluate(`api("/api/launch", {id: G.find(g => g.title === ${JSON.stringify(title)}).id}).then(r => r.ok ? "" : r.data.error || "error")`);
    if (started) throw new Error(`${system}: the game didn't start: ${started}`);
    await sleep(7000);
    const st = await page.evaluate(`api("/api/status").then(r => r.data)`), ra = fs.readFileSync(log, "utf8");
    fs.writeFileSync(path.join(OUT, `retroarch-${system.replace(/\W+/g, "-").toLowerCase()}.log`), ra);
    if (!st.running && process.platform === "darwin" && /Apple Paravirtual device/.test(ra) && /\[Core\] Geometry/.test(ra)) {
      step(`${system}: loaded (its window can't open on this machine's virtual graphics chip)`);
      played = "loads them";
      continue;
    }
    if (!st.running) throw new Error(`${system}: the game closed by itself` + (st.exit && st.exit.error ? ": " + st.exit.error : ""));
    const look = PICTURE[system] === "lcd" ? "handheld" : PICTURE[system] === "crt" ? "old-TV" : "sharp", shader = { handheld: "zfast_lcd", "old-TV": "zfast_crt" }[look];
    if (shader && !new RegExp(`\\[Slang\\] Compiling shader: "[^"]*${shader}`).test(ra)) throw new Error(`${system}: the game runs, but without the ${look} picture (see its retroarch log)`);
    await page.evaluate(`api("/api/stop", {})`);
    const ex = await until(`${system}: the game didn't close when asked`, () => page.evaluate(`api("/api/status").then(r => !r.data.running && r.data.exit)`), 20000);
    if (ex.error) throw new Error(`${system}: the game closed with: ${ex.error}`);
    step(`${system}: running with the ${look} picture, closed after ${Math.round(ex.dt)} s`);
  }

  if (page.errors.length) throw new Error("the page had errors:\n  " + page.errors.join("\n  "));
  page.ws.close();
  console.log("ok: the app " + (process.platform === "win32" ? "installs, " : "") + "opens, finds the games and " + played);
} catch (e) {
  failed = true;
  console.error("FAILED: " + e.message);
} finally {
  try { fs.copyFileSync(log, path.join(OUT, "retroarch.log")); } catch {}
  if (failed) { try { console.error("\n--- the end of retroarch.log ---\n" + fs.readFileSync(log, "utf8").split("\n").slice(-60).join("\n")); } catch {} }
  if (app) {
    const pid = app.pid; app = null;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await sleep(1500);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

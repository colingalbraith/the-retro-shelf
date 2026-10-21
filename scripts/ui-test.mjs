#!/usr/bin/env node
// Checks the app's screens the way the 0.3.0 review did by hand: a library of real game names on every console,
// the longest-titled box of each shape turned over at three window sizes (nothing overlapping, running off or cut
// off), every screen at the smallest window and a large one (nothing off the side or cut off), a simulated
// controller through every panel (each opens and B closes it), and no errors on the page.
//   node scripts/ui-test.mjs [the app's executable]      (default: this checkout, run with Electron)
// On Linux, run it under xvfb-run. Pictures of every screen go to dist/ui-test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "ui-test"), PORT = 9343;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
const series = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "franchises.json"), "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

/** a library of real names: per console, its longest names (the hardest to fit) and a few others; empty files are
    enough for the shelves */
function library(games) {
  const by = {};
  for (const list of Object.values(series)) for (const [system, look] of list) (by[system] = by[system] || new Set()).add(look);
  const made = [];
  for (const [system, s] of Object.entries(cfg.systems)) {
    if (s.names) {    // arcade games go by short names
      for (const k of ["sf2", "mslug", "pacman", "dkong", "galaga"]) { fs.mkdirSync(path.join(games, s.folder), { recursive: true }); fs.writeFileSync(path.join(games, s.folder, k + ".zip"), ""); made.push(k + ".zip"); }
      continue;
    }
    // consoles with no series data: names from their game info, or made up when there's none (Sega CD, Saturn)
    let names = [...(by[system] || [])].filter(n => !/\((Disc|Disk|CD) ?\d/i.test(n));
    if (names.length < 4) { try { names = names.concat(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "meta", (s.folder || system) + ".json"), "utf8"))).filter(n => !/\((Disc|Disk|CD) ?\d/i.test(n)).slice(0, 40)); } catch {} }
    if (!names.length) names = ["Test Disc One (USA)", "A Much Longer Test Disc Title - The Second Chapter (USA)"];
    const pick = [...names].sort((a, b) => b.length - a.length).slice(0, 4).concat(names.slice(0, 4));
    const ext = s.exts.find(e => ![".zip", ".7z"].includes(e)) || s.exts[0];
    fs.mkdirSync(path.join(games, s.folder || system.toLowerCase()), { recursive: true });
    for (const name of new Set(pick)) { const f = name.replace(/[\\/:*?"<>|]/g, "_") + ext; fs.writeFileSync(path.join(games, s.folder || system.toLowerCase(), f), ""); made.push(f); }
  }
  return made;
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page" && x.url.startsWith("arcade://app"));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        let id = 0; const pending = new Map(), errors = [];
        ws.onmessage = m => {
          const d = JSON.parse(m.data);
          if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
          if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
        };
        const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async expr => {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
          return r.result.result.value;
        };
        await send("Runtime.enable");
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        return { ws, send, ev, errors };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("the app's window never opened");
}

// --- the checks, run in the page ---------------------------------------------------------------------------------
/* every shape of box: the longest titles turned over, and what overlaps, runs off the bottom or is cut off */
const BACKS = `(async () => {
  const out = [], wait = ms => new Promise(r => setTimeout(r, ms)), byType = {};
  for (const c of document.querySelectorAll("#shelves .card")) { const g = byId.get(c.dataset.id); if (g) (byType[c.dataset.m] = byType[c.dataset.m] || []).push([c, g]); }
  for (const [m, list] of Object.entries(byType)) {
    list.sort((a, b) => b[1].title.length - a[1].title.length);
    for (let [c, g] of list.slice(0, 3)) {
      // turned over and filled in: a moment on a fast computer, longer where drawing is slow. If the shelf is drawn
      // again meanwhile (after a resize), the box is a new one: find it and turn that over
      for (let tries = 0; tries < 3; tries++) {
        if (!c.isConnected) c = document.querySelector('#shelves .card[data-id="' + g.id + '"]') || c;
        select(c); await wait(300); flip(true);
        for (let i = 0; i < 30 && c.isConnected && !c.querySelector(".bk .in"); i++) await wait(100);
        if (c.isConnected && c.querySelector(".bk .in")) break;
      }
      await wait(650);
      const inn = c.querySelector(".bk .in");
      if (!inn) { if (!c.closest(".lslot")) out.push(m + " box, " + g.title + ": didn't turn over"); continue; }
      const kids = [...inn.children].filter(e => e.offsetHeight && getComputedStyle(e).display !== "none"), bad = [];
      if (inn.scrollHeight > inn.clientHeight + 1) bad.push("runs off the bottom");
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i], b = kids[j];
        const ox = Math.min(a.offsetLeft + a.offsetWidth, b.offsetLeft + b.offsetWidth) - Math.max(a.offsetLeft, b.offsetLeft);
        const oy = Math.min(a.offsetTop + a.offsetHeight, b.offsetTop + b.offsetHeight) - Math.max(a.offsetTop, b.offsetTop);
        if (ox > 2 && oy > 2) bad.push((a.className || a.tagName) + " over " + (b.className || b.tagName));
      }
      for (const e of inn.querySelectorAll("h4,dd,button,.sub,.sub2,.fine,.fresh,.slots")) if (e.offsetWidth && e.scrollWidth > e.clientWidth + 1) bad.push((e.className || e.tagName) + " cut off");
      if (bad.length) out.push(m + " box, " + g.title + ": " + bad.join(", "));
      flip(false); await wait(200);
    }
  }
  return out;
})()`;
/* the panel that's open: anything off the side of the window or cut off (rows of boxes that scroll sideways and
   text boxes, which scroll their own text, are fine) */
const PANEL = `(() => { const out = [], vis = e => e.offsetWidth && getComputedStyle(e).visibility !== "hidden";
  const root = [...document.querySelectorAll("#settings,#getg,#pick,#colls,#trophy,.over,#opts,#osk,#imp")].find(e => e.classList.contains("show")) || document.body;
  for (const e of root.querySelectorAll("button,h2,h3,b,.tplate,label,kbd")) {
    if (!vis(e) || e.closest(".strip,#pgrid")) continue;
    const r = e.getBoundingClientRect(), name = (e.textContent || e.id || e.tagName).trim().slice(0, 30);
    /* below the window, with nothing to scroll it into view */
    let sc = e.parentElement; while (sc && sc !== root && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
    if (r.top > innerHeight - 4 && (!sc || sc === root) && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) out.push(name + " below the window");
    if (r.right > innerWidth + 1 || r.left < -1) out.push(name + " off the side");
    else if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== "visible") out.push(name + " cut off");
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push("the window scrolls sideways");
  return out; })()`;
/* text straight on the wall or a panel's own color, too faint to read: under 3:1 against what's behind it. Text over
   pictures and patterns (box art, spines, wood) is left out */
const CONTRAST = `(() => {
  const rgb = s => (s.match(/[\\d.]+/g) || []).map(Number), out = new Set();
  const lum = c => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const css = getComputedStyle(document.documentElement), wall = rgb(css.getPropertyValue("--wall").trim().replace(/^#(..)(..)(..)$/, (_, a, b, c) => [a, b, c].map(h => parseInt(h, 16)).join(",")));
  const bgOf = e => {
    for (let n = e; n; n = n.parentElement) {
      if (["app", "shelves", "trophy", "colls"].includes(n.id) || n === document.body) return wall;
      const cs = getComputedStyle(n); if (cs.backgroundImage !== "none") return null;
      const c = rgb(cs.backgroundColor); if (c.length === 3 || c[3] > .85) return c;
    }
    return wall;
  };
  const root = [...document.querySelectorAll("#settings,#getg,#colls,#trophy,.over")].find(e => e.classList.contains("show")) || document.getElementById("app");
  for (const e of root.querySelectorAll("*")) {
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || !e.offsetWidth) continue;
    const cs = getComputedStyle(e); if (cs.visibility === "hidden" || +cs.opacity < .5 || e.closest(".card,.cv,.ci,.tro,.svpic,svg")) continue;
    const bg = bgOf(e), fg = rgb(cs.color); if (!bg) continue;
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x), ratio = (a + .05) / (b + .05);
    if (ratio < 3) out.add(e.textContent.trim().slice(0, 30) + " (" + ratio.toFixed(1) + ":1)");
  }
  return [...out]; })()`;
const SCREENS = [
  ["settings", "openSettings()", "closeSettings()"],
  ["settings-end", "openSettings(); setTimeout(() => { $('#spanel').scrollTop = 1e6; }, 100)", "closeSettings()"],
  ["collections", "openColls('series')", "closeColls()"],
  ["collections-yours", "openColls('mine')", "closeColls()"],
  ["your-play", "openTrophy()", "closeTrophy()"],
  ["your-play-pins", "openTrophy(); setTimeout(() => document.querySelector('#cork').scrollIntoView(), 700)", "closeTrophy()"],
  ["get-games", "openGetGames()", "closeGetGames()"],
  ["find-cover", "openPicker(G[0].id)", "closePicker()"],
  ["welcome", "$('#welcome').classList.add('show')", "$('#welcome').classList.remove('show')"],
  ["options", "openOpts()", "closeOpts()"],
  ["keyboard", "openOsk($('#q'))", "closeOsk(); setQ('')"],
  ["rename", "openRename(G.slice().sort((a, b) => b.title.length - a.title.length)[0].id)", "closeRename()"],
  ["new-shelf", "openShelfSlip({})", "closeShelfSlip()"],
  ["sign-in", "openRas()", "closeRas()"],
  ["controller-test", "openCtest()", "closeCtest()"],
  ["buttons", "openButtons(G.find(g => cons(g.system).buttons && cons(g.system).builtin).system)", "closeList()"],
  ["choose-folder", "openBrowse()", "closeList()"],
  // a month's recap filled in, with the longest titles in the library as its most played
  ["recap", `(() => { const long = G.slice().sort((a, b) => b.title.length - a.title.length).slice(0, 3), now = Date.now() / 1000;
    RC = {year: 2026, month: 9, from: 0, to: 0, total: 98000, sittings: 41, days: 27, games: 6, newGames: 3, top: long.map((g, i) => ({id: g.id, time: 30000 - i * 5000})),
      longest: {id: long[0].id, time: 8000, at: now}, busiest: {day: now, time: 12000}, first: 1,
      pins: ["first", "sampler", "hours10", "multi", "onemore", "streak3", "weekend", "lunch", "friday", "sunday", "quick", "sessions25"]};
    renderRecap(RC).then(() => $("#recap").classList.add("show")); })()`, "closeRecap()"],
  ["keys", "openKeys()", "closeKeys()"],
  ["screensaver", "UI.tv = true; startSaver()", "stopSaver(); UI.tv = false"],
  ["what-counts", "openColls('series'); setTimeout(() => openCounts(COLL.series[0].name), 700)", "closeList(); closeColls()"],
];

// --- run ---------------------------------------------------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-ui-"));
const made = library(path.join(home, "The Retro Shelf", "Games")), count = made.length;
fs.mkdirSync(path.join(home, "data"), { recursive: true });
// no downloads (the same boxes every run), no sounds, and seen as an update from 0.2.0 so What's new shows
fs.writeFileSync(path.join(home, "data", "settings.json"), JSON.stringify({ ui: { welcomed: true, autoCovers: false, updates: false, sound: false } }));
fs.writeFileSync(path.join(home, "data", "state.json"), JSON.stringify({ seenVersion: "0.2.0" }));

const given = process.argv[2], electron = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const args = [...(given ? [] : ["."]), `--remote-debugging-port=${PORT}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
const app = spawn(given || electron, args, { cwd: ROOT, env: { ...process.env, ARCADE_HOME: home, RETRO_SHELF_TEST: "1" }, stdio: "ignore", shell: !given && process.platform === "win32" });
const problems = [];
try {
  const p = await connect();
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const n = await (async () => { for (let i = 0; i < 120; i++) { const v = await p.ev(`typeof G !== "undefined" && !document.querySelector("#splash") ? G.length : 0`); if (v) return v; await sleep(500); } return 0; })();
  console.log(`· the shelf shows ${n} of ${count} games`);
  if (n !== count) {
    const shown = new Set(await p.ev("G.map(g => g.file)"));
    problems.push(`the shelf has ${n} games, not ${count}; missing: ${made.filter(f => !shown.has(f)).join(", ")}`);
  }

  // What's new, as someone updating from 0.2.0 sees it
  await sleep(1200);
  if (!(await p.ev(`isOpen("news") && $$("#nlist li").length`))) problems.push("What's new didn't show for an update");
  for (const r of await p.ev(PANEL)) problems.push("What's new: " + r);
  await p.ev(`closeNews(), 1`);
  /* HARVEST_WORDS=1: also note every piece of text the screens show, for scripts/words.mjs (a made-up language, so
     every piece goes through the translator, which notes it) */
  const harvest = !!process.env.HARVEST_WORDS;
  if (harvest) await p.ev(`(async () => { HARVEST = new Set(); await setLang("xx"); return 1; })()`);

  for (const [w, h] of [[720, 520], [1000, 650], [1600, 1000]]) {
    await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const bad = await p.ev(BACKS);
    console.log(`· box backs at ${w}×${h}: ${bad.length ? bad.length + " problems" : "ok"}`);
    for (const b of bad) problems.push(`${w}×${h}: ${b}`);
  }

  for (const [w, h] of [[720, 520], [1600, 1000]]) {
    await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    for (const [name, open, close] of SCREENS) {
      await p.ev(open + "; 1"); await sleep(1300);
      const bad = await p.ev(PANEL);
      for (const b of bad) problems.push(`${name} at ${w}×${h}: ${b}`);
      const shot = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      fs.writeFileSync(path.join(OUT, `${name}-${w}x${h}.jpg`), Buffer.from(shot.result.data, "base64"));
      await p.ev(close + "; 1"); await sleep(400);
    }
    console.log(`· screens at ${w}×${h} done`);
  }

  // every wood and wall: the shelves, box backs and the screens that sit on the wall, readable and fitting
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const [wood, wall] of [["walnut", "dark"], ["oak", "dark"], ["white", "dark"], ["walnut", "light"], ["white", "light"], ["cherry", "green"], ["black", "blue"], ["black", "light"]]) {
    await p.ev(`(HTML.dataset.wood = "${wood}", HTML.dataset.wall = "${wall}", 1)`); await sleep(500);
    const theme = `${wood} wood, ${wall} wall`;
    for (const r of await p.ev(CONTRAST)) problems.push(`${theme}, the shelves: ${r} is hard to read`);
    const shot = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    fs.writeFileSync(path.join(OUT, `theme-${wood}-${wall}.jpg`), Buffer.from(shot.result.data, "base64"));
    for (const [name, open, close] of SCREENS.filter(([n]) => ["settings", "collections", "your-play", "recap", "keys", "get-games"].includes(n))) {
      await p.ev(open + "; 1"); await sleep(1300);
      for (const b of await p.ev(PANEL)) problems.push(`${name}, ${theme}: ${b}`);
      for (const r of await p.ev(CONTRAST)) problems.push(`${name}, ${theme}: ${r} is hard to read`);
      if (wall === "light") { const sh = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }); fs.writeFileSync(path.join(OUT, `theme-${wood}-${wall}-${name}.jpg`), Buffer.from(sh.result.data, "base64")); }
      await p.ev(close + "; 1"); await sleep(400);
    }
    console.log(`· ${theme} done`);
  }
  await p.ev(`(HTML.dataset.wood = "walnut", HTML.dataset.wall = "dark", 1)`);

  // a Steam Deck in TV mode: 1280×800, a quarter bigger, so the page has 1024×640
  await p.ev(`(UI.tv = true, applyTv(), 1)`);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 640, deviceScaleFactor: 1.25, mobile: false }); await sleep(800);
  for (const b of await p.ev(BACKS)) problems.push(`Steam Deck (TV mode): ${b}`);
  for (const [name, open, close] of SCREENS) {
    await p.ev(open + "; 1"); await sleep(1300);
    for (const b of await p.ev(PANEL)) problems.push(`${name} on a Steam Deck (TV mode): ${b}`);
    const shot = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    fs.writeFileSync(path.join(OUT, `deck-${name}.jpg`), Buffer.from(shot.result.data, "base64"));
    await p.ev(close + "; 1"); await sleep(400);
  }
  await p.ev(`(UI.tv = false, applyTv(), 1)`);
  console.log("· Steam Deck (TV mode) done");

  // German, Russian and Polish, the longest words (Russian in the computer's own font, which is wider): every screen still fits
  // at the smallest window (and the language comes back)
  for (const [code, lname] of [["de", "German"], ["ru", "Russian"], ["pl", "Polish"]]) {
  if (!harvest && fs.existsSync(path.join(ROOT, "src", "words", code + ".json"))) {
    await p.ev(`(async () => { await setLang("${code}"); renderHints(); renderShelves(focusId); return 1; })()`); await sleep(800);
    await p.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 520, deviceScaleFactor: 1, mobile: false }); await sleep(600);
    const bad = await p.ev(BACKS);
    for (const b of bad) problems.push(`${lname}, 720×520: ${b}`);
    for (const [name, open, close] of SCREENS) {
      await p.ev(open + "; 1"); await sleep(1300);
      for (const b of await p.ev(PANEL)) problems.push(`${name} in ${lname} at 720×520: ${b}`);
      const shot = await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
      fs.writeFileSync(path.join(OUT, `${code}-${name}-720x520.jpg`), Buffer.from(shot.result.data, "base64"));
      await p.ev(close + "; 1"); await sleep(400);
    }
    await p.ev(`(async () => { await setLang("en"); renderHints(); renderShelves(focusId); return 1; })()`); await sleep(500);
    await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    console.log(`· ${lname} done`);
  }
  }

  // a controller through every panel: Select opens options, each panel opens from there, B closes it
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await p.ev(`(() => { document.hasFocus = () => true;
    window.FAKEPAD = {id: "Xbox Wireless Controller (STANDARD GAMEPAD)", connected: true, axes: [0, 0, 0, 0], buttons: Array.from({length: 17}, () => ({pressed: false}))};
    navigator.getGamepads = () => [FAKEPAD]; return 1; })()`);
  // each controller's own button names: told apart by name
  for (const [id, style] of [["Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)", "xbox"], ["Xbox 360 Controller (XInput STANDARD GAMEPAD)", "xbox"],
    ["Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)", "playstation"], ["DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", "playstation"],
    ["Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)", "nintendo"]]) {
    const got = await p.ev(`padStyle({id: ${JSON.stringify(id)}})`);
    if (got !== style) problems.push(`controller names: "${id}" is taken for ${got}, not ${style}`);
  }
  const B = { a: 0, b: 1, y: 3, rb: 5, sel: 8, st: 9, u: 12, d: 13, r: 15 };
  const tap = async k => { await p.ev(`FAKEPAD.buttons[${B[k]}] = {pressed: true}, 1`); await sleep(140); await p.ev(`FAKEPAD.buttons[${B[k]}] = {pressed: false}, 1`); await sleep(180); };
  const top = () => p.ev(`(topPanel() || [""])[0]`);
  await tap("r"); await tap("y"); await sleep(500);
  if (!(await p.ev(`!!(sel && sel.classList.contains("flip"))`))) problems.push("controller: Y didn't turn the box over");
  await tap("b"); await sleep(300);
  for (const item of ["Collections", "Your play", "Settings"]) {
    await tap("sel"); await sleep(300);
    if (await top() !== "opts") { problems.push("controller: Select didn't open options"); break; }
    await p.ev(`[...document.querySelectorAll("#optl button")].find(b => b.textContent === ${JSON.stringify(item)}).focus(), 1`);
    await tap("a"); await sleep(1200);
    const open = await top();
    if (!open || open === "opts") problems.push(`controller: ${item} didn't open`);
    if (open === "colls") { await tap("rb"); await sleep(300); }
    for (let i = 0; i < 3; i++) { await tap("d"); }
    await tap("b"); await sleep(500);
    if (await top()) problems.push(`controller: B didn't close ${item} (${await top()} still open)`);
  }
  await tap("st"); await sleep(600);
  if (await top() !== "settings") problems.push("controller: Start didn't open Settings");
  await tap("b"); await sleep(400);
  console.log("· controller walk done");

  if (harvest) {
    const seen = await p.ev(`JSON.stringify({seen: [...HARVEST], titles: G.map(g => g.title), systems: SYSTEMS})`);
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true }); fs.writeFileSync(path.join(ROOT, "dist", "words-seen.json"), seen);
    console.log("· noted " + JSON.parse(seen).seen.length + " pieces of text in dist/words-seen.json");
  }
  for (const e of p.errors) problems.push("page error: " + e);
  p.ws.close();
} catch (e) {
  problems.push("the test stopped: " + e.message);
} finally {
  try { process.platform === "win32" ? spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"]) : process.kill(app.pid, "SIGTERM"); } catch {}
  await sleep(1500);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}
if (problems.length) { console.error(`FAILED: ${problems.length} problems\n  ` + problems.join("\n  ")); process.exit(1); }
console.log("ok: every screen fits, every box back fits, the controller reaches every panel, no errors");
process.exit(0);

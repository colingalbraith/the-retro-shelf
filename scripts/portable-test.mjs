#!/usr/bin/env node
// Checks the portable Windows copy keeps to its own folder: opens dist/The Retro Shelf/The Retro Shelf.exe (beside
// its portable.txt), waits for the shelf, and passes when what it keeps and its games folder are in the Data folder beside
// it. CI runs it after making the portable .zip.
//   node scripts/portable-test.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "dist", "The Retro Shelf"), EXE = path.join(DIR, "The Retro Shelf.exe"), DATA = path.join(DIR, "Data"), PORT = 9343;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let app = null, failed = false;
try {
  if (!fs.existsSync(path.join(DIR, "portable.txt"))) throw new Error("no portable.txt beside the app");
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, RETRO_SHELF_TEST: "1" }; delete env.ARCADE_HOME;
  app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: "ignore" });
  // the shelf page is up once DevTools lists it
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some(t => t.type === "page" && t.url.startsWith("arcade://app")); } catch {}
    if (!up) await sleep(1000);
  }
  if (!up) throw new Error("the app didn't open");
  await sleep(3000);
  for (const p of [path.join(DATA, "data", "state.json"), path.join(DATA, "The Retro Shelf")])
    if (!fs.existsSync(p)) throw new Error(`${path.relative(DIR, p)} isn't there: the app kept its things somewhere else`);
  console.log("ok: the portable copy keeps its settings and games in the Data folder beside it");
} catch (e) {
  failed = true;
  console.error("FAILED: " + e.message);
} finally {
  if (app) spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1500);
  // the zip is already made; the test's Data folder goes
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

#!/usr/bin/env node
// Downloads RetroArch and the libretro cores The Retro Shelf ships with into vendor/<os>/,
// which electron-builder copies into the app as Resources/emulators.
//
//   node scripts/fetch-emulators.mjs mac   -> vendor/mac/{RetroArch.app,cores,info,dolphin-Sys,PPSSPP,shaders}
//   node scripts/fetch-emulators.mjs win   -> vendor/win/{RetroArch,cores,info,dolphin-Sys,PPSSPP,shaders}
//
// Cores come from src/config.json (every system with a "core"). Downloads are cached in vendor/.cache.
// No games are downloaded, ever.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RA_VERSION = "1.22.2";
const BOT = "https://buildbot.libretro.com";
// The old-TV and handheld looks (Settings → Picture): zfast-crt and zfast-lcd from libretro's shader collection,
// pinned to one commit
const SHADERS = "https://raw.githubusercontent.com/libretro/slang-shaders/e1d75632a205";
const SHADER_FILES = ["crt/zfast-crt.slangp", "crt/shaders/zfast_crt/zfast_crt_finemask.slang", "crt/shaders/zfast_crt/zfast_crt_impl.inc",
  "handheld/zfast-lcd.slangp", "handheld/shaders/zfast_lcd.slang"];
// Dolphin's libretro core needs the Sys folder from the same source tree it was built from.
const DOLPHIN_SYS_REPO = "https://github.com/libretro/dolphin.git";

const os_ = process.argv[2] || (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "");
if (!["mac", "win"].includes(os_)) {
  console.error("usage: fetch-emulators.mjs mac|win");
  process.exit(1);
}
const OUT = path.join(ROOT, "vendor", os_);
const CACHE = path.join(ROOT, "vendor", ".cache");
const SEVEN = require("7zip-bin").path7za;
// npm doesn't always keep the executable bit on 7zip-bin's binary
try { fs.chmodSync(SEVEN, 0o755); } catch {}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
const CORES = [...new Set(Object.values(cfg.systems).map(s => s.core).filter(Boolean))].sort();

// RetroArch extras we never use: the game database, cheats, shaders, touch overlays, and so on.
const TRIM = ["database", "cheats", "overlays", "overlay", "layouts", "filters", "shaders", "downloads", "playlists", "thumbnails", "logs", "screenshots", "system", "saves", "states", "info", "cores"];
// Menu assets kept: the Ozone menu, its fonts and sounds. The rest (XMB, RGUI, GLUI themes) is ~60 MB.
const KEEP_ASSETS = ["ozone", "pkg", "sounds"];

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts }).toString();
}
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function mb(p) {
  let n = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(f); else n += fs.statSync(f).size; } };
  fs.statSync(p).isDirectory() ? walk(p) : (n = fs.statSync(p).size);
  return (n / 1048576).toFixed(0) + " MB";
}

async function download(url, name) {
  const dest = path.join(mkdir(CACHE), name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  process.stdout.write(`  downloading ${url}\n`);
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TheRetroShelfBuild/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(dest + ".part", Buffer.from(await r.arrayBuffer()));
      fs.renameSync(dest + ".part", dest);
      return dest;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      await new Promise(s => setTimeout(s, 2000 * attempt));
    }
  }
}

function unzip(archive, dir) {
  mkdir(dir);
  sh(SEVEN, ["x", "-y", "-bso0", "-bsp0", `-o${dir}`, archive]);
}

async function core(arch, name, ext) {
  const plat = os_ === "mac" ? `apple/osx/${arch}` : "windows/x86_64";
  const zip = await download(`${BOT}/nightly/${plat}/latest/${name}${ext}.zip`, `${os_}-${arch}-${name}${ext}.zip`);
  const dir = path.join(CACHE, "x", `${os_}-${arch}-${name}`);
  rm(dir); unzip(zip, dir);
  return path.join(dir, name + ext);
}

async function cores() {
  const dir = mkdir(path.join(OUT, "cores"));
  for (const c of CORES) {
    if (os_ === "mac") {
      // One universal dylib per core so the app runs natively on Apple Silicon and Intel.
      const a = await core("arm64", c, ".dylib"), x = await core("x86_64", c, ".dylib");
      const dest = path.join(dir, c + ".dylib");
      sh("lipo", ["-create", a, x, "-output", dest]);
      adhoc(dest);
    } else {
      fs.copyFileSync(await core("x86_64", c, ".dll"), path.join(dir, c + ".dll"));
    }
    console.log(`  core ${c}`);
  }
}

async function infos() {
  const zip = await download(`${BOT}/assets/frontend/info.zip`, "info.zip");
  const tmp = path.join(CACHE, "x", "info"); rm(tmp); unzip(zip, tmp);
  const dir = mkdir(path.join(OUT, "info"));
  for (const c of CORES) {
    const f = path.join(tmp, c + ".info");
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, c + ".info"));
    else console.warn(`  (no .info for ${c})`);
  }
}

async function autoconfig(have) {
  if (have) return;
  const zip = await download(`${BOT}/assets/frontend/autoconfig.zip`, "autoconfig.zip");
  unzip(zip, path.join(OUT, "autoconfig"));
}

function trim(base) {
  for (const t of TRIM) rm(path.join(base, t));
  const a = path.join(base, "assets");
  if (fs.existsSync(a)) for (const n of fs.readdirSync(a)) if (!KEEP_ASSETS.includes(n)) rm(path.join(a, n));
}

// Ad-hoc signature with no entitlements and no hardened runtime: Apple Silicon needs every binary signed,
// and RetroArch's own iCloud entitlements are only valid under libretro's team ID. A Developer ID build
// re-signs everything anyway (see build/entitlements.mac.plist).
function adhoc(p, deep) {
  sh("codesign", ["--force", "--sign", "-", "--timestamp=none", ...(deep ? ["--deep"] : []), p]);
}

async function retroarchMac() {
  const dmg = await download(`${BOT}/stable/${RA_VERSION}/apple/osx/universal/RetroArch_Metal.dmg`, `RetroArch_Metal-${RA_VERSION}.dmg`);
  const mnt = path.join(CACHE, "mnt");
  rm(mnt); mkdir(mnt);
  sh("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mnt, dmg]);
  try {
    const app = fs.readdirSync(mnt).find(n => n.endsWith(".app"));
    if (!app) throw new Error("no .app in RetroArch dmg");
    // ditto keeps the bundle's symlinks, permissions and extended attributes intact
    sh("ditto", [path.join(mnt, app), path.join(OUT, "RetroArch.app")]);
  } finally {
    sh("hdiutil", ["detach", mnt, "-quiet"]);
  }
  const app = path.join(OUT, "RetroArch.app"), res = path.join(app, "Contents", "Resources");
  // The Mac build packs its menu assets, shaders and database into a 180 MB assets.zip that it unpacks on
  // first launch. Take only what the menu needs, unpacked, and drop the zip.
  const zip = path.join(res, "assets.zip");
  const tmp = path.join(CACHE, "x", "ra-mac-assets"); rm(tmp);
  mkdir(tmp);
  sh(SEVEN, ["x", "-y", "-bso0", "-bsp0", `-o${tmp}`, zip, ...KEEP_ASSETS.map(k => `assets/${k}/*`), "autoconfig/*"]);
  fs.cpSync(path.join(tmp, "assets"), path.join(OUT, "assets"), { recursive: true });
  fs.cpSync(path.join(tmp, "autoconfig"), path.join(OUT, "autoconfig"), { recursive: true });
  rm(zip);
  rm(path.join(app, "Contents", "embedded.provisionprofile"));
  adhoc(app, true);
  return true;
}

async function retroarchWin() {
  const z = await download(`${BOT}/stable/${RA_VERSION}/windows/x86_64/RetroArch.7z`, `RetroArch-win-${RA_VERSION}.7z`);
  const tmp = path.join(CACHE, "x", "ra-win"); rm(tmp); unzip(z, tmp);
  // the archive holds one top-level folder (RetroArch-Win64)
  const top = fs.readdirSync(tmp).map(n => path.join(tmp, n)).find(p => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "retroarch.exe"))) || tmp;
  fs.cpSync(top, path.join(OUT, "RetroArch"), { recursive: true });
  const base = path.join(OUT, "RetroArch");
  trim(base);
  for (const f of ["retroarch_debug.exe", "retroarch.cfg"]) rm(path.join(base, f));
  return fs.existsSync(path.join(base, "autoconfig"));
}

function dolphinSys() {
  const dest = path.join(OUT, "dolphin-Sys");
  const src = path.join(CACHE, "dolphin-src");
  if (!fs.existsSync(path.join(src, "Data", "Sys"))) {
    rm(src);
    console.log("  fetching Dolphin Sys folder");
    sh("git", ["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", DOLPHIN_SYS_REPO, src]);
    sh("git", ["-C", src, "sparse-checkout", "set", "Data/Sys"]);
  }
  fs.cpSync(path.join(src, "Data", "Sys"), dest, { recursive: true });
}

// PPSSPP's core needs its fonts and system dialogs (PPSSPP/ppge_atlas.zim and friends) in the BIOS folder
async function ppssppAssets() {
  const z = await download(`${BOT}/assets/system/PPSSPP.zip`, "PPSSPP-system.zip");
  const tmp = path.join(CACHE, "x", "ppsspp"); rm(tmp); unzip(z, tmp);
  fs.cpSync(path.join(tmp, "PPSSPP"), path.join(OUT, "PPSSPP"), { recursive: true });
  console.log("  PPSSPP system files");
}

async function pictureShaders() {
  for (const f of SHADER_FILES) {
    const src = await download(`${SHADERS}/${f}`, "shader-" + f.replace(/\//g, "-"));
    fs.mkdirSync(path.dirname(path.join(OUT, "shaders", f)), { recursive: true });
    fs.copyFileSync(src, path.join(OUT, "shaders", f));
  }
  console.log("  old-TV and handheld shaders");
}

(async () => {
  console.log(`The Retro Shelf: fetching emulators for ${os_} -> ${path.relative(ROOT, OUT)}`);
  rm(OUT); mkdir(OUT);
  const hasAuto = os_ === "mac" ? await retroarchMac() : await retroarchWin();
  console.log(`  RetroArch ${RA_VERSION}`);
  await autoconfig(hasAuto);
  await cores();
  await infos();
  if (CORES.includes("dolphin_libretro")) dolphinSys();
  if (CORES.includes("ppsspp_libretro")) await ppssppAssets();
  await pictureShaders();
  fs.writeFileSync(path.join(OUT, "versions.json"), JSON.stringify({ retroarch: RA_VERSION, cores: CORES, fetched: new Date().toISOString() }, null, 2));
  console.log(`Done: ${mb(OUT)} in ${path.relative(ROOT, OUT)}`);
})().catch(e => { console.error(e.message || e); process.exit(1); });

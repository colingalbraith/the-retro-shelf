"use strict";
// The RetroArch that ships inside The Retro Shelf: where its pieces live, the config it runs with,
// and turning its log into a sentence when a game won't start.
const fs = require("fs");
const path = require("path");

const CORE_EXT = { win32: ".dll", darwin: ".dylib" }[process.platform] || ".so";

function firstDir(...ps) { return ps.find(p => p && fs.existsSync(p)) || ps[0]; }

/** Paths of the bundled emulator, or null when this build has none (running from source without vendor/). */
function bundled(emuDir) {
  if (!emuDir || !fs.existsSync(emuDir)) return null;
  const mac = process.platform === "darwin";
  const raDir = mac ? path.join(emuDir, "RetroArch.app") : path.join(emuDir, "RetroArch");
  const exe = mac ? path.join(raDir, "Contents", "MacOS", "RetroArch")
    : path.join(raDir, process.platform === "win32" ? "retroarch.exe" : "retroarch");
  if (!fs.existsSync(exe)) return null;
  let version = "";
  try { version = JSON.parse(fs.readFileSync(path.join(emuDir, "versions.json"), "utf8")).retroarch || ""; } catch {}
  return {
    exe,
    version,
    cores: path.join(emuDir, "cores"),
    info: path.join(emuDir, "info"),
    assets: firstDir(path.join(emuDir, "assets"), path.join(raDir, "assets")),
    autoconfig: firstDir(path.join(emuDir, "autoconfig"), path.join(raDir, "autoconfig")),
    dolphinSys: path.join(emuDir, "dolphin-Sys"),
    ppsspp: path.join(emuDir, "PPSSPP"),
    crt: path.join(emuDir, "shaders", "crt", "zfast-crt.slangp"),
    lcd: path.join(emuDir, "shaders", "handheld", "zfast-lcd.slangp"),
  };
}

function corePath(dir, core) { return path.join(dir, core + CORE_EXT); }

// RetroArch's own working folders, relative to the app's private RetroArch folder
const PRIVATE_DIRS = {
  rgui_config_directory: "config", input_remapping_directory: "config/remaps", playlist_directory: "playlists",
  runtime_log_directory: "playlists/logs", cache_directory: "cache", core_assets_directory: "downloads",
  thumbnails_directory: "thumbnails", content_database_path: "database", cheat_database_path: "cheats",
  overlay_directory: "overlays", osk_overlay_directory: "overlays/keyboards", log_dir: "logs",
  recording_output_directory: "recordings", recording_config_directory: "recordings/config",
};
/** Folders a launch needs to exist (RetroArch ignores directory settings that point nowhere). */
function neededDirs(dirs) {
  return [dirs.saves, dirs.states, dirs.screenshots, dirs.system, ...Object.values(PRIVATE_DIRS).map(sub => path.join(dirs.private, sub))];
}

const q = v => '"' + String(v).replace(/"/g, "") + '"';

/**
 * Settings the app insists on every launch. Everything else in retroarch.cfg is left alone, so changes
 * people make in RetroArch's own menu stick.
 */
function enforced(ra, dirs, opts) {
  return {
    video_fullscreen: opts.fullscreen ? "true" : "false",
    // Hold Start (or press Esc) to come back to the shelf; hold Select for RetroArch's menu.
    input_quit_gamepad_combo: "7",
    input_menu_toggle_gamepad_combo: "8",
    quit_press_twice: "false",
    // lets the app ask RetroArch to quit cleanly (saving first) from the Stop button
    stdin_cmd_enable: "true",
    savestate_auto_save: opts.resume ? "true" : "false",
    // a launch from a chosen save slot, or "start fresh", skips the resume point
    savestate_auto_load: opts.resume && opts.load !== false ? "true" : "false",
    // the picture: sharp pixels, smoothed, or the scanlines of an old TV or a handheld's screen (a shader, passed with
    // --set-shader)
    video_smooth: opts.picture === "smooth" ? "true" : "false",
    video_shader_enable: opts.picture === "crt" || opts.picture === "lcd" ? "true" : "false",
    // a picture with every save, shown on the back of the box
    savestate_thumbnail_enable: "true",
    autosave_interval: "10",
    savefile_directory: dirs.saves,
    savestate_directory: dirs.states,
    screenshot_directory: dirs.screenshots,
    system_directory: dirs.system,
    // everything else RetroArch writes stays in the app's data folder, apart from any other RetroArch install
    ...Object.fromEntries(Object.entries(PRIVATE_DIRS).map(([k, sub]) => [k, path.join(dirs.private, sub)])),
    core_options_path: path.join(dirs.private, "retroarch-core-options.cfg"),
    history_list_enable: "false",
    content_runtime_log: "false",
    content_runtime_log_aggregate: "false",
    libretro_directory: ra.cores,
    libretro_info_path: ra.info,
    assets_directory: ra.assets,
    joypad_autoconfig_dir: ra.autoconfig,
    bundle_assets_extract_enable: "false",
    menu_driver: "ozone",
    // nothing in a game needs these, and the microphone would trigger a permission prompt
    microphone_enable: "false",
    midi_driver: "null",
    cloud_sync_enable: "false",
    discord_allow: "false",
    // the bundled cores are read-only; updating them happens with app updates
    menu_show_online_updater: "false",
    menu_show_core_updater: "false",
    config_save_on_exit: "true",
  };
}

/** Rewrite only the given keys in a retroarch.cfg, creating it if needed. */
function writeConfig(file, keys) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch {}
  const left = new Map(Object.entries(keys));
  lines = lines.map(l => {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(l);
    if (m && left.has(m[1])) { const v = left.get(m[1]); left.delete(m[1]); return `${m[1]} = ${q(v)}`; }
    return l;
  });
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [k, v] of left) lines.push(`${k} = ${q(v)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

/**
 * Data folders some cores read from the BIOS folder, pointed at the bundled copies: Dolphin's Sys folder
 * (<system>/dolphin-emu/Sys) and PPSSPP's fonts and dialogs (<system>/PPSSPP).
 */
function linkSystemData(ra, systemDir, core) {
  if (!ra) return;
  const want = { dolphin_libretro: [ra.dolphinSys, path.join(systemDir, "dolphin-emu", "Sys")], ppsspp_libretro: [ra.ppsspp, path.join(systemDir, "PPSSPP")] }[core];
  if (!want || !fs.existsSync(want[0])) return;
  const [from, link] = want;
  try {
    if (fs.realpathSync(link) === fs.realpathSync(from)) return;
  } catch {}
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  try {
    fs.symlinkSync(from, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    fs.cpSync(from, link, { recursive: true });
  }
}

/** Why did RetroArch close right away? Reads its log; returns "" when there's nothing useful. */
/**
 * Why a game closed right after starting, in plain words, from RetroArch's log; "" when the log doesn't say.
 * exit: how the emulator ended ({code, signal}), to tell a crash apart.
 */
function explain(logFile, exit = {}) {
  let log = "";
  try { log = fs.readFileSync(logFile, "utf8"); } catch { return ""; }
  const lines = log.split(/\r?\n/), errs = lines.filter(l => /\[(ERROR|WARN)\]|error|fail/i.test(l)).join("\n");
  const hard = lines.filter(l => /\[ERROR\]/.test(l)).join("\n");
  if (/bios|firmware/i.test(errs) && /missing|not found|required|could not|failed/i.test(errs)) {
    // the file it wanted, when the log names it
    const name = (/([\w-]+\.(?:bin|rom|img|zip|pce|BIN|ROM))\b/.exec(errs.split("\n").filter(l => /bios|firmware/i.test(l)).join("\n")) || [])[1];
    return "This game needs a BIOS file from the original console" + (name ? " (" + name + ")" : "") + ". Drop it on this window and it goes in the right place. Settings → Saves & BIOS shows what each console has.";
  }
  if (/Failed to open libretro core|Failed to load core|dylib.*not|could not load library/i.test(errs))
    return "The emulator for this system didn't load. Reinstalling The Retro Shelf should fix it.";
  if (/(video driver|graphics).*(fail|could not|cannot)|failed to initialize video/i.test(errs))
    return "RetroArch couldn't start graphics on this computer." + (process.platform === "win32" ? " Updating the graphics driver usually fixes this." : "");
  if (/\b(zip|7z|archive|compressed)\b/i.test(hard))
    return "This game is in a .zip or .7z its emulator can't play from. Unzip it, then add the game file itself.";
  if (/Failed to load content|failed to load game|content.*(not|couldn).*load|Couldn't open/i.test(errs))
    return "RetroArch couldn't open this file. It may be damaged, or not a game for this system.";
  // ended by a crash: a signal on a Mac, an NTSTATUS error code (0xC0000005 and the like) on Windows
  if (exit.signal && exit.signal !== "SIGTERM" && exit.signal !== "SIGKILL" || exit.code >= 0xC0000000)
    return "The emulator crashed while starting this game. If it happens again, Settings → Copy info puts what's needed for a bug report on the clipboard.";
  return "";
}

module.exports = { bundled, corePath, enforced, neededDirs, writeConfig, linkSystemData, explain, CORE_EXT };

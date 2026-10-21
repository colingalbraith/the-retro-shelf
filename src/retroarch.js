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
    bluemsx: path.join(emuDir, "blueMSX"),
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
  const hardcore = !!(opts.cheevos && opts.hardcore);
  return {
    video_fullscreen: opts.fullscreen ? "true" : "false",
    // Linux's usual driver can't run the old-TV and handheld looks (slang shaders); glcore can
    ...(process.platform === "linux" ? { video_driver: "glcore" } : {}),
    // Hold Start (or press Esc) to come back to the shelf; hold Select for RetroArch's menu.
    input_quit_gamepad_combo: "7",
    input_menu_toggle_gamepad_combo: "8",
    quit_press_twice: "false",
    // lets the app ask RetroArch to quit cleanly (saving first) from the Stop button
    stdin_cmd_enable: "true",
    savestate_auto_save: opts.resume ? "true" : "false",
    // a launch from a chosen save slot, or "start fresh", skips the resume point
    savestate_auto_load: opts.resume && opts.load !== false && !hardcore ? "true" : "false",
    // the picture: sharp pixels, smoothed, or the scanlines of an old TV or a handheld's screen (a shader, passed with
    // --set-shader)
    video_smooth: opts.picture === "smooth" ? "true" : "false",
    video_shader_enable: opts.picture === "crt" || opts.picture === "lcd" ? "true" : "false",
    // the screen's shape: as the console showed it (22 in RetroArch's list), 4:3 (0), whole-pixel steps, or the whole
    // screen (24)
    aspect_ratio_index: String({ "4:3": 0, stretch: 24 }[opts.shape] ?? 22),
    video_scale_integer: opts.shape === "pixel" ? "true" : "false",
    // rewind (hold the left trigger, or R) and fast-forward (hold the right trigger, or L; Space keeps it on), and a
    // frame less lag (run-ahead): on light consoles (opts.light), where they cost little. The triggers only on
    // consoles whose controllers had none (opts.freeTriggers); in RetroArch's own controller profiles for Macs and
    // Xbox-style pads they're axes +4 and +5
    rewind_enable: opts.light && opts.rewind !== false && !hardcore ? "true" : "false",
    input_rewind: "r",
    input_rewind_axis: opts.light && opts.freeTriggers && opts.rewind !== false ? "+4" : "nul",
    input_hold_fast_forward: "l",
    input_hold_fast_forward_axis: opts.freeTriggers ? "+5" : "nul",
    input_toggle_fast_forward: "space",
    fastforward_ratio: "3.0",
    run_ahead_enabled: opts.light && opts.lessLag !== false ? "true" : "false",
    run_ahead_frames: "1",
    run_ahead_secondary_instance: "false",
    run_ahead_hide_warnings: "true",
    // a game on several discs (opts.discs): E opens and closes the tray, D picks the next disc (RetroArch only
    // changes discs with the tray open)
    input_disk_eject_toggle: opts.discs ? "e" : "nul",
    input_disk_next: opts.discs ? "d" : "nul",
    // the cheats chosen for this game (written to its file in the cheats folder), switched on as it starts; never
    // with hardcore achievements
    apply_cheats_after_load: opts.cheats && !hardcore ? "true" : "false",
    // RetroAchievements (opts.cheevos: {user} once signed in, {user, pass} the first time): RetroArch signs in with the
    // password, keeps a token in its place and clears the password itself. Hardcore also means no rewind and no
    // starting from a save
    cheevos_enable: opts.cheevos ? "true" : "false",
    cheevos_hardcore_mode_enable: hardcore ? "true" : "false",
    ...(opts.cheevos && opts.cheevos.pass ? { cheevos_username: opts.cheevos.user, cheevos_password: opts.cheevos.pass, cheevos_token: "" } : {}),
    ...(!opts.cheevos ? { cheevos_username: "", cheevos_password: "", cheevos_token: "" } : {}),
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
    ...players(opts.pads),
  };
}

/**
 * Player 1, 2… as the app showed them: each player prefers its controller (RetroArch's "reserved device"). Told apart
 * by name on a Mac, where RetroArch's controller driver knows no vendor or product numbers, and by vendor:product
 * elsewhere. Controllers that can't be told apart (two of the same) keep the order they connected in, which both
 * count the same way.
 */
function players(pads, platform = process.platform) {
  const key = p => platform === "darwin" ? String(p.name || "").trim()
    : /^[0-9a-f]{4}$/i.test(p.vid) && /^[0-9a-f]{4}$/i.test(p.pid) ? `${p.vid}:${p.pid}`.toLowerCase() : "";
  const keys = (Array.isArray(pads) ? pads : []).slice(0, 4).map(p => (p && typeof p === "object" ? key(p) : "").slice(0, 120));
  const once = k => k && keys.length > 1 && keys.filter(x => x === k).length === 1;
  const out = {};
  for (let i = 0; i < 4; i++) {
    out[`input_player${i + 1}_device_reservation_type`] = once(keys[i]) ? "1" : "0";
    out[`input_player${i + 1}_reserved_device`] = once(keys[i]) ? keys[i].replace(/["\x00-\x1f]/g, "") : "";
  }
  return out;
}

/** Rewrite only the given keys in a retroarch.cfg, creating it if needed. */
/** one setting's value in a RetroArch config file, or "" */
function readConfigKey(file, key) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return ""; }
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\r\\n]*)"?`, "m").exec(text);
  return m ? m[1] : "";
}

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
  const want = {
    dolphin_libretro: [[ra.dolphinSys, path.join(systemDir, "dolphin-emu", "Sys")]],
    ppsspp_libretro: [[ra.ppsspp, path.join(systemDir, "PPSSPP")]],
    bluemsx_libretro: ra.bluemsx ? [[path.join(ra.bluemsx, "Databases"), path.join(systemDir, "Databases")], [path.join(ra.bluemsx, "Machines"), path.join(systemDir, "Machines")]] : [],
  }[core] || [];
  for (const [from, link] of want) {
    if (!fs.existsSync(from)) continue;
    try {
      if (fs.realpathSync(link) === fs.realpathSync(from)) continue;
    } catch {}
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    try {
      fs.symlinkSync(from, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      fs.cpSync(from, link, { recursive: true });
    }
  }
}

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
  // Linux: an emulator built for a newer system than this one (Dolphin, for GameCube and Wii, wants Ubuntu 24.04's)
  if (/GLIBCXX_[\d.]+'? not found|GLIBC_[\d.]+'? not found/.test(log))
    return "This console's emulator needs a newer Linux than this one (like Ubuntu 24.04 or SteamOS). The other consoles work as they are.";
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

module.exports = { bundled, corePath, enforced, players, neededDirs, writeConfig, readConfigKey, linkSystemData, explain, CORE_EXT };

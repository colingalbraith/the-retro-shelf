import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ra = createRequire(import.meta.url)("../src/retroarch.js");

test("the RetroArch config keeps what people set and enforces what the app needs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-cfg-"));
  try {
    const file = path.join(dir, "retroarch.cfg");
    fs.writeFileSync(file, 'video_shader = "crt.slangp"\nvideo_fullscreen = "false"\n');
    ra.writeConfig(file, { video_fullscreen: "true", stdin_cmd_enable: "true" });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^video_shader = "crt\.slangp"$/m, "other settings are left alone");
    assert.match(text, /^video_fullscreen = "true"$/m, "an enforced setting is replaced in place");
    assert.match(text, /^stdin_cmd_enable = "true"$/m, "a missing one is added");
    assert.equal(text.match(/video_fullscreen/g).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("starting from a save slot or fresh skips the resume point", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  assert.equal(ra.enforced(emu, dirs, { resume: true }).savestate_auto_load, "true");
  assert.equal(ra.enforced(emu, dirs, { resume: true, load: false }).savestate_auto_load, "false");
  assert.equal(ra.enforced(emu, dirs, { resume: false }).savestate_auto_save, "false");
});

test("a failed start is explained from RetroArch's log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-log-"));
  try {
    const log = path.join(dir, "retroarch.log");
    fs.writeFileSync(log, "[ERROR] [Content] Failed to load content.\n");
    assert.match(ra.explain(log), /couldn't open this file/);
    fs.writeFileSync(log, "[ERROR] Missing required firmware: scph5501.bin\n");
    assert.match(ra.explain(log), /BIOS file from the original console \(scph5501\.bin\)\. Drop it on this window/);
    fs.writeFileSync(log, "[ERROR] [Content] Cannot load compressed archive for this core.\n");
    assert.match(ra.explain(log), /\.zip or \.7z/);
    fs.writeFileSync(log, "[INFO] all good\n");
    assert.equal(ra.explain(log), "");
    // nothing in the log, but the emulator crashed
    assert.match(ra.explain(log, { code: null, signal: "SIGSEGV" }), /crashed/);
    assert.match(ra.explain(log, { code: 3221225477, signal: null }), /crashed/);
    assert.equal(ra.explain(log, { code: 0, signal: null }), "");
    assert.equal(ra.explain(log, { code: null, signal: "SIGTERM" }), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the picture setting picks sharp pixels, smoothing, or the old-TV or handheld shader", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  const look = picture => { const e = ra.enforced(emu, dirs, { picture }); return [e.video_smooth, e.video_shader_enable]; };
  assert.deepEqual(look("sharp"), ["false", "false"]);
  assert.deepEqual(look("smooth"), ["true", "false"]);
  assert.deepEqual(look("crt"), ["false", "true"]);
  assert.deepEqual(look("lcd"), ["false", "true"]);
  const shape = s => { const e = ra.enforced(emu, dirs, { shape: s }); return [e.aspect_ratio_index, e.video_scale_integer]; };
  assert.deepEqual(shape(undefined), ["22", "false"]);
  assert.deepEqual(shape("4:3"), ["0", "false"]);
  assert.deepEqual(shape("pixel"), ["22", "true"]);
  assert.deepEqual(shape("stretch"), ["24", "false"]);
});

test("rewind, fast-forward and less lag: on light consoles, the triggers only where controllers had none", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  const e = o => { const x = ra.enforced(emu, dirs, { triggers: "j-triggers", ...o }); return [x.rewind_enable, x.joypad_autoconfig_dir, x.run_ahead_enabled]; };
  assert.deepEqual(e({ light: true, freeTriggers: true }), ["true", "j-triggers", "true"]);          // SNES: the profiles with the triggers
  assert.deepEqual(e({ light: true }), ["true", "j", "true"]);                                       // Atari 2600: its triggers are switches
  assert.deepEqual(e({}), ["false", "j", "false"]);                                                  // PS1: R2 is a button there
  assert.deepEqual(e({ light: true, freeTriggers: true, rewind: false, lessLag: false }), ["false", "j-triggers", "false"]);
  assert.equal(e({ light: true, freeTriggers: true, triggers: null })[1], "j", "no copy made: RetroArch's own profiles");
  // nothing bound in the settings themselves, so each profile's own binding counts (a setting would win over it)
  const x = ra.enforced(emu, dirs, { light: true, freeTriggers: true, triggers: "j-triggers" });
  assert.deepEqual([x.input_rewind_btn, x.input_rewind_axis, x.input_hold_fast_forward_btn, x.input_hold_fast_forward_axis], ["nul", "nul", "nul", "nul"]);
  assert.deepEqual([x.input_rewind, x.input_hold_fast_forward, x.input_toggle_fast_forward], ["r", "l", "space"]);
});

test("fast-forward goes at the chosen speed, the sound sped up with it, and quiet at the fastest", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  const ff = v => { const x = ra.enforced(emu, dirs, { ffSpeed: v }); return [x.fastforward_ratio, x.audio_fastforward_speedup, x.audio_fastforward_mute]; };
  assert.deepEqual(ff(2), ["2.0", "true", "false"]);
  assert.deepEqual(ff(4), ["4.0", "true", "false"]);
  assert.deepEqual(ff(0), ["0.0", "false", "true"]);          // as fast as the computer can
  assert.deepEqual(ff(undefined), ["3.0", "true", "false"]);  // not chosen: 3 times, as before
  assert.deepEqual(ff(17), ["3.0", "true", "false"]);
});

test("each controller's own triggers rewind and fast-forward, whatever they are on it", () => {
  const on = text => Object.fromEntries([...ra.withTriggers(text).matchAll(/^input_(rewind|hold_fast_forward)_(btn|axis) = "([^"]*)"$/gm)].map(m => [m[1] + "_" + m[2], m[3]]));
  // Linux (udev), an Xbox pad and the Steam Deck's: the left trigger is axis 2, and axis 4 is the right stick
  assert.deepEqual(on('input_device = "Microsoft X-Box 360 pad"\ninput_l2_axis = "+2"\ninput_r2_axis = "+5"\ninput_r_y_plus_axis = "+4"\n'),
    { rewind_axis: "+2", hold_fast_forward_axis: "+5" });
  // Mac (mFi): axes 4 and 5
  assert.deepEqual(on('input_l2_axis = "+4"\ninput_r2_axis = "+5"\ninput_l2_axis_label = "Left Trigger"\n'), { rewind_axis: "+4", hold_fast_forward_axis: "+5" });
  // Windows, a PlayStation pad without Steam (DirectInput): buttons 6 and 7, not axes
  assert.deepEqual(on('input_l2_btn = "6"\ninput_r2_btn = "7"\ninput_r_y_plus_axis = "+5"\ninput_l2_btn_label = "L2"\n'), { rewind_btn: "6", hold_fast_forward_btn: "7" });
  // a pad without triggers, and one that binds them itself, are left as they are
  const plain = 'input_device = "SNES pad"\ninput_l_btn = "4"\n';
  assert.equal(ra.withTriggers(plain), plain);
  const own = 'input_l2_axis = "+2"\ninput_r2_axis = "+5"\ninput_hold_fast_forward_btn = "9"\n';
  assert.equal(ra.withTriggers(own), own);
});

test("RetroArch's menu and messages are in the app's language", () => {
  const lang = l => ra.enforced({ autoconfig: "j" }, { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" }, { lang: l }).user_language;
  assert.deepEqual([lang("en"), lang("ja"), lang("de"), lang("pt"), lang("ru"), lang("ko"), lang("zh"), lang("zh-Hant"), lang("pl")], ["0", "1", "4", "7", "9", "10", "12", "11", "14"]);
  assert.equal(lang("xx"), "0", "any other: English");
  assert.equal(lang(undefined), "0");
});

test("the trigger can switch fast-forward on and off instead, from its own copy of the profiles", () => {
  const on = text => Object.fromEntries([...text.matchAll(/^input_(rewind|hold_fast_forward|toggle_fast_forward)_(btn|axis) = "([^"]*)"$/gm)].map(m => [m[1] + "_" + m[2], m[3]]));
  assert.deepEqual(on(ra.withTriggers('input_l2_axis = "+2"\ninput_r2_axis = "+5"\n', true)), { rewind_axis: "+2", toggle_fast_forward_axis: "+5" });
  assert.deepEqual(on(ra.withTriggers('input_l2_btn = "6"\ninput_r2_btn = "7"\n', true)), { rewind_btn: "6", toggle_fast_forward_btn: "7" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-pads-"));
  try {
    const src = path.join(dir, "autoconfig");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "Pad.cfg"), 'input_l2_axis = "+4"\ninput_r2_axis = "+5"\n');
    const hold = ra.triggerProfiles({ autoconfig: src }, path.join(dir, "p")), toggle = ra.triggerProfiles({ autoconfig: src }, path.join(dir, "p"), true);
    assert.notEqual(hold, toggle, "two copies, side by side");
    assert.match(fs.readFileSync(path.join(hold, "Pad.cfg"), "utf8"), /^input_hold_fast_forward_axis = "\+5"$/m);
    assert.match(fs.readFileSync(path.join(toggle, "Pad.cfg"), "utf8"), /^input_toggle_fast_forward_axis = "\+5"$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // the settings bind neither, so the profile's binding counts; Space still switches it from the keyboard
  const x = ra.enforced({ autoconfig: "j" }, { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" }, {});
  assert.deepEqual([x.input_toggle_fast_forward, x.input_toggle_fast_forward_btn, x.input_toggle_fast_forward_axis], ["space", "nul", "nul"]);
});

test("the copy of the controller profiles is made once, again when they change, and never half", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-pads-"));
  try {
    const src = path.join(dir, "autoconfig"), priv = path.join(dir, "private");
    fs.mkdirSync(path.join(src, "udev"), { recursive: true });
    fs.writeFileSync(path.join(src, "udev", "Pad.cfg"), 'input_l2_axis = "+2"\ninput_r2_axis = "+5"\n');
    fs.writeFileSync(path.join(src, "udev", "NoTriggers.cfg"), 'input_a_btn = "0"\n');
    const emu = { autoconfig: src, version: "1.22.2" };
    const out = ra.triggerProfiles(emu, priv);
    assert.equal(out, path.join(priv, "autoconfig-triggers"));
    assert.match(fs.readFileSync(path.join(out, "udev", "Pad.cfg"), "utf8"), /^input_rewind_axis = "\+2"$/m);
    assert.equal(fs.readFileSync(path.join(out, "udev", "NoTriggers.cfg"), "utf8"), 'input_a_btn = "0"\n');
    // the same profiles: the copy stays (a mark left in it survives)
    fs.writeFileSync(path.join(out, "mark"), "");
    assert.equal(ra.triggerProfiles(emu, priv), out);
    assert.ok(fs.existsSync(path.join(out, "mark")));
    // changed profiles: made again
    fs.writeFileSync(path.join(src, "udev", "New.cfg"), 'input_l2_btn = "6"\ninput_r2_btn = "7"\n');
    assert.equal(ra.triggerProfiles(emu, priv), out);
    assert.ok(!fs.existsSync(path.join(out, "mark")));
    assert.match(fs.readFileSync(path.join(out, "udev", "New.cfg"), "utf8"), /^input_hold_fast_forward_btn = "7"$/m);
    assert.ok(!fs.existsSync(out + ".part"));
    // no profiles to copy: none
    assert.equal(ra.triggerProfiles({ autoconfig: path.join(dir, "missing") }, priv), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("achievements: signing in hands RetroArch the password once; hardcore turns off rewind, cheats and starting from a save", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  const first = ra.enforced(emu, dirs, { cheevos: { user: "P", pass: "pw" } });
  assert.deepEqual([first.cheevos_enable, first.cheevos_username, first.cheevos_password, first.cheevos_token], ["true", "P", "pw", ""]);
  const later = ra.enforced(emu, dirs, { cheevos: { user: "P" } });
  assert.equal(later.cheevos_enable, "true");
  assert.ok(!("cheevos_password" in later) && !("cheevos_token" in later));      // RetroArch's own token stays
  const off = ra.enforced(emu, dirs, {});
  assert.deepEqual([off.cheevos_enable, off.cheevos_token, off.cheevos_password], ["false", "", ""]);
  const hc = ra.enforced(emu, dirs, { cheevos: { user: "P" }, hardcore: true, light: true, resume: true, cheats: true });
  assert.deepEqual([hc.cheevos_hardcore_mode_enable, hc.rewind_enable, hc.apply_cheats_after_load, hc.savestate_auto_load], ["true", "false", "false", "false"]);
  assert.equal(ra.enforced(emu, dirs, { hardcore: true }).cheevos_hardcore_mode_enable, "false");   // hardcore means nothing signed out
});

test("players as the app shows them: each prefers its controller, by name on a Mac and by vendor:product elsewhere", () => {
  const ps = { name: "DualSense Wireless Controller", vid: "054c", pid: "0CE6" }, xb = { name: "Xbox Wireless Controller", vid: "045e", pid: "0b13" };
  const mac = ra.players([ps, xb], "darwin");
  assert.equal(mac.input_player1_device_reservation_type, "1"); assert.equal(mac.input_player1_reserved_device, "DualSense Wireless Controller");
  assert.equal(mac.input_player2_reserved_device, "Xbox Wireless Controller"); assert.equal(mac.input_player3_device_reservation_type, "0");
  const win = ra.players([ps, xb], "win32");
  assert.equal(win.input_player1_reserved_device, "054c:0ce6"); assert.equal(win.input_player2_reserved_device, "045e:0b13");
  // one controller, or two of the same: the order they connected in, with nothing left over from before
  assert.equal(ra.players([ps], "win32").input_player1_device_reservation_type, "0");
  const same = ra.players([xb, xb, ps], "darwin");
  assert.deepEqual([1, 2, 3].map(i => same[`input_player${i}_device_reservation_type`]), ["0", "0", "1"]);
  // an XInput pad the browser gives no numbers for isn't reserved; the other still is
  const mixed = ra.players([{ name: "Xbox 360 Controller (XInput STANDARD GAMEPAD)", vid: "", pid: "" }, ps], "win32");
  assert.deepEqual([mixed.input_player1_device_reservation_type, mixed.input_player2_reserved_device], ["0", "054c:0ce6"]);
  assert.equal(ra.players([{ name: 'a"b\nc' }, xb], "darwin").input_player1_reserved_device, "abc");
  assert.equal(ra.players("junk").input_player1_device_reservation_type, "0");
});

test("system files are linked into the BIOS folder without ever removing a folder someone put there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-link-"));
  try {
    const bundled = path.join(dir, "app", "blueMSX"), bios = path.join(dir, "bios");
    fs.mkdirSync(path.join(bundled, "Machines", "MSX - C-BIOS"), { recursive: true }); fs.mkdirSync(path.join(bundled, "Databases"), { recursive: true });
    // someone's own Machines folder, with real MSX firmware in it
    fs.mkdirSync(path.join(bios, "Machines", "Shared Roms"), { recursive: true }); fs.writeFileSync(path.join(bios, "Machines", "Shared Roms", "MSX.rom"), "mine");
    ra.linkSystemData({ bluemsx: bundled }, bios, "bluemsx_libretro");
    assert.equal(fs.readFileSync(path.join(bios, "Machines", "Shared Roms", "MSX.rom"), "utf8"), "mine");
    assert.equal(fs.realpathSync(path.join(bios, "Databases")), fs.realpathSync(path.join(bundled, "Databases")));   // linked
    ra.linkSystemData({ bluemsx: bundled }, bios, "bluemsx_libretro");                                                  // and again: unchanged
    assert.ok(fs.existsSync(path.join(bios, "Machines", "Shared Roms", "MSX.rom")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a value with quotes or line breaks can't add settings of its own", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-cfg-")), f = path.join(dir, "retroarch.cfg");
  try {
    ra.writeConfig(f, { cheevos_username: 'a"\nvideo_driver = "null' });
    assert.equal(fs.readFileSync(f, "utf8"), 'cheevos_username = "avideo_driver = null"\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

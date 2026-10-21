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
  const e = o => { const x = ra.enforced(emu, dirs, o); return [x.rewind_enable, x.input_rewind_axis, x.input_hold_fast_forward_axis, x.run_ahead_enabled]; };
  assert.deepEqual(e({ light: true, freeTriggers: true }), ["true", "+4", "+5", "true"]);             // SNES
  assert.deepEqual(e({ light: true }), ["true", "nul", "nul", "true"]);                               // Atari 2600: its triggers are switches
  assert.deepEqual(e({}), ["false", "nul", "nul", "false"]);                                          // PS1: R2 is a button there
  assert.deepEqual(e({ light: true, freeTriggers: true, rewind: false, lessLag: false }), ["false", "nul", "+5", "false"]);
});

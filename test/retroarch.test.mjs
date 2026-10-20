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
    assert.match(ra.explain(log), /BIOS/);
    fs.writeFileSync(log, "[INFO] all good\n");
    assert.equal(ra.explain(log), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the picture setting picks sharp pixels, smoothing or the CRT shader", () => {
  const dirs = { saves: "s", states: "t", screenshots: "p", system: "b", private: "x" };
  const emu = { cores: "c", info: "i", assets: "a", autoconfig: "j" };
  const look = picture => { const e = ra.enforced(emu, dirs, { picture }); return [e.video_smooth, e.video_shader_enable]; };
  assert.deepEqual(look("sharp"), ["false", "false"]);
  assert.deepEqual(look("smooth"), ["true", "false"]);
  assert.deepEqual(look("crt"), ["false", "true"]);
});

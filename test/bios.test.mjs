import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { biosDest, biosStatus } = require("../src/bios.js");
const { Importer } = require("../src/importer.js");
const config = require("../src/config.json");

test("BIOS files are recognized by name and sent where their emulator looks", () => {
  assert.equal(biosDest("SCPH5501.BIN"), "scph5501.bin");
  assert.equal(biosDest("dc_boot.bin"), "dc/dc_boot.bin");
  assert.equal(biosDest("neogeo.zip"), "fbneo/neogeo.zip");
  assert.equal(biosDest("Super Mario World (USA).sfc"), null);
});

test("the checker tells found, partly there, missing and wrong-size apart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-bios-"));
  try {
    const put = (rel, size) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); };
    put("scph5501.bin", 524288);
    put("bios7.bin", 16384);
    put("dc/dc_boot.bin", 1000);
    put("bios_CD_U.bin", 131072);
    const st = Object.fromEntries(biosStatus(dir, null).map(c => [c.system, c.state]));
    assert.deepEqual(st, { PS1: "ok", "PC Engine": "missing", Dreamcast: "bad", DS: "partial", GBA: "missing", Arcade: "missing",
      "Sega CD": "ok", Saturn: "missing", Lynx: "missing", "Atari 7800": "missing", ColecoVision: "missing", Intellivision: "missing",
      "3DO": "missing", "Neo Geo CD": "missing", "Pokémon Mini": "missing", PS2: "missing" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// a PS2 BIOS's start: its table of contents names RESET, ROMDIR and ROMVER
const ps2Bios = (size = 4194304) => { const b = Buffer.alloc(size); b.write("RESET", 0x2700); b.write("ROMDIR", 0x2710); b.write("ROMVER", 0x2720); return b; };

test("a PS2 BIOS is known by what's in it, under any name, in its own folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-ps2-"));
  try {
    const ps2 = () => biosStatus(dir, null).find(c => c.system === "PS2");
    assert.equal(ps2().state, "missing");
    fs.mkdirSync(path.join(dir, "pcsx2", "bios"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pcsx2", "bios", "my console.bin"), Buffer.alloc(4194304));
    assert.equal(ps2().state, "bad", "the right size but not a BIOS");
    fs.writeFileSync(path.join(dir, "pcsx2", "bios", "SCPH-70012_BIOS_V12_USA_200.BIN"), ps2Bios());
    assert.equal(ps2().state, "ok");
    assert.deepEqual(ps2().files.filter(f => f.ok).map(f => f.name), ["SCPH-70012_BIOS_V12_USA_200.BIN"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a dropped PS2 BIOS goes to its folder; a game of the same size doesn't", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-drop2-"));
  try {
    fs.writeFileSync(path.join(dir, "ps2-0230a-20080220.bin"), ps2Bios());
    fs.writeFileSync(path.join(dir, "Super Street Fighter II (USA).bin"), Buffer.alloc(5242880, 1));   // a 5 MB Genesis game
    const { items, bios } = new Importer(config.systems).inspect([dir]);
    assert.deepEqual(bios.map(b => b.dest), ["pcsx2/bios/ps2-0230a-20080220.bin"]);
    assert.ok(items.some(i => i.name.startsWith("Super Street Fighter")), "the game is a game");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a dropped BIOS goes to the BIOS folder, not onto a shelf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-drop-"));
  try {
    fs.writeFileSync(path.join(dir, "scph5501.bin"), Buffer.alloc(524288));
    fs.writeFileSync(path.join(dir, "syscard3.pce"), Buffer.alloc(262144));
    const { items, bios } = new Importer(config.systems).inspect([dir]);
    assert.equal(items.length, 0);
    assert.deepEqual(bios.map(b => b.dest).sort(), ["scph5501.bin", "syscard3.pce"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

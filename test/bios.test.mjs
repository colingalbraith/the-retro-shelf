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
    const st = Object.fromEntries(biosStatus(dir, null).map(c => [c.system, c.state]));
    assert.deepEqual(st, { PS1: "ok", "PC Engine": "missing", Dreamcast: "bad", DS: "partial", GBA: "missing", Arcade: "missing" });
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

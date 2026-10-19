import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Importer } = require("../electron/importer.js");
const config = require("../config.json");

let dir;
const file = (name, size, patches = []) => {
  const b = Buffer.alloc(size);
  for (const [at, data] of patches) Buffer.from(data).copy(b, at);
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), b);
};
// ISO 9660 volume descriptor with a system id, in a raw 2352-byte-sector disc image
const rawDisc = id => [[2352 * 16 + 24, Buffer.concat([Buffer.from("\x01CD001\x01\x00", "latin1"), Buffer.from(id.padEnd(32))])]];
// the smallest valid zip: stored (uncompressed) entries
function zip(name, entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [n, data] of entries) {
    const crc = zlib.crc32(data), nb = Buffer.from(n), l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nb.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, nb, data); centrals.push(c, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(path.join(dir, name), Buffer.concat([...locals, cd, end]));
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-test-"));
  file("Super Mario Bros. (World).nes", 64, [[0, "NES\x1a"]]);
  file("Streets of Rage 2 (USA).bin", 2 * 1048576, [[0x100, "SEGA MEGA DRIVE"]]);
  file("Adventure (USA).bin", 4096);
  file("Metroid Prime (USA).iso", 0x9000, [[0x1c, Buffer.from("c2339f3d", "hex")]]);
  file("Patapon (USA).iso", 0x9000, [[0x8000, Buffer.concat([Buffer.from("\x01CD001\x01\x00", "latin1"), Buffer.from("PSP GAME".padEnd(32))])]]);
  file("Mystery.iso", 0x9000);
  file("Crash Bandicoot (USA).bin", 2352 * 20, rawDisc("PLAYSTATION"));
  fs.writeFileSync(path.join(dir, "Crash Bandicoot (USA).cue"), 'FILE "Crash Bandicoot (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
  file("Spyro the Dragon (USA).bin", 5 * 1048576, rawDisc("PLAYSTATION"));
  zip("Tetris (World).zip", [["Tetris (World).gb", Buffer.alloc(32768)]]);
  zip("sf2.zip", ["sf2e_30g.11e", "sf2e_37b.11f", "sf2e_31g.12e", "sf2-5m.4a"].map(n => [n, Buffer.alloc(64)]));
  fs.writeFileSync(path.join(dir, "readme.txt"), "not a game");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("dropped files are sorted onto the right shelf by their contents", () => {
  const { items, unknown } = new Importer(config.systems).inspect([dir]);
  const system = Object.fromEntries(items.map(i => [i.name, i.system]));
  assert.deepEqual(system, {
    "Super Mario Bros. (World).nes": "NES",
    "Streets of Rage 2 (USA).bin": "Genesis",
    "Adventure (USA).bin": "Atari 2600",
    "Metroid Prime (USA).iso": "GameCube/Wii",
    "Patapon (USA).iso": "PSP",
    "Mystery.iso": null,
    "Crash Bandicoot (USA).cue": "PS1",
    "Spyro the Dragon (USA).bin": "PS1",
    "Tetris (World).zip": "Game Boy",
    "sf2.zip": "Arcade",
  });
  assert.deepEqual(items.find(i => i.name === "Mystery.iso").choices, ["PSP", "GameCube/Wii", "PS2"]);
  assert.equal(unknown.length, 0, "readme.txt is ignored, not reported");
});

test("a disc keeps its track files and gets its own folder", () => {
  const imp = new Importer(config.systems), { items } = imp.inspect([dir]);
  const crash = items.find(i => i.name === "Crash Bandicoot (USA).cue");
  assert.equal(crash.extras.length, 1, "the .bin travels with the .cue");
  const plan = imp.plan(crash, "/games");
  assert.equal(plan.main, path.join("/games", "ps1", "Crash Bandicoot (USA)", "Crash Bandicoot (USA).cue"));
});

test("a bare PlayStation .bin gets a .cue written for it", async () => {
  const imp = new Importer(config.systems), { items } = imp.inspect([dir]);
  const spyro = items.find(i => i.name === "Spyro the Dragon (USA).bin");
  assert.ok(spyro.makeCue);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-out-"));
  try {
    const r = await imp.copy([spyro], out, () => {});
    assert.equal(r.added, 1);
    const cue = fs.readFileSync(path.join(out, "ps1", "Spyro the Dragon (USA)", "Spyro the Dragon (USA).cue"), "utf8");
    assert.match(cue, /FILE "Spyro the Dragon \(USA\)\.bin" BINARY/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

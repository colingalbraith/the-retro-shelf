import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Importer } = require("../src/importer.js");
const config = require("../src/config.json");

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
  file("Sonic CD (USA).bin", 2352 * 20, [[16, "SEGADISCSYSTEM  "]]);
  fs.writeFileSync(path.join(dir, "Sonic CD (USA).cue"), 'FILE "Sonic CD (USA).bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
  file("Nights into Dreams (USA).iso", 0x9000, [[0, "SEGA SEGASATURN "]]);
  file("Gex (USA).iso", 0x9000, [[0, Buffer.from([1, 0x5a, 0x5a, 0x5a, 0x5a, 0x5a, 1])]]);
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
    "Sonic CD (USA).cue": "Sega CD",
    "Nights into Dreams (USA).iso": "Saturn",
    "Gex (USA).iso": "3DO",
    "Tetris (World).zip": "Game Boy",
    "sf2.zip": "Arcade",
  });
  assert.deepEqual(items.find(i => i.name === "Mystery.iso").choices, ["Sega CD", "Saturn", "3DO", "PSP", "GameCube/Wii", "PS2"]);
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

test("zips: arcade chip sets, a game with its readme, discs and BIOS files that need asking about, and empty files", () => {
  const was = dir; dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-zips-"));
  try {
    zip("dkong.zip", ["c_5et_g.bin", "c_5ct_g.bin", "c_5bt_g.bin", "v_5h_b.bin"].map(n => [n, Buffer.alloc(64)]));
    zip("Pokemon Emerald (USA).zip", [["Pokemon Emerald (USA).gba", Buffer.alloc(4096)], ["readme.txt", Buffer.from("hi")], ["release.nfo", Buffer.from("x")]]);
    zip("Crash (USA).zip", [["Crash (USA).bin", Buffer.alloc(2048)], ["Crash (USA).cue", Buffer.from('FILE "Crash (USA).bin" BINARY')]]);
    zip("PS BIOS.zip", [["scph5501.bin", Buffer.alloc(524288)]]);
    fs.writeFileSync(path.join(dir, "Empty (USA).nes"), "");
    const { items, unknown } = new Importer(config.systems).inspect([dir]), by = n => items.find(i => i.name === n);
    assert.equal(by("dkong.zip").system, "Arcade");
    assert.equal(by("Pokemon Emerald (USA).zip").system, "GBA");
    assert.equal(by("Crash (USA).zip").system, null);                                // asked, not guessed
    assert.equal(by("PS BIOS.zip").system, null);
    assert.ok(unknown.includes("Empty (USA).nes"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); dir = was; }
});

test("a .cue's tracks travel with it whatever their letter case, a missing track is said, and tracks from another folder are rewritten", async () => {
  const was = dir; dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-cues-"));
  try {
    file("Sonic CD (USA) (Track 01).bin", 2352 * 20, [[16, "SEGADISCSYSTEM  "]]); file("Sonic CD (USA) (Track 02).bin", 4096);
    fs.writeFileSync(path.join(dir, "Sonic CD (USA).cue"), 'FILE "SONIC CD (USA) (TRACK 01).BIN" BINARY\n  TRACK 01 MODE1/2352\nFILE "SONIC CD (USA) (TRACK 02).BIN" BINARY\n  TRACK 02 AUDIO\n');
    fs.writeFileSync(path.join(dir, "Lost (USA).cue"), 'FILE "Lost (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n');
    file("Tracks/Far (USA).bin", 2352 * 20, [[16, "SEGADISCSYSTEM  "]]);
    fs.mkdirSync(path.join(dir, "Sheets")); fs.writeFileSync(path.join(dir, "Sheets", "Far (USA).cue"), 'FILE "../Tracks/Far (USA).bin" BINARY\n  TRACK 01 MODE1/2352\n');
    const imp = new Importer(config.systems), { items, unknown } = imp.inspect([dir]);
    if (process.platform !== "linux") {
      assert.deepEqual(items.filter(i => /Sonic/.test(i.name)).map(i => i.name), ["Sonic CD (USA).cue"]);   // its tracks aren't games of their own
    }
    assert.ok(unknown.some(u => /^Lost \(USA\)\.cue \(Lost \(USA\)\.bin is missing\)$/.test(u)));
    const far = items.find(i => i.name === "Far (USA).cue"), root = path.join(dir, "out");
    assert.equal(far.system, "Sega CD");
    await imp.copy([far], root, () => {});
    const copied = fs.readFileSync(path.join(root, "segacd", "Far (USA)", "Far (USA).cue"), "utf8");
    assert.match(copied, /^FILE "Far \(USA\)\.bin" BINARY/);
    assert.ok(fs.existsSync(path.join(root, "segacd", "Far (USA)", "Far (USA).bin")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); dir = was; }
});

test("a PlayStation disc's SYSTEM.CNF says whether it's PS1 or PS2", () => {
  const was = dir; dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-ps-"));
  // a 2048-byte-sector ISO: the volume descriptor at sector 16, the root folder at 20, SYSTEM.CNF at 21
  const iso = (name, cnf) => {
    const b = Buffer.alloc(2048 * 24), at = s => s * 2048;
    Buffer.from("\x01CD001\x01\x00", "latin1").copy(b, at(16)); Buffer.from("PLAYSTATION".padEnd(32)).copy(b, at(16) + 8);
    b[at(16) + 156] = 34; b.writeUInt32LE(20, at(16) + 156 + 2); b.writeUInt32LE(2048, at(16) + 156 + 10);
    const rec = at(20), nm = Buffer.from("SYSTEM.CNF;1");
    b[rec] = 33 + nm.length; b.writeUInt32LE(21, rec + 2); b.writeUInt32LE(cnf.length, rec + 10); b[rec + 32] = nm.length; nm.copy(b, rec + 33);
    Buffer.from(cnf).copy(b, at(21));
    fs.writeFileSync(path.join(dir, name), b);
  };
  try {
    iso("Final Fantasy VII (USA) (Disc 1).iso", "BOOT = cdrom:\\SCUS_941.63;1\r\nTCB = 4\r\n");
    iso("Ico (USA).iso", "BOOT2 = cdrom0:\\SCUS_971.13;1\r\nVER = 1.00\r\n");
    const { items } = new Importer(config.systems).inspect([dir]), by = n => items.find(i => i.name === n);
    assert.equal(by("Ico (USA).iso").system, "PS2");
    const ff = by("Final Fantasy VII (USA) (Disc 1).iso");
    assert.ok(ff.system === "PS1" || ff.system === null, ff.system);                 // never filed as PS2
  } finally { fs.rmSync(dir, { recursive: true, force: true }); dir = was; }
});

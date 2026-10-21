import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { zipFolder, unzipInto } = require("../src/zip.js");
const { zipEntries } = require("../src/importer.js");

/** reads every entry back, inflating it and checking its checksum */
function unzip(file) {
  const b = fs.readFileSync(file), out = {};
  let i = 0;
  while (b.readUInt32LE(i) === 0x04034b50) {
    const method = b.readUInt16LE(i + 8), crc = b.readUInt32LE(i + 14), size = b.readUInt32LE(i + 18), n = b.readUInt16LE(i + 26), x = b.readUInt16LE(i + 28);
    const name = b.toString("utf8", i + 30, i + 30 + n), body = b.subarray(i + 30 + n + x, i + 30 + n + x + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(zlib.crc32(data), crc, name + " checksum");
    out[name] = data.toString("utf8");
    i += 30 + n + x + size;
  }
  return out;
}

test("saves are zipped under one Saves folder and come back out intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-zip-"));
  try {
    const saves = path.join(dir, "Saves");
    fs.mkdirSync(path.join(saves, "States"), { recursive: true });
    fs.writeFileSync(path.join(saves, "Pokémon - Red Version (USA).srm"), "battery save ".repeat(500));
    fs.writeFileSync(path.join(saves, "States", "Tetris (World).state.auto"), "x");
    fs.writeFileSync(path.join(saves, ".DS_Store"), "hidden");
    const out = path.join(dir, "backup.zip");
    assert.equal(await zipFolder(saves, out), 2);
    assert.deepEqual(zipEntries(out).map(e => e.name).sort(), ["Saves/Pokémon - Red Version (USA).srm", "Saves/States/Tetris (World).state.auto"]);
    const files = unzip(out);
    assert.equal(files["Saves/Pokémon - Red Version (USA).srm"], "battery save ".repeat(500));
    assert.equal(files["Saves/States/Tetris (World).state.auto"], "x");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("restoring puts saves back, keeps ones newer than the backup, and never writes outside the folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-restore-"));
  try {
    const saves = path.join(dir, "Saves"), zip = path.join(dir, "backup.zip");
    fs.mkdirSync(path.join(saves, "States"), { recursive: true });
    fs.writeFileSync(path.join(saves, "Old (USA).srm"), "from the backup");
    fs.writeFileSync(path.join(saves, "Played since (USA).srm"), "from the backup");
    fs.writeFileSync(path.join(saves, "States", "Gone (USA).state.auto"), "resume point");
    const past = new Date(Date.now() - 86400000);
    for (const f of ["Old (USA).srm", "Played since (USA).srm", "States/Gone (USA).state.auto"]) fs.utimesSync(path.join(saves, f), past, past);
    await zipFolder(saves, zip);
    fs.writeFileSync(path.join(saves, "Old (USA).srm"), "overwritten later, but older");
    fs.utimesSync(path.join(saves, "Old (USA).srm"), new Date(past.getTime() - 86400000), new Date(past.getTime() - 86400000));
    fs.writeFileSync(path.join(saves, "Played since (USA).srm"), "newer progress");
    fs.rmSync(path.join(saves, "States"), { recursive: true });
    const r = await unzipInto(zip, saves);
    assert.deepEqual(r, { restored: 2, kept: 1, skipped: 0, failed: 0 });
    assert.equal(fs.readFileSync(path.join(saves, "Old (USA).srm"), "utf8"), "from the backup");
    assert.equal(fs.readFileSync(path.join(saves, "Played since (USA).srm"), "utf8"), "newer progress");
    assert.equal(fs.readFileSync(path.join(saves, "States", "Gone (USA).state.auto"), "utf8"), "resume point");

    // a zip whose entries try to climb out of the folder
    const evil = path.join(dir, "evil"), ez = path.join(dir, "evil.zip");
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, "x.srm"), "x");
    await zipFolder(evil, ez);
    // same length as "Saves/x.srm", so the zip stays valid and only the path is the problem
    fs.writeFileSync(ez, Buffer.from(fs.readFileSync(ez).toString("latin1").replaceAll("Saves/x.srm", "../../x.srm"), "latin1"));
    assert.deepEqual(await unzipInto(ez, saves), { restored: 0, kept: 0, skipped: 1, failed: 0 });
    assert.ok(!fs.existsSync(path.join(dir, "x.srm")) && !fs.existsSync(path.join(path.dirname(dir), "x.srm")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a save that can't be written doesn't stop the rest from coming back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-restore-"));
  try {
    const saves = path.join(dir, "Saves"), zip = path.join(dir, "backup.zip"), to = path.join(dir, "to");
    fs.mkdirSync(path.join(saves, "Locked"), { recursive: true });
    fs.writeFileSync(path.join(saves, "A (USA).srm"), "a");
    fs.writeFileSync(path.join(saves, "Locked", "B (USA).srm"), "b");
    fs.writeFileSync(path.join(saves, "Z (USA).srm"), "z");
    await zipFolder(saves, zip);
    // a file where the folder "Locked" has to go: that entry can't be written, like a save another program holds
    fs.mkdirSync(to); fs.writeFileSync(path.join(to, "Locked"), "in the way");
    assert.deepEqual(await unzipInto(zip, to), { restored: 2, kept: 0, skipped: 0, failed: 1 });
    assert.equal(fs.readFileSync(path.join(to, "Z (USA).srm"), "utf8"), "z");
    assert.ok(!fs.readdirSync(to).some(f => f.endsWith(".part")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a backup of saves kept in a cloud folder restores into the saves, and a zip that isn't a backup restores nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-zip-"));
  try {
    const cloud = path.join(dir, "The Retro Shelf Saves"), out = path.join(dir, "b.zip"), back = path.join(dir, "back");
    fs.mkdirSync(path.join(cloud, "Snes9x"), { recursive: true });
    fs.writeFileSync(path.join(cloud, "Snes9x", "Game.srm"), "SAVE");
    fs.writeFileSync(path.join(cloud, "old backup.zip"), "not a save");
    assert.equal(await zipFolder(cloud, out), 1);                                    // the zip among them isn't one
    assert.deepEqual(Object.keys(unzip(out)), ["Saves/Snes9x/Game.srm"]);
    fs.mkdirSync(back);
    assert.equal((await unzipInto(out, back)).restored, 1);
    assert.equal(fs.readFileSync(path.join(back, "Snes9x", "Game.srm"), "utf8"), "SAVE");
    // a game's zip (no one top folder) isn't a backup
    const { zipFiles } = require("../src/zip.js"), game = path.join(dir, "game.zip");
    fs.writeFileSync(path.join(dir, "Game.sfc"), "ROM"); fs.writeFileSync(path.join(dir, "readme.txt"), "hi");
    await zipFiles([{ name: "Game.sfc", full: path.join(dir, "Game.sfc") }, { name: "readme.txt", full: path.join(dir, "readme.txt") }], game);
    await assert.rejects(unzipInto(game, back), /isn't a backup/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a file dated past 2107 doesn't stop a backup, and an entry can't unpack past the size it claims", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-zip-"));
  try {
    const saves = path.join(dir, "Saves"), out = path.join(dir, "b.zip");
    fs.mkdirSync(saves); fs.writeFileSync(path.join(saves, "far.srm"), "x");
    fs.utimesSync(path.join(saves, "far.srm"), new Date(2200, 0, 1), new Date(2200, 0, 1));
    assert.equal(await zipFolder(saves, out), 1);
    // a "bomb": a megabyte of zeros claiming to be 10 bytes
    const big = zlib.deflateRawSync(Buffer.alloc(1048576)), name = Buffer.from("Saves/bomb.srm"), crc = zlib.crc32(Buffer.alloc(1048576));
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(big.length, 18); lh.writeUInt32LE(10, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(big.length, 20); cd.writeUInt32LE(10, 24); cd.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + big.length, 16);
    const bomb = path.join(dir, "bomb.zip"); fs.writeFileSync(bomb, Buffer.concat([lh, name, big, cd, name, end]));
    const back = path.join(dir, "back"); fs.mkdirSync(back);
    const r = await unzipInto(bomb, back);
    assert.deepEqual([r.restored, r.skipped], [0, 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

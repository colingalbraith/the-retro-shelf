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

test("saves are zipped under their folder's name and come back out intact", async () => {
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
    // same length as "evil/x.srm", so the zip stays valid and only the path is the problem
    fs.writeFileSync(ez, Buffer.from(fs.readFileSync(ez).toString("latin1").replaceAll("evil/x.srm", "../../x.sr"), "latin1"));
    assert.deepEqual(await unzipInto(ez, saves), { restored: 0, kept: 0, skipped: 1, failed: 0 });
    assert.ok(!fs.existsSync(path.join(dir, "x.sr")) && !fs.existsSync(path.join(path.dirname(dir), "x.sr")));
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

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { zipFolder } = require("../src/zip.js");
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

test("saves are zipped under their folder's name and come back out intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-zip-"));
  try {
    const saves = path.join(dir, "Saves");
    fs.mkdirSync(path.join(saves, "States"), { recursive: true });
    fs.writeFileSync(path.join(saves, "Pokémon - Red Version (USA).srm"), "battery save ".repeat(500));
    fs.writeFileSync(path.join(saves, "States", "Tetris (World).state.auto"), "x");
    fs.writeFileSync(path.join(saves, ".DS_Store"), "hidden");
    const out = path.join(dir, "backup.zip");
    assert.equal(zipFolder(saves, out), 2);
    assert.deepEqual(zipEntries(out).map(e => e.name).sort(), ["Saves/Pokémon - Red Version (USA).srm", "Saves/States/Tetris (World).state.auto"]);
    const files = unzip(out);
    assert.equal(files["Saves/Pokémon - Red Version (USA).srm"], "battery save ".repeat(500));
    assert.equal(files["Saves/States/Tetris (World).state.auto"], "x");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

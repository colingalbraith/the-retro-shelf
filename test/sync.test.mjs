import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const sync = createRequire(import.meta.url)("../src/sync.js");

test("people's names: each its own folder, in any language, and a name in English letters as before", () => {
  assert.equal(sync.personKey("Sam"), "sam");
  assert.equal(sync.personKey("Player 1"), "player-1");
  const keys = ["Саша", "Маша", "ゆき", "さくら", "민준", "小明", "Zoë", "Zoe"].map(sync.personKey);
  assert.equal(new Set(keys).size, keys.length, "no two share one");
  for (const k of keys) assert.match(k, /^[a-z0-9-]+$/, "a folder name anywhere");
  assert.equal(sync.personKey("Саша"), sync.personKey(" саша "), "the same name, typed again");
});

test("two games with one console and file name keep their own play", () => {
  const keys = sync.keysFor([
    { id: "a", system: "PS1", path: "/g/ps1/Final Fantasy VII/Disc 1.chd" },
    { id: "b", system: "PS1", path: "/g/ps1/Chrono Cross/Disc 1.chd" },
    { id: "c", system: "PS1", path: "/g/ps1/Crash (USA).chd" },
  ]);
  assert.deepEqual([...keys.values()], ["PS1/final fantasy vii/disc 1.chd", "PS1/chrono cross/disc 1.chd", "PS1/crash (usa).chd"]);
  const st = { plays: { a: 5, b: 1 }, time: { a: 50000, b: 60 }, last: {}, sessions: [], fav: [], progress: {}, rating: {}, notes: {} };
  const j = sync.journal(st, keys, "m", "h", 1);
  assert.equal(j.games["PS1/final fantasy vii/disc 1.chd"].time, 50000);
  assert.equal(j.games["PS1/chrono cross/disc 1.chd"].time, 60);
  // an old id with the same key as the game's id now: added together
  const both = sync.journal({ ...st, plays: { a: 5, old: 2 } }, new Map([["a", "k"], ["old", "k"]]), "m", "h", 1);
  assert.equal(both.games.k.plays, 7);
});

test("another computer's journal counts once, a cloud drive's copies of it or of this one's own not again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-sync-"));
  try {
    const j = (machine, at, plays) => JSON.stringify({ v: 1, machine, host: machine, at, games: { "SNES/x.sfc": { plays } }, sessions: [] });
    fs.writeFileSync(path.join(dir, "mine.json"), j("mine", 5, 2));
    fs.writeFileSync(path.join(dir, "mine 2.json"), j("mine", 4, 2));               // a copy of this computer's own
    fs.writeFileSync(path.join(dir, "other.json"), j("other", 10, 3));
    fs.writeFileSync(path.join(dir, "other (conflicted copy).json"), j("other", 9, 1));
    fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ v: 1, machine: "x", games: { "SNES/x.sfc": null }, sessions: "no" }));
    const js = sync.readJournals(dir, "mine");
    assert.deepEqual(js.map(x => x.j.machine).sort(), ["other", "x"]);
    assert.equal(js.find(x => x.j.machine === "other").j.at, 10, "the newest copy");
    const c = sync.combine(js, new Map([["g", "SNES/x.sfc"]]));
    assert.equal(c.add.get("g").plays, 3, "a broken journal adds nothing and breaks nothing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

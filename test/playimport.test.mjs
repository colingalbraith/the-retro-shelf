import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { parseList, findLists, plan, summary, apply } = createRequire(import.meta.url)("../src/playimport.js");

const ES = `<?xml version="1.0"?>
<gameList>
  <game id="1"><path>./Super Mario World (USA).sfc</path><name>Super Mario World</name><favorite>true</favorite>
    <playcount>12</playcount><lastplayed>20230514T201530</lastplayed><rating>0.8</rating><gametime>5400</gametime></game>
  <game><path>./Pilotwings (USA).sfc</path><name>Pilotwings</name></game>
  <game><path>./Mario &amp; Wario (Japan).sfc</path><playcount>1</playcount></game>
</gameList>`;
const LB = `<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Game><Title>Sonic the Hedgehog</Title><ApplicationPath>..\\Games\\Genesis\\Sonic The Hedgehog (USA, Europe).md</ApplicationPath><Platform>Sega Genesis</Platform>
    <Favorite>false</Favorite><PlayCount>3</PlayCount><LastPlayedDate>2024-02-01T20:00:00.0000000-07:00</LastPlayedDate><StarRating>4</StarRating><PlayTime>1800</PlayTime><Completed>true</Completed></Game>
</LaunchBox>`;

test("EmulationStation's and LaunchBox's lists are read: favorite, plays, last played, rating, time, finished", () => {
  const es = parseList(ES);
  assert.equal(es.length, 3);
  assert.deepEqual([es[0].fav, es[0].plays, es[0].rating, es[0].time], [true, 12, 4, 5400]);
  assert.equal(new Date(es[0].last * 1000).getFullYear(), 2023);
  assert.equal(es[2].file, "./Mario & Wario (Japan).sfc", "&amp; read as &");
  const lb = parseList(LB);
  assert.deepEqual([lb[0].plays, lb[0].rating, lb[0].time, lb[0].done, lb[0].platform], [3, 4, 1800, true, "Sega Genesis"]);
  assert.equal(parseList("<html></html>"), null);
});

test("lists in a folder are found, games matched by file name, and bringing a list in twice adds nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-import-"));
  try {
    fs.mkdirSync(path.join(dir, "gamelists", "snes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "gamelists", "snes", "gamelist.xml"), ES);
    fs.mkdirSync(path.join(dir, "LaunchBox", "Data", "Platforms"), { recursive: true });
    fs.writeFileSync(path.join(dir, "LaunchBox", "Data", "Platforms", "Sega Genesis.xml"), LB);
    const lists = findLists([dir]);
    assert.equal(lists.length, 2);
    const games = [
      { id: "smw", system: "SNES", path: "/g/snes/Super Mario World (USA).sfc" },
      { id: "s1", system: "Genesis", path: "/g/genesis/Sonic The Hedgehog (USA, Europe).md" },
      { id: "pw", system: "SNES", path: "/g/snes/Pilotwings (USA).sfc" },
    ];
    const p = plan(lists, games);
    assert.deepEqual(p.found.map(f => f.id).sort(), ["s1", "smw"], "played games that are here (Pilotwings has no play, Mario & Wario isn't here)");
    assert.deepEqual(summary(p), { lists: 2, listed: 3, games: 2, favs: 1, plays: 15, time: 7200, ratings: 2, done: 1 });
    const st = { fav: [], plays: { smw: 2 }, time: {}, last: {}, rating: { s1: 5 }, progress: {} };
    assert.equal(apply(st, p), 2);
    assert.deepEqual([st.plays.smw, st.time.smw, st.fav, st.rating.smw, st.rating.s1, st.progress.s1], [14, 5400, ["smw"], 4, 5, "beaten"]);
    assert.equal(apply(st, p), 0, "the same lists again");
    assert.equal(st.plays.smw, 14);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("two games here with the same file name: the list's console or folder decides, or it's left out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-import2-"));
  try {
    fs.mkdirSync(path.join(dir, "snes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snes", "gamelist.xml"), `<gameList><game><path>./Tetris.bin</path><playcount>5</playcount></game></gameList>`);
    const games = [{ id: "a", system: "SNES", path: "/g/snes/Tetris.bin" }, { id: "b", system: "Atari 2600", path: "/g/atari2600/Tetris.bin" }];
    assert.deepEqual(plan(findLists([dir]), games).found.map(f => f.id), ["a"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a list's console decides by its whole name, on Windows paths too; another console's game isn't this one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-import3-"));
  try {
    fs.mkdirSync(path.join(dir, "snes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snes", "gamelist.xml"), `<gameList><game><path>./Tetris 2 (USA).zip</path><playcount>5</playcount></game></gameList>`);
    fs.mkdirSync(path.join(dir, "gc"), { recursive: true });
    fs.writeFileSync(path.join(dir, "gc", "gamelist.xml"), `<gameList><game><path>./Game.iso</path><playcount>2</playcount></game></gameList>`);
    const games = [
      { id: "nes", system: "NES", path: "C:\\Games\\nes\\Tetris 2 (USA).zip" }, { id: "snes", system: "SNES", path: "C:\\Games\\snes\\Tetris 2 (USA).zip" },
      { id: "gc", system: "GameCube/Wii", path: "C:\\Games\\gc\\Game.iso" }, { id: "ps2", system: "PS2", path: "C:\\Games\\ps2\\Game.iso" },
    ];
    assert.deepEqual(plan(findLists([dir]), games).found.map(f => f.id).sort(), ["gc", "snes"]);
    // only the NES copy here: an SNES list's line isn't it
    assert.deepEqual(plan(findLists([path.join(dir, "snes")]), [games[0]]).found, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bringing a list in again adds nothing, even after the game's file moved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-import4-"));
  try {
    fs.mkdirSync(path.join(dir, "snes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "snes", "gamelist.xml"), ES);
    const st = { fav: [], plays: {}, time: {}, last: {}, rating: {}, progress: {} };
    assert.equal(apply(st, plan(findLists([dir]), [{ id: "smw", system: "SNES", path: "/g/snes/Super Mario World (USA).sfc" }])), 1);
    // moved: a new id, the same game
    st.plays.moved = st.plays.smw; delete st.plays.smw;
    assert.equal(apply(st, plan(findLists([dir]), [{ id: "moved", system: "SNES", path: "/h/snes/Super Mario World (USA).sfc" }])), 0);
    assert.equal(st.plays.moved, 12);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

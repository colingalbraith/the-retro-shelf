import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { Backend } = createRequire(import.meta.url)("../src/backend.js");
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

let home, be, games;
const put = (rel, text = "x") => { const p = path.join(games, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const cue = bins => bins.map(b => `FILE "${b}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`).join("");
const byTitle = t => [...be.games.values()].find(g => g.title === t);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-be-"));
  be = new Backend({ app: APP, data: path.join(home, "data"), docs: path.join(home, "docs"), emu: path.join(home, "none"), version: "test" }, async () => { throw new Error("offline"); });
  be.init();
  games = be.romsRoot();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test("a disc game's tracks and pictures belong to it, and nothing of the game next to it", () => {
  put("ps1/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA).bin"); put("ps1/Crash (USA).png");
  put("ps1/Spyro (USA).cue", cue(["Spyro (USA).bin"])); put("ps1/Spyro (USA).bin");
  be.scan();
  const { folder, files } = be.gameFiles(byTitle("Crash"));
  assert.equal(folder, null);
  assert.deepEqual(files.map(f => path.basename(f)).sort(), ["Crash (USA).bin", "Crash (USA).cue", "Crash (USA).png"]);
});

test("a game in a folder of its own goes as the folder; a shared folder doesn't", () => {
  put("ps1/FF7/FF7 (Disc 1).cue", cue(["FF7 (Disc 1).bin"])); put("ps1/FF7/FF7 (Disc 1).bin");
  put("ps1/RPGs/Suikoden.cue", cue(["Suikoden.bin"])); put("ps1/RPGs/Suikoden.bin");
  put("ps1/RPGs/Xenogears.cue", cue(["Xenogears.bin"])); put("ps1/RPGs/Xenogears.bin");
  be.scan();
  assert.equal(be.gameFiles(byTitle("FF7")).folder, path.join(games, "ps1", "FF7"));
  const s = be.gameFiles(byTitle("Suikoden"));
  assert.equal(s.folder, null);
  assert.equal(s.files.length, 2);
});

test("moving a disc game takes its tracks along and keeps its play history", () => {
  put("ps1/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA).bin");
  be.scan();
  const g = byTitle("Crash");
  be.state.plays[g.id] = 7;
  const [code, res] = be.moveTo(g.id, "PC Engine");
  assert.equal(code, 200);
  assert.ok(fs.existsSync(path.join(games, "pce", "Crash (USA).bin")));
  assert.ok(!fs.existsSync(path.join(games, "ps1", "Crash (USA).bin")));
  assert.equal(be.state.plays[res.id], 7);
});

test("choosing the cover that's already next to the game keeps it", () => {
  put("nes/Tetris.nes"); const pic = put("nes/Tetris.png", "PNGDATA");
  be.scan();
  const [code] = be.setArt(byTitle("Tetris").id, "cover", pic);
  assert.equal(code, 200);
  assert.equal(fs.readFileSync(pic, "utf8"), "PNGDATA");
});

test("discs listed in an .m3u show once, even from a subfolder", () => {
  put("ps1/MGS.m3u", "discs/MGS (Disc 1).cue\ndiscs/MGS (Disc 2).cue\n");
  for (const d of [1, 2]) { put(`ps1/discs/MGS (Disc ${d}).cue`, cue([`MGS (Disc ${d}).bin`])); put(`ps1/discs/MGS (Disc ${d}).bin`); }
  be.scan();
  assert.deepEqual([...be.games.values()].map(g => path.basename(g.path)), ["MGS.m3u"]);
});

test("play history follows games when the games folder moves (the Arcade rename)", () => {
  const p = put("snes/Chrono Trigger (USA).sfc");
  be.scan();
  const oldRoot = path.join(home, "old", "Games"), crypto = createRequire(import.meta.url)("node:crypto");
  const oldId = crypto.createHash("sha1").update(path.join(oldRoot, "snes", "Chrono Trigger (USA).sfc")).digest("hex").slice(0, 12);
  be.state.time[oldId] = 3600; be.state.fav.push(oldId);
  be.remapIds(oldRoot);
  const id = byTitle("Chrono Trigger").id;
  assert.equal(be.state.time[id], 3600);
  assert.ok(be.state.fav.includes(id));
  assert.ok(fs.existsSync(p));
});

test("shelves people make can be filled, renamed and deleted, and follow a game that moves", () => {
  put("snes/Chrono Trigger (USA).sfc"); put("snes/EarthBound (USA).sfc"); put("ps1/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA).bin");
  be.scan();
  const chrono = byTitle("Chrono Trigger").id, crash = byTitle("Crash").id;
  assert.equal(be.shelfOp({ op: "create", name: "Couch co-op", id: crash })[0], 200);
  assert.equal(be.shelfOp({ op: "create", name: "couch CO-OP" })[0], 409, "names don't repeat, whatever their case");
  be.shelfOp({ op: "add", name: "Couch co-op", id: chrono });
  be.shelfOp({ op: "add", name: "Couch co-op", id: chrono });
  assert.deepEqual(be.state.shelves[0].ids, [crash, chrono], "a game is on a shelf once");
  const [, moved] = be.moveTo(crash, "PC Engine");
  assert.deepEqual(be.state.shelves[0].ids, [moved.id, chrono]);
  be.shelfOp({ op: "rename", name: "Couch co-op", to: "Two players" });
  be.shelfOp({ op: "remove", name: "Two players", id: chrono });
  assert.deepEqual(be.libraryJson().shelves, [{ name: "Two players", ids: [moved.id] }]);
  be.shelfOp({ op: "delete", name: "Two players" });
  assert.deepEqual(be.state.shelves, []);
});

test("the bug report gives versions and setup without the home folder's path", () => {
  put("nes/Tetris.nes");
  be.scan();
  const text = be.report("9.9.9");
  assert.match(text, /^The Retro Shelf 9\.9\.9/);
  assert.match(text, /Games: 1 \(NES 1\)/);
  assert.ok(!text.includes(os.homedir()), "paths start with ~");
});

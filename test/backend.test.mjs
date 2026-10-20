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
  assert.deepEqual(be.libraryJson().shelves, [{ name: "Two players", ids: [moved.id], wanted: [] }]);
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

test("each sitting is logged when a game closes (not one that quit right away), and follows a game that moves", () => {
  put("ps1/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA).bin");
  be.scan();
  const id = byTitle("Crash").id, t = Date.now() / 1000;
  be.onExit({ id, since: t - 1800, alive: true, builtIn: false, stopping: false });
  be.onExit({ id, since: t - 2, alive: true, builtIn: false, stopping: false });
  assert.equal(be.state.sessions.length, 1);
  assert.equal(be.state.sessions[0][0], id);
  assert.ok(Math.abs(be.state.sessions[0][2] - 1800) < 5);
  const [, moved] = be.moveTo(id, "PC Engine");
  assert.equal(be.state.sessions[0][0], moved.id);
});

test("collections: series show which games you have, and your own ones can hold games you want", () => {
  put("gb/Pokemon - Red Version (USA, Europe) (SGB Enhanced).gb");
  put("snes/Legend of Zelda, The - A Link to the Past (USA).sfc");
  be.scan();
  const { series } = be.collections()[1];
  const poke = series.find(s => s.name === "Pokémon"), zelda = series.find(s => s.name === "The Legend of Zelda");
  assert.ok(poke && zelda, "series with a game you have are listed");
  assert.equal(poke.have, 1);
  assert.ok(poke.items.length > 5, "and the ones you don't have too");
  assert.equal(poke.items.find(i => i.id).title, "Pokemon: Red Version");
  assert.ok(!series.some(s => s.name === "Mega Man"), "series with none of your games aren't");

  const found = be.gameSearch("pokemon blue")[1].results;
  assert.equal(found[0].title, "Pokemon: Blue Version");
  assert.equal(found[0].id, null);
  be.shelfOp({ op: "create", name: "Wishlist" });
  be.shelfOp({ op: "want", name: "Wishlist", system: found[0].system, look: found[0].look });
  let mine = be.collections()[1].mine[0];
  assert.deepEqual(mine.items.map(i => [i.title, !!i.id]), [["Pokemon: Blue Version", false]]);
  put("gb/" + found[0].look + ".gb");
  be.scan();
  mine = be.collections()[1].mine[0];
  assert.equal(mine.have, 1, "a wanted game you then add counts as yours");
  be.shelfOp({ op: "unwant", name: "Wishlist", system: found[0].system, look: found[0].look });
  assert.equal(be.collections()[1].mine[0].items.length, 0);
});

test("pins: ones already earned when pins arrive don't pop up; a new one does, after the game", () => {
  put("nes/Tetris.nes");
  be.scan();
  const id = byTitle("Tetris").id;
  be.state.plays[id] = 3; be.state.time[id] = 12 * 3600; delete be.state.pins;
  be.checkPins();
  assert.equal(be.state.pins.hours10, 0, "earned before pins existed");
  assert.deepEqual(be.newPins || [], []);
  be.onExit({ id, since: Date.now() / 1000 - 3.5 * 3600, alive: true, builtIn: false, stopping: false });
  assert.ok(be.newPins.includes("marathon"));
  assert.ok(be.state.pins.marathon > 0);
});

test("covers are found for games with & in their name (the cover site writes it as _)", () => {
  const names = ["Sonic _ Knuckles (World).png", "Sonic _ Knuckles (Europe).png", "Tetris (World).png"];
  const nm = new Map();
  const norm = s => s.replace(/[([][^)\]]*[)\]]/g, " ").toLowerCase().replace(/&/g, "and").trim().replace(/^(.*?),\s*(the|a|an)$/, "$2 $1").replace(/[^a-z0-9]+/g, "");
  for (const n of names) { const k = norm(n.replace(/\.png$/, "")); (nm.get(k) || nm.set(k, []).get(k)).push(n); }
  const idx = { names: new Set(names), nm };
  assert.equal(be.matchName(idx, "Sonic & Knuckles (World)"), "Sonic _ Knuckles (World).png");
  assert.equal(be.matchName(idx, "Sonic & Knuckles (USA)"), "Sonic _ Knuckles (World).png");
  assert.equal(be.matchName(idx, "Tetris (World)"), "Tetris (World).png");
});

test("a first, like the first backup, earns its pin once", () => {
  be.checkPins();
  be.newPins = [];
  be.event("backup");
  be.event("backup");
  assert.deepEqual(be.newPins, ["backup"]);
  assert.ok(be.state.pins.backup > 0);
});

test("pins added in a newer version that were already earned don't all pop up at once", () => {
  put("nes/Tetris.nes");
  be.scan();
  const id = byTitle("Tetris").id;
  be.state.plays[id] = 1; be.state.time[id] = 30 * 3600;
  be.checkPins();
  be.newPins = [];
  delete be.state.pins.hours25; be.state.pinKeys = be.state.pinKeys.filter(k => k !== "hours25");   // as if "Settling In" were new
  be.checkPins();
  assert.equal(be.state.pins.hours25, 0);
  assert.deepEqual(be.newPins, []);
});

test("what's new: shown after an update, once, and never on a new install", async () => {
  const mk = (seen, welcomed) => {
    const data = path.join(home, "u" + Math.random());
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ ui: { welcomed } }));
    if (seen) fs.writeFileSync(path.join(data, "state.json"), JSON.stringify({ seenVersion: seen }));
    const b = new Backend({ app: APP, data, docs: path.join(home, "docs"), emu: path.join(home, "none"), version: "0.3.0" }, async () => { throw new Error("offline"); });
    b.init();
    return b;
  };
  assert.deepEqual(mk(null, false).whatsNew(), []);                 // new: the welcome card instead
  const up = mk(null, true), news = up.whatsNew();                   // from 0.2.0, which didn't keep a version
  assert.deepEqual(news.map(c => c.version), ["0.3.0"]);
  assert.equal(news[0].items[0][0], "Collections:");
  assert.match(news[0].items[0][1], /faded, and collections of your own/);   // the wrapped line joins up
  await up.route("POST", "/api/whatsnew/seen", {});
  assert.deepEqual(up.whatsNew(), []);
  assert.deepEqual(mk("0.1.0", true).whatsNew().map(c => c.version), ["0.3.0", "0.2.0"]);
});

test("a resume picture of one color (a game left before it drew anything) counts as no picture", async () => {
  const { flatPng } = createRequire(import.meta.url)("../src/backend.js");
  const zlib = await import("node:zlib");
  // a PNG the way RetroArch writes one: 8-bit RGB, rows filtered with "Sub"
  const png = (w, h, px) => {
    const rows = [];
    for (let y = 0; y < h; y++) {
      const r = Buffer.alloc(1 + w * 3); r[0] = 1;
      for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) r[1 + x * 3 + c] = (px(x, y)[c] - (x ? px(x - 1, y)[c] : 0)) & 255;
      rows.push(r);
    }
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "latin1"); d.copy(b, 8); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  };
  assert.equal(flatPng(png(256, 224, () => [0, 0, 0])), true);
  assert.equal(flatPng(png(256, 224, () => [4, 2, 6])), true);                                    // near enough black
  assert.equal(flatPng(png(256, 224, (x, y) => (x > 100 && x < 110 && y === 50 ? [255, 255, 255] : [0, 0, 0]))), false);  // a little something
  assert.equal(flatPng(png(64, 64, (x, y) => [x * 4, y * 4, 0])), false);
  assert.equal(flatPng(Buffer.from("not a png")), false);
});

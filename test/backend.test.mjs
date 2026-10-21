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

test("what's new with test versions: their notes reach people on test versions, a release shows its own", () => {
  const app = path.join(home, "app"), src = path.join(app, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(app, "CHANGELOG.md"), "# Changelog\n\n## 0.4.0\n\n- **All of it**\n\n## 0.4.0-beta.2\n\n- Rewind\n\n## 0.4.0-beta.1\n\n- Filters\n\n## 0.3.1\n\n- Fixes\n");
  const mk = (version, seen) => {
    const data = path.join(home, "v" + Math.random());
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ ui: { welcomed: true } }));
    fs.writeFileSync(path.join(data, "state.json"), JSON.stringify({ seenVersion: seen }));
    const b = new Backend({ app: src, data, docs: path.join(home, "docs"), emu: path.join(home, "none"), version }, async () => { throw new Error("offline"); });
    b.init();
    return b.whatsNew().map(c => c.version);
  };
  assert.deepEqual(mk("0.4.0-beta.2", "0.4.0-beta.1"), ["0.4.0-beta.2"]);
  assert.deepEqual(mk("0.4.0-beta.1", "0.3.1"), ["0.4.0-beta.1"]);
  assert.deepEqual(mk("0.4.0", "0.3.1"), ["0.4.0"]);
  assert.deepEqual(mk("0.4.0", "0.4.0-beta.2"), ["0.4.0"]);
});

test("a game can have settings of its own, over the app's, and they follow it when it moves", async () => {
  put("snes/Chrono Trigger (USA).sfc"); be.scan();
  const g = byTitle("Chrono Trigger");
  assert.equal(be.ui.picture, "auto");
  assert.equal(be.playOpts(g).picture, "crt");                                // SNES, by console: the old TV
  assert.deepEqual((await be.route("POST", "/api/game/opts", { id: g.id, opts: { picture: "crt", nonsense: 1 } })).body, { ok: true, opts: { picture: "crt" } });
  assert.equal(be.playOpts(g).picture, "crt");
  assert.equal((await be.route("POST", "/api/game/opts", { id: g.id, opts: { picture: "neon" } })).code, 400);
  assert.equal(be.libraryJson().games.find(x => x.id === g.id).opts.picture, "crt");
  be.moveStats(g.id, "moved");
  assert.equal(be.state.gameOpts.moved.picture, "crt");
  be.moveStats("moved", g.id);
  await be.route("POST", "/api/game/opts", { id: g.id, opts: { picture: null } });   // back to the app's setting
  assert.equal(be.state.gameOpts[g.id], undefined);
  assert.equal(be.playOpts(g).picture, "crt");
  put("gb/Tetris (World).gb"); be.scan();
  assert.equal(be.playOpts(byTitle("Tetris")).picture, "lcd");               // a handheld, by console: its screen
  be.ui.picture = "sharp";
  assert.equal(be.playOpts(byTitle("Tetris")).picture, "sharp");             // a choice of your own wins
});

test("RetroAchievements: the password stays in memory until RetroArch has a token, then it's wiped", async () => {
  assert.equal((await be.route("POST", "/api/cheevos/signin", { user: "bad name!", pass: "x" })).code, 400);
  assert.equal((await be.route("POST", "/api/cheevos/signin", { user: "Player_1", pass: "hunter2" })).code, 200);
  assert.equal(be.settingsJson().cheevos.pending, "Player_1");
  be.saveState(); be.saveSettings();
  assert.ok(!fs.readFileSync(be.files.settings, "utf8").includes("hunter2") && !fs.readFileSync(be.files.state, "utf8").includes("hunter2"));
  // the game: RetroArch signed in, kept a token, and its settings were saved with the password still in them
  fs.mkdirSync(path.dirname(be.files.raCfg), { recursive: true });
  fs.writeFileSync(be.files.raCfg, 'cheevos_username = "Player_1"\ncheevos_password = "hunter2"\ncheevos_token = "TOKEN"\n');
  be.cheevosAfter();
  assert.deepEqual(be.settingsJson().cheevos, { user: "Player_1", pending: "", failed: false });
  assert.ok(!fs.readFileSync(be.files.raCfg, "utf8").includes("hunter2"));
  // a wrong password: no token, and still wiped
  await be.route("POST", "/api/cheevos/signout", {});
  await be.route("POST", "/api/cheevos/signin", { user: "Player_1", pass: "wrong" });
  fs.writeFileSync(be.files.raCfg, 'cheevos_password = "wrong"\ncheevos_token = ""\n');
  be.cheevosAfter();
  assert.deepEqual(be.settingsJson().cheevos, { user: "", pending: "", failed: true });
  assert.ok(!fs.readFileSync(be.files.raCfg, "utf8").includes("wrong"));
});

test("a game on several discs gets a disc list: one box, its history added up, the first disc's saves under its name", async () => {
  const { createHash } = await import("node:crypto");
  const id = rel => createHash("sha1").update(path.join(games, rel)).digest("hex").slice(0, 12);
  put("ps1/Final Fantasy VII (USA) (Disc 1).cue", cue(["Final Fantasy VII (USA) (Disc 1).bin"])); put("ps1/Final Fantasy VII (USA) (Disc 1).bin");
  put("ps1/Final Fantasy VII (USA) (Disc 2).cue", cue(["Final Fantasy VII (USA) (Disc 2).bin"])); put("ps1/Final Fantasy VII (USA) (Disc 2).bin");
  put("ps1/Final Fantasy VII (USA) (Disc 3).chd");
  put("ps1/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA).bin");
  // from before there was a list: play history on two discs' boxes, and a save from the first
  const d1 = id("ps1/Final Fantasy VII (USA) (Disc 1).cue"), d2 = id("ps1/Final Fantasy VII (USA) (Disc 2).cue");
  Object.assign(be.state.time, { [d1]: 3600, [d2]: 600 }); Object.assign(be.state.plays, { [d1]: 3, [d2]: 1 }); be.state.fav.push(d2);
  be.resumeAt = () => 0; be._coreNames = { pcsx_rearmed_libretro: "PCSX-ReARMed" };
  fs.mkdirSync(path.join(be.folders.saves, "PCSX-ReARMed"), { recursive: true });
  fs.writeFileSync(path.join(be.folders.saves, "PCSX-ReARMed", "Final Fantasy VII (USA) (Disc 1).srm"), "memory card");
  be.scan();
  const ff = [...be.games.values()].filter(g => g.title === "Final Fantasy VII");
  assert.equal(ff.length, 1);
  assert.ok(ff[0].path.endsWith("Final Fantasy VII (USA).m3u"));
  assert.deepEqual(fs.readFileSync(ff[0].path, "utf8").trim().split("\n"), ["Final Fantasy VII (USA) (Disc 1).cue", "Final Fantasy VII (USA) (Disc 2).cue", "Final Fantasy VII (USA) (Disc 3).chd"]);
  assert.equal(be.state.time[ff[0].id], 4200);
  assert.equal(be.state.plays[ff[0].id], 4);
  assert.ok(be.state.fav.includes(ff[0].id) && !be.state.fav.includes(d2));
  assert.equal(fs.readFileSync(path.join(be.folders.saves, "PCSX-ReARMed", "Final Fantasy VII (USA).srm"), "utf8"), "memory card");
  assert.ok(byTitle("Crash"));                                                       // one disc: left as it is
  be.scan();                                                                          // and the next scan changes nothing
  assert.equal([...be.games.values()].filter(g => g.title === "Final Fantasy VII").length, 1);
  assert.equal(be.state.time[ff[0].id], 4200);
});

test("Game Gear games move from the Master System shelf to their own, once, keeping their history", async () => {
  const { createHash } = await import("node:crypto");
  const id = p => createHash("sha1").update(p).digest("hex").slice(0, 12);
  const old = put("sms/Sonic Chaos (USA, Europe).gg"); put("sms/Sonic Chaos (USA, Europe).png", "cover");
  put("sms/Alex Kidd (USA).sms");
  be.state.time[id(old)] = 900; be.state.fav.push(id(old)); delete be.state.ggShelf; be.saveState();
  be.init();
  const sonic = byTitle("Sonic Chaos");
  assert.equal(sonic.system, "Game Gear");
  assert.ok(sonic.path.includes(path.join("gg", "Sonic Chaos")));
  assert.ok(fs.existsSync(path.join(games, "gg", "Sonic Chaos (USA, Europe).png")));
  assert.equal(be.state.time[sonic.id], 900);
  assert.ok(be.state.fav.includes(sonic.id));
  assert.equal(byTitle("Alex Kidd").system, "Master System");
});

test("a game whose name starts with a dot is on the shelf; macOS's ._ files and hidden folders aren't", () => {
  put("ps2/.hack - Infection (USA).iso"); put("ps2/._.hack - Infection (USA).iso"); put("ps2/.cache/Other (USA).iso"); put("ps2/.DS_Store");
  be.scan();
  assert.deepEqual([...be.games.values()].filter(g => g.system === "PS2").map(g => path.basename(g.path)), [".hack - Infection (USA).iso"]);
});

test("progress, rating and a note for a game: set, cleared, kept when it moves", async () => {
  put("snes/Super Metroid (Japan, USA) (En,Ja).sfc"); be.scan();
  const g = byTitle("Super Metroid");
  assert.equal((await be.route("POST", "/api/game/info", { id: g.id, progress: "beaten", rating: 5, note: "  Found   every\nmissile  " })).code, 200);
  let x = be.libraryJson().games.find(y => y.id === g.id);
  assert.deepEqual([x.progress, x.rating, x.note], ["beaten", 5, "Found every missile"]);
  assert.equal((await be.route("POST", "/api/game/info", { id: g.id, rating: 9 })).code, 400);
  assert.equal((await be.route("POST", "/api/game/info", { id: g.id, progress: "abandoned" })).code, 400);
  await be.route("POST", "/api/game/info", { id: g.id, rating: null });                // just the rating goes
  x = be.libraryJson().games.find(y => y.id === g.id);
  assert.deepEqual([x.progress, x.rating], ["beaten", 0]);
  be.moveStats(g.id, "moved");
  assert.equal(be.state.progress.moved, "beaten"); assert.equal(be.state.notes.moved, "Found every missile");
});

test("a watched folder's games show where they are, each on its console's shelf, and go when it's unwatched", () => {
  const dir = path.join(home, "My Games");
  const at = (rel, data = "") => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  at("Super Mario World (USA).sfc");
  at("Discs/Crash Bandicoot (USA).cue", cue(["Crash Bandicoot (USA).bin"])); at("Discs/Crash Bandicoot (USA).bin");
  const md = Buffer.alloc(0x200); md.write("SEGA MEGA DRIVE", 0x100); at("Sonic 2 (World).bin", md);
  at("readme.txt", "hi"); at("._Super Mario World (USA).sfc");
  assert.equal(be.addWatch(path.join(games, "snes"))[0], 400);                     // the games folder's own
  const [code, res] = be.addWatch(dir);
  assert.equal(code, 200);
  const mine = [...be.games.values()].filter(g => g.watched === dir).map(g => [g.title, g.system]).sort();
  assert.deepEqual(mine, [["Sonic 2", "Genesis"], ["Super Mario World", "SNES"]]);
  assert.equal(res.games, 2);
  // an empty disc says nothing about its console: it waits for you to choose, and then it's on that shelf
  const w = be.settingsJson().paths.watch[0];
  assert.deepEqual([w.games, w.unsure], [2, 1]);
  const unsure = be.watchUnsure();
  assert.equal(unsure.length, 1); assert.ok(unsure[0].choices.includes("PS1"));
  assert.equal(be.assignWatched(unsure[0].src, "N64")[0], 400);                  // not a console that file can be
  assert.equal(be.assignWatched(unsure[0].src, "PS1")[0], 200);
  assert.ok([...be.games.values()].some(g => g.title === "Crash Bandicoot" && g.system === "PS1" && g.watched === dir));
  assert.equal(be.addWatch(path.join(dir, "Discs"))[0], 409);                     // inside one that's watched
  assert.equal(be.state.watchSys[path.join(dir, "Sonic 2 (World).bin")], "Genesis"); // remembered, not read again
  be.removeWatch(dir);
  assert.equal([...be.games.values()].filter(g => g.watched).length, 0);
});

test("games from RetroArch's playlists come in on their playlist's console, where they are", () => {
  const ra = path.join(home, "RetroArch", "playlists"), lib = path.join(home, "roms");
  fs.mkdirSync(ra, { recursive: true }); fs.mkdirSync(path.join(lib, "md"), { recursive: true }); fs.mkdirSync(path.join(lib, "sfc"), { recursive: true });
  fs.writeFileSync(path.join(lib, "sfc", "Chrono Trigger (USA).sfc"), "");
  fs.writeFileSync(path.join(lib, "md", "Streets of Rage 2 (USA).bin"), "");        // .bin: could be several consoles; the playlist says
  put("snes/Super Metroid (USA).sfc");
  const item = (p, db) => ({ path: p, label: path.basename(p), core_path: "DETECT", core_name: "DETECT", crc32: "DETECT", db_name: db });
  fs.writeFileSync(path.join(ra, "Nintendo - Super Nintendo Entertainment System.lpl"), JSON.stringify({ version: "1.5", items: [
    item(path.join(lib, "sfc", "Chrono Trigger (USA).sfc"), "Nintendo - Super Nintendo Entertainment System.lpl"),
    item(path.join(lib, "sfc", "Gone (USA).sfc"), "Nintendo - Super Nintendo Entertainment System.lpl"),
    item(path.join(games, "snes", "Super Metroid (USA).sfc"), "Nintendo - Super Nintendo Entertainment System.lpl")] }));
  fs.writeFileSync(path.join(ra, "Sega - Mega Drive - Genesis.lpl"), JSON.stringify({ version: "1.5", items: [item(path.join(lib, "md", "Streets of Rage 2 (USA).bin"), "Sega - Mega Drive - Genesis.lpl")] }));
  be.retroArchPlaylistDirs = () => [ra];
  assert.deepEqual(be.retroArchGames().map(g => [path.basename(g.path), g.system]).sort(), [["Chrono Trigger (USA).sfc", "SNES"], ["Streets of Rage 2 (USA).bin", "Genesis"]]);
  const [code, res] = be.importRetroArch();
  assert.equal(code, 200); assert.deepEqual([res.games, res.folders], [2, 2]);
  assert.deepEqual([...be.paths.watch].sort(), [path.join(lib, "md"), path.join(lib, "sfc")]);   // just the folders they're in
  const got = [...be.games.values()].filter(g => g.watched).map(g => [g.title, g.system]).sort();
  assert.deepEqual(got, [["Chrono Trigger", "SNES"], ["Streets of Rage 2", "Genesis"]]);
});

test("a game's saves: its battery save, resume point and numbered saves, each to the Trash on its own", async () => {
  put("snes/Chrono Trigger (USA).sfc"); be.scan();
  const g = byTitle("Chrono Trigger");
  be.resumeAt = () => 0; be._coreNames = { snes9x_libretro: "Snes9x" };
  const sv = path.join(be.folders.saves, "Snes9x"), st = path.join(be.folders.states, "Snes9x");
  fs.mkdirSync(sv, { recursive: true }); fs.mkdirSync(st, { recursive: true });
  for (const f of ["Chrono Trigger (USA).srm"]) fs.writeFileSync(path.join(sv, f), "battery");
  for (const f of ["Chrono Trigger (USA).state.auto", "Chrono Trigger (USA).state", "Chrono Trigger (USA).state3", "Chrono Trigger (USA) Rev 1.state"]) fs.writeFileSync(path.join(st, f), "state");
  const saves = be.gameSaves(g);
  assert.deepEqual(saves.map(s => [s.kind, s.n]), [["battery", null], ["resume", null], ["slot", 0], ["slot", 3]]);   // not another game's
  const trashed = [];
  be.trash = async p => { trashed.push(path.basename(p)); fs.rmSync(p); };
  assert.equal((await be.route("POST", "/api/saves/trash", { id: g.id, file: path.join(st, "Chrono Trigger (USA).state3") })).code, 200);
  assert.equal((await be.route("POST", "/api/saves/trash", { id: g.id, file: path.join(home, "elsewhere.txt") })).code, 404);   // only its own saves
  assert.deepEqual(trashed, ["Chrono Trigger (USA).state3"]);
  assert.equal(be.gameSaves(g).length, 3);
});

test("saves moved to a folder of your own: copied (the newer copy wins), used from there, and a game open elsewhere is told", async () => {
  put("snes/Chrono Trigger (USA).sfc"); be.scan();
  const g = byTitle("Chrono Trigger"), cloud = path.join(home, "Dropbox");
  fs.mkdirSync(path.join(be.folders.saves, "Snes9x"), { recursive: true });
  fs.writeFileSync(path.join(be.folders.saves, "Snes9x", "Chrono Trigger (USA).srm"), "here");
  fs.mkdirSync(path.join(cloud, "The Retro Shelf Saves", "Snes9x"), { recursive: true });
  const other = path.join(cloud, "The Retro Shelf Saves", "Snes9x", "Other (USA).srm"); fs.writeFileSync(other, "other computer's");
  const [code, res] = await be.moveSaves(cloud);
  assert.equal(code, 200); assert.equal(res.copied, 1);
  assert.equal(be.folders.saves, path.join(cloud, "The Retro Shelf Saves"));
  assert.equal(fs.readFileSync(path.join(be.folders.saves, "Snes9x", "Chrono Trigger (USA).srm"), "utf8"), "here");
  assert.equal(fs.readFileSync(other, "utf8"), "other computer's");                // nothing there was overwritten
  assert.ok(fs.existsSync(path.join(be.dirs.docs, "Saves", "Snes9x", "Chrono Trigger (USA).srm")));   // the old copy stays
  // the other computer has it open
  fs.mkdirSync(path.join(be.folders.saves, ".in-play"), { recursive: true });
  fs.writeFileSync(path.join(be.folders.saves, ".in-play", "Den-PC.json"), JSON.stringify({ host: "Den-PC", system: "SNES", game: "Chrono Trigger (USA)", since: Math.floor(Date.now() / 1000) - 60 }));
  const [c2, r2] = await be.launch(g.id);
  assert.equal(c2, 409); assert.equal(r2.elsewhere, "Den-PC");
  // back to the usual place
  assert.equal((await be.moveSaves(""))[0], 200);
  assert.equal(be.folders.saves, path.join(be.dirs.docs, "Saves"));
});

test("the games folder moved to another drive: every file copied, history kept, the old copy left for you", async () => {
  put("snes/Chrono Trigger (USA).sfc", "rom"); put("ps1/Crash (USA)/Crash (USA).cue", cue(["Crash (USA).bin"])); put("ps1/Crash (USA)/Crash (USA).bin", "disc");
  be.scan();
  be.state.time[byTitle("Chrono Trigger").id] = 7200;
  const drive = path.join(home, "Drive"); fs.mkdirSync(drive);
  const [code, res] = await be.moveLibrary(drive);
  assert.equal(code, 200); assert.ok(res.files >= 3);                              // the games, and what else the folder holds
  assert.equal(be.romsRoot(), path.join(drive, "Games"));
  assert.ok(byTitle("Chrono Trigger").path.startsWith(path.join(drive, "Games")));
  assert.equal(be.state.time[byTitle("Chrono Trigger").id], 7200);
  assert.ok(fs.existsSync(path.join(games, "snes", "Chrono Trigger (USA).sfc")));    // the old copy, until you say
  assert.equal((await be.moveLibrary(drive))[0], 400);                              // into itself
});

test("a backup by itself is due weekly, only when it's on", () => {
  be.ui.autoBackup = false; assert.equal(be.backupDue(), false);
  be.ui.autoBackup = true; delete be.state.lastAutoBackup; assert.equal(be.backupDue(), true);
  be.state.lastAutoBackup = Math.floor(Date.now() / 1000) - 3 * 86400; assert.equal(be.backupDue(), false);
  be.state.lastAutoBackup = Math.floor(Date.now() / 1000) - 8 * 86400; assert.equal(be.backupDue(), true);
  assert.equal(be.backupDir(), path.join(be.dirs.docs, "Backups"));                // until you choose a folder
});

test("a console's buttons, changed: written as RetroArch's remap file for each game, and gone when put back", async () => {
  put("snes/Chrono Trigger (USA).sfc"); be.scan();
  const g = byTitle("Chrono Trigger");
  be.resumeAt = () => 0; be._coreNames = { snes9x_libretro: "Snes9x" };
  const file = path.join(path.dirname(be.files.raCfg), "config", "remaps", "Snes9x", "Chrono Trigger (USA).rmp");
  assert.equal((await be.route("POST", "/api/remap", { system: "SNES", map: { 0: 8, 8: 0 } })).code, 200);   // B and A swapped
  assert.equal((await be.route("POST", "/api/remap", { system: "SNES", map: { 0: 8, 1: 8 } })).code, 400);  // two doing one thing
  assert.equal(be.writeRemap(g), true);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /input_player1_btn_b = "8"/); assert.match(text, /input_player1_btn_a = "0"/); assert.match(text, /input_player1_btn_y = "1"/);
  assert.match(text, /input_player4_btn_b = "8"/);
  assert.equal(be.libraryJson().consoles.SNES.remap[0], 8);
  await be.route("POST", "/api/remap", { system: "SNES", map: {} });
  be.writeRemap(g);
  assert.ok(!fs.existsSync(file));
  // one made in RetroArch's own menu stays
  fs.writeFileSync(file, 'input_player1_btn_b = "9"\n');
  await be.route("POST", "/api/remap", { system: "SNES", map: { 0: 8, 8: 0 } });
  be.writeRemap(g);
  assert.equal(fs.readFileSync(file, "utf8"), 'input_player1_btn_b = "9"\n');
});

test("folders to choose with a controller: the places to start, then each folder's folders and games", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "browse-"));
  fs.mkdirSync(path.join(top, "Retro", "SNES"), { recursive: true }); fs.mkdirSync(path.join(top, ".hidden"));
  fs.writeFileSync(path.join(top, "Retro", "SNES", "Game (USA).sfc"), "x"); fs.writeFileSync(path.join(top, "Retro", "SNES", "notes.txt"), "x");
  fs.writeFileSync(path.join(top, "Retro", "Other (USA).nes"), "x"); fs.writeFileSync(path.join(top, "Retro", "._Other (USA).nes"), "x");
  const start = await be.route("POST", "/api/browse", {});
  assert.equal(start.code, 200); assert.ok(start.body.places.some(p => p.path === os.homedir()));
  const d = (await be.route("POST", "/api/browse", { dir: path.join(top, "Retro") })).body;
  assert.equal(d.games, 1);                                                        // the Mac's ._ copy doesn't count
  assert.deepEqual(d.folders.map(f => [f.name, f.games]), [["SNES", 1]]);
  assert.equal(d.parent, top);
  assert.deepEqual((await be.route("POST", "/api/browse", { dir: top })).body.folders.map(f => f.name), ["Retro"]);
  assert.equal((await be.route("POST", "/api/browse", { dir: path.join(top, "nope") })).code, 404);
  fs.rmSync(top, { recursive: true, force: true });
});

test("a whole home folder or drive isn't watched", () => {
  assert.equal(be.addWatch(os.homedir())[0], 400);
  assert.equal(be.addWatch(path.parse(os.tmpdir()).root)[0], 400);
});

test("the controllers' order reaches RetroArch's config with the game", () => {
  put("nes/Contra (USA).nes"); be.scan();
  // a stand-in for the bundled RetroArch, which tests run without
  const ra = createRequire(import.meta.url)("../src/retroarch.js"), emu = path.join(home, "emu");
  be.ra = { exe: path.join(emu, "retroarch"), cores: path.join(emu, "cores"), info: emu, assets: emu, autoconfig: emu, version: "test" };
  const core = ra.corePath(be.ra.cores, be.cfg.systems.NES.core);
  fs.mkdirSync(path.dirname(core), { recursive: true }); fs.writeFileSync(core, "");
  be.buildCmd(byTitle("Contra"), { pads: [{ name: "Pro Controller", vid: "057e", pid: "2009" }, { name: "Xbox Wireless Controller", vid: "045e", pid: "0b13" }] });
  const cfg = fs.readFileSync(be.files.raCfg, "utf8");
  assert.match(cfg, /input_player1_device_reservation_type = "1"/);
  assert.match(cfg, process.platform === "darwin" ? /input_player1_reserved_device = "Pro Controller"/ : /input_player1_reserved_device = "057e:2009"/);
  be.buildCmd(byTitle("Contra"), {});                                               // one controller later: nothing left over
  assert.match(fs.readFileSync(be.files.raCfg, "utf8"), /input_player1_device_reservation_type = "0"/);
});

test("a game in a series marked as not counting leaves the series' total, and counts again when unmarked", async () => {
  be.franchises = { "Test Series": [["NES", "Game One (USA)"], ["NES", "Game Two (USA)"], ["NES", "Odd One (Japan)"]] };
  put("nes/Game One (USA).nes"); put("nes/Game Two (USA).nes"); be.scan();
  let s = be.collections()[1].series.find(x => x.name === "Test Series");
  assert.deepEqual([s.have, s.total], [2, 3]);
  assert.equal((await be.route("POST", "/api/collections/count", { series: "Test Series", system: "NES", look: "Odd One (Japan)", counts: false })).code, 200);
  s = be.collections()[1].series.find(x => x.name === "Test Series");
  assert.deepEqual([s.have, s.total], [2, 2]); assert.equal(s.items.find(i => i.look === "Odd One (Japan)").counts, false);
  assert.equal((await be.route("POST", "/api/collections/count", { series: "Test Series", system: "NES", look: "Not In It", counts: false })).code, 404);
  await be.route("POST", "/api/collections/count", { series: "Test Series", system: "NES", look: "Odd One (Japan)", counts: true });
  assert.deepEqual(be.state.notCounted, {});
});

test("a month's and a year's recap, and last month's offered once when a new month starts", async () => {
  put("snes/Chrono Trigger (USA).sfc"); put("nes/Contra (USA).nes"); be.scan();
  const ct = byTitle("Chrono Trigger").id, co = byTitle("Contra").id, at = (m, d, h = 20) => new Date(2026, m, d, h).getTime() / 1000;
  be.state.sessions = [[co, at(8, 28), 600], [ct, at(9, 3), 3600], [ct, at(9, 3, 22), 1800], [co, at(9, 10), 7200], [ct, at(9, 20), 900], ["gone", at(9, 21), 300]];
  be.state.pins = { first: at(8, 28), sampler: at(9, 10), old: 0 };
  const r = (await be.route("POST", "/api/recap", { year: 2026, month: 9 })).body;                // October
  assert.deepEqual([r.total, r.sittings, r.days, r.games, r.newGames], [3600 + 1800 + 7200 + 900 + 300, 5, 4, 3, 2]);
  assert.deepEqual(r.top.map(t => [t.id, t.time]), [[co, 7200], [ct, 6300]]);                  // a game no longer here isn't listed
  assert.deepEqual([r.longest.id, r.longest.time], [co, 7200]);
  assert.equal(r.busiest.time, 7200); assert.deepEqual(r.pins, ["sampler"]);
  const y = (await be.route("POST", "/api/recap", { year: 2026, month: null })).body;
  assert.deepEqual([y.sittings, y.pins], [6, ["first", "sampler"]]);
  assert.equal((await be.route("POST", "/api/recap", { year: 2026, month: 12 })).code, 400);
  // offered in November for October, once
  const realNow = Date.now; Date.now = () => new Date(2026, 10, 2).getTime();
  try {
    assert.equal(be.recapDue().month, 9);
    await be.route("POST", "/api/recap/seen", { year: 2026, month: 9 });
    assert.equal(be.recapDue(), null);
    Date.now = () => new Date(2027, 0, 3).getTime();                                          // January: the whole year
    assert.deepEqual([be.recapDue().year, be.recapDue().month], [2026, null]);
  } finally { Date.now = realNow; }
});

test("display settings are kept as chosen: sort by rating, the shelves' wood and wall, the screensaver and music", async () => {
  await be.route("POST", "/api/settings", { ui: { sort: "rating", wood: "oak", wall: "light", saver: 10, music: true, musicVol: "quiet" } });
  const ui = be.ui;
  assert.deepEqual([ui.sort, ui.wood, ui.wall, ui.saver, ui.music, ui.musicVol], ["rating", "oak", "light", 10, true, "quiet"]);
  await be.route("POST", "/api/settings", { ui: { sort: "nope", wood: "pine", saver: 7 } });
  const back = be.ui;
  assert.deepEqual([back.sort, back.wood, back.saver], ["title", "walnut", 5]);
});

test("the menu music: every track in the list is there, CC0 and credited, and served", async () => {
  const tracks = JSON.parse(fs.readFileSync(path.join(APP, "music", "tracks.json"), "utf8"));
  assert.ok(tracks.length >= 3);
  for (const t of tracks) {
    assert.ok(fs.existsSync(path.join(APP, "music", t.file)), t.file);
    assert.equal(t.license, "CC0"); assert.ok(t.by && t.title && /^https:\/\/opengameart\.org\//.test(t.url));
  }
  const r = await be.route("GET", "/music/" + tracks[0].file);
  assert.equal(r.code ?? 200, 200);
  assert.equal((await be.route("GET", "/music/../config.json")).code ?? 404, 404);
});

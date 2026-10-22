// Random and broken inputs, many of them: nothing the app reads from outside (a dropped folder, another app's play
// lists, another computer's journal, a backup zip, RetroArch's settings) may crash it or write outside where it should.
// Seeded, so a failure happens again the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseList } = require("../src/playimport.js");
const sync = require("../src/sync.js");
const { unzipInto, zipFolder } = require("../src/zip.js");
const { Importer } = require("../src/importer.js");
const ra = require("../src/retroarch.js");
const config = require("../src/config.json");

let seed = 20261022;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const PIECES = ["", " ", ".", "..", "/", "\\", "\0", "\n", "\r\n", '"', "'", "&amp;", "&#x41;", "&#99999999;", "<", ">", "]]>", "<![CDATA[", "é", "é",
  "🎮", "‮", "constructor", "__proto__", "toString", "CON", "nul", "a".repeat(300), "(Disc 1)", "(USA)", ".m3u", ".cue", ".bin", "-1", "1e309", "NaN", "999999999999"];
const junk = n => Array.from({ length: n }, () => rnd() < .5 ? pick(PIECES) : String.fromCharCode(Math.floor(rnd() * 0x3000))).join("");
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), "retro-shelf-fuzz-" + name + "-"));

test("play lists from other apps: any text reads as a list or as nothing, never a crash or a nonsense number", () => {
  for (let i = 0; i < 3000; i++) {
    const tag = pick(["path", "playcount", "gametime", "lastplayed", "rating", "favorite", "ApplicationPath", "PlayCount", "PlayTime", "LastPlayedDate", "StarRating", "Completed", "Platform"]);
    const body = rnd() < .5 ? junk(8) : `<${tag}>${junk(4)}</${tag}>`;
    const text = pick([`<gameList><game>${body}<path>${junk(3)}</path></game></gameList>`, `<LaunchBox><Game>${body}<ApplicationPath>${junk(3)}</ApplicationPath></Game></LaunchBox>`, junk(20)]);
    const list = parseList(text);
    if (list === null) continue;
    for (const g of list) {
      for (const k of ["plays", "time", "last", "rating"]) assert.ok(Number.isFinite(g[k]) && g[k] >= 0, `${k} ${g[k]} from ${JSON.stringify(text).slice(0, 120)}`);
      assert.ok(g.rating <= 5 && g.plays <= 1e5 && g.time <= 1e8);
      assert.ok(g.last <= Date.now() / 1000 + 86400 + 1);
    }
  }
});

test("journals from other computers: any JSON (or not) is read without a crash, and never adds nonsense", () => {
  const dir = tmp("journals"), keyOf = new Map([["g1", "SNES/a.sfc"], ["g2", "NES/b.nes"]]);
  try {
    const values = [null, true, 0, -1, 1e309, "x", [], {}, [1], [1, 2, 3], ["beaten", 1], [7, 1], [null, 0], ["constructor", 1], { plays: 1 }];
    for (let i = 0; i < 2000; i++) {
      const e = {}; for (const k of ["plays", "time", "last", "rating", "progress", "notes", "fav"]) if (rnd() < .6) e[k] = pick(values);
      const j = rnd() < .1 ? junk(30) : JSON.stringify({ v: pick([1, 1, 1, 2, "1"]), machine: pick(["m1", "m2", 5, null]), host: pick(["Den", 7, null]), at: pick(values),
        games: pick([{ [pick(["SNES/a.sfc", "NES/b.nes", "x"])]: e }, null, [], "x"]), sessions: pick([[["SNES/a.sfc", 100, 60]], [[1, 2, 3]], "x", null, [[null]], [["SNES/a.sfc", -5, 1e9]]]) });
      fs.writeFileSync(path.join(dir, `j${i % 7}.json`), j);
      const c = sync.combine(sync.readJournals(dir, "me"), keyOf);
      for (const a of c.add.values()) for (const k of ["plays", "time", "last"]) assert.ok(Number.isFinite(a[k]) && a[k] >= 0);
      for (const [k, [v]] of c.set) {
        const f = k.split(":")[0];
        if (f === "rating") assert.ok(v === null || (Number.isInteger(v) && v >= 1 && v <= 5));
        if (f === "progress") assert.ok(v === null || ["backlog", "playing", "beaten", "complete"].includes(v));
        if (f === "fav") assert.equal(typeof v, "boolean");
      }
      for (const s of c.sessions) assert.ok(s[2] > 0 && s[2] <= 12 * 3600);
      const st = { fav: [], progress: {}, rating: {}, notes: {}, edited: {} };
      sync.adopt(st, c.set);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a zip that isn't a backup, or a broken one, restores nothing outside the saves folder and doesn't crash", async () => {
  const base = tmp("zip"), saves = path.join(base, "Saves"), out = path.join(base, "restore"), outside = path.join(base, "outside");
  try {
    fs.mkdirSync(path.join(saves, "Snes9x"), { recursive: true });
    fs.writeFileSync(path.join(saves, "Snes9x", "Game.srm"), "save data");
    await zipFolder(saves, path.join(base, "good.zip"));
    const good = fs.readFileSync(path.join(base, "good.zip"));
    for (let i = 0; i < 400; i++) {
      // the good backup, with bytes changed, cut short or names rewritten to climb out
      const z = Buffer.from(good);
      if (rnd() < .4) for (let k = 0; k < 1 + rnd() * 20; k++) z[Math.floor(rnd() * z.length)] = Math.floor(rnd() * 256);
      const name = Buffer.from("Saves/Snes9x/Game.srm"), at = z.indexOf(name);
      if (rnd() < .3 && at >= 0) Buffer.from(pick(["Saves/../out/x.srm", "Saves/..\\x.srm", "Saves/C:x.srm", "Saves//x.srm", "Saves/./x.srm"]).padEnd(name.length, "a").slice(0, name.length)).copy(z, at);
      const file = path.join(base, "z.zip"); fs.writeFileSync(file, rnd() < .2 ? z.subarray(0, Math.floor(rnd() * z.length)) : z);
      fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
      try { await unzipInto(file, out); } catch { /* "that isn't a backup" is fine */ }
      assert.ok(!fs.existsSync(outside));
      for (const e of fs.readdirSync(base)) assert.ok(["Saves", "restore", "good.zip", "z.zip"].includes(e), "nothing written beside it: " + e);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("dropped folders with odd file names and broken disc sheets are looked at without a crash", () => {
  const base = tmp("drop"), imp = new Importer(config.systems);
  try {
    const exts = [".nes", ".sfc", ".gb", ".md", ".bin", ".cue", ".m3u", ".gdi", ".iso", ".chd", ".zip", ".png", ".txt", ""];
    for (let i = 0; i < 150; i++) {
      const name = junk(2).replace(/[\/\\\0:*?"<>|\r\n]/g, "_").slice(0, 120).trim() || "x";
      const ext = pick(exts), f = path.join(base, (name + ext).slice(-200));
      try { fs.writeFileSync(f, ext === ".cue" || ext === ".m3u" || ext === ".gdi" ? `FILE "${junk(2)}" BINARY\n${junk(10)}\n../../${junk(1)}\n/etc/hosts\n` : Buffer.from(junk(rnd() * 600))); } catch {}
    }
    const r = imp.inspect([base]);
    assert.ok(Array.isArray(r.items) && Array.isArray(r.unknown));
    for (const it of r.items) for (const x of it.extras) assert.ok(x.startsWith(base), "nothing from outside the drop comes along: " + x);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("RetroArch's settings file: any value written is read back as written, on one line, and nothing else changes", () => {
  const dir = tmp("cfg"), file = path.join(dir, "retroarch.cfg");
  try {
    fs.writeFileSync(file, 'video_driver = "gl"\r\ninput_player1_a = "x"\n# a comment\n');
    for (let i = 0; i < 1000; i++) {
      const key = pick(["savefile_directory", "cheevos_username", "input_player1_a", "x_" + Math.floor(rnd() * 20)]), value = junk(3);
      ra.writeConfig(file, { [key]: value });
      const text = fs.readFileSync(file, "utf8");
      assert.equal(text.split(/\r?\n/).filter(l => l.startsWith(key + " ")).length, 1, "one line for " + key);
      assert.ok(text.includes('video_driver = "gl"'));
      const back = ra.readConfigKey(file, key);
      assert.equal(back, value.replace(/["\x00-\x1f]/g, ""));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

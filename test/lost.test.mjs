// Nothing is ever lost: long random runs of what people do (play, add games, move them, rename and hide them, add,
// switch, rename and take off people, share saves through a cloud folder and come back, a second computer sharing it,
// back up and restore, put saves and screenshots in the Trash, choose covers), with a stand-in for RetroArch writing
// saves where the app tells it to. After every step, every save, game, cover and screenshot that was ever made (each
// with contents of its own) has to still be somewhere: where it was, moved, copied, or in the Trash. Only RetroArch
// writing a save again replaces one, as it does when you play. And each person's game shows their newest save of it.
// Seeded: a run that fails fails the same way again, with the steps that led there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Backend } = require("../src/backend.js");
const { zipFolder, unzipInto } = require("../src/zip.js");
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// the consoles played here, their folders and files, and their emulators' folder names (as RetroArch names them)
const KINDS = [["NES", "nes", ".nes"], ["SNES", "snes", ".sfc"], ["Genesis", "genesis", ".md"], ["Master System", "sms", ".sms"], ["Game Gear", "gg", ".gg"]];
const CORES = { fceumm_libretro: "FCEUmm", snes9x_libretro: "Snes9x", genesis_plus_gx_libretro: "Genesis Plus GX" };
const NAMES = ["Sonic (USA)", "Tetris (World)", "Zelda (USA)", "Columns (USA)", "Mario (USA)", "Golf (Japan)", "Pac-Man (USA)", "Ys (USA)", ".hack (USA)", "Ünïcødé (Europe)"];

function run(seed, steps) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }, pick = a => a[Math.floor(rnd() * a.length)];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `retro-shelf-lost-${seed}-`)), trash = path.join(home, "Trash"), cloud = path.join(home, "Dropbox");
  fs.mkdirSync(trash); fs.mkdirSync(cloud);
  let n = 0, clock = Math.floor(Date.now() / 1000) - 400 * 86400;
  const made = new Map(), replaced = [];      // every piece of your data: its contents → what it was
  // the newest battery save of each game, for each person on the first computer: what the app has to show them (by
  // person, console and file name)
  const latest = new Map(), keyOf = (person, system, stem) => person + "|" + system + "|" + stem;
  const log = [];
  const tick = () => (clock += 120);
  const write = (file, what) => {
    // RetroArch (or you) writing a file: what was in it before is replaced there (a copy of it elsewhere, left by a
    // game moved between consoles or a cloud folder, is still yours: it's looked for once the step's done)
    try { const old = fs.readFileSync(file, "utf8"); if (made.has(old)) { replaced.push([old, made.get(old)]); made.delete(old); } } catch {}
    const body = `${what} #${++n}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body); const t = tick(); fs.utimesSync(file, t, t);
    made.set(body, what);
  };
  const computer = (name, docs) => {
    const b = new Backend({ app: APP, data: path.join(home, name), docs, emu: path.join(home, "none"), version: "test" }, async () => { throw new Error("offline"); });
    b.init();
    b.ra = { info: path.join(home, "none") }; b._coreNames = { ...CORES };
    b.hostName = () => name;
    b.trash = async p => { fs.renameSync(p, path.join(trash, `${++n} ${path.basename(p)}`)); };
    return b;
  };
  const be = computer("a", path.join(home, "docs"));
  let other = null, backup = null, shared = false;
  const games = () => [...be.games.values()];
  const addGame = (root, kind, name) => write(path.join(root, kind[1], name + kind[2]), "game " + name + kind[2]);

  // what the stand-in RetroArch does when a game is played: its battery save, sometimes its resume point and a
  // screenshot, all where the app says, for whoever's playing; then the app's own end of a game
  const play = (b, g) => {
    const sd = b.saveDirs(g.system), cn = CORES[b.cfg.systems[g.system].core], stem = path.parse(g.path).name;
    if (!cn) return;
    const file = path.join(sd.saves, cn, stem + ".srm");
    write(file, `save of ${g.system} ${stem} by ${b.people.active}`);
    const body = fs.readFileSync(file, "utf8");
    if (b === be) latest.set(keyOf(be.people.active, g.system, stem), body);
    // the second computer writing a file the first one reads too (both sharing the folder, the same person's)
    else for (const p of be.people.list) { const there = be.saveDirs(g.system, be.personFolder(p.id)); if (path.join(there.saves, cn, stem + ".srm") === file) latest.set(keyOf(p.id, g.system, stem), body); }
    if (rnd() < .5) write(path.join(sd.states, cn, stem + ".state.auto"), `resume of ${g.system} ${stem} by ${b.people.active}`);
    if (rnd() < .3) write(path.join(b.folders.screenshots, `${stem}-${String(260101 + n).slice(-6)}-120000.png`), `screenshot of ${stem}`);
    b.onExit({ id: g.id, since: clock - 600, t0: performance.now() - 600000, alive: true, builtIn: true, stopping: true });
  };

  const actions = {
    async add() { addGame(be.romsRoot(), pick(KINDS), pick(NAMES)); be.scan(); },
    async play() { const g = pick(games()); if (g) play(be, g); },
    async scan() { be.scan(); },
    async moveTo(g = pick(games()), k = pick(KINDS)) {
      if (!g) return false;
      const stem = path.parse(g.path).name, same = be.cfg.systems[g.system].core === be.cfg.systems[k[0]].core;
      // (a game of that name on that console already keeps its own saves: the moved one's don't go there)
      const taken = games().some(x => x.id !== g.id && x.system === k[0] && path.parse(x.path).name.toLowerCase() === stem.toLowerCase());
      if (be.moveTo(g.id, k[0])[0] !== 200) return false;
      for (const p of be.people.list) {
        const was = keyOf(p.id, g.system, stem), v = latest.get(was), to = keyOf(p.id, k[0], stem);
        latest.delete(was);
        if (v && same && !taken) latest.set(to, v);
      }
      return true;
    },
    // a game put on the wrong one of the consoles one emulator plays, maybe played there, and put back: its saves go
    // there and back, meeting the ones it left behind
    async moveBack() {
      const sega = KINDS.filter(k => ["Genesis", "Master System", "Game Gear"].includes(k[0])), g = pick(games().filter(x => sega.some(k => k[0] === x.system)));
      if (!g) return;
      const stem = path.parse(g.path).name, from = sega.find(k => k[0] === g.system), to = pick(sega.filter(k => k !== from));
      if (!(await actions.moveTo(g, to))) return;
      const there = games().find(x => x.system === to[0] && path.parse(x.path).name === stem);
      if (there && rnd() < .7) play(be, there);
      if (there) await actions.moveTo(there, from);
    },
    async hide() { const g = pick(games()); if (g) be.hide(g.id, rnd() < .7); },
    async rename() { const g = pick(games()); if (g) be.rename(g.id, rnd() < .5 ? "" : "My " + g.title); },
    async addPerson() { be.addPerson(pick(["Sam", "Alex", "Ann Marie", "Саша", "Zoë", "Kim"])); },
    async usePerson() { be.usePerson(pick(be.people.list).id); },
    // a folder of the new name already there (one left in a shared folder by someone taken off): the newer saves win
    async renamePerson() {
      const p = pick(be.people.list), was = new Map(), walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else was.set(f, fs.readFileSync(f, "utf8")); } };
      walk(path.join(be.savesRoot(), "People"));
      if ((await be.renamePerson(p.id, pick(["Samantha", "Lex", "Ann-Marie", "Маша", "Zoe", "Kimberly"])))[0] !== 200) return;
      for (const [k, v] of [...latest]) { const [id, sys, stem] = k.split("|"), there = id === p.id && was.get(theirFile(id, sys, stem)); if (there && num(there) > num(v)) latest.set(k, there); }
    },
    async removePerson() { const p = pick(be.people.list); if (p.id !== "p1" && (await be.removePerson(p.id))[0] === 200) for (const k of [...latest.keys()]) if (k.startsWith(p.id + "|")) latest.delete(k); },
    async share() {
      if ((await be.moveSaves(cloud))[0] !== 200) return;
      // a folder another computer may use keeps the saves in it: all of them the first time this one shares it; after
      // that, the part of whoever another computer plays as (the first person's: the other computer's only one), and
      // for the rest the newer wins
      if (!shared) accept(); else { newerWins(); if (other) accept(k => k.startsWith("p1|")); }
      shared = true;
    },
    // coming home, the newer of each save wins: one played on the other computer since can be the one shown
    async home() { if ((await be.moveSaves(""))[0] === 200) newerWins(); },
    async moveLibrary() {
      const r = await be.moveLibrary(path.join(home, "drive" + n));
      if (r[0] === 200 && rnd() < .5) await be.trash(r[1].from);          // and the old copy to the Trash, as offered
    },
    async backup() { if (fs.existsSync(be.savesRoot())) { backup = path.join(home, `backup ${++n}.zip`); await zipFolder(be.savesRoot(), backup); } },
    // a restore puts back the backup's copy of a save older than it: a newer one than the one shown can come back
    async restore() { if (backup && fs.existsSync(be.savesRoot())) { await unzipInto(backup, be.savesRoot(), { aside: f => be.trash(f) }); be.afterRestore(); newerWins(); } },
    async trashSave() {
      const g = pick(games()); if (!g) return;
      const sv = be.gameSaves(g); if (!sv.length) return;
      const f = pick(sv); await be.trashSave(g.id, f.file);
      // a battery save put in the Trash: there's no newest one to show (a backup may bring an older one back)
      if (f.kind === "battery") latest.delete(keyOf(be.people.active, g.system, path.parse(g.path).name));
    },
    async trashShot() { const g = pick(games()); if (!g) return; const sh = be.shotsOf(g); if (sh.length) await be.trashShot(g.id, path.basename(pick(sh).file)); },
    async cover() {
      const g = pick(games()); if (!g) return;
      const img = path.join(home, "pictures", `${++n}.png`); write(img, "a picture for " + g.title);
      await be.setArt(g.id, "cover", img);
    },
    async importGames() {
      const drop = path.join(home, "drop" + ++n), k = pick(KINDS), name = pick(NAMES);
      addGame(drop, k, name);
      const r = be.importCheck([drop])[1];
      be.importRun(r.items.filter(it => it.system).map(it => ({ id: it.id, system: it.system })));
      for (let i = 0; i < 200 && be.imp.running; i++) await new Promise(res => setTimeout(res, 5));
    },
    // a second computer, sharing the cloud folder: its own games of the same names, played there
    async otherComputer() {
      if (!other) { other = computer("b", path.join(home, "docs-b")); for (const [k, nm] of SHARED) addGame(other.romsRoot(), KINDS[k], NAMES[nm]); other.scan(); await other.moveSaves(cloud); }
      const g = pick([...other.games.values()]); if (g) play(other, g);
    },
  };
  // the games both computers have (so they meet in the shared folder), played often on both
  const SHARED = [[0, 0], [3, 3], [2, 1]];
  actions.playShared = async () => { const g = games().find(x => SHARED.some(([k, nm]) => x.system === KINDS[k][0] && path.parse(x.path).name === NAMES[nm])); if (g) play(be, g); };
  const names = Object.keys(actions), weight = { play: 5, add: 2, moveBack: 2, scan: 2, otherComputer: seed % 2 ? 4 : 1, playShared: 3, share: 2, home: 2 };
  const bag = names.flatMap(k => Array(weight[k] || 1).fill(k));

  // (someone not playing now: what they'd be shown, their save where the app keeps it for them)
  const shownSave = (person, system, stem) => {
    const g = games().find(x => x.system === system && path.parse(x.path).name === stem);
    if (!g) return undefined;
    if (person !== be.people.active) return theirSave(person, system, stem);
    const f = be.gameSaves(g).find(x => x.kind === "battery");
    try { return f ? fs.readFileSync(f.file, "utf8") : null; } catch { return null; }
  };
  const num = v => +((/#(\d+)$/.exec(v || "") || [])[1] || 0);
  // what a person would be shown (playing or not): their save of that game, where the app keeps it for them
  const theirFile = (person, system, stem) => path.join(be.saveDirs(system, be.personFolder(person)).saves, CORES[be.cfg.systems[system].core], stem + ".srm");
  const theirSave = (person, system, stem) => {
    if (!be.people.list.some(p => p.id === person)) return undefined;
    try { return fs.readFileSync(theirFile(person, system, stem), "utf8"); } catch { return null; }
  };
  const newerWins = () => { for (const [k, v] of [...latest]) { const there = theirSave(...k.split("|")); if (there && num(there) > num(v)) latest.set(k, there); } };
  const accept = (only = () => true) => { for (const k of [...latest.keys()].filter(only)) { const v = theirSave(...k.split("|")); if (v !== undefined) { if (v) latest.set(k, v); else latest.delete(k); } } };
  // everything that's yours, wherever it is: contents of every file under the home folder and in the Trash
  const everywhere = () => {
    const seen = new Set(), walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { const st = fs.statSync(p); if (st.size < 512) seen.add(fs.readFileSync(p, "utf8")); } catch {} } } };
    walk(home);
    return seen;
  };
  return (async () => {
    try {
      const ids = { a: be.machine() };
      for (let i = 0; i < 4; i++) await actions.add();
      for (const [k, nm] of SHARED) addGame(be.romsRoot(), KINDS[k], NAMES[nm]);
      be.scan();
      if (seed % 2) await actions.otherComputer();
      for (let i = 0; i < steps; i++) {
        const a = pick(bag);
        log.push(a);
        try { await actions[a](); } catch (e) { throw new Error(`step ${i} (${a}) threw: ${e.stack}\n  steps: ${log.join(", ")}`); }
        const seen = everywhere();
        for (const [c, what] of replaced.splice(0)) if (seen.has(c)) made.set(c, what);
        const lost = [...made].filter(([c]) => !seen.has(c)).map(([c, what]) => `${what} (${c})`);
        // and the newest save of each game is the one the app shows whoever's playing
        const unseen = [...latest].filter(([k, v]) => { const [p, sys, stem] = k.split("|"), shown = shownSave(p, sys, stem); return shown !== undefined && shown !== v; })
          .map(([k, v]) => `${k}: shows ${JSON.stringify(shownSave(...k.split("|")))}, not ${v}`);
        // and neither computer ever takes itself for two (only a copy of one's app data is another computer)
        if (be.machine() !== ids.a || (other && other.machine() !== (ids.b = ids.b || other.machine()))) throw new Error(`seed ${seed}, after step ${i} (${a}), a computer split in two\n  steps: ${log.join(", ")}`);
        if (unseen.length) throw new Error(`seed ${seed}, after step ${i} (${a}), not shown: ${unseen.join("; ")}\n  steps: ${log.join(", ")}`);
        if (lost.length) throw new Error(`seed ${seed}, after step ${i} (${a}), lost: ${lost.join("; ")}\n  steps: ${log.join(", ")}`);
      }
      return made.size;
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  })();
}

test("nothing you have is ever lost, whatever you do, in any order", async () => {
  // LOST_SEEDS=200 LOST_STEPS=400 for a longer run by hand
  const seeds = +process.env.LOST_SEEDS || 12, steps = +process.env.LOST_STEPS || 300;
  for (let seed = 1; seed <= seeds; seed++) {
    const kept = await run(seed, steps);
    assert.ok(kept > 20, `seed ${seed}: the run made things to keep (${kept})`);
  }
});

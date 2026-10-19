#!/usr/bin/env node
// Builds data/arcade-names.json: arcade romset name -> [full game name, year, publisher] ("sf2" -> ["Street
// Fighter II: The World Warrior (World 910522)", "1991", "Capcom"]), from the FinalBurn Neo list in
// libretro-database. Arcade games are named by short codes, so this gives them real titles and lets their covers
// and logos be found.
//   node scripts/fetch-arcade-names.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/fbneo-split/FBNeo%20-%20Arcade%20Games.dat";

const dat = await (await fetch(URL)).text();
const names = {};
for (const block of dat.split(/\ngame \(/).slice(1)) {
  const title = /^\s*name "((?:[^"\\]|\\.)*)"/m.exec(block);
  const rom = /rom \( name ([^ ]+)\.zip /.exec(block);
  const year = /releaseyear "(\d{4})/.exec(block), pub = /publisher "([^"]*)"/.exec(block);
  if (title && rom) names[rom[1]] = [title[1], year ? year[1] : "", pub ? pub[1].replace(/\?+$/, "") : ""];
}
const out = path.join(ROOT, "data", "arcade-names.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(names));
console.log(`${Object.keys(names).length} arcade names -> ${path.relative(ROOT, out)}`);

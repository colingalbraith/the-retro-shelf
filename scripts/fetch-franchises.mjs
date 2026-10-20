#!/usr/bin/env node
// Builds src/data/franchises.json: series name -> its games, as [console, name] in release order, from the franchise
// lists in libretro-database. Only English releases from the West count (a Japanese release has its own name, like
// "Pocket Monsters - Aka" for Pokemon Red, and would count twice); regional versions and revisions of a game count
// once, the original USA one preferred, and a European name for a game released in the USA under another (Lylat
// Wars for Star Fox 64) isn't counted again. Left out: betas, prototypes, demos, unlicensed and homebrew games,
// re-releases (Virtual Console, mini consoles) and compilations, so having "every game" of a series means the
// games themselves. Collections compare these names with the games in the library.
//   node scripts/fetch-franchises.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/franchise";
const SKIP = /\((?:[^)]*\b(?:Beta|Proto|Prototype|Demo|Sample|Kiosk|Debug|Promo|Pirate|Hack|Unl|Aftermarket|Homebrew|Virtual Console|Classic Mini|Genesis Mini|Mega Drive Mini|Switch Online|Evercade|Retro-Bit|Limited Run|Arcade Archives)\b[^)]*)\)|\[BIOS\]/i;
// several games in one box (by the name, not a "(… Collection)" tag saying where a single game came from): their games
// are in the series on their own
const PACK = / \+ |\b\d+ Games in 1\b|Combo Pack|Double Pack|Compilation|Collection\b|Anthology|Classic NES Series|NES Classics|Famicom Mini/i;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
// the same name matching the app uses (backend.js norm): no brackets, no punctuation, "Legend of Zelda, The" = "The Legend of Zelda"
function norm(s) {
  s = s.replace(/[([][^)\]]*[)\]]/g, " ").toLowerCase().replace(/&/g, "and").trim();
  s = s.replace(/^(.*?),\s*(the|a|an)$/, "$2 $1");
  return s.replace(/[^a-z0-9]+/g, "");
}
// a release for the West in English: a region tag naming one of these, and no language list without English
const WEST = /\((?:[^)]*\b)?(?:USA|Europe|World|Australia|Canada|Brazil|UK)\b[^)]*\)/;
const english = n => { const langs = /\(((?:[A-Z][a-z](?:-[A-Za-z]+)?,?)+)\)/.exec(n); return !langs || /\bEn\b/.test(langs[1]); };
const REISSUE = /Virtual Console|Classic Mini|Switch Online|Collection|e-Reader|Evercade|Retro-Bit|Limited Run|Arcade Archives|GameCube Edition|Wii U/i;
const rank = n => (/\bUSA\b/.test(n) ? 0 : /\bWorld\b/.test(n) ? 1 : 2) + (REISSUE.test(n) ? 10 : 0) + (/\(Rev /.test(n) ? 1 : 0);

const series = new Map();   // name -> Map(console|norm -> {system, look, year})
for (const [name, s] of Object.entries(cfg.systems)) {
  const thumbs = !s.thumbs ? [] : typeof s.thumbs === "string" ? [s.thumbs] : s.thumbs;
  if (s.names || !thumbs.length) continue;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "meta", (s.folder || name) + ".json"), "utf8")); } catch {}
  const years = new Map();
  for (const [k, v] of Object.entries(meta)) if (v[0] && !years.has(norm(k))) years.set(norm(k), v[0]);
  for (const system of thumbs) {
    const r = await fetch(`${BASE}/${encodeURIComponent(system)}.dat`);
    if (!r.ok) continue;
    for (const block of (await r.text()).split(/\ngame \(/).slice(1)) {
      const title = /^\s*(?:comment|name) "((?:[^"\\]|\\.)*)"/m.exec(block), fr = /^\s*franchise "([^"]+)"/m.exec(block);
      if (!title || !fr || SKIP.test(title[1]) || PACK.test(title[1].replace(/\s*\([^)]*\)/g, "")) || !WEST.test(title[1]) || !english(title[1])) continue;
      const look = title[1], key = name + "|" + norm(look);
      // "Legend of Zelda" and "The Legend of Zelda" are one series, under the name with "The"
      const bare = fr[1].replace(/^the\s+/i, ""), sname = [...series.keys()].find(k => k.replace(/^the\s+/i, "").toLowerCase() === bare.toLowerCase()) || fr[1];
      if (sname !== fr[1] && /^the\s/i.test(fr[1]) && !/^the\s/i.test(sname)) { series.set(fr[1], series.get(sname)); series.delete(sname); }
      const games = series.get(/^the\s/i.test(fr[1]) ? fr[1] : sname) || series.set(fr[1], new Map()).get(fr[1]);
      const cur = games.get(key);
      if (!cur || rank(look) < rank(cur.look) || (rank(look) === rank(cur.look) && look.length < cur.look.length))
        games.set(key, { system: name, look, year: years.get(norm(look)) || (cur && cur.year) || "" });
    }
  }
}
const US = /\((?:[^)]*\b)?(?:USA|World)\b[^)]*\)/;
const out = {};
for (const [name, games] of [...series].sort((a, b) => a[0].localeCompare(b[0]))) {
  // a release only outside the USA in the same year, on the same console, as one in the USA is that game renamed
  const list = [...games.values()].filter(g => US.test(g.look) || !g.year
    || ![...games.values()].some(o => o !== g && o.system === g.system && o.year === g.year && US.test(o.look)));
  if (list.length < 2) continue;
  out[name] = list.sort((a, b) => (a.year || "9999").localeCompare(b.year || "9999") || a.look.localeCompare(b.look)).map(g => [g.system, g.look]);
}
const file = path.join(ROOT, "src", "data", "franchises.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${Object.keys(out).length} series, ${Object.values(out).reduce((n, g) => n + g.length, 0)} games -> ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

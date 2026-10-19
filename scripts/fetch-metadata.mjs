#!/usr/bin/env node
// Builds src/data/meta/<system folder>.json: game name -> [year, publisher, developer, genre], from the metadata
// lists in libretro-database (matched by the same No-Intro / Redump names that game files and cover art use).
// Shipped with the app, so the back of a box needs no lookups.
//   node scripts/fetch-metadata.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat";
const FIELDS = ["releaseyear", "publisher", "developer", "genre"];

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "config.json"), "utf8"));
const outDir = path.join(ROOT, "src", "data", "meta");
fs.mkdirSync(outDir, { recursive: true });

async function dat(field, system) {
  const r = await fetch(`${BASE}/${field}/${encodeURIComponent(system)}.dat`);
  return r.ok ? r.text() : "";
}

let total = 0;
for (const [name, s] of Object.entries(cfg.systems)) {
  const thumbs = !s.thumbs ? [] : typeof s.thumbs === "string" ? [s.thumbs] : s.thumbs;
  if (s.names || !thumbs.length) continue;            // arcade games get theirs from data/arcade-names.json
  const games = {};
  for (const system of thumbs) {
    for (const [i, field] of FIELDS.entries()) {
      for (const block of (await dat(field, system)).split(/\ngame \(/).slice(1)) {
        const title = /^\s*(?:comment|name) "((?:[^"\\]|\\.)*)"/m.exec(block);
        const value = new RegExp(`^\\s*${field} "([^"]*)"`, "m").exec(block);
        const v = value ? value[1].replace(/\s*\?+\s*/g, " ").trim() : "";   // the lists mark unknowns with "???"
        if (!title || !v) continue;
        const g = games[title[1]] || (games[title[1]] = ["", "", "", ""]);
        if (!g[i]) g[i] = v;
      }
    }
  }
  const n = Object.keys(games).length;
  if (!n) continue;
  fs.writeFileSync(path.join(outDir, (s.folder || name) + ".json"), JSON.stringify(games));
  total += n;
  console.log(`${name.padEnd(14)} ${n} games`);
}
console.log(`${total} games -> ${path.relative(ROOT, outDir)}`);

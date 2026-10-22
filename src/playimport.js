"use strict";
// Play brought in from another game app: EmulationStation's gamelist.xml files (RetroPie, Batocera, ES-DE) and
// LaunchBox's Data/Platforms/<platform>.xml. Each game's favorite, play count, last played, rating, play time and
// (LaunchBox) completed, matched to the games here by file name. Read with a few patterns rather than an XML library:
// both are flat lists of the same few tags.
const fs = require("fs");
const path = require("path");

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m).trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block); return m ? unxml(m[1]) : ""; };
const blocks = (text, name) => [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))].map(m => m[1]);
const yes = v => /^(true|1|yes)$/i.test(v);
/** a file name the way games are matched: no folders, no letter case, accents written one way */
const fileKey = p => path.basename(String(p).replace(/\\/g, "/")).normalize("NFC").toLowerCase();

/** EmulationStation's last played: 20230514T201530 */
function esTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(v || "");
  return m ? Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000) : 0;
}
const isoTime = v => { const t = Date.parse(v || ""); return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : 0; };

/**
 * The games in one file, as { file, folder, fav, plays, last, rating (1-5), time (seconds), done }, or null when it's
 * neither kind of list
 */
function parseList(text) {
  if (/<gameList[\s>]/i.test(text)) {
    return blocks(text, "game").map(b => {
      const r = parseFloat(tag(b, "rating")) || 0;
      return { file: tag(b, "path"), fav: yes(tag(b, "favorite")), plays: parseInt(tag(b, "playcount"), 10) || 0, last: esTime(tag(b, "lastplayed")),
        rating: r > 0 ? Math.max(1, Math.min(5, Math.round(r * 5))) : 0, time: parseInt(tag(b, "gametime"), 10) || 0, done: false };
    }).filter(g => g.file);
  }
  if (/<LaunchBox[\s>]/i.test(text)) {
    return blocks(text, "Game").map(b => {
      const r = parseInt(tag(b, "StarRating"), 10) || 0;
      return { file: tag(b, "ApplicationPath"), platform: tag(b, "Platform"), fav: yes(tag(b, "Favorite")), plays: parseInt(tag(b, "PlayCount"), 10) || 0,
        last: isoTime(tag(b, "LastPlayedDate")), rating: r > 0 ? Math.min(5, r) : 0, time: parseInt(tag(b, "PlayTime"), 10) || 0, done: yes(tag(b, "Completed")) };
    }).filter(g => g.file);
  }
  return null;
}

/** the list files in what was chosen: the files themselves, or in a folder (a few levels down) gamelist.xml files and
    LaunchBox platform lists */
function findLists(paths) {
  const out = new Set();
  const walk = (dir, depth) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith(".")) walk(p, depth + 1);
      else if (e.isFile() && (/^gamelist\.xml$/i.test(e.name) || (/\.xml$/i.test(e.name) && /platforms$/i.test(path.basename(dir))))) out.add(p);
    }
  };
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, 0); else if (/\.xml$/i.test(p)) out.add(p);
  }
  return [...out].slice(0, 500);
}

/**
 * What would come in: each listed game matched to one here by file name (when two games here share one, the console
 * or folder decides, or it's left out). games: [{id, system, path}]
 */
function plan(lists, games) {
  const byFile = new Map();
  for (const g of games) { const k = fileKey(g.path); byFile.set(k, [...(byFile.get(k) || []), g]); }
  const found = [], seen = new Set();
  let listed = 0;
  for (const file of lists) {
    let items = null;
    try { items = parseList(fs.readFileSync(file, "utf8")); } catch {}
    if (!items) continue;
    const folder = path.basename(path.dirname(file)).toLowerCase();
    for (const it of items) {
      if (!(it.fav || it.plays || it.last || it.rating || it.time || it.done)) continue;
      listed++;
      let cands = byFile.get(fileKey(it.file)) || [];
      if (cands.length > 1) {
        const hint = (it.platform || folder || "").toLowerCase();
        cands = cands.filter(g => hint && (hint.includes(g.system.toLowerCase()) || g.path.toLowerCase().includes("/" + folder + "/")));
      }
      if (cands.length !== 1 || seen.has(cands[0].id)) continue;
      seen.add(cands[0].id);
      found.push({ id: cands[0].id, source: file, ...it });
    }
  }
  return { lists: lists.length, listed, found };
}

/** a summary: how many games, favorites, plays, hours, ratings and finished games would come in */
function summary(p) {
  const s = { lists: p.lists, listed: p.listed, games: p.found.length, favs: 0, plays: 0, time: 0, ratings: 0, done: 0 };
  for (const f of p.found) { if (f.fav) s.favs++; s.plays += f.plays; s.time += f.time; if (f.rating) s.ratings++; if (f.done) s.done++; }
  return s;
}

/**
 * Brought into a person's state: favorites added, plays and time added (once for each list and game: bringing the same
 * list in again adds nothing), last played the later one, a rating or "beaten" only where there's none here
 */
function apply(st, p) {
  st.imported = st.imported || {};
  let n = 0;
  for (const f of p.found) {
    const mark = f.source + "|" + f.id;
    if (st.imported[mark]) continue;
    st.imported[mark] = 1; n++;
    if (f.fav && !st.fav.includes(f.id)) st.fav.push(f.id);
    if (f.plays) st.plays[f.id] = (st.plays[f.id] || 0) + f.plays;
    if (f.time) st.time[f.id] = (st.time[f.id] || 0) + f.time;
    if (f.last > (st.last[f.id] || 0)) st.last[f.id] = f.last;
    if (f.rating && !st.rating[f.id]) st.rating[f.id] = f.rating;
    if (f.done && !st.progress[f.id]) st.progress[f.id] = "beaten";
  }
  return n;
}

module.exports = { parseList, findLists, plan, summary, apply, fileKey };

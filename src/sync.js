"use strict";
// Play that follows you between computers. With saves in a cloud folder (iCloud Drive, Dropbox, OneDrive), each
// computer keeps a journal there of each person's play on it, and reads the other computers' journals: play time and
// sittings add up, and progress, ratings, notes and favorites go with whichever was set last. A computer only ever
// writes its own journal, so two of them syncing at once never overwrite each other. Games are matched by console and
// file name (a game's id comes from where it is on each computer), people by name.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FIELDS = ["progress", "rating", "notes", "fav"];
/** a game across computers: its console and file name */
const gameKey = g => g.system + "/" + path.basename(g.path).toLowerCase();
/** every game's key, by id. Two games here with the same console and file name (Disc 1.chd in two games' folders)
    have their folder's name in it too, so neither takes the other's play */
function keysFor(games) {
  const all = [...games], n = new Map();
  for (const g of all) n.set(gameKey(g), (n.get(gameKey(g)) || 0) + 1);
  return new Map(all.map(g => [g.id, n.get(gameKey(g)) > 1 ? g.system + "/" + path.basename(path.dirname(g.path)).toLowerCase() + "/" + path.basename(g.path).toLowerCase() : gameKey(g)]));
}
/** a person across computers: their name as a folder name. A name in letters beyond English's (Саша, ゆき, Zoë) gets
    a short fingerprint of itself, so two such names never share one */
function personKey(name) {
  const n = String(name || "").normalize("NFC").trim().toLowerCase();
  const slug = n.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/[^\x00-\x7f]/.test(n)) return slug || "player";
  return (slug ? slug + "-" : "") + crypto.createHash("sha1").update(n).digest("hex").slice(0, 10);
}
const journalDir = (root, person) => path.join(root, ".the-retro-shelf", "play", personKey(person));

/**
 * This computer's journal for one person: its own sittings, and for each game the totals played here and what was set
 * (with when), by game key. st: the person's state (plays, time, last, sessions, progress, rating, notes, fav, edited);
 * keyOf: each game's key by id, games not here right now (a drive unplugged, a game deleted) included
 */
function journal(st, keyOf, machine, host, at) {
  const out = { v: 1, machine, host, at, games: {}, sessions: [] };
  // two ids with one key (a game that was somewhere else before) add up: plays and time, the latest play, the newest edit
  const put = (k, e) => {
    const o = out.games[k];
    if (!o) { out.games[k] = e; return; }
    for (const f of ["plays", "time"]) if (e[f]) o[f] = (o[f] || 0) + e[f];
    if (e.last) o.last = Math.max(o.last || 0, e.last);
    for (const f of FIELDS) if (e[f] && (!o[f] || e[f][1] > o[f][1])) o[f] = e[f];
  };
  for (const id of keyOf.keys()) {
    const e = {};
    if (st.plays[id]) e.plays = st.plays[id];
    if (st.time[id]) e.time = st.time[id];
    if (st.last[id]) e.last = st.last[id];
    for (const f of FIELDS) {
      const when = (st.edited || {})[f + ":" + id] || 0;
      const value = f === "fav" ? st.fav.includes(id) : st[f][id];
      // what was set, or taken off, here: only once it's been touched (a value from before journals counts too)
      if (when || (f === "fav" ? value : value !== undefined)) e[f] = [f === "fav" ? value : value ?? null, when];
    }
    if (Object.keys(e).length) put(keyOf.get(id), e);
  }
  for (const [id, start, secs] of st.sessions) { const k = keyOf.get(id); if (k) out.sessions.push([k, start, secs]); }
  return out;
}

/** the other computers' journals for a person: [{file, j}], this computer's left out, unreadable ones skipped (a
    cloud drive part-way through bringing one in). A copy a cloud drive made of one ("… 2.json", a conflicted copy)
    counts once: the newest for each computer */
function readJournals(dir, machine) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json") && n !== machine + ".json"); } catch { return []; }
  const by = new Map();
  for (const n of names) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
    if (!j || j.v !== 1 || !j.games || typeof j.games !== "object" || typeof j.machine !== "string" || j.machine === machine) continue;
    const had = by.get(j.machine);
    if (!had || (j.at || 0) > (had.j.at || 0)) by.set(j.machine, { file: n, j });
  }
  return [...by.values()];
}

/**
 * What the other computers add, in this computer's ids: play totals by game, their sittings (a game this computer
 * doesn't have keeps its key, so time still counts), and what they set for games, newest per field
 */
function combine(journals, keyOf) {
  const idOf = new Map([...keyOf].map(([id, k]) => [k, id])), add = new Map(), sessions = [], set = new Map(), hosts = [];
  const num = v => Number.isFinite(v) && v > 0 ? v : 0;
  for (const { j } of journals) {
    hosts.push({ host: String(j.host || ""), at: num(j.at) });
    for (const [k, e] of Object.entries(j.games || {})) {
      const id = idOf.get(k);
      if (!id || !e || typeof e !== "object") continue;
      const a = add.get(id) || { plays: 0, time: 0, last: 0 };
      a.plays += num(e.plays); a.time += num(e.time); a.last = Math.max(a.last, num(e.last));
      add.set(id, a);
      for (const f of FIELDS) {
        if (!Array.isArray(e[f]) || e[f].length !== 2) continue;
        const cur = set.get(f + ":" + id);
        if (!cur || e[f][1] > cur[1]) set.set(f + ":" + id, e[f]);
      }
    }
    for (const s of Array.isArray(j.sessions) ? j.sessions : []) if (Array.isArray(s) && s.length === 3 && typeof s[0] === "string" && num(s[1]) && num(s[2])) sessions.push([idOf.get(s[0]) || "~" + s[0], s[1], s[2]]);
  }
  sessions.sort((a, b) => a[1] - b[1]);
  return { add, sessions, set, hosts };
}

/** what another computer set later than this one did, put in this person's state (with its time, so it isn't taken
    for a newer change here). True when anything changed */
function adopt(st, set) {
  let changed = false;
  st.edited = st.edited || {};
  for (const [k, [value, when]] of set) {
    const [f, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const here = f === "fav" ? st.fav.includes(id) : st[f][id] !== undefined;
    // newer than what was set here; or from before journals kept times, filling in what this computer doesn't have
    const newer = when > (st.edited[k] || 0), fills = !when && !st.edited[k] && !here && value !== null && value !== false && value !== "" && value !== 0;
    if (!newer && !fills) continue;
    if (f === "fav") {
      const i = st.fav.indexOf(id);
      if (value && i < 0) st.fav.push(id); else if (!value && i >= 0) st.fav.splice(i, 1);
    } else if (value === null || value === undefined || value === "" || value === 0) delete st[f][id];
    else st[f][id] = value;
    st.edited[k] = when;
    changed = true;
  }
  return changed;
}

/** a journal's play totals by game key: {key: {plays, time}} */
function totals(j) {
  return Object.fromEntries(Object.entries(j.games || {}).filter(([, e]) => e && (e.plays || e.time)).map(([k, e]) => [k, { plays: e.plays || 0, time: e.time || 0 }]));
}
function addTotals(a, b) {
  const out = structuredClone(a || {});
  for (const [k, e] of Object.entries(b || {})) { const o = out[k] = out[k] || { plays: 0, time: 0 }; o.plays += e.plays || 0; o.time += e.time || 0; }
  return out;
}
/**
 * A journal less what's counted elsewhere already (base: {at, games: totals}): plays and time taken off, and sittings
 * from before base.at left out. A computer whose app data was copied to another takes a new name, and what it wrote
 * under the old one (now the other's) is taken off both what it writes from then on and what it reads there
 */
function minus(j, base) {
  if (!base || !base.games) return j;
  for (const [k, b] of Object.entries(base.games)) {
    const e = j.games[k];
    if (!e) continue;
    for (const f of ["plays", "time"]) if (e[f]) { e[f] = Math.max(0, e[f] - (b[f] || 0)); if (!e[f]) delete e[f]; }
  }
  j.sessions = (j.sessions || []).filter(s => Array.isArray(s) && s[1] >= (base.at || 0));
  return j;
}

/** a journal written whole or not at all (a cloud drive never sends half of one), and not when it hasn't changed */
function writeJournal(file, j) {
  const text = JSON.stringify(j);
  try { if (fs.readFileSync(file, "utf8").replace(/"at":\d+,/, "") === text.replace(/"at":\d+,/, "")) return false; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".part", text);
  fs.renameSync(file + ".part", file);
  return true;
}

module.exports = { gameKey, keysFor, personKey, journalDir, journal, readJournals, combine, adopt, writeJournal, totals, addTotals, minus, FIELDS };

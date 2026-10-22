"use strict";
// Play that follows you between computers. With saves in a cloud folder (iCloud Drive, Dropbox, OneDrive), each
// computer keeps a journal there of each person's play on it, and reads the other computers' journals: play time and
// sittings add up, and progress, ratings, notes and favorites go with whichever was set last. A computer only ever
// writes its own journal, so two of them syncing at once never overwrite each other. Games are matched by console and
// file name (a game's id comes from where it is on each computer), people by name.
const fs = require("fs");
const path = require("path");

const FIELDS = ["progress", "rating", "notes", "fav"];
/** a game across computers: its console and file name */
const gameKey = g => g.system + "/" + path.basename(g.path).toLowerCase();
/** a person across computers: their name, as a folder name */
const personKey = name => String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "player";
const journalDir = (root, person) => path.join(root, ".the-retro-shelf", "play", personKey(person));

/**
 * This computer's journal for one person: its own sittings, and for each game the totals played here and what was set
 * (with when), by game key. st: the person's state (plays, time, last, sessions, progress, rating, notes, fav, edited)
 */
function journal(st, games, machine, host, at) {
  const keyOf = new Map([...games].map(g => [g.id, gameKey(g)])), out = { v: 1, machine, host, at, games: {}, sessions: [] };
  const entry = id => { const k = keyOf.get(id); return k ? (out.games[k] = out.games[k] || {}) : null; };
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
    if (Object.keys(e).length) Object.assign(entry(id), e);
  }
  for (const [id, start, secs] of st.sessions) { const k = keyOf.get(id); if (k) out.sessions.push([k, start, secs]); }
  return out;
}

/** the other computers' journals for a person: [{file, j}], this computer's left out, unreadable ones skipped (a
    cloud drive part-way through bringing one in) */
function readJournals(dir, machine) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json") && n !== machine + ".json"); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); if (j && j.v === 1 && j.games) out.push({ file: n, j }); } catch {}
  }
  return out;
}

/**
 * What the other computers add, in this computer's ids: play totals by game, their sittings (a game this computer
 * doesn't have keeps its key, so time still counts), and what they set for games, newest per field
 */
function combine(journals, games) {
  const idOf = new Map([...games].map(g => [gameKey(g), g.id])), add = new Map(), sessions = [], set = new Map(), hosts = [];
  for (const { j } of journals) {
    hosts.push({ host: j.host || "", at: j.at || 0 });
    for (const [k, e] of Object.entries(j.games || {})) {
      const id = idOf.get(k);
      if (!id) continue;
      const a = add.get(id) || { plays: 0, time: 0, last: 0 };
      a.plays += e.plays || 0; a.time += e.time || 0; a.last = Math.max(a.last, e.last || 0);
      add.set(id, a);
      for (const f of FIELDS) {
        if (!Array.isArray(e[f])) continue;
        const cur = set.get(f + ":" + id);
        if (!cur || e[f][1] > cur[1]) set.set(f + ":" + id, e[f]);
      }
    }
    for (const s of j.sessions || []) if (Array.isArray(s) && s.length === 3) sessions.push([idOf.get(s[0]) || "~" + s[0], s[1], s[2]]);
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

/** a journal written whole or not at all (a cloud drive never sends half of one), and not when it hasn't changed */
function writeJournal(file, j) {
  const text = JSON.stringify(j);
  try { if (fs.readFileSync(file, "utf8").replace(/"at":\d+,/, "") === text.replace(/"at":\d+,/, "")) return false; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".part", text);
  fs.renameSync(file + ".part", file);
  return true;
}

module.exports = { gameKey, personKey, journalDir, journal, readJournals, combine, adopt, writeJournal, FIELDS };

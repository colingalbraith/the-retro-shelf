"use strict";
// BIOS files the bundled emulators look for in the BIOS folder, as each console's entry in config.json lists them
// (from its emulator's .info file). Settings shows which ones are there, files with these names dropped on the window
// go to the BIOS folder, and they're kept off the shelves when they sit among games.
const fs = require("fs");
const path = require("path");

const BASE = require("./config.json").systems;

/** the consoles Settings shows a BIOS check for: { system, label, note, any, for, inGames, files: [[path, size]], dir }.
    A console with a dir takes any BIOS file there, under any name, told apart by what's in it (a PS2's) */
function consoles(systems = BASE) {
  return Object.entries(systems).filter(([, s]) => s.bios && s.bios.label)
    .map(([system, s]) => ({ system, label: s.bios.label, note: s.bios.note || "", any: !!s.bios.any, for: s.bios.for || "", inGames: !!s.bios.inGames, files: s.bios.files || [],
      dir: s.bios.dir || "", min: s.bios.min || 0, max: s.bios.max || 0, sig: s.bios.sig || [] }));
}

/** whether a file is a BIOS by its contents: the right size, with the marks it starts with (a PS2 BIOS's table of
    contents names RESET, ROMDIR and ROMVER near its start). Read from the file, or given as a buffer */
const LOOK = 0x10000;
function looksLike(c, file, size) {
  if (!c.dir || !(size >= c.min && size <= c.max)) return false;
  let head;
  try {
    if (Buffer.isBuffer(file)) head = file.subarray(0, LOOK);
    else { const fd = fs.openSync(file, "r"); try { head = Buffer.alloc(Math.min(LOOK, size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); } }
  } catch { return false; }
  return c.sig.every(m => head.includes(m));
}
/** where a BIOS file goes that's known by its contents rather than its name ("pcsx2/bios/<its name>"), or null */
function biosByContent(file, size, systems = BASE) {
  for (const c of consoles(systems)) if (looksLike(c, file, size)) return c.dir + "/" + (Buffer.isBuffer(file) ? "bios.bin" : path.basename(String(file)));
  return null;
}

// file name -> path in the BIOS folder, for each set of consoles
const dests = new WeakMap();
function destMap(systems) {
  if (!dests.has(systems)) {
    const all = Object.values(systems).flatMap(s => s.bios ? [...(s.bios.files || []).map(f => f[0]), ...(s.bios.also || [])] : []);
    dests.set(systems, new Map(all.map(p => [path.posix.basename(p).toLowerCase(), p])));
  }
  return dests.get(systems);
}

/** where a file with this name goes in the BIOS folder, or null when it isn't a BIOS file */
function biosDest(name, systems = BASE) { return destMap(systems).get(String(name).toLowerCase()) || null; }
/** the size a BIOS file with this name has (from its emulator's list), or 0 when there's none given */
function biosSize(name, systems = BASE) {
  const n = String(name).toLowerCase();
  for (const s of Object.values(systems)) for (const [p, size] of (s.bios && s.bios.files) || []) if (path.posix.basename(p).toLowerCase() === n && size) return size;
  return 0;
}

/**
 * Which BIOS files are in place. biosDir: the BIOS folder; arcadeDir: the arcade games folder, where FinalBurn Neo
 * also finds neogeo.zip. Returns one entry per console: { system, label, note, for, state: ok|partial|missing|bad, files }
 */
function biosStatus(biosDir, arcadeDir, systems = BASE) {
  return consoles(systems).map(c => {
    // any BIOS in its folder, by what's in it: the real ones are ok, anything else there isn't
    if (c.dir) {
      const dir = path.join(biosDir, ...c.dir.split("/"));
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => !n.startsWith(".") && fs.statSync(path.join(dir, n)).isFile()); } catch {}
      const files = names.map(n => { const p = path.join(dir, n); let size = 0; try { size = fs.statSync(p).size; } catch {} return { name: n, found: true, ok: looksLike(c, p, size) }; })
        .filter(f => f.ok || /\.(bin|rom)$/i.test(f.name));
      const state = files.some(f => f.ok) ? "ok" : files.length ? "bad" : "missing";
      return { system: c.system, label: c.label, note: c.note, for: c.for, state, files };
    }
    const files = c.files.map(([rel, size]) => {
      const where = [path.join(biosDir, ...rel.split("/"))];
      if (c.inGames && arcadeDir) where.push(path.join(arcadeDir, path.posix.basename(rel)));
      let found = "", got = 0;
      for (const p of where) { try { const st = fs.statSync(p); if (st.isFile()) { found = p; got = st.size; break; } } catch {} }
      return { name: path.posix.basename(rel), found: !!found, ok: !!found && (!size || got === size) };
    });
    const good = files.filter(f => f.ok), wrong = files.filter(f => f.found && !f.ok);
    const state = c.any ? (good.length ? "ok" : wrong.length ? "bad" : "missing")
      : good.length === files.length ? "ok" : wrong.length ? "bad" : good.length ? "partial" : "missing";
    return { system: c.system, label: c.label, note: c.note, for: c.for, state, files };
  });
}

module.exports = { biosDest, biosSize, biosStatus, biosByContent, consoles };

"use strict";
// BIOS files the bundled emulators look for in the BIOS folder, as each core's .info file lists them. Settings shows
// which ones are there, files with these names dropped on the window go to the BIOS folder, and they're kept off the
// shelves when they sit among games.
const fs = require("fs");
const path = require("path");

// [path in the BIOS folder, size of every good copy (when they all match)]
const CONSOLES = [
  { system: "PS1", label: "PlayStation", note: "Optional, makes more games work.", any: true,
    files: [["scph5501.bin", 524288], ["scph5500.bin", 524288], ["scph5502.bin", 524288], ["psxonpsp660.bin", 524288],
            ["scph101.bin", 524288], ["scph7001.bin", 524288], ["scph1001.bin", 524288]] },
  { system: "PC Engine", label: "PC Engine CD", note: "Needed for CD games.", any: true,
    files: [["syscard3.pce"], ["syscard2.pce"], ["syscard1.pce"], ["gexpress.pce"]] },
  { system: "Dreamcast", label: "Dreamcast", note: "Optional.", files: [["dc/dc_boot.bin", 2097152]] },
  { system: "DS", label: "Nintendo DS", note: "Optional.", files: [["bios7.bin", 16384], ["bios9.bin", 4096], ["firmware.bin"]] },
  { system: "GBA", label: "Game Boy Advance", note: "Optional.", files: [["gba_bios.bin", 16384]] },
  { system: "Arcade", label: "Neo Geo (Arcade)", note: "Needed for Neo Geo games.", files: [["fbneo/neogeo.zip"]] },
];
// the rest the cores know about, so a dropped one still lands in the right place
const FBNEO = ["neocdz", "decocass", "isgsm", "midssio", "nmk004", "pgm", "skns", "ym2608", "cchip", "bubsys", "namcoc69",
  "namcoc70", "namcoc75", "coleco", "fdsbios", "msx", "ngp", "spectrum", "spec128", "spec1282a", "channelf"].map(n => `fbneo/${n}.zip`);
const OTHERS = ["dc/dc_flash.bin", "dsi_bios7.bin", "dsi_bios9.bin", "dsi_firmware.bin", "dsi_nand.bin", "gb_bios.bin", "gbc_bios.bin", "sgb_bios.bin", ...FBNEO];

const DEST = new Map([...CONSOLES.flatMap(c => c.files.map(f => f[0])), ...OTHERS].map(p => [path.posix.basename(p).toLowerCase(), p]));

/** where a file with this name goes in the BIOS folder, or null when it isn't a BIOS file */
function biosDest(name) { return DEST.get(String(name).toLowerCase()) || null; }

/**
 * Which BIOS files are in place. biosDir: the BIOS folder; arcadeDir: the arcade games folder, where FinalBurn Neo
 * also finds neogeo.zip. Returns one entry per console: { system, label, note, state: ok|partial|missing|bad, files }
 */
function biosStatus(biosDir, arcadeDir) {
  return CONSOLES.map(c => {
    const files = c.files.map(([rel, size]) => {
      const where = [path.join(biosDir, ...rel.split("/"))];
      if (c.system === "Arcade" && arcadeDir) where.push(path.join(arcadeDir, path.posix.basename(rel)));
      let found = "", got = 0;
      for (const p of where) { try { const st = fs.statSync(p); if (st.isFile()) { found = p; got = st.size; break; } } catch {} }
      return { name: path.posix.basename(rel), found: !!found, ok: !!found && (!size || got === size) };
    });
    const good = files.filter(f => f.ok), wrong = files.filter(f => f.found && !f.ok);
    const state = c.any ? (good.length ? "ok" : wrong.length ? "bad" : "missing")
      : good.length === files.length ? "ok" : wrong.length ? "bad" : good.length ? "partial" : "missing";
    return { system: c.system, label: c.label, note: c.note, state, files };
  });
}

module.exports = { biosDest, biosStatus, CONSOLES };

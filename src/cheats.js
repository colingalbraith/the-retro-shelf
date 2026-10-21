"use strict";
// Cheats from libretro's cheat collection (a zip of RetroArch .cht files, one folder per console, downloaded the
// first time someone opens a game's cheats): finding a game's files in it, reading them, and writing the chosen
// cheats where RetroArch looks for that game's cheats when it starts (cheats/<emulator>/<game>.cht), switched on.

// cheat devices a file can be for, named in brackets after the game ("Super Mario World (USA) (Game Genie).cht")
const DEVICE = /\s*\((Game Genie|Pro Action Replay|Action Replay|Code ?Breaker|GameShark|Gameshark|Xploder|Rumbles)\)/i;

/**
 * The cheat files for one game. names: the collection's entry names; dirs: the console's folders in it (libretro's
 * names, as for box art); stem: the game's file name without its extension; norm: how names are compared. The file
 * named exactly like the game comes first, then others for the same game: no device first, then by device.
 * Returns [{name, label}], label being the device ("Game Genie") or "".
 */
function gameFiles(names, dirs, stem, norm) {
  const want = norm(stem), exact = stem.toLowerCase(), out = [];
  for (const name of names) {
    const i = name.indexOf("/");
    if (i < 0 || !dirs.includes(name.slice(0, i)) || !name.toLowerCase().endsWith(".cht")) continue;
    const base = name.slice(i + 1, -4), dev = DEVICE.exec(base);
    if (norm(base.replace(DEVICE, "")) !== want) continue;
    out.push({ name, label: dev ? dev[1] : "", rank: base.toLowerCase() === exact ? 0 : dev ? 2 : 1 });
  }
  return out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(({ name, label }) => ({ name, label }));
}

/** a .cht file's cheats, each as its fields in order (desc, code, enable, and any others), values as written */
function parse(text) {
  const cheats = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*cheat(\d+)_(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const n = +m[1];
    (cheats[n] = cheats[n] || new Map()).set(m[2], m[3]);
  }
  return cheats.filter(Boolean);
}
const unquote = v => (/^"(.*)"$/.exec(v || "") || [, v || ""])[1];

/** a .cht file holding these cheats, numbered afresh and switched on */
function write(cheats) {
  let out = `cheats = ${cheats.length}\n\n`;
  cheats.forEach((c, i) => {
    for (const [k, v] of c) if (k !== "enable") out += `cheat${i}_${k} = ${v}\n`;
    out += `cheat${i}_enable = true\n\n`;
  });
  return out;
}

module.exports = { gameFiles, parse, write, unquote };

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cheats = require("../src/cheats.js"), { norm } = require("../src/backend.js");
const SNES = "Nintendo - Super Nintendo Entertainment System";

test("a game's cheat files: its own first, then others for the same game, by device", () => {
  const names = [`${SNES}/Super Mario World (USA).cht`, `${SNES}/Super Mario World (USA) (Game Genie).cht`, `${SNES}/Super Mario World (World) (Action Replay).cht`,
    `${SNES}/Super Mario World 2 - Yoshi's Island (USA).cht`, `${SNES}/Super Mario All-Stars + Super Mario World (USA).cht`, "Nintendo - Game Boy/Super Mario World (USA).cht", `${SNES}/`];
  assert.deepEqual(cheats.gameFiles(names, [SNES], "Super Mario World (USA)", norm), [
    { name: `${SNES}/Super Mario World (USA).cht`, label: "" },
    { name: `${SNES}/Super Mario World (USA) (Game Genie).cht`, label: "Game Genie" },
    { name: `${SNES}/Super Mario World (World) (Action Replay).cht`, label: "Action Replay" },
  ]);
  assert.deepEqual(cheats.gameFiles(names, [SNES], "Chrono Trigger (USA)", norm), []);
});

test("cheat files are read, and the chosen ones written back numbered afresh and switched on", () => {
  const read = cheats.parse(`cheats = 3\n\ncheat0_desc = "Infinite lives"\ncheat0_code = "7E0DBE:63"\ncheat0_enable = false\n\ncheat1_desc = "Start with cape"\ncheat1_code = "7E0019:02"\ncheat1_enable = false\ncheat1_handler = "1"\n\ncheat2_desc = "Moon jump"\ncheat2_code = "x"\ncheat2_enable = false\n`);
  assert.equal(read.length, 3);
  assert.equal(cheats.unquote(read[1].get("desc")), "Start with cape");
  assert.equal(cheats.write([read[1], read[0]]),
    `cheats = 2\n\ncheat0_desc = "Start with cape"\ncheat0_code = "7E0019:02"\ncheat0_handler = "1"\ncheat0_enable = true\n\ncheat1_desc = "Infinite lives"\ncheat1_code = "7E0DBE:63"\ncheat1_enable = true\n\n`);
});

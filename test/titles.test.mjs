import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { cleanTitle, regionTag, norm } = createRequire(import.meta.url)("../src/backend.js");

test("file names become readable titles", () => {
  assert.equal(cleanTitle("Super Mario World (USA)"), "Super Mario World");
  assert.equal(cleanTitle("Legend of Zelda, The - A Link to the Past (USA)"), "The Legend of Zelda: A Link to the Past");
  assert.equal(cleanTitle("Pokemon - Red Version (USA, Europe) (SGB Enhanced)"), "Pokemon: Red Version");
  assert.equal(cleanTitle("Star Wars - Episode I - Racer (USA)"), "Star Wars: Episode I – Racer");
  assert.equal(cleanTitle("Tetris [!]"), "Tetris");
});

test("region tags are picked out of file names", () => {
  assert.equal(regionTag("Sonic The Hedgehog (USA, Europe)"), "USA, Europe");
  assert.equal(regionTag("Final Fantasy III (USA) (Rev 1)"), "USA");
  assert.equal(regionTag("Tetris (Rev 1)"), "");
});

test("names match art regardless of punctuation and articles", () => {
  assert.equal(norm("Legend of Zelda, The (USA)"), norm("The Legend of Zelda"));
  assert.equal(norm("Ghosts 'n Goblins"), norm("Ghosts n Goblins"));
});

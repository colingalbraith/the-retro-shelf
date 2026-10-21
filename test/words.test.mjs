import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The languages other than English: src/words/<lang>.json, keyed by the English in src/words/keys.json (made by
// scripts/words.mjs from what the app shows)
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "words");
const keys = JSON.parse(fs.readFileSync(path.join(DIR, "keys.json"), "utf8"));
const blanks = s => (s.match(/\{\w+\}/g) || []).sort().join();

for (const lang of ["es", "fr", "de", "pt", "ja"]) {
  test(`${lang}: every piece of English has words, with the same blanks to fill`, () => {
    const table = JSON.parse(fs.readFileSync(path.join(DIR, lang + ".json"), "utf8"));
    const missing = keys.filter(k => typeof table[k] !== "string" || !table[k].trim());
    assert.deepEqual(missing, [], `${missing.length} without words`);
    const wrong = keys.filter(k => blanks(k) !== blanks(table[k]));
    assert.deepEqual(wrong, [], "blanks that don't match");
    const extra = Object.keys(table).filter(k => !keys.includes(k));
    assert.deepEqual(extra, [], "words for English the app no longer shows");
  });
}

test("the main process and the page read the same languages", () => {
  const src = path.join(DIR, "..");
  const main = fs.readFileSync(path.join(src, "main.js"), "utf8"), page = fs.readFileSync(path.join(src, "index.html"), "utf8");
  for (const lang of ["es", "fr", "de", "pt", "ja"]) { assert.match(main, new RegExp(`"${lang}"`)); assert.match(page, new RegExp(`${lang}: "`)); }
});

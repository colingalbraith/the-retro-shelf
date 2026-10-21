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
const LANGS = ["es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh"];
// the words that follow a number, as plural(n, "game", "games") writes them: a language with more forms than English's
// two lists the others as "games|few" and the like
const page = fs.readFileSync(path.join(DIR, "..", "index.html"), "utf8");
const counted = [...new Set([...page.matchAll(/plural\([^;]*?, "([^"]+)", "([^"]+)"\)/g)].map(m => m[2]))];
const FORMS = { ru: ["few"] };

for (const lang of LANGS) {
  test(`${lang}: every piece of English has words, with the same blanks to fill`, () => {
    const table = JSON.parse(fs.readFileSync(path.join(DIR, lang + ".json"), "utf8"));
    const missing = keys.filter(k => typeof table[k] !== "string" || !table[k].trim());
    assert.deepEqual(missing, [], `${missing.length} without words`);
    const wrong = keys.filter(k => blanks(k) !== blanks(table[k]));
    assert.deepEqual(wrong, [], "blanks that don't match");
    const forms = FORMS[lang] || [];
    const extra = Object.keys(table).filter(k => !keys.includes(k) && !(forms.includes(k.split("|")[1]) && counted.includes(k.split("|")[0])));
    assert.deepEqual(extra, [], "words for English the app no longer shows");
    const lacking = counted.flatMap(w => forms.map(f => w + "|" + f)).filter(k => typeof table[k] !== "string" || !table[k].trim());
    assert.deepEqual(lacking, [], "counted words without all of the language's forms");
  });
}

test("the counted words are found", () => { assert.ok(counted.includes("games") && counted.length >= 8, counted.join()); });

test("the main process, the page and the backend have the same languages", () => {
  const src = path.join(DIR, "..");
  const main = fs.readFileSync(path.join(src, "main.js"), "utf8"), backend = fs.readFileSync(path.join(src, "backend.js"), "utf8");
  const served = (/words\\\/\(([a-z|]+)\)/.exec(backend) || [])[1] || "", kept = (/\[("auto", "en"[^\]]*)\]\.includes\(d\.lang\)/.exec(backend) || [])[1] || "";
  assert.deepEqual(served.split("|").sort(), [...LANGS].sort(), "the word files the backend serves");
  for (const lang of LANGS) assert.match(kept, new RegExp(`"${lang}"`), "a language the settings keep");
  for (const lang of LANGS) { assert.match(main, new RegExp(`"${lang}"`)); assert.match(page, new RegExp(`${lang}: "`)); }
});

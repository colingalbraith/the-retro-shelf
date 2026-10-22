import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, keys, translate, shape, scriptKeys } from "../scripts/site-words.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
const words = l => JSON.parse(fs.readFileSync(path.join(ROOT, "site", "words", l + ".json"), "utf8"));

test("the website is translated whole into each of the app's languages, tags, links and blanks kept", () => {
  const all = keys(page);
  assert.ok(all.length > 100, "found what's marked on the page");
  for (const l of LANGS) {
    const w = words(l);
    const missing = all.filter(k => !w[k] || !w[k].trim());
    assert.deepEqual(missing, [], `${l}: not translated`);
    const bent = all.filter(k => shape(w[k]) !== shape(k));
    assert.deepEqual(bent, [], `${l}: tags or blanks differ from the English`);
    assert.deepEqual(Object.keys(w).filter(k => !all.includes(k)), [], `${l}: words the page no longer has`);
  }
});

test("a language's page has its words, its language, and its pictures a folder up", () => {
  const out = translate(page, "fr", { "Download": "Télécharger", "Mac with Intel": "Mac avec Intel", "Language": "Langue \"x\"" });
  assert.match(out, /<html lang="fr">/);
  assert.match(out, /<a href="#download" data-t>Télécharger<\/a>/);
  assert.match(out, /aria-label="Langue &quot;x&quot;"/);
  assert.match(out, /const LANG = "fr", WORDS = \{"Mac with Intel":"Mac avec Intel"\}, UP = "\.\.\/"/);
  assert.match(out, /src="\.\.\/images\/icon\.png"/);
  assert.match(out, /url\(\.\.\/fonts\/plex-cond-400\.woff2\)/);
  assert.doesNotMatch(out, /src="images\//);
  assert.ok(scriptKeys(page).includes("Version {v}, {date}. Updates itself after this."));
  assert.match(translate(page, "zh", {}), /<html lang="zh-Hans">/);
});

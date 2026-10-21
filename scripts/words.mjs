// The English the app shows, as one list to translate: src/words/keys.json. Two sources:
//  - what the screens showed in the screen test (HARVEST_WORDS=1 node scripts/ui-test.mjs writes dist/words-seen.json)
//  - text in the code that only some situations show: t("…") and the like in the page, menus and dialogs in the
//    main process, error messages from the backend, the pins, and the BIOS notes
// Game, series and console names stay as they are, and so do the What's new notes (the changelog is English).
// Run: node scripts/words.mjs. The language files (src/words/<lang>.json) are checked against the list by the tests.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const require = createRequire(import.meta.url);
const keys = new Set(), add = s => { if (typeof s === "string" && s.trim()) keys.add(s.trim()); };
const unq = s => JSON.parse('"' + s + '"');

// what the screens showed
let seen = { seen: [], titles: [], systems: [] };
try { seen = JSON.parse(read("dist/words-seen.json")); } catch { console.warn("no dist/words-seen.json: run HARVEST_WORDS=1 node scripts/ui-test.mjs first"); }
seen.seen.forEach(add);

// the page: t("…"), and the helpers whose text appears as it is (settings rows, menu items, messages, buttons)
const page = read("src/index.html"), str = '"((?:[^"\\\\]|\\\\.)*)"';
// everything given to t() is words, even a single small one ("today")
for (const m of page.matchAll(new RegExp(`\\bt\\(${str}`, "g"))) add(unq(m[1]));
for (const re of [
  new RegExp(`\\b(?:R|H|item|toast|openList)\\(${str}`, "g"),
  new RegExp(`\\bR\\(${str}, ${str}`, "g"),
  new RegExp(`\\bel\\("[a-z0-9]+", "[^"]*", ${str}\\)`, "g"),
  new RegExp(`\\[\\s*(?:"[^"]*"|\\d+|null), ${str}\\]`, "g"),
  new RegExp(`\\.(?:textContent|title) = ${str}`, "g"),
]) for (const m of page.matchAll(re)) for (const g of m.slice(1)) if (g !== undefined) { const v = unq(g); if (/[A-Z]/.test(v[0]) || / /.test(v) || /\{\w+\}/.test(v)) add(v); }
// the words that follow a number ("3 games"): every plural( … , "game", "games") in the page
for (const m of page.matchAll(new RegExp(`, ${str}, ${str}\\)`, "g"))) {
  const before = page.slice(Math.max(0, m.index - 200), m.index);
  if (before.includes("plural(") && !/["']$/.test(before.trim())) { add(unq(m[1])); add(unq(m[2])); }
}
// the page's own markup: headings, buttons, labels
const markup = page.slice(0, page.indexOf("<script>")).replace(/<style>[\s\S]*?<\/style>/g, "");
for (const m of markup.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)) add(m[1].replace(/\s+/g, " "));
for (const m of markup.matchAll(/(?:aria-label|title|placeholder)="([^"]*[A-Za-z][^"]*)"/g)) add(m[1]);

// menus and dialogs in the main process
const main = read("src/main.js");
for (const m of main.matchAll(new RegExp(`(?:label: |tm\\()${str}`, "g"))) add(unq(m[1]));
for (const m of main.matchAll(/\[\s*"[^"]*", "([A-Z][^"]*)"\]/g)) add(m[1]);
for (const m of main.matchAll(new RegExp(`error: ${str}`, "g"))) add(unq(m[1]));
// the right-click menu's own choices for a game ({ picture: "Picture", shape: "Screen Shape", … })
for (const m of main.matchAll(/\{ picture: "([^"]+)", shape: "([^"]+)"[^}]*?ffSpeed: "([^"]+)"/g)) m.slice(1).forEach(add);

// the backend's messages (the ones without blanks filled in by code)
const backend = read("src/backend.js");
for (const m of backend.matchAll(new RegExp(`error: ${str}`, "g"))) add(unq(m[1]));
const { GAME_CHOICES } = require(path.join(ROOT, "src", "backend.js"));
for (const list of Object.values(GAME_CHOICES)) for (const [, name] of list) add(name);

// pins, and what each BIOS is for
const pins = require(path.join(ROOT, "src", "pins.js"));
for (const p of pins.build(["NES"])) { if (p.tpl) { add(p.tpl.desc); if (p.key.startsWith("c")) add(p.tpl.title); } else { add(p.title); add(p.desc); } }
for (const [, label] of pins.CATS) add(label);
// the shelves' group names when arranged by genre or progress (shown with t() from data, not written in a t() call)
for (const [, name] of pins.GENRES) add(name);
for (const m of page.matchAll(/const PLAYED = \[([^\]]*)\]/g)) for (const x of m[1].matchAll(/"([^"]+)"/g)) add(x[1]);
for (const n of ["Other", "Year unknown"]) add(n);
// the launch screen's words while a game starts ("Inserting cartridge…")
for (const m of page.matchAll(/const MEDIA_VERB = \{([^}]*)\}/g)) for (const x of m[1].matchAll(/"([^"]+)"/g)) add(x[1] + "…");
add("Starting…");
const cfg = JSON.parse(read("src/config.json"));
for (const s of Object.values(cfg.systems)) if (s.bios) { add(s.bios.note); }

// not words: games, series, consoles, versions, colors, the changelog, file names, and sentences already filled in
const franchises = JSON.parse(read("src/data/franchises.json"));
const names = new Set([...seen.titles, ...seen.systems, ...Object.keys(cfg.systems), ...Object.keys(franchises)]);
const { cleanTitle } = require(path.join(ROOT, "src", "backend.js"));
for (const list of Object.values(franchises)) for (const [, look] of list) { names.add(look.replace(/\s*\([^)]*\)/g, "").trim()); names.add(cleanTitle(look)); }
for (const s of Object.values(cfg.systems)) {
  for (const th of [].concat(s.thumbs || [])) names.add(String(th).replace(/^[^-]+ - /, ""));
  if (s.bios && s.bios.label) names.add(s.bios.label);
}
// every game the metadata knows, without its region and version
for (const f of fs.readdirSync(path.join(ROOT, "src", "data", "meta"))) {
  try { for (const n of Object.keys(JSON.parse(read("src/data/meta/" + f)))) names.add(n.replace(/\s*[([][^)\]]*[)\]]/g, "").trim()); } catch {}
}
// never words, even where the code writes them: languages go by their own names, and the app's, the consoles' and
// other makers' names stay as they are
const fixed = new Set(["English", "Español", "Français", "Deutsch", "Italiano", "Polski", "Português", "Русский", "日本語", "한국어", "简体中文", "繁體中文", "The Retro Shelf", "THE RETRO SHELF", "English text",
  "PlayStation", "PlayStation 2", "RetroAchievements", "RetroArch", "Limited Run Games", "PDRoms", "GOG", "Evercade", "itch.io", "Retrode",
  "GB Operator", "Homebrew Hub", "CleanRip (Wii)", "Xbox", "Nintendo", ...Object.keys(cfg.systems)]);
for (const n of ["Español", "Français", "Deutsch", "Italiano", "Polski", "Português", "Русский", "日本語", "한국어", "简体中文", "繁體中文"]) fixed.add(n + " (beta)");
for (const s of Object.values(cfg.systems)) if (s.bios && s.bios.label) fixed.add(s.bios.label);
// a famous series' pin is a nickname, the same in every language
for (const p of require(path.join(ROOT, "src", "pins.js")).build([])) if (p.key.startsWith("s:")) fixed.add(p.title);
const short = d => [...Array(12)].map((_, m) => new Date(2000, m, 1).toLocaleDateString("en", { month: "short" })).concat([...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString("en", { weekday: "short" })));
for (const n of short()) names.add(n);
const templates = [...keys].filter(k => /\{\w+\}/.test(k)).map(k => new RegExp("^" + k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{\w+\\?\}/g, ".+?") + "$"));
// a sentence with blanks has to still be in the code; a line that's two entries side by side is those two
const code = page + main + backend + read("src/pins.js") + read("src/config.json");
const joined = k => [...keys].some(a => a !== k && /[.!?…]$/.test(a) && k.startsWith(a + " ") && keys.has(k.slice(a.length + 1)));
// written in the app's own code, so words even when a game has the same name ("Dark", "X")
const inCode = k => [page, main, backend].some(c => c.includes(`"${k}"`) || c.includes(`>${k}<`));
const out = [...keys].filter(k => {
  if (/\{\w+\}/.test(k) && !code.includes(k)) return false;
  if (joined(k)) return false;
  if (!/[A-Za-z]/.test(k) || fixed.has(k) || (names.has(k) && !inCode(k))) return false;
  // keys and buttons by their letters (X, LB, F1, "Q E"): the same everywhere
  if (k.length <= 2 || /^[A-Z0-9]{1,3}( +[A-Z0-9]{1,3})*$/.test(k)) return false;
  if (/^(#[0-9a-f]{3,8}|v?\d+\.\d+|https?:|\/|[\w-]+\.(png|jpe?g|json|zip|bin|rom|cht|rmp|cfg|m3u)$)/i.test(k)) return false;
  // file names of games (dates, makers and regions in brackets), a console with a count, a month and year, font specs
  if (/\((?:[^)]*\d{4}[^)]*|[^)]*\b(?:USA|Japan|Europe|World|En)\b[^)]*)\)/.test(k) || /\d+px/.test(k) || /^[A-Z][a-z]{2} \d{4}$/.test(k)) return false;
  if (!inCode(k) && (names.has(k.replace(/ \d+$/, "")) || names.has(k.replace(/\s*[([][^)\]]*[)\]]/g, "").trim()))) return false;
  if (!/\{\w+\}/.test(k) && !inCode(k) && templates.some(re => re.test(k))) return false;
  return true;
}).sort((a, b) => a.localeCompare(b, "en"));

fs.mkdirSync(path.join(ROOT, "src", "words"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "src", "words", "keys.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length} pieces of English in src/words/keys.json`);
// what each language is missing
for (const lang of ["es", "fr", "de", "pt", "ja"]) {
  let table = {}; try { table = JSON.parse(read(`src/words/${lang}.json`)); } catch {}
  const missing = out.filter(k => !table[k]);
  if (missing.length) console.log(`  ${lang}: ${missing.length} to translate`);
}

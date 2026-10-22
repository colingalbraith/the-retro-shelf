#!/usr/bin/env node
// The website (GitHub Pages): site/index.html with the README's pictures (docs/images), the app's fonts, and the
// latest release's downloads written in, put together in dist/site, in English and (dist/site/<lang>/) the app's other
// languages (scripts/site-words.mjs, site/words). CI publishes it (.github/workflows/pages.yml) when the page changes
// and when a release comes out; run it to look first.
//   node scripts/site.mjs      then open dist/site/index.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, OFFER, translate } from "./site-words.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist", "site"), REPO = "colingalbraith/the-retro-shelf";
const FONTS = ["plex-cond-400", "plex-cond-600", "plex-cond-700", "plex-mono-400"].flatMap(f => [f + ".woff2", f + "-ext.woff2"]);
const SITE = "https://colingalbraith.github.io/the-retro-shelf/";
// which file is which, by name
const KINDS = { mac_arm64: /-mac-arm64\.dmg$/, mac_x64: /-mac-x64\.dmg$/, win: /Setup-.*\.exe$/, portable: /portable-win\.zip$/, linux: /\.AppImage$/ };

/** the latest full release (not a test version): its version, date and each download's address and size */
async function latest() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rel = await r.json(), files = {};
    for (const [k, re] of Object.entries(KINDS)) {
      const a = rel.assets.find(x => re.test(x.name));
      if (a) files[k] = { url: a.browser_download_url, size: a.size };
    }
    return { version: rel.tag_name.replace(/^v/, ""), date: rel.published_at, files };
  } catch (e) {
    console.warn(`couldn't find the latest release (${e.message}): the buttons go to the releases page`);
    return null;
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "images"), { recursive: true });
fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "docs", "images"))) if (/\.(jpg|png|gif)$/.test(f)) fs.copyFileSync(path.join(ROOT, "docs", "images", f), path.join(OUT, "images", f));
for (const f of FONTS) fs.copyFileSync(path.join(ROOT, "src", "fonts", f), path.join(OUT, "fonts", f));
fs.copyFileSync(path.join(ROOT, "src", "fonts", "OFL.txt"), path.join(OUT, "fonts", "OFL.txt"));
const rel = await latest();
const page = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
if (!page.includes("/*LATEST*/null")) throw new Error("site/index.html has no /*LATEST*/null to fill in");
// as JSON inside a script: nothing in it can close the script early
const json = v => JSON.stringify(v).replace(/</g, "\\u003c");
const words = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, "site", "words", l + ".json"), "utf8"))]));
// each language's page, and where the others are (for search engines)
const alternates = [`<link rel="alternate" hreflang="en" href="${SITE}">`, `<link rel="alternate" hreflang="x-default" href="${SITE}">`,
  ...LANGS.map(l => `<link rel="alternate" hreflang="${l === "zh" ? "zh-Hans" : l}" href="${SITE}${l}/">`)].join("\n");
const base = page.replace("/*LATEST*/null", json(rel)).replace('<link rel="icon"', alternates + '\n<link rel="icon"');
const offers = Object.fromEntries(LANGS.map(l => [l, { offer: words[l][OFFER[0]], close: words[l][OFFER[1]] }]).filter(([, o]) => o.offer && o.close));
fs.writeFileSync(path.join(OUT, "index.html"), base.replace("/*OFFERS*/{}", json(offers)));
for (const l of LANGS) {
  fs.mkdirSync(path.join(OUT, l));
  fs.writeFileSync(path.join(OUT, l, "index.html"), translate(base, l, words[l]));
}
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
console.log(`dist/site, in English and ${LANGS.length} more languages: ${rel ? `downloads for ${rel.version} (${Object.keys(rel.files).join(", ")})` : "no release found"}`);

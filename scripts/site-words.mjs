// The website's words, and the page in another language. What's translated is marked in site/index.html:
//   data-t          an element's text, inline <b>, <a> and <code> included
//   data-t-alt      an image's alt text
//   data-t-aria     an aria-label
//   data-t-content  a <meta>'s content
// plus T("…") in its script (what the script writes, put in the page as WORDS), and the two words of the offer to read
// the page in another language. Translations are in site/words/<lang>.json, by the English: a translation keeps the
// English's tags and {blanks}.

/** the languages besides English, as in the app (src/words) */
export const LANGS = ["es", "fr", "de", "it", "pl", "pt", "ru", "ja", "ko", "zh", "zh-Hant"];
/** the offer on the English page, in the visitor's language: "This page in English" means this page in that language */
export const OFFER = ["This page in English", "Close"];

const norm = s => s.replace(/\s+/g, " ").trim();
const ELEMENT = /<(\w+)([^>]*\sdata-t(?=[\s>])[^>]*)>([\s\S]*?)<\/\1>/g;
const ATTR = { "data-t-alt": "alt", "data-t-aria": "aria-label", "data-t-content": "content" };
const tagged = name => new RegExp(`<(\\w+)([^>]*\\s${name}(?=[\\s>])[^>]*)>`, "g");
const attrOf = (attrs, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(attrs); return m ? m[1] : null; };
const SCRIPT = /<script>([\s\S]*?)<\/script>/;
const CALL = /\bT\("((?:[^"\\]|\\.)*)"/g;

/** what the script translates: T("…") calls */
export function scriptKeys(page) {
  const js = (SCRIPT.exec(page) || ["", ""])[1];
  return [...new Set([...js.matchAll(CALL)].map(m => JSON.parse(`"${m[1]}"`)))];
}

/** everything on the page to translate, in page order */
export function keys(page) {
  const out = [];
  for (const m of page.matchAll(ELEMENT)) out.push(norm(m[3]));
  for (const [mark, a] of Object.entries(ATTR)) for (const m of page.matchAll(tagged(mark))) { const v = attrOf(m[2], a); if (v) out.push(norm(v)); }
  return [...new Set([...out, ...scriptKeys(page), ...OFFER])];
}

/** the page in a language: its marked text replaced, its script given its words, and where English is ("../") */
export function translate(page, lang, words) {
  const w = s => words[norm(s)] || norm(s), quote = s => s.replace(/&(?!#?\w+;)/g, "&amp;").replace(/"/g, "&quot;");
  let out = page.replace(ELEMENT, (m, tag, attrs, inner) => `<${tag}${attrs}>${w(inner)}</${tag}>`);
  for (const [mark, a] of Object.entries(ATTR)) {
    out = out.replace(tagged(mark), (m, tag, attrs) => {
      const v = attrOf(attrs, a);
      return v ? m.replace(`${a}="${v}"`, () => `${a}="${quote(w(v))}"`) : m;
    });
  }
  const own = Object.fromEntries(scriptKeys(page).filter(k => words[k]).map(k => [k, words[k]]));
  return out.replace('<html lang="en">', `<html lang="${lang === "zh" ? "zh-Hans" : lang}">`)
    .replace('/*LANG*/"en"', JSON.stringify(lang))
    .replace("/*WORDS*/{}", JSON.stringify(own).replace(/</g, "\\u003c"))
    .replace('/*UP*/""', '"../"')
    // its pictures and fonts are a folder up
    .replace(/(src|href)="(images|fonts)\//g, '$1="../$2/').replace(/url\(fonts\//g, "url(../fonts/");
}

/** a translation's tags (with their links) and blanks, which have to be the English's, in any order */
export const shape = s => [...s.matchAll(/<\/?\w+[^>]*>|\{\w+\}/g)].map(m => m[0]).sort().join(" ");

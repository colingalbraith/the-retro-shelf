import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { PINS, context, evaluate, genreGroup } = createRequire(import.meta.url)("../src/pins.js");
const at = (y, m, d, h = 15, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;
const earned = (games, st, series = []) => evaluate(context(games, { fav: [], shelves: [], plays: {}, time: {}, sessions: [], ...st }, series, genreGroup)).filter(r => r.earned).map(r => r.key).sort();

test("every pin has a title, a tier and something to show", () => {
  assert.equal(new Set(PINS.map(p => p.key)).size, PINS.length);
  for (const p of PINS) { assert.ok(p.title && p.desc && p.icon); assert.ok(["bronze", "silver", "gold"].includes(p.tier)); }
  assert.ok(PINS.length >= 30);
});

test("an empty shelf has earned nothing", () => {
  assert.deepEqual(earned([], {}), []);
});

test("habits come from the play log: a week in a row, late nights, early mornings, long sittings, weekends", () => {
  const g = [{ id: "a", system: "SNES", year: "1991", genre: "Platform" }];
  const days = Array.from({ length: 7 }, (_, i) => ["a", at(2026, 10, 1 + i), 1800]);   // Oct 1 to 7, 2026; the 3rd and 4th are a weekend
  const got = earned(g, { plays: { a: 9 }, time: { a: 9 * 1800 + 4 * 3600 }, sessions: [...days, ["a", at(2026, 10, 8, 1), 600], ["a", at(2026, 10, 9, 6), 4 * 3600]] });
  for (const k of ["first", "streak7", "nightowl", "earlybird", "marathon", "weekend"]) assert.ok(got.includes(k), k);
  assert.ok(!got.includes("streak30"));
});

test("a sitting longer than 12 hours is a game left running, not a marathon", () => {
  const g = [{ id: "a", system: "NES", year: "1985" }];
  assert.ok(!earned(g, { plays: { a: 1 }, time: { a: 20 * 3600 }, sessions: [["a", at(2026, 3, 2), 20 * 3600]] }).includes("marathon"));
});

test("coming back to a game after six months, and Christmas", () => {
  const g = [{ id: "a", system: "NES", year: "1988" }];
  const got = earned(g, { plays: { a: 2 }, time: { a: 7200 }, sessions: [["a", at(2025, 12, 25), 3600], ["a", at(2026, 8, 1), 3600]] });
  assert.ok(got.includes("comeback") && got.includes("holiday") && got.includes("oldschool"));
});

test("variety and collecting: consoles, decades, genres, a whole series", () => {
  const sys = ["NES", "SNES", "Genesis", "N64", "PS1"], g = sys.map((s, i) => ({ id: "g" + i, system: s, year: String(1978 + i * 6), genre: ["Platform", "Role-playing (RPG)", "Racing", "Shooter", "Puzzle"][i] }));
  const st = { plays: Object.fromEntries(g.map(x => [x.id, 1])), time: Object.fromEntries(g.map(x => [x.id, 600])) };
  const got = earned(g, st, [{ have: 3, items: [{}, {}, {}] }]);
  for (const k of ["hopper", "fullhouse", "decades", "genres", "pioneer", "complete", "disc"]) assert.ok(got.includes(k), k);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: "x" + i, system: "NES" }));
  assert.ok(earned(many, {}).includes("archivist"));
});

const { build } = createRequire(import.meta.url)("../src/pins.js");
const full = (games, st, series = [], extra = {}) => evaluate(context(games, { fav: [], shelves: [], plays: {}, time: {}, sessions: [], events: {}, ...st }, series, genreGroup, extra), ["NES", "SNES", "PS2"]);

test("there are well over 90 pins, every key different", () => {
  const all = build(["NES", "SNES", "Game Boy", "GBA", "Genesis", "Master System", "PC Engine", "Atari 2600", "N64", "PS1", "Dreamcast", "DS", "PSP", "Arcade", "GameCube/Wii", "PS2"]);
  assert.ok(all.length > 90, String(all.length));
  assert.equal(new Set(all.map(p => p.key)).size, all.length);
});

test("console pins show for consoles on your shelves, and count games and hours on that console", () => {
  const g = Array.from({ length: 5 }, (_, i) => ({ id: "n" + i, system: "NES" }));
  const st = { plays: Object.fromEntries(g.map(x => [x.id, 1])), time: Object.fromEntries(g.map(x => [x.id, 6 * 3600])) };
  const r = new Map(full(g, st).map(x => [x.key, x]));
  assert.ok(r.get("c5:NES").earned && r.get("c25:NES").earned && !r.get("c100:NES").earned);
  assert.deepEqual(r.get("c100:NES").progress, [30, 100]);
  assert.equal(r.get("c5:SNES").shown, false, "no SNES games, no SNES pins on the board");
});

test("series pins show once you have a game in the series, and are earned with all of it", () => {
  const series = [{ name: "Metroid", have: 6, items: Array.from({ length: 6 }, () => ({})) }, { name: "Pokémon", have: 2, items: Array.from({ length: 17 }, () => ({})) }];
  const r = new Map(full([], {}, series).map(x => [x.key, x]));
  assert.ok(r.get("s:Metroid").earned);
  assert.ok(r.get("s:Pokémon").shown && !r.get("s:Pokémon").earned);
  assert.deepEqual(r.get("s:Pokémon").progress, [2, 17]);
  assert.equal(r.get("s:Sonic").shown, false);
});

test("more habits: variety nights, a grand tour, loyalty, weekend binges, lunch, the new year", () => {
  const g = Array.from({ length: 7 }, (_, i) => ({ id: "g" + i, system: "SNES" }));
  const ses = g.map((x, i) => [x.id, at(2026, 6, 1 + i, 20), 1800]);                       // a different game each day, Mon 1 June to Sun 7 June
  ses.push(["g1", at(2026, 6, 1, 21), 600], ["g2", at(2026, 6, 1, 22), 600]);               // three games on the first day
  for (let d = 8; d < 18; d++) ses.push(["g0", at(2026, 6, d, 12, 30), 900]);               // g0 on 10 more days, some at lunch
  ses.push(["g2", at(2026, 6, 6, 10), 4 * 3600], ["g2", at(2026, 6, 7, 10), 3600]);         // 5+ hours over the weekend of 6-7 June
  ses.push(["g3", at(2026, 12, 31, 23, 30), 3600]);                                         // into the new year
  const got = new Set(full(g, { plays: { g0: 1 }, sessions: ses }).filter(x => x.earned).map(x => x.key));
  for (const k of ["varietynight", "grandtour", "loyal", "binge", "lunch", "newyear", "friday", "streak7"]) assert.ok(got.has(k), k);
});

test("firsts the app records: CRT, TV mode, a backup, a BIOS, a cover, a name", () => {
  const got = new Set(full([], { events: { crt: 1, tv: 1, backup: 1, cover: 1, rename: 1, hide: 1, arrange: 1 } }, [], { bios: true }).filter(x => x.earned).map(x => x.key));
  for (const k of ["crt", "tv", "backup", "bios", "cover", "rename", "tidy", "rearrange"]) assert.ok(got.has(k), k);
});

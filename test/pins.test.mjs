import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { PINS, context, evaluate, genreGroup } = createRequire(import.meta.url)("../src/pins.js");
const at = (y, m, d, h = 15) => new Date(y, m - 1, d, h).getTime() / 1000;
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

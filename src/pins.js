"use strict";
// Shelf achievements ("pins"): milestones earned from how people play and collect, worked out from what the app
// already keeps (play sessions, totals, the library, shelves, collections). Nothing leaves the computer and no account
// is needed, but nothing inside a game counts: the app can't see a final boss.

const H = 3600, DAY = 86400;
/* the genre groups shelves are arranged by: the metadata's 33 genre names, folded into a dozen */
const GENRES = [[/role|rpg/i, "RPGs"], [/platform/i, "Platformers"], [/beat/i, "Beat 'em ups"], [/shoot|lightgun/i, "Shooters"], [/fight/i, "Fighting"],
  [/rac/i, "Racing"], [/sport|hunting/i, "Sports"], [/puzzle|thinking|quiz/i, "Puzzle & quiz"], [/strategy|simulation/i, "Strategy & sim"],
  [/adventure/i, "Adventure"], [/action/i, "Action"], [/board|card|gambling|casual/i, "Board, cards & casual"], [/music|danc/i, "Music"]];
const genreGroup = text => { const m = GENRES.find(([re]) => re.test(text || "")); return m ? m[1] : ""; };
const HANDHELD = new Set(["Game Boy", "GBA", "DS", "PSP"]);
const DISC = new Set(["PS1", "PS2", "Dreamcast", "PSP", "GameCube/Wii"]);
const dayKey = t => { const d = new Date(t * 1000); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };

/**
 * Every pin: key, title, what earns it, tier (bronze, silver, gold), an icon, and a test that returns
 * true/false or [have, need] for pins that build up. Secret pins say what they are only once earned.
 */
const PINS = [
  // getting started
  { key: "first", title: "Press Start", desc: "Play your first game.", tier: "bronze", icon: "▶", test: c => [Math.min(c.played.size, 1), 1] },
  { key: "home", title: "Moving In", desc: "Put 10 games on your shelves.", tier: "bronze", icon: "⌂", test: c => [c.games.length, 10] },
  { key: "curator", title: "Curator", desc: "Make a shelf of your own.", tier: "bronze", icon: "▤", test: c => [Math.min(c.shelves.length, 1), 1] },
  { key: "organizer", title: "Organizer", desc: "Make three shelves of your own.", tier: "silver", icon: "▥", test: c => [c.shelves.length, 3] },
  { key: "favorites", title: "Gold Stars", desc: "Star five favorites.", tier: "bronze", icon: "★", test: c => [c.favs, 5] },
  { key: "wishlist", title: "Wishful Thinking", desc: "Add a game you don't have to a collection.", tier: "bronze", icon: "✧", test: c => c.wanted > 0 },
  // time
  { key: "hours10", title: "Getting Into It", desc: "Play for 10 hours in all.", tier: "bronze", icon: "◔", test: c => [Math.floor(c.total / H), 10] },
  { key: "hours100", title: "Lifer", desc: "Play for 100 hours in all.", tier: "silver", icon: "◑", test: c => [Math.floor(c.total / H), 100] },
  { key: "hours250", title: "Living Room Legend", desc: "Play for 250 hours in all.", tier: "gold", icon: "●", test: c => [Math.floor(c.total / H), 250] },
  { key: "devoted", title: "Devoted", desc: "Spend 20 hours on one game.", tier: "silver", icon: "♥", test: c => [Math.floor(c.most / H), 20] },
  { key: "obsessed", title: "Obsessed", desc: "Spend 50 hours on one game.", tier: "gold", icon: "❤", test: c => [Math.floor(c.most / H), 50] },
  { key: "marathon", title: "Marathon", desc: "Play for 3 hours in one sitting.", tier: "silver", icon: "⌛", test: c => c.sittings.some(d => d >= 3 * H && d <= 12 * H) },
  { key: "quick", title: "Quick Break", desc: "Play 10 short sittings of under 15 minutes.", tier: "bronze", icon: "⏱", test: c => [c.sittings.filter(d => d < 15 * 60).length, 10] },
  // habits (from the play log, which starts with version 0.3.0)
  { key: "streak7", title: "Regular", desc: "Play 7 days in a row.", tier: "silver", icon: "▦", test: c => [c.bestStreak, 7] },
  { key: "streak30", title: "Daily Ritual", desc: "Play 30 days in a row.", tier: "gold", icon: "▩", test: c => [c.bestStreak, 30] },
  { key: "onemore", title: "Just One More", desc: "Play five times in one day.", tier: "bronze", icon: "↻", test: c => [c.maxPerDay, 5] },
  { key: "weekend", title: "Weekend Warrior", desc: "Play on a Saturday and the Sunday after it.", tier: "bronze", icon: "☀", test: c => c.weekend },
  { key: "nightowl", title: "Night Owl", desc: "Start a game after midnight.", tier: "bronze", icon: "☾", secret: true, test: c => c.starts.some(h => h < 5) },
  { key: "earlybird", title: "Early Bird", desc: "Start a game before 7 in the morning.", tier: "bronze", icon: "☼", secret: true, test: c => c.starts.some(h => h >= 5 && h < 7) },
  { key: "comeback", title: "Comeback", desc: "Go back to a game after six months away.", tier: "silver", icon: "↺", secret: true, test: c => c.comeback },
  { key: "holiday", title: "Holiday Spirit", desc: "Play on Christmas Day.", tier: "bronze", icon: "❄", secret: true, test: c => c.christmas },
  // variety
  { key: "sampler", title: "Sampler", desc: "Play 10 different games.", tier: "bronze", icon: "◇", test: c => [c.played.size, 10] },
  { key: "connoisseur", title: "Connoisseur", desc: "Play 50 different games.", tier: "gold", icon: "◆", test: c => [c.played.size, 50] },
  { key: "hopper", title: "Console Hopper", desc: "Play games on 5 different consoles.", tier: "silver", icon: "⇄", test: c => [c.playedSystems.size, 5] },
  { key: "fullhouse", title: "Full House", desc: "Play a game on every console on your shelves (at least 3).", tier: "gold", icon: "♛",
    test: c => c.systems.size >= 3 && [...c.systems].every(s => c.playedSystems.has(s)) },
  { key: "decades", title: "Time Traveler", desc: "Play games from three different decades.", tier: "silver", icon: "⧗", test: c => [c.playedDecades.size, 3] },
  { key: "genres", title: "Well Rounded", desc: "Play games from five different genres.", tier: "silver", icon: "✦", test: c => [c.playedGenres.size, 5] },
  { key: "oldschool", title: "Old School", desc: "Play a game from the 1980s.", tier: "bronze", icon: "▣", test: c => c.playedYears.some(y => y >= 1980 && y < 1990) },
  { key: "pioneer", title: "Pioneer", desc: "Play a game from the 1970s.", tier: "silver", icon: "▲", secret: true, test: c => c.playedYears.some(y => y < 1980) },
  { key: "arcade", title: "Insert Coin", desc: "Play an arcade game.", tier: "bronze", icon: "¢", test: c => c.playedSystems.has("Arcade") },
  { key: "handheld", title: "On the Go", desc: "Play a handheld game.", tier: "bronze", icon: "▯", test: c => [...c.playedSystems].some(s => HANDHELD.has(s)) },
  { key: "disc", title: "Spin It", desc: "Play a game on disc.", tier: "bronze", icon: "◎", test: c => [...c.playedSystems].some(s => DISC.has(s)) },
  // collecting
  { key: "collector", title: "Collector", desc: "Have 50 games on your shelves.", tier: "silver", icon: "▚", test: c => [c.games.length, 50] },
  { key: "archivist", title: "Archivist", desc: "Have 100 games on your shelves.", tier: "gold", icon: "▞", test: c => [c.games.length, 100] },
  { key: "museum", title: "Museum", desc: "Have 250 games on your shelves.", tier: "gold", icon: "♜", test: c => [c.games.length, 250] },
  { key: "complete", title: "Completionist", desc: "Have every game in a series of three or more.", tier: "gold", icon: "✔", test: c => c.completeSeries > 0 },
];

/**
 * What the tests read. games: [{id, system, year, genre}]; st: the saved state (time, plays, fav, shelves, sessions);
 * series: [{have, items}] from collections; genreOf: (genre text) -> genre group or "".
 */
function context(games, st, series, genreOf) {
  const byId = new Map(games.map(g => [g.id, g]));
  const played = new Set(games.filter(g => (st.plays[g.id] || 0) > 0 || (st.time[g.id] || 0) > 0).map(g => g.id));
  const pg = [...played].map(id => byId.get(id));
  const times = games.map(g => st.time[g.id] || 0);
  const sessions = st.sessions || [];
  // days in a row, sittings per day, weekends, the hour each sitting started, gaps between sittings of one game
  const days = [...new Set(sessions.map(s => dayKey(s[1])))].map(k => new Date(Math.floor(k / 10000), Math.floor(k / 100) % 100, k % 100).getTime()).sort((a, b) => a - b);
  let best = days.length ? 1 : 0, run = 1;
  for (let i = 1; i < days.length; i++) { run = Math.round((days[i] - days[i - 1]) / (DAY * 1000)) === 1 ? run + 1 : 1; best = Math.max(best, run); }
  const perDay = new Map(); sessions.forEach(s => perDay.set(dayKey(s[1]), (perDay.get(dayKey(s[1])) || 0) + 1));
  const daySet = new Set(sessions.map(s => dayKey(s[1])));
  const weekend = sessions.some(s => { const d = new Date(s[1] * 1000); if (d.getDay() !== 6) return false; const n = new Date(d); n.setDate(n.getDate() + 1); return daySet.has(dayKey(n.getTime() / 1000)); });
  const lastOf = new Map(); let comeback = false;
  for (const [id, start, dur] of [...sessions].sort((a, b) => a[1] - b[1])) {
    if (lastOf.has(id) && start - lastOf.get(id) >= 182 * DAY) comeback = true;
    lastOf.set(id, start + dur);
  }
  const years = pg.map(g => parseInt(g.year, 10)).filter(Boolean);
  return {
    games, played, favs: (st.fav || []).filter(id => byId.has(id)).length, shelves: st.shelves || [],
    wanted: (st.shelves || []).reduce((n, s) => n + ((s.wanted || []).length), 0),
    total: times.reduce((a, b) => a + b, 0), most: Math.max(0, ...times),
    sittings: sessions.map(s => s[2]), starts: sessions.map(s => new Date(s[1] * 1000).getHours()),
    bestStreak: best, maxPerDay: Math.max(0, ...perDay.values()), weekend, comeback,
    christmas: sessions.some(s => { const d = new Date(s[1] * 1000); return d.getMonth() === 11 && d.getDate() === 25; }),
    systems: new Set(games.map(g => g.system)), playedSystems: new Set(pg.map(g => g.system)),
    playedYears: years, playedDecades: new Set(years.map(y => Math.floor(y / 10))),
    playedGenres: new Set(pg.map(g => genreOf(g.genre || "")).filter(Boolean)),
    completeSeries: series.filter(s => s.items.length >= 3 && s.have === s.items.length).length,
  };
}

/** every pin with whether it's earned and, for ones that build up, how far along it is */
function evaluate(ctx) {
  return PINS.map(p => {
    const r = p.test(ctx), earned = Array.isArray(r) ? r[0] >= r[1] : !!r;
    return { key: p.key, earned, progress: Array.isArray(r) ? [Math.min(r[0], r[1]), r[1]] : null };
  });
}

/** the pins as the shelf shows them (without their tests) */
const catalog = () => PINS.map(({ test, ...p }) => p);

module.exports = { PINS, context, evaluate, catalog, genreGroup };

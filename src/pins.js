"use strict";
// Shelf achievements ("pins"): milestones earned from how people play and collect, worked out from what the app
// already keeps (play sessions, totals, the library, shelves, collections, and a few firsts like the first backup).
// Nothing leaves the computer and no account is needed, but nothing inside a game counts: the app can't see a boss.

const H = 3600, DAY = 86400;
/* the genre groups shelves are arranged by: the metadata's 33 genre names, folded into a dozen */
const GENRES = [[/role|rpg/i, "RPGs"], [/platform/i, "Platformers"], [/beat/i, "Beat 'em ups"], [/shoot|lightgun/i, "Shooters"], [/fight/i, "Fighting"],
  [/rac/i, "Racing"], [/sport|hunting/i, "Sports"], [/puzzle|thinking|quiz/i, "Puzzle & quiz"], [/strategy|simulation/i, "Strategy & sim"],
  [/adventure/i, "Adventure"], [/action/i, "Action"], [/board|card|gambling|casual/i, "Board, cards & casual"], [/music|danc/i, "Music"]];
const genreGroup = text => { const m = GENRES.find(([re]) => re.test(text || "")); return m ? m[1] : ""; };
const HANDHELD = new Set(["Game Boy", "GBA", "DS", "PSP"]);
const DISC = new Set(["PS1", "PS2", "Dreamcast", "PSP", "GameCube/Wii"]);
const local = t => new Date(t * 1000);
const dayKey = t => { const d = local(t); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };

/* groups on the corkboard, in order */
const CATS = [["start", "Getting started"], ["time", "Time played"], ["finish", "Finishing"], ["habits", "Habits"], ["dates", "Days and nights"], ["variety", "Variety"],
  ["collecting", "Collecting"], ["consoles", "Consoles"], ["series", "Series"], ["app", "Making it yours"]];

/* the famous series, by the name libretro-database gives them: [name, pin title, icon] */
const SERIES = [["Pokémon", "Gotta Catch 'Em All", "◓"], ["The Legend of Zelda", "Hero of Time", "▲"], ["Metroid", "Bounty Hunter", "◉"],
  ["Super Mario Bros", "Mushroom Kingdom", "♣"], ["Mario Kart", "Grand Prix", "⚑"], ["Sonic", "Gotta Go Fast", "»"], ["Castlevania", "Vampire Hunter", "✝"],
  ["Mega Man", "Blue Bomber", "◈"], ["Final Fantasy", "Crystal Keeper", "◊"], ["Donkey Kong", "Banana Hoard", "◖"], ["Kirby", "Dream Lander", "✿"],
  ["Street Fighter", "World Warrior", "✊"], ["Metal Gear", "Tactical Espionage", "!"], ["Streets of Rage", "Back Alley Brawler", "✶"], ["Star Fox", "Barrel Roll", "↯"],
  ["Phantasy Star", "Algol Explorer", "✺"], ["Crash Bandicoot", "Wumpa Collector", "✹"], ["Spyro", "Dragon Keeper", "✣"], ["Tetris", "Line Clear", "▙"]];

/* a pin per console for 5 games played, 25 hours and 100 hours, shown once that console is on your shelves. Their
   words are made from a pattern with the console's name in it (tpl), so they can be translated */
const fill = (text, v) => text.replace(/\{(\w+)\}/g, (m, k) => v[k]);
const made = (title, desc, v) => ({ title: fill(title, v), desc: fill(desc, v), tpl: { title, desc, v } });
function consolePins(systems) {
  return systems.flatMap(s => [
    { key: "c5:" + s, ...made("{console} Fan", "Play 5 different {console} games.", { console: s }), tier: "bronze", icon: "5", cat: "consoles", show: c => c.systems.has(s),
      test: c => [(c.perSystem.get(s) || { played: 0 }).played, 5] },
    { key: "c25:" + s, ...made("{console} Devotee", "Play {console} games for 25 hours.", { console: s }), tier: "silver", icon: "25", cat: "consoles", show: c => c.systems.has(s),
      test: c => [Math.floor(((c.perSystem.get(s) || { time: 0 }).time) / H), 25] },
    { key: "c100:" + s, ...made("{console} Master", "Play {console} games for 100 hours.", { console: s }), tier: "gold", icon: "♛", cat: "consoles", show: c => c.systems.has(s),
      test: c => [Math.floor(((c.perSystem.get(s) || { time: 0 }).time) / H), 100] },
  ]);
}
/* a famous series' pin keeps its name in every language (they're nicknames); what earns it is translated */
function seriesPins() {
  return SERIES.map(([name, title, icon]) => ({
    key: "s:" + name, title, desc: fill("Have every {series} game.", { series: name }), tpl: { title, desc: "Have every {series} game.", v: { series: name } }, tier: "gold", icon, cat: "series",
    show: c => c.seriesByName.has(name), test: c => { const s = c.seriesByName.get(name); return s ? [s.have, s.total] : [0, 1]; },
  }));
}

/**
 * Every pin: key, title, what earns it, tier (bronze, silver, gold), an icon, its group, an optional show() (pins for
 * consoles or series you don't have stay off the board until you do), and a test that returns true/false or
 * [have, need] for ones that build up. Secret pins say what they are only once earned.
 */
const STATIC = [
  // getting started
  { key: "first", title: "Press Start", desc: "Play your first game.", tier: "bronze", icon: "▶", cat: "start", test: c => [Math.min(c.played.size, 1), 1] },
  { key: "home", title: "Moving In", desc: "Put 10 games on your shelves.", tier: "bronze", icon: "⌂", cat: "start", test: c => [c.games.length, 10] },
  { key: "curator", title: "Curator", desc: "Make a shelf of your own.", tier: "bronze", icon: "▤", cat: "start", test: c => [Math.min(c.shelves.length, 1), 1] },
  { key: "favorites", title: "Gold Stars", desc: "Star five favorites.", tier: "bronze", icon: "★", cat: "start", test: c => [c.favs, 5] },
  { key: "wishlist", title: "Wishful Thinking", desc: "Add a game you don't have to a collection.", tier: "bronze", icon: "✧", cat: "start", test: c => c.wanted > 0 },
  { key: "sessions25", title: "Habit Forming", desc: "Sit down to play 25 times.", tier: "bronze", icon: "≡", cat: "start", test: c => [c.sittings.length, 25] },
  // time
  { key: "hours10", title: "Getting Into It", desc: "Play for 10 hours in all.", tier: "bronze", icon: "◔", cat: "time", test: c => [Math.floor(c.total / H), 10] },
  { key: "hours25", title: "Settling In", desc: "Play for 25 hours in all.", tier: "bronze", icon: "◕", cat: "time", test: c => [Math.floor(c.total / H), 25] },
  { key: "hours100", title: "Lifer", desc: "Play for 100 hours in all.", tier: "silver", icon: "◑", cat: "time", test: c => [Math.floor(c.total / H), 100] },
  { key: "hours250", title: "Living Room Legend", desc: "Play for 250 hours in all.", tier: "gold", icon: "●", cat: "time", test: c => [Math.floor(c.total / H), 250] },
  { key: "hours500", title: "Hall of Fame", desc: "Play for 500 hours in all.", tier: "gold", icon: "♔", cat: "time", test: c => [Math.floor(c.total / H), 500] },
  { key: "hours1000", title: "Eternal", desc: "Play for 1,000 hours in all.", tier: "gold", icon: "∞", cat: "time", test: c => [Math.floor(c.total / H), 1000] },
  { key: "devoted", title: "Devoted", desc: "Spend 20 hours on one game.", tier: "silver", icon: "♥", cat: "time", test: c => [Math.floor(c.most / H), 20] },
  { key: "obsessed", title: "Obsessed", desc: "Spend 50 hours on one game.", tier: "gold", icon: "❤", cat: "time", test: c => [Math.floor(c.most / H), 50] },
  { key: "lifework", title: "Life's Work", desc: "Spend 100 hours on one game.", tier: "gold", icon: "❦", cat: "time", test: c => [Math.floor(c.most / H), 100] },
  { key: "marathon", title: "Marathon", desc: "Play for 3 hours in one sitting.", tier: "silver", icon: "⌛", cat: "time", test: c => c.sittings.some(d => d >= 3 * H && d <= 12 * H) },
  { key: "ultra", title: "Ultramarathon", desc: "Play for 6 hours in one sitting.", tier: "gold", icon: "⧗", cat: "time", test: c => c.sittings.some(d => d >= 6 * H && d <= 12 * H) },
  { key: "quick", title: "Quick Break", desc: "Play 10 short sittings of under 15 minutes.", tier: "bronze", icon: "⏱", cat: "time", test: c => [c.sittings.filter(d => d < 15 * 60).length, 10] },
  // finishing, rating and notes (Progress, Rating and Note in a game's options)
  { key: "beaten1", title: "Roll Credits", desc: "Mark a game beaten.", tier: "bronze", icon: "⚐", cat: "finish", test: c => [c.beaten, 1] },
  { key: "beaten10", title: "Finisher", desc: "Beat 10 games.", tier: "silver", icon: "⚑", cat: "finish", test: c => [c.beaten, 10] },
  { key: "beaten25", title: "Closer", desc: "Beat 25 games.", tier: "gold", icon: "⛿", cat: "finish", test: c => [c.beaten, 25] },
  { key: "full1", title: "Every Last Secret", desc: "Mark a game 100%.", tier: "silver", icon: "✓", cat: "finish", test: c => [c.complete, 1] },
  { key: "full5", title: "Perfectionist", desc: "Mark five games 100%.", tier: "gold", icon: "✪", cat: "finish", test: c => [c.complete, 5] },
  { key: "backlog10", title: "Big Plans", desc: "Put 10 games on your backlog.", tier: "bronze", icon: "☰", cat: "finish", test: c => [c.backlog, 10] },
  { key: "rated10", title: "Critic", desc: "Rate 10 games.", tier: "bronze", icon: "☆", cat: "finish", test: c => [c.rated, 10] },
  { key: "rated50", title: "Reviewer", desc: "Rate 50 games.", tier: "silver", icon: "★", cat: "finish", test: c => [c.rated, 50] },
  { key: "note1", title: "Note to Self", desc: "Write a note on a game.", tier: "bronze", icon: "✎", cat: "finish", test: c => [c.noted, 1] },
  { key: "note10", title: "Field Notes", desc: "Write notes on 10 games.", tier: "silver", icon: "✍", cat: "finish", test: c => [c.noted, 10] },
  // habits (from the play log, which starts with version 0.3.0)
  { key: "streak3", title: "Three in a Row", desc: "Play 3 days in a row.", tier: "bronze", icon: "▤", cat: "habits", test: c => [c.bestStreak, 3] },
  { key: "streak7", title: "Regular", desc: "Play 7 days in a row.", tier: "silver", icon: "▦", cat: "habits", test: c => [c.bestStreak, 7] },
  { key: "streak30", title: "Daily Ritual", desc: "Play 30 days in a row.", tier: "gold", icon: "▩", cat: "habits", test: c => [c.bestStreak, 30] },
  { key: "streak100", title: "Unbroken", desc: "Play 100 days in a row.", tier: "gold", icon: "▉", cat: "habits", test: c => [c.bestStreak, 100] },
  { key: "sessions100", title: "Familiar Face", desc: "Sit down to play 100 times.", tier: "silver", icon: "☰", cat: "habits", test: c => [c.sittings.length, 100] },
  { key: "sessions1000", title: "Part of the Furniture", desc: "Sit down to play 1,000 times.", tier: "gold", icon: "⌬", cat: "habits", test: c => [c.sittings.length, 1000] },
  { key: "onemore", title: "Just One More", desc: "Play five times in one day.", tier: "bronze", icon: "↻", cat: "habits", test: c => [c.maxPerDay, 5] },
  { key: "varietynight", title: "Variety Night", desc: "Play 3 different games in one day.", tier: "bronze", icon: "⁂", cat: "habits", test: c => [c.maxGamesPerDay, 3] },
  { key: "grandtour", title: "Grand Tour", desc: "Play 7 different games in one week.", tier: "silver", icon: "✈", cat: "habits", test: c => [c.maxGamesPerWeek, 7] },
  { key: "loyal", title: "Loyal", desc: "Play the same game on 10 different days.", tier: "silver", icon: "⚓", cat: "habits", test: c => [c.mostDaysOneGame, 10] },
  { key: "comeback", title: "Comeback", desc: "Go back to a game after six months away.", tier: "silver", icon: "↺", cat: "habits", secret: true, test: c => c.comeback },
  // days and nights
  { key: "weekend", title: "Weekend Warrior", desc: "Play on a Saturday and the Sunday after it.", tier: "bronze", icon: "☀", cat: "dates", test: c => c.weekend },
  { key: "binge", title: "Weekend Binge", desc: "Play 5 hours over one weekend.", tier: "silver", icon: "☕", cat: "dates", test: c => [Math.floor(c.bestWeekend / H), 5] },
  { key: "lunch", title: "Lunch Break", desc: "Start a game at lunchtime on a weekday.", tier: "bronze", icon: "◷", cat: "dates", test: c => c.lunch },
  { key: "friday", title: "Friday Night", desc: "Start a game on a Friday evening.", tier: "bronze", icon: "♫", cat: "dates", test: c => c.friday },
  { key: "sunday", title: "Sunday Morning", desc: "Start a game on a Sunday morning.", tier: "bronze", icon: "☼", cat: "dates", test: c => c.sundayMorning },
  { key: "nightowl", title: "Night Owl", desc: "Start a game after midnight.", tier: "bronze", icon: "☾", cat: "dates", secret: true, test: c => c.starts.some(h => h < 5) },
  { key: "earlybird", title: "Early Bird", desc: "Start a game before 7 in the morning.", tier: "bronze", icon: "◒", cat: "dates", secret: true, test: c => c.starts.some(h => h >= 5 && h < 7) },
  { key: "holiday", title: "Holiday Spirit", desc: "Play on Christmas Day.", tier: "bronze", icon: "❄", cat: "dates", secret: true, test: c => c.on(11, 25) },
  { key: "newyear", title: "Happy New Year", desc: "Play as the new year begins.", tier: "silver", icon: "✷", cat: "dates", secret: true, test: c => c.newYear },
  { key: "halloween", title: "Spooky Season", desc: "Play on Halloween.", tier: "bronze", icon: "☠", cat: "dates", secret: true, test: c => c.on(9, 31) },
  { key: "leapday", title: "Leap Day", desc: "Play on the 29th of February.", tier: "gold", icon: "❋", cat: "dates", secret: true, test: c => c.on(1, 29) },
  // variety
  { key: "sampler", title: "Sampler", desc: "Play 10 different games.", tier: "bronze", icon: "◇", cat: "variety", test: c => [c.played.size, 10] },
  { key: "explorer", title: "Explorer", desc: "Play 25 different games.", tier: "silver", icon: "◈", cat: "variety", test: c => [c.played.size, 25] },
  { key: "connoisseur", title: "Connoisseur", desc: "Play 50 different games.", tier: "gold", icon: "◆", cat: "variety", test: c => [c.played.size, 50] },
  { key: "globetrotter", title: "Globetrotter", desc: "Play 100 different games.", tier: "gold", icon: "⊕", cat: "variety", test: c => [c.played.size, 100] },
  { key: "multi", title: "Multi-Console", desc: "Play games on 3 different consoles.", tier: "bronze", icon: "⇆", cat: "variety", test: c => [c.playedSystems.size, 3] },
  { key: "hopper", title: "Console Hopper", desc: "Play games on 5 different consoles.", tier: "silver", icon: "⇄", cat: "variety", test: c => [c.playedSystems.size, 5] },
  { key: "tenconsoles", title: "Ten Consoles Deep", desc: "Play games on 10 different consoles.", tier: "gold", icon: "⑩", cat: "variety", test: c => [c.playedSystems.size, 10] },
  { key: "fullhouse", title: "Full House", desc: "Play a game on every console on your shelves (at least 3).", tier: "gold", icon: "♛", cat: "variety",
    test: c => c.systems.size >= 3 && [...c.systems].every(s => c.playedSystems.has(s)) },
  { key: "decades", title: "Time Traveler", desc: "Play games from three different decades.", tier: "silver", icon: "⧗", cat: "variety", test: c => [c.playedDecades.size, 3] },
  { key: "ages", title: "Through the Ages", desc: "Play games from four different decades.", tier: "gold", icon: "⌚", cat: "variety", test: c => [c.playedDecades.size, 4] },
  { key: "genres", title: "Well Rounded", desc: "Play games from five different genres.", tier: "silver", icon: "✦", cat: "variety", test: c => [c.playedGenres.size, 5] },
  { key: "allgenres", title: "Renaissance Player", desc: "Play a game from every genre.", tier: "gold", icon: "✧", cat: "variety", test: c => [c.playedGenres.size, GENRES.length] },
  { key: "specialist", title: "Specialist", desc: "Play 10 games of one genre.", tier: "silver", icon: "◎", cat: "variety", test: c => [c.mostInGenre, 10] },
  { key: "oldschool", title: "Old School", desc: "Play a game from the 1980s.", tier: "bronze", icon: "▣", cat: "variety", test: c => c.playedYears.some(y => y >= 1980 && y < 1990) },
  { key: "thirty", title: "Thirty Years Young", desc: "Play a game at least 30 years old.", tier: "bronze", icon: "㉚", cat: "variety", test: c => c.playedYears.some(y => y <= c.thisYear - 30) },
  { key: "pioneer", title: "Pioneer", desc: "Play a game from the 1970s.", tier: "silver", icon: "▲", cat: "variety", secret: true, test: c => c.playedYears.some(y => y < 1980) },
  { key: "arcade", title: "Insert Coin", desc: "Play an arcade game.", tier: "bronze", icon: "¢", cat: "variety", test: c => c.playedSystems.has("Arcade") },
  { key: "handheld", title: "On the Go", desc: "Play a handheld game.", tier: "bronze", icon: "▯", cat: "variety", test: c => [...c.playedSystems].some(s => HANDHELD.has(s)) },
  { key: "disc", title: "Spin It", desc: "Play a game on disc.", tier: "bronze", icon: "◎", cat: "variety", test: c => [...c.playedSystems].some(s => DISC.has(s)) },
  // collecting
  { key: "bookshelf", title: "Bookshelf", desc: "Have 25 games on your shelves.", tier: "bronze", icon: "▙", cat: "collecting", test: c => [c.games.length, 25] },
  { key: "collector", title: "Collector", desc: "Have 50 games on your shelves.", tier: "silver", icon: "▚", cat: "collecting", test: c => [c.games.length, 50] },
  { key: "archivist", title: "Archivist", desc: "Have 100 games on your shelves.", tier: "gold", icon: "▞", cat: "collecting", test: c => [c.games.length, 100] },
  { key: "museum", title: "Museum", desc: "Have 250 games on your shelves.", tier: "gold", icon: "♜", cat: "collecting", test: c => [c.games.length, 250] },
  { key: "library", title: "Great Library", desc: "Have 500 games on your shelves.", tier: "gold", icon: "⛫", cat: "collecting", test: c => [c.games.length, 500] },
  { key: "organizer", title: "Organizer", desc: "Make three shelves of your own.", tier: "silver", icon: "▥", cat: "collecting", test: c => [c.shelves.length, 3] },
  { key: "librarian", title: "Librarian", desc: "Make ten shelves of your own.", tier: "gold", icon: "▧", cat: "collecting", test: c => [c.shelves.length, 10] },
  { key: "favs25", title: "Hall of Favorites", desc: "Star 25 favorites.", tier: "silver", icon: "✪", cat: "collecting", test: c => [c.favs, 25] },
  { key: "longlist", title: "Long List", desc: "Want 10 games you don't have yet.", tier: "silver", icon: "✎", cat: "collecting", test: c => [c.wanted, 10] },
  { key: "seriesfan", title: "Series Fan", desc: "Play games from 10 different series.", tier: "silver", icon: "⁘", cat: "collecting", test: c => [c.seriesPlayed, 10] },
  { key: "complete", title: "Completionist", desc: "Have every game in a series of three or more.", tier: "gold", icon: "✔", cat: "collecting", test: c => c.completeSeries > 0 },
  { key: "complete5", title: "Set Collector", desc: "Have every game in five series.", tier: "gold", icon: "✔", cat: "collecting", test: c => [c.completeSeries, 5] },
  { key: "complete10", title: "Box Set", desc: "Have every game in ten series.", tier: "gold", icon: "✔", cat: "collecting", test: c => [c.completeSeries, 10] },
  // making it yours (firsts the app records)
  { key: "crt", title: "Old TV", desc: "Play with the old-TV picture.", tier: "bronze", icon: "▭", cat: "app", test: c => !!c.events.crt },
  { key: "tv", title: "Couch Mode", desc: "Play a game in TV mode.", tier: "bronze", icon: "▢", cat: "app", test: c => !!c.events.tv },
  { key: "backup", title: "Safe Keeping", desc: "Back up your saves.", tier: "bronze", icon: "⛁", cat: "app", test: c => !!c.events.backup },
  { key: "bios", title: "Ready to Boot", desc: "Add a BIOS file from your own console.", tier: "bronze", icon: "⌁", cat: "app", test: c => c.bios },
  { key: "cover", title: "Art Director", desc: "Choose a game's cover yourself.", tier: "bronze", icon: "▨", cat: "app", test: c => !!c.events.cover },
  { key: "rename", title: "Name Tag", desc: "Rename a game.", tier: "bronze", icon: "✐", cat: "app", test: c => !!c.events.rename },
  { key: "tidy", title: "Tidy Up", desc: "Hide a game from your shelves.", tier: "bronze", icon: "◌", cat: "app", test: c => !!c.events.hide },
  { key: "rearrange", title: "Rearranged", desc: "Arrange your shelves by genre, decade or what you've played.", tier: "bronze", icon: "⇅", cat: "app", test: c => !!c.events.arrange },
  { key: "redecorate", title: "Redecorated", desc: "Change your shelves' wood or wall.", tier: "bronze", icon: "▤", cat: "app", test: c => !!c.events.theme },
  { key: "shutterbug", title: "Shutterbug", desc: "Save a recap, time card or trophy shelf as a picture.", tier: "bronze", icon: "▣", cat: "app", test: c => !!c.events.picture },
  { key: "lookback", title: "Looking Back", desc: "Look at a recap of your play.", tier: "bronze", icon: "↺", cat: "app", test: c => !!c.events.recap },
  { key: "speedset", title: "Speed Setter", desc: "Choose how fast fast-forward goes.", tier: "bronze", icon: "≫", cat: "app", test: c => !!c.events.ffspeed },
  { key: "lookout", title: "On the Lookout", desc: "Watch a folder of games.", tier: "bronze", icon: "◎", cat: "app", test: c => !!c.events.watch },
  { key: "inventory", title: "Inventory", desc: "Save the list of your games.", tier: "bronze", icon: "☰", cat: "app", test: c => !!c.events.export },
  { key: "clouds", title: "Head in the Clouds", desc: "Keep your saves in a cloud folder.", tier: "bronze", icon: "☁", cat: "app", test: c => !!c.events.cloud },
  { key: "polyglot", title: "Polyglot", desc: "Choose a language in Settings.", tier: "bronze", icon: "¿", cat: "app", test: c => !!c.events.lang },
];

const build = systems => [...STATIC, ...consolePins(systems), ...seriesPins()];

/**
 * What the tests read. games: [{id, system, year, genre}]; st: the saved state (time, plays, fav, shelves, sessions,
 * events); series: [{name, have, items: [{id}]}] from collections; extra: {bios: bool, now: unix seconds}.
 */
/** the largest of many numbers (0 for none): a loop, as spreading a very long list into Math.max overflows the stack */
const most0 = list => { let m = 0; for (const v of list) if (v > m) m = v; return m; };
function context(games, st, series, genreOf, extra = {}) {
  const byId = new Map(games.map(g => [g.id, g]));
  // played means for at least a few seconds: a game that closed straight away (no BIOS, a bad file) doesn't count
  const played = new Set(games.filter(g => (st.time[g.id] || 0) >= 10).map(g => g.id));
  const pg = [...played].map(id => byId.get(id));
  const times = games.map(g => st.time[g.id] || 0);
  const sessions = (st.sessions || []).slice().sort((a, b) => a[1] - b[1]);
  // days in a row, sittings and games per day, weekends, the hour each sitting started, gaps between sittings of one game
  const days = [...new Set(sessions.map(s => dayKey(s[1])))].map(k => new Date(Math.floor(k / 10000), Math.floor(k / 100) % 100, k % 100).getTime()).sort((a, b) => a - b);
  let best = days.length ? 1 : 0, run = 1;
  for (let i = 1; i < days.length; i++) { run = Math.round((days[i] - days[i - 1]) / (DAY * 1000)) === 1 ? run + 1 : 1; best = Math.max(best, run); }
  const perDay = new Map(), gamesPerDay = new Map(), daysPerGame = new Map(), weekendTime = new Map();
  for (const [id, start, dur] of sessions) {
    const k = dayKey(start), d = local(start), wd = d.getDay();
    perDay.set(k, (perDay.get(k) || 0) + 1);
    (gamesPerDay.get(k) || gamesPerDay.set(k, new Set()).get(k)).add(id);
    (daysPerGame.get(id) || daysPerGame.set(id, new Set()).get(id)).add(k);
    if (wd === 6 || wd === 0) { const sat = new Date(d); sat.setDate(d.getDate() - (wd === 0 ? 1 : 0)); const wk = dayKey(sat.getTime() / 1000); weekendTime.set(wk, (weekendTime.get(wk) || 0) + dur); }
  }
  const daySet = new Set(perDay.keys());
  const weekend = sessions.some(s => { const d = local(s[1]); if (d.getDay() !== 6) return false; const n = new Date(d); n.setDate(n.getDate() + 1); return daySet.has(dayKey(n.getTime() / 1000)); });
  // most different games in any 7 days running
  let maxWeek = 0;
  for (let i = 0, j = 0; i < sessions.length; i++) {
    while (sessions[i][1] - sessions[j][1] >= 7 * DAY) j++;
    maxWeek = Math.max(maxWeek, new Set(sessions.slice(j, i + 1).map(s => s[0])).size);
  }
  const lastOf = new Map(); let comeback = false;
  for (const [id, start, dur] of sessions) {
    if (lastOf.has(id) && start - lastOf.get(id) >= 182 * DAY) comeback = true;
    lastOf.set(id, start + dur);
  }
  const at = fn => sessions.some(s => fn(local(s[1])));
  const years = pg.map(g => parseInt(g.year, 10)).filter(Boolean);
  const perSystem = new Map();
  for (const g of games) {
    const p = perSystem.get(g.system) || perSystem.set(g.system, { played: 0, time: 0 }).get(g.system);
    if (played.has(g.id)) p.played++;
    p.time += st.time[g.id] || 0;
  }
  // what you marked, for games still on the shelves
  const marked = (obj, fn) => Object.entries(obj || {}).filter(([id, v]) => byId.has(id) && fn(v)).length;
  const genreCount = new Map(); for (const g of pg) { const k = genreOf(g.genre || ""); if (k) genreCount.set(k, (genreCount.get(k) || 0) + 1); }
  return {
    games, played, favs: (st.fav || []).filter(id => byId.has(id)).length, shelves: st.shelves || [],
    wanted: (st.shelves || []).reduce((n, s) => n + ((s.wanted || []).length), 0),
    total: times.reduce((a, b) => a + b, 0), most: most0(times),
    sittings: sessions.map(s => s[2]), starts: sessions.map(s => local(s[1]).getHours()),
    bestStreak: best, maxPerDay: most0(perDay.values()), maxGamesPerDay: most0([...gamesPerDay.values()].map(s => s.size)),
    maxGamesPerWeek: maxWeek, mostDaysOneGame: most0([...daysPerGame.values()].map(s => s.size)),
    weekend, bestWeekend: most0(weekendTime.values()), comeback,
    lunch: at(d => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 12 && d.getHours() < 14),
    friday: at(d => d.getDay() === 5 && d.getHours() >= 19),
    sundayMorning: at(d => d.getDay() === 0 && d.getHours() >= 8 && d.getHours() < 12),
    newYear: sessions.some(([, start, dur]) => { const d = local(start), e = local(start + dur); return (d.getMonth() === 11 && d.getDate() === 31 && (e.getFullYear() > d.getFullYear() || d.getHours() >= 23)) || (d.getMonth() === 0 && d.getDate() === 1 && d.getHours() < 1); }),
    on: (month, date) => at(d => d.getMonth() === month && d.getDate() === date),
    systems: new Set(games.map(g => g.system)), playedSystems: new Set(pg.map(g => g.system)), perSystem,
    playedYears: years, playedDecades: new Set(years.map(y => Math.floor(y / 10))), thisYear: local(extra.now || Date.now() / 1000).getFullYear(),
    playedGenres: new Set(genreCount.keys()), mostInGenre: most0(genreCount.values()),
    beaten: marked(st.progress, v => v === "beaten" || v === "complete"), complete: marked(st.progress, v => v === "complete"),
    backlog: marked(st.progress, v => v === "backlog"), rated: marked(st.rating, v => v > 0), noted: marked(st.notes, v => !!String(v || "").trim()),
    // a series counts its games marked as counting (all of them, unless some were marked otherwise)
    completeSeries: series.filter(s => (s.total ?? s.items.length) >= 3 && s.have === (s.total ?? s.items.length)).length,
    seriesPlayed: series.filter(s => s.items.some(i => i.id && played.has(i.id))).length,
    seriesByName: new Map(series.map(s => [s.name, { have: s.have, total: s.total ?? s.items.length }])),
    events: st.events || {}, bios: !!extra.bios,
  };
}

/** every pin with whether it's earned, whether it's on the board, and for ones that build up, how far along it is */
function evaluate(ctx, systems) {
  return build(systems || [...ctx.systems]).map(p => {
    const r = p.test(ctx), earned = Array.isArray(r) ? r[0] >= r[1] : !!r;
    return { key: p.key, earned, shown: earned || !p.show || !!p.show(ctx), progress: Array.isArray(r) ? [Math.min(r[0], r[1]), r[1]] : null };
  });
}

/** the pins as the shelf shows them (without their tests), and the groups they're in */
const catalog = systems => build(systems).map(({ test, show, ...p }) => p);

const PINS = STATIC;
module.exports = { PINS, CATS, build, context, evaluate, catalog, genreGroup, GENRES };

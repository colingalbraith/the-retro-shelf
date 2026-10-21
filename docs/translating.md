# Helping with translations

The Retro Shelf comes in twelve languages. Apart from English they're first drafts, and nobody who speaks them
natively has read them all yet. If something reads oddly, you can fix it, and every fix helps everyone who plays in
that language.

## The quick way: tell us

In the app, Settings → App → Language → **Suggest better words** opens a page on GitHub. Say what the app shows,
where, and what it should say instead. That's all.

## The direct way: change the words yourself

Each language is one file in [`src/words`](../src/words), named after the language: `de.json` is German, `pl.json`
Polish, `zh-Hant.json` Traditional Chinese, and so on. Every line pairs the English with its translation:

```json
"Turn the box over": "Schachtel umdrehen",
```

To change one:

1. Open the language's file on GitHub and click the pencil (✏️) to edit it. GitHub makes you a copy if you need one.
2. Change the words on the right. Leave the English on the left exactly as it is.
3. Click **Commit changes**, then **Propose changes**, and open the pull request. We'll check it and put it in the
   next version.

A few things to keep:

- **Blanks in braces** like `{n}`, `{title}` or `{console}` are filled in by the app (a number, a game's name). Keep
  each one, spelled the same, but put it wherever your language wants it.
- **Names stay as they are:** The Retro Shelf, RetroArch, RetroAchievements, console names (NES, Game Boy,
  PlayStation), key names (Esc, Enter) and button symbols (✕ ○ □ △).
- **Words after a number:** some short entries, like `"games"` or `"files"`, are what the app writes after a count
  ("3 games"). Languages with more than one plural form list the others separately: in Polish, `"games"` is the form
  for 5 games (`gier`) and `"games|few"` the one for 2–4 (`gry`).
- **Keep it short.** Buttons and labels are narrow, and the plain word is usually the best one.

## Checking your change

If you'd like to try it first: install [Node.js 22](https://nodejs.org), then in the project folder run

```sh
npm install
npm test
```

The tests check that every piece of English has words in each language and that the blanks in braces match. To see
the app in your language, `npm start`, then Settings → App → Language.

## A new language

Open an [issue](https://github.com/colingalbraith/the-retro-shelf/issues) saying which language you'd like to
translate. We'll add it to the app's list of languages and start you off with a file of the English to work
through.

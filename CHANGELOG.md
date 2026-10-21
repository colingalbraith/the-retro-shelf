# Changelog

## 0.4.2

- **Fast-forward your way:** a speed for one game of its own, in its options or right-click menu, and Settings →
  While you play → Fast-forward on the trigger: hold it, or press it once to switch fast-forward on and again to switch
  it off.
- **Sort by most played,** in Settings → Shelves.
- **More looks:** cherry wood and shelves painted black, and deep green and blue walls.
- **A list of your games:** Settings → Library → A list of your games saves every game with its console, year,
  progress, rating and time played, as a spreadsheet file for Excel, Numbers or Google Sheets.
- **Open when the computer starts:** Settings → App, for a computer hooked up to a TV (in TV mode if that's on).
- **Eight new pins** for making the app yours: redecorating, saving a picture, looking at a recap, choosing a
  fast-forward speed, watching a folder, saving your list, keeping saves in a cloud folder and choosing a language.
  216 in all.
- **More of the app in every language:** the corkboard's headings, the genre shelves' names and some pins were still
  in English everywhere.

## 0.4.1

- **Two more languages (beta):** Polski and 繁體中文 (Traditional Chinese). Computers set to Traditional Chinese
  (Taiwan, Hong Kong, Macau) now get it by themselves instead of English. Polish letters like ą, ł and ś show in the
  app's own font.
- **Help with translations:** docs/translating.md says how to fix the words in any language, straight on GitHub.

## 0.4.0

- **Linux and Steam Deck:** an AppImage for 64-bit Linux with every emulator built in, that updates itself. On a
  Steam Deck it works in Game Mode with the Deck's own controls (see docs/steam-deck.md).
- **17 more consoles, 33 in all:** Game Gear on its own shelf, SG-1000, Sega CD, 32X, Saturn, Atari 7800 and Lynx,
  ColecoVision, Intellivision, Vectrex, MSX, 3DO, Neo Geo CD and Pocket, WonderSwan, Virtual Boy and Pokémon Mini.
  MSX runs on C-BIOS, a free BIOS that comes with the app.
- **Rewind and fast-forward:** hold the left trigger to go back a few seconds, the right one to speed up (2× to as
  fast as it goes), on 8- and 16-bit consoles and Game Boy. Those games also answer the controller a frame sooner.
- **The look of each console:** an old TV's scanlines for home consoles and a handheld's screen for Game Boy, or
  choose a picture and screen shape for one game.
- **Your controller:** a test that lights up every button you press, your own button layout for each console, hints
  with your controller's own button names (✕ ○ □ △ or B A Y X), and player 1 and 2 shown when two are plugged in.
- **Games on several discs** are one box with a disc list, and discs can be changed while playing.
- **Progress, ratings and notes:** mark a game backlog, playing, beaten or 100%, give it stars, and write on the back
  of its box. Shelves by progress, a Top rated shelf, and new pins for finishing games: 208 pins in all.
- **Watched folders:** games in a folder of yours show on the shelves where they are, and new ones appear by
  themselves. Games in RetroArch's playlists can come in too.
- **Search that forgives spelling** and knows consoles, years, genres and progress ("snes rpg", "90s"). Pick several
  games to shelve, mark or hide at once, and Surprise me picks one you haven't played.
- **Saves:** each game's own saves with their pictures, a backup every week by itself, saves in iCloud Drive, Dropbox
  or OneDrive shared between computers, and moving all your games to another drive.
- **Cheats and RetroAchievements,** with a hardcore switch.
- **Recaps:** a card for any month or year of play, and the recap, time card and trophy shelf saved as pictures to
  share. Made on your computer; nothing is uploaded.
- **Look and sound:** shelf themes (walnut, oak or painted white wood; a dark or light wall), a screensaver in TV
  mode, menu music (five public-domain chiptunes), bigger text, and a sheet of every key and button (press ?).
- **Ten languages (beta):** Español, Français, Deutsch, Italiano, Português, Русский, 日本語, 한국어 and 简体中文,
  following your computer's language. "Suggest better words" in Settings says what reads oddly.
- **A portable Windows copy** that keeps everything in a folder beside it, for a USB stick.
- **Sturdier:** play history survives a crash, nothing of yours is ever deleted (replaced pictures go to the Trash),
  and a controller can't get stuck in a window that needs a mouse.

## 0.4.0-beta.15

- **Fast-forward speed:** Settings → While you play → Fast-forward speed: 2×, 3× (as before), 4× or Fastest, as fast
  as your computer can go. It's kept for every game. The sound now speeds up smoothly with the game instead of
  breaking up, and is off at Fastest.
- An Xbox Wireless Controller (Xbox Series and One, over Bluetooth) shows A B X Y in hints again, not PlayStation's
  ✕ ○ □ △.

## 0.4.0-beta.14

- **Four more languages (beta):** Italiano, Русский, 한국어 and 简体中文, in Settings → App → Language, or by
  themselves when your computer uses one of them. Like the others, these are first drafts: "Suggest better words"
  there says what reads oddly. Counting follows each language's own rules (in Russian, 1 игра, 2 игры, 5 игр).
- **Linux:** the AppImage opens on Ubuntu 22.04 and later and other systems that don't come with the old libfuse2 it
  used to need: it now carries that part itself.
- **Rewind and fast-forward on the triggers, with every controller:** each controller's own triggers are used,
  whatever they are on it. On Linux and the Steam Deck the left trigger now rewinds (pushing the right stick down did),
  and a PlayStation controller on Windows gets its triggers right.

## 0.4.0-beta.13

A careful look for bugs, and their fixes. Among them:
- **Your play history is safer:** a settings file cut short by a crash is set aside and the copy before it used,
  instead of starting over empty. Changing the games folder in Settings keeps every game's history.
- **Backups:** saves kept in a cloud folder now restore properly, single-game exports can be restored, and a backup
  folder inside the saves folder isn't allowed. Hand-made backups aren't pruned with the weekly ones.
- **Nothing of yours is deleted:** a new cover sends the old picture to the Trash, a dropped BIOS file never replaces
  a good one, cheat files made in RetroArch stay, and folders you put in the BIOS folder are left alone.
- **On Windows,** moving the games to another drive works (it was refused).
- **Games:** a game that closes within a second no longer leaves "Inserting cartridge…" on screen; a second press
  can't start two games; play time can't jump when the clock changes; a game left open overnight counts 12 hours at
  most; the RetroAchievements password leaves RetroArch's settings seconds after the game starts.
- **Importing:** track files are matched whatever their letter case; arcade sets, zipped games, PS1 and PS2 discs and
  PSP and PS2 compressed images are told apart; empty files and discs with missing tracks aren't added.
- **Controllers and keyboard:** Stop game can be reached, Esc and B close the panel on top, Tab stays in it, Enter in
  a note no longer starts the game, and windows that need a mouse say so instead of leaving a controller stuck.
- **Updates:** a full disk doesn't freeze the updater, Restart closes the game first, and the Linux AppImage keeps one
  name so Steam shortcuts keep working.

## 0.4.0-beta.12

- **Menu music, for real:** five chiptunes by Juhani Junkala, Aureolus_Omicron and johndekale, which their makers
  gave to the public domain (CC0), in place of the tunes the app made up. Shuffled, each looping for a minute or so
  and fading into the next, all at the same loudness. Settings → App → Menu music, with "Next track"; still off at
  first. The Licenses page credits each one.

## 0.4.0-beta.11

- **Linux:** an AppImage for 64-bit Linux, with RetroArch and every console's emulator built in, that updates itself
  like the Mac and Windows versions. GameCube and Wii need a recent Linux (like Ubuntu 24.04 or SteamOS).
- **Steam Deck:** checked in TV mode at the Deck's screen size, and a short guide to adding it to Game Mode
  (docs/steam-deck.md).
- **Portable Windows copy:** unzip it anywhere, like a USB stick: games, saves and settings stay in the Data folder
  beside it. It tells you when a new version is out rather than installing it.
- When a game closes straight away, Settings → Copy info now includes how the emulator ended, for bug reports.

## 0.4.0-beta.10

- **Five more languages (beta):** Español, Français, Deutsch, Português and 日本語. The app follows your computer's
  language, or choose one in Settings → App → Language. These are first drafts; "Suggest better words" there opens a
  page to tell us what reads oddly. Dates and numbers follow the language too.
- **Text size:** 100%, 115% or 130%, in Settings → App, on top of TV mode's bigger view.
- **Screen readers** hear each box as its name, console, year and when you last played it, and pins by their tier.
- **Pins differ in shape, not only color:** bronze ones are round, silver ones eight-sided with a double rim, gold ones
  a twelve-pointed seal.
- Stronger outlines show where you are when using the keyboard.

## 0.4.0-beta.9

- **Shelf themes:** Settings → Shelves → Wood (walnut, oak or painted white) and Wall (dark or light).
- **Screensaver:** in TV mode, after 5 minutes with nothing pressed, the shelves drift slowly and pictures from your
  games fade through. Any button wakes it, and it never comes on during a game. Settings → App → Screensaver.
- **Buttons and keys:** press ? (or choose Buttons and keys in a game's options, or Help) for every key and controller
  button on one sheet, with your controller's own button names.
- **Menu music:** little chiptunes the app makes up as it plays them, so there's no recording to license. Off at
  first: Settings → App → Menu music, with a volume and "Another tune". They stop while you play.
- Sort by rating is remembered after a restart.
- The options menu scrolls when the window is short, so its last items can be reached.

## 0.4.0-beta.8

- **Recaps:** a card for any month or year of play: time played, sittings, days, games (and how many were new), your
  most played, the longest sitting, the busiest day and the pins you earned. Last month's is offered once when a new
  month starts (in January, the whole last year). Your play → Recap.
- **Save as a picture:** the recap, the time card and the trophy shelf, saved as a PNG to share anywhere. Made on your
  computer; nothing is uploaded. With a controller, pictures go straight into Pictures → The Retro Shelf.
- **New pins** for finishing games (beaten, 100%), your backlog, ratings and notes.
- **What counts in a series:** in Collections, mark a game in a series as not counting (an odd regional release, a
  spin-off) so having them all is fair.

## 0.4.0-beta.7

- **Controller test:** Settings → Playing → Your controller → Test. A drawing of the controller lights up as you
  press, sticks included, to see that every button works.
- **Change buttons:** for each console, choose which of your controller's buttons does each of the console's (say,
  Genesis A, B and C, or PlayStation ✕ ○ □ △). It's for all that console's games, and "Put back" undoes it.
- **Buttons by their real names:** a PlayStation controller's hints say ✕ ○ □ △, a Nintendo one's B A Y X.
- **Player 1, player 2:** with more than one controller, the playing screen says whose is which, and the game
  numbers the players the same way.
- **Set up with only a controller:** "Add games" and "Watch a folder" open the app's own folder browser when you use
  a controller, so a couch setup never needs a mouse.
- Reopening a list no longer shows the last list's rows above it, and closing a list opened from Settings goes back
  to Settings.

## 0.4.0-beta.6

- **Saves for each game:** in its options or on the back of its box. See its own save, where you left off and the
  numbered saves with their pictures; start from any of them, export them, or move one to the Trash.
- **Back up by itself:** every week, a backup of all your saves in a folder you choose, keeping the last five.
- **Saves on more than one computer:** put them in an iCloud Drive, Dropbox or OneDrive folder and point your other
  computers at it. If a game is open on another computer, you're told before playing it here.
- **Move the games to another drive:** every game copied and checked, play history kept, and the old copy goes to the
  Trash only if you say.

## 0.4.0-beta.5

- **Progress, ratings and notes:** mark a game backlog, playing, beaten or 100%, give it one to five stars, and write
  a note on the back of its box. Arrange the shelves by progress, sort by rating, and see a Top rated shelf.
- **Watched folders:** Settings → Library → Watch a folder. Games there show on the shelves where they are, without
  being copied, and new ones appear by themselves. When a file could be for more than one console, you choose.
- **Games from RetroArch:** if RetroArch is installed with playlists, Settings offers to bring those games in.
- **Search** forgives spelling ("zelad" finds Zelda) and understands consoles, years, decades, genres and progress:
  try "snes rpg" or "90s".
- **Pick several games** with ⌘/Ctrl-click (or X) to put them on a shelf, set their progress or hide them at once.
- **Surprise me** (R, or in the options) picks a game you haven't played.
- **The same game twice:** Settings lists games you have more than one copy of, to keep one. Hidden games have a list
  too, to bring them back.

## 0.4.0-beta.4

- **Eight more consoles:** Atari 7800, ColecoVision, Intellivision, Vectrex, MSX, 3DO, Neo Geo CD and Pokémon Mini.
  MSX games run on C-BIOS, a free MSX BIOS that comes with the app. ColecoVision, Intellivision and 3DO need a BIOS
  from your own console.
- Dropped 3DO discs are recognized by what's on them.

## 0.4.0-beta.3

- **Nine more consoles:** Game Gear (now its own shelf; Game Gear games move there by themselves), SG-1000, Sega CD,
  32X, Saturn, Neo Geo Pocket, Atari Lynx, WonderSwan and Virtual Boy, with box art, box styles and their own pins.
  Sega CD and Saturn need a BIOS from your own console.
- Dropped Sega CD and Saturn discs are recognized by what's on them.
- Games whose names start with a dot (.hack) no longer go missing from the shelf.

## 0.4.0-beta.2

- **Handheld screen look:** Settings → Playing → Picture → By console gives home consoles an old TV's scanlines and
  Game Boy and GBA a handheld's screen. New installs start on it; your current choice stays.
- **Picture and screen shape for one game:** in its options or right-click menu (4:3, pixel-perfect, stretch).
- **Rewind and fast-forward:** hold the left trigger (or R) to go back a few seconds, the right trigger (or L) to
  speed up, on 8- and 16-bit consoles and Game Boy.
- **Less lag** on the same consoles: games answer the controller a frame sooner.
- **Cheats:** libretro's cheat lists for each game, ticked on from its options. The lists download the first time.
- **RetroAchievements:** sign in under Settings → Your play, with a hardcore switch.
- **Games on several discs** get a disc list: one box, one memory card, and the discs can be changed while playing.

## 0.4.0-beta.1

- **The first test version of 0.4.0.** Nothing new to see yet: it checks that test versions reach you, and lays the
  groundwork for what's coming (more consoles, settings for each game, and more languages).

## 0.3.1

- **Test versions:** Settings → App → Get test versions, to try new features early.
- **Clearer messages** when a game won't start: which BIOS file it needs, a game zipped in a way its emulator can't
  read, or an emulator that crashed.
- Box backs no longer let the picture cover the text, and a blank "where you left off" picture gives way to the
  game's screenshot.

## 0.3.0

- **Collections:** every series your games belong to, with the games you don't have standing faded, and collections
  of your own that can hold games you want.
- **Your play:** a trophy shelf of your most played games, a time card stamped with the days you played, and a
  corkboard of 147 pins earned from how you play: time, habits, days and nights, variety, collecting, every console
  and famous series. No account; nothing leaves your computer.
- **Shelves your way:** arrange by console, genre, decade or what you've played, a "Just added" shelf, shelves of your
  own, and sorting by title, year or last played.
- **TV mode:** fullscreen and bigger, and everything works from a controller: an options menu on Select, the d-pad in
  every screen, and an on-screen keyboard.
- **CRT picture** setting: sharp pixels, smoothed, or old-TV scanlines.
- **Find Cover:** search for the right box art when the automatic one is wrong.
- **Saves:** back them all up to one file and restore them. A BIOS checker shows what each console has.
- **Smoother with big libraries** (tested with 1,500 games), and PSP games get the system files they were missing.
- **Bug report info:** Settings → Copy info.

## 0.2.0

- The app updates itself.
- Separate, smaller Mac downloads for Apple silicon and Intel.

## 0.1.0

- First release.

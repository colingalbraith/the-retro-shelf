<p align="center">
  <img src="docs/images/icon.png" width="112" alt="">
</p>

<h1 align="center">The Retro Shelf</h1>

<p align="center">
  Your retro game collection as real boxes on a shelf.<br>
  Emulators built in. Games not included.<br>
  <a href="https://colingalbraith.github.io/the-retro-shelf/"><b>Download it from the website</b></a>
</p>

<p align="center">
  <a href="https://github.com/colingalbraith/the-retro-shelf/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/colingalbraith/the-retro-shelf?include_prereleases&sort=semver&label=release&color=e2582b"></a>
  <a href="https://github.com/colingalbraith/the-retro-shelf/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/colingalbraith/the-retro-shelf/total?color=e2582b"></a>
  <a href="https://github.com/colingalbraith/the-retro-shelf/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/colingalbraith/the-retro-shelf/test.yml?branch=main&label=tests"></a>
  <img alt="macOS, Windows and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555">
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/github/license/colingalbraith/the-retro-shelf?color=555"></a>
  <a href="https://github.com/colingalbraith/the-retro-shelf/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/colingalbraith/the-retro-shelf?style=social"></a>
</p>

<p align="center">
  <img src="docs/images/demo.gif" width="840" alt="Moving along the shelf: boxes slide out when picked, turn over to show play history, and each console's games stand spines-out on their own shelf">
</p>

Drag your games onto the window and they land on the right shelf with their box art, ready to play with a
keyboard or controller. RetroArch and its cores come inside the app, so there's nothing else to set up.

## Features

- **A real shelf:** every console has its own box style, with spine art and logos from the game's cover. Walnut, oak
  or painted white wood, on a dark or light wall.
- **Pull a box out to play,** or turn it over to see last played, playtime, your saves and a note of your own.
- **Drag-and-drop import** that works out which console each file is for, or **watch a folder** and new games appear
  by themselves.
- **Pick up where you left off:** leaving a game saves your spot, and each game's saves are listed with pictures.
- **Rewind and fast-forward** on the triggers, and a frame less lag, on 8- and 16-bit consoles and Game Boy.
- **The right look for each console:** an old TV's scanlines, a handheld's screen, or sharp pixels.
- **Art and details are automatic:** covers, logos, year, publisher and genre for 38,000+ games. Wrong cover? Pick
  the right one from a list.
- **Shelves your way:** arrange by console, genre, decade or progress; make your own like "Couch co-op"; sort by
  title, year, last played or rating. Search forgives spelling: try "snes rpg" or "90s".
- **Collections:** every series your games belong to, with the ones you don't have yet standing faded, and wishlists
  of your own.
- **Your play:** mark games backlog, playing, beaten or 100% and give them stars. A trophy shelf, a time card, monthly
  and yearly recaps to save as pictures, and 208 pins to earn, no account needed.
- **TV mode and Steam Deck:** fullscreen and bigger, everything works from a controller, with an on-screen keyboard
  and a screensaver.
- **Controllers just work:** Xbox, PlayStation, Switch Pro and more, with a button test, your own layout for each
  console, and two players numbered on screen.
- **Saves are safe:** a backup every week by itself, saves shared between computers through iCloud Drive, Dropbox or
  OneDrive, and the BIOS files each console has.
- **Extras:** cheats, RetroAchievements, games on several discs, and menu music.
- **Ten languages:** English, plus Español, Français, Deutsch, Italiano, Português, Русский, 日本語, 한국어 and 简体中文
  (drafts, in beta). Text size and screen reader labels too.
- **Updates itself** in the background.
- **Private:** no account, no tracking.

<table>
  <tr>
    <td width="50%"><img src="docs/images/selected.jpg" alt="A selected game pulled out of the shelf"></td>
    <td width="50%"><img src="docs/images/back.jpg" alt="The back of a box: last played, playtime and a screenshot"></td>
  </tr>
  <tr>
    <td width="60%"><img src="docs/images/your-play.jpg" alt="Your play: the five most played games face-out on a shelf with brass plates showing their hours"></td>
    <td width="40%"><img src="docs/images/time-card.jpg" alt="A paper time card: hours this month, days in a row, and twelve weeks of days stamped in ink"></td>
  </tr>
  <tr>
    <td width="55%"><img src="docs/images/collections.jpg" alt="Collections: the Legend of Zelda and Mario Kart series on shelves, with the games not in the library standing faded"></td>
    <td width="45%"><img src="docs/images/pins.jpg" alt="The corkboard of pins: round bronze and eight-sided silver pins earned for playing, and faded ones still to earn with progress bars"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/recap.jpg" alt="A month's recap card: hours played, sittings, days, the most played games, the longest sitting and the pins earned"></td>
    <td width="50%"><img src="docs/images/controller-test.jpg" alt="The controller test: a drawing of an Xbox controller with the A button lit up as it's pressed"></td>
  </tr>
</table>

## Download

The easiest way is the [website](https://colingalbraith.github.io/the-retro-shelf/): its button picks the right file for your computer. Or grab one from [Releases](https://github.com/colingalbraith/the-retro-shelf/releases):

- **Mac with Apple silicon** (M1 and newer): `mac-arm64.dmg`. **Mac with Intel**: `mac-x64.dmg`. Open it and drag
  The Retro Shelf into Applications. Not sure which Mac you have? Apple menu → About This Mac: "Chip" means
  Apple silicon, "Processor" means Intel.
- **Windows** 10 and 11: run the `Setup .exe`. Or, to keep everything on a USB stick, unzip `portable-win.zip`
  and open The Retro Shelf in it: games, saves and settings stay in its Data folder.
- **Linux** (64-bit, including Steam Deck): `linux-x86_64.AppImage`. Make it runnable (right-click → Properties →
  Allow executing, or `chmod +x` it) and open it. On a Steam Deck, see [Steam Deck](docs/steam-deck.md).

After that it updates itself (the portable copy tells you when there's a new version instead).

The app isn't signed by Apple or Microsoft, so the first launch needs an extra step. After that it opens normally,
updates included.

**Mac:**
1. Open The Retro Shelf from Applications. macOS says it can't check the app; click **Done**.
2. Open **System Settings → Privacy & Security** and scroll down to **Security**. Next to "The Retro Shelf was
   blocked to protect your Mac", click **Open Anyway** and confirm with your password or Touch ID.
3. Click **Open Anyway** once more when asked.

**Windows:** if a blue "Windows protected your PC" box appears, click **More info**, then **Run anyway**.

> [!NOTE]
> Something not working? [Bug reports](https://github.com/colingalbraith/the-retro-shelf/issues) are welcome:
> Settings → App → Copy info adds what helps track it down.

## Getting games

No games are included, and the app doesn't link to sites that hand out commercial games. Instead you can copy
cartridges and discs you own, play free homebrew, or buy official re-releases. The app has a guide to all of
these under **Help → Where to Get Games**.

## Supported consoles

33 of them: NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Genesis / Mega Drive, Sega CD, 32X, Saturn,
Master System, Game Gear, SG-1000, PC Engine, Atari 2600, 7800 and Lynx, ColecoVision, Intellivision, Vectrex, MSX,
N64, DS, PlayStation, PSP, Dreamcast, GameCube, Wii, 3DO, Neo Geo CD and Pocket, WonderSwan, Virtual Boy,
Pokémon Mini and Arcade. Their emulators come with the app; PlayStation 2 works with PCSX2 installed separately.

<details>
<summary>Which emulator runs each one</summary>

| Console | Emulator | BIOS file |
| --- | --- | --- |
| NES | FCEUmm | Not needed |
| SNES | Snes9x | Not needed |
| Game Boy, Game Boy Color | Gambatte | Not needed |
| Game Boy Advance | mGBA | Not needed |
| Genesis / Mega Drive, Master System, Game Gear, SG-1000 | Genesis Plus GX | Not needed |
| Sega CD / Mega-CD | Genesis Plus GX | Required |
| 32X | PicoDrive | Not needed |
| PC Engine / TurboGrafx-16 | Beetle PCE Fast | Only for CD games |
| Atari 2600 | Stella | Not needed |
| Atari 7800 | ProSystem | Optional |
| Atari Lynx | Handy | Optional |
| ColecoVision | Gearcoleco | Required |
| Intellivision | FreeIntv | Required |
| Vectrex | vecx | Not needed |
| MSX, MSX2 | blueMSX | Not needed (the free C-BIOS comes with the app) |
| Nintendo 64 | Mupen64Plus-Next | Not needed |
| PlayStation | PCSX ReARMed | Optional, improves compatibility |
| Saturn | YabaSanshiro | Required |
| 3DO | Opera | Required |
| Neo Geo CD | NeoCD | Optional |
| Dreamcast | Flycast | Optional |
| Nintendo DS | melonDS DS | Optional |
| PSP | PPSSPP | Not needed |
| Neo Geo Pocket, Neo Geo Pocket Color | Beetle NeoPop | Not needed |
| WonderSwan, WonderSwan Color | Beetle WonderSwan | Not needed |
| Virtual Boy | Beetle VB | Not needed |
| Pokémon Mini | PokeMini | Optional |
| GameCube, Wii | Dolphin | Not needed |
| Arcade | FinalBurn Neo | Not needed (romsets named like `sf2.zip`) |
| PlayStation 2 | PCSX2, installed separately | Required |

All of them run inside [RetroArch](https://www.retroarch.com), which comes with the app. BIOS files are copied from
your own console: drop them on the window and they go in the right place. Settings → Saves & BIOS shows what each
console has.

</details>

## Controls

| Keyboard | Controller | |
| --- | --- | --- |
| Arrows | D-pad | Browse |
| Enter | A | Play |
| Space | Y | Turn box over |
| F | X | Favorite |
| Esc | B | Back |
| ? | Select → Buttons and keys | Every key and button |

In a game, hold **Start** or press **Esc** to return to the shelf. On 8- and 16-bit consoles and Game Boy, hold the
**left trigger** (or R) to rewind and the **right trigger** (or L) to fast-forward; Space keeps fast-forward on.

## Build from source

You need [Node.js 22](https://nodejs.org).

```sh
npm install
npm run fetch:mac   # or fetch:win or fetch:linux: downloads RetroArch and the cores
npm start
npm test
npm run dist:mac    # or dist:win or dist:linux
```

Pushing a `v*` tag builds the installers in GitHub Actions and attaches them to a draft release. Publishing it is
what the app's updater picks up.

## License

[GPL-3.0-or-later](LICENSE). The bundled RetroArch and cores keep their own licenses
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Some cores are non-commercial, so the app can't be sold.
Box art comes from libretro-thumbnails and belongs to its owners. This project isn't affiliated with any
console maker.

## Star history

<a href="https://star-history.com/#colingalbraith/the-retro-shelf&Date">
  <img alt="Star history chart" src="https://api.star-history.com/svg?repos=colingalbraith/the-retro-shelf&type=Date" width="600">
</a>

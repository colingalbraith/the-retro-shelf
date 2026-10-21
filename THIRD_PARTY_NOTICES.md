# Third-party software in The Retro Shelf

The Retro Shelf ships with these programs, downloaded unmodified from their official builds by
`scripts/fetch-emulators.mjs`. Each keeps its own license. The Retro Shelf includes no games, BIOS files or other
copyrighted game content.

## RetroArch 1.22.2

GNU General Public License v3. © libretro team.
Source: https://github.com/libretro/RetroArch/tree/v1.22.2
Binaries: https://buildbot.libretro.com/stable/1.22.2/

The macOS copy is re-signed ad hoc so it can run inside the app, and unused extras (game database,
shaders, overlays, alternate menu themes) are left out. No code is changed.

The Linux copy is libretro's AppImage, unpacked. It carries the libraries libretro bundled with it (among them SDL2,
PulseAudio's client library, libsndfile, FLAC, Ogg and Vorbis, libpng, libjpeg, the Wayland and X11 client libraries
and Boost), each under its own license (LGPL, BSD-style, zlib and MIT); they're listed in its usr/lib folder. Where
JACK isn't installed, RetroArch is given The Retro Shelf's own stand-in for JACK's library (scripts/linux/jack-stub.c,
GPL-3.0), which only fails every call.

## libretro cores

Nightly builds from https://buildbot.libretro.com/nightly/. Exact versions are listed in the app under
Settings → About → Licenses.

| System | Core | License | Source |
| --- | --- | --- | --- |
| NES | FCEUmm | GPLv2 | https://github.com/libretro/libretro-fceumm |
| SNES | Snes9x | **Non-commercial** | https://github.com/libretro/snes9x |
| Game Boy / Color | Gambatte | GPLv2 | https://github.com/libretro/gambatte-libretro |
| Game Boy Advance | mGBA | MPL 2.0 | https://github.com/libretro/mgba |
| Genesis, Sega CD, Master System, Game Gear, SG-1000 | Genesis Plus GX | **Non-commercial** | https://github.com/libretro/Genesis-Plus-GX |
| 32X | PicoDrive | **Non-commercial** (MAME license) | https://github.com/libretro/picodrive |
| PC Engine | Beetle PCE Fast | GPLv2 | https://github.com/libretro/beetle-pce-fast-libretro |
| Atari 2600 | Stella | GPLv2 | https://github.com/stella-emu/stella |
| Atari 7800 | ProSystem | GPLv2 | https://github.com/libretro/prosystem-libretro |
| Atari Lynx | Handy | zlib | https://github.com/libretro/libretro-handy |
| ColecoVision | Gearcoleco | GPLv3 | https://github.com/drhelius/Gearcoleco |
| Intellivision | FreeIntv | GPLv2+ | https://github.com/libretro/FreeIntv |
| Vectrex | vecx | GPLv3 | https://github.com/libretro/libretro-vecx |
| MSX | blueMSX | GPLv2 | https://github.com/libretro/blueMSX-libretro |
| N64 | Mupen64Plus-Next | GPLv2 | https://github.com/libretro/mupen64plus-libretro-nx |
| PlayStation | PCSX ReARMed | GPLv2 | https://github.com/libretro/pcsx_rearmed |
| Saturn | YabaSanshiro | GPLv2 | https://github.com/libretro/yabause |
| 3DO | Opera | **Non-commercial** (LGPL and non-commercial parts) | https://github.com/libretro/opera-libretro |
| Neo Geo CD | NeoCD | LGPLv3 | https://github.com/libretro/neocd_libretro |
| Dreamcast | Flycast | GPLv2 | https://github.com/flyinghead/flycast |
| DS | melonDS DS | GPLv3+ | https://github.com/JesseTG/melonds-ds |
| PSP | PPSSPP | GPLv2+ | https://github.com/hrydgard/ppsspp |
| Neo Geo Pocket (Color) | Beetle NeoPop | GPLv2 | https://github.com/libretro/beetle-ngp-libretro |
| WonderSwan (Color) | Beetle WonderSwan | GPLv2 | https://github.com/libretro/beetle-wswan-libretro |
| Virtual Boy | Beetle VB | GPLv2 | https://github.com/libretro/beetle-vb-libretro |
| Pokémon Mini | PokeMini | GPLv3 | https://github.com/libretro/PokeMini |
| Arcade | FinalBurn Neo | **Non-commercial** | https://github.com/libretro/FBNeo |
| GameCube / Wii | Dolphin | GPLv2+ | https://github.com/libretro/dolphin |

**Non-commercial** cores may be redistributed freely but not sold. The Retro Shelf must therefore be given away
for free. To sell it, replace them with GPL alternatives (bsnes for SNES, BlastEm for Genesis, MAME for
Arcade) and check every license again.

## Dolphin Sys folder

GNU General Public License v2 or later. From https://github.com/libretro/dolphin (`Data/Sys`).

## PPSSPP system files

Fonts, the on-screen dialog atlas and other data the PPSSPP core reads, from libretro's
https://buildbot.libretro.com/assets/system/PPSSPP.zip (the `assets` folder of https://github.com/hrydgard/ppsspp).
GNU General Public License v2 or later, with the notices in `PPSSPP/LICENSE.TXT`; the Roboto fonts are Apache 2.0
and Inconsolata is SIL Open Font License 1.1.

## zfast-crt shader

The CRT picture setting uses zfast-crt by Greg Hogan (SoltanGris42), from https://github.com/libretro/slang-shaders.
GNU General Public License v2 or later.

## Game details and series

Release years, genres, arcade game names and the series lists Collections use (`src/data/meta`,
`src/data/arcade-names.json`, `src/data/franchises.json`) are built from https://github.com/libretro/libretro-database
by the `scripts/fetch-*.mjs` scripts.
Creative Commons Attribution-ShareAlike 4.0 International; these files are shared under the same license.

## C-BIOS and blueMSX's databases

MSX games run on C-BIOS (https://cbios.sourceforge.net), a free MSX BIOS for cartridge games, under its BSD-style
license (in `blueMSX/Machines/*/cbios.txt`), with blueMSX's game databases. Both come from libretro's
`assets/system/blueMSX.zip`; the real MSX machines' firmware in that download is copyrighted and not included.

## Electron

MIT License. Electron bundles Chromium, Node.js and other components; their notices ship in the app as
`LICENSES.chromium.html` and `LICENSE.electron.txt`.

## AppImage runtime

The Linux AppImage starts with the AppImage project's runtime (https://github.com/AppImage/type2-runtime, MIT),
which carries libfuse (LGPL 2.1), squashfuse (BSD-style) and zstd (BSD) inside it, so it needs no libfuse2 from the
system.

## Menu music

From OpenGameArt, each given to the public domain by its maker (CC0 1.0,
https://creativecommons.org/publicdomain/zero/1.0/). Credited with thanks, though CC0 doesn't ask for it.

- “Stage Select” by Juhani Junkala, from Chiptune Adventures: https://opengameart.org/content/4-chiptunes-adventure
- “Title Screen” by Juhani Junkala, from 5 Chiptunes (Action): https://opengameart.org/content/5-chiptunes-action
- “forgotten path” by johndekale: https://opengameart.org/content/forgotten-path
- “Title Screen” by Aureolus_Omicron, from 15 Melodic RPG Chiptunes: https://opengameart.org/content/15-melodic-rpg-chiptunes
- “Town” by Aureolus_Omicron, from 15 Melodic RPG Chiptunes: https://opengameart.org/content/15-melodic-rpg-chiptunes

## IBM Plex

IBM Plex Sans Condensed and IBM Plex Mono, SIL Open Font License 1.1 (`src/fonts/OFL.txt`).

## GPL source availability

The GPL requires that whoever distributes these binaries also makes their source available. The links
above point to the upstream source. If you publish The Retro Shelf builds, keep this file with them, and consider
attaching the source archives for the exact versions to each release.

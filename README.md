# Zuujis game scripts

The small JavaScript libraries behind the Zuujis game starters. Each starter is one HTML file that plays with the keyboard, a gamepad, or touch, and fits phone screens upright and sideways. Plain browser scripts with no build step.

**[Download zuujis-game-scripts.zip](https://github.com/zuujis-cc0/free-game-assets/releases/download/v1.1.0/zuujis-game-scripts.zip)**: the scripts, the asset library they draw from, and fifteen ready-to-play starters. Unzip, serve the folder from the root of any static web server, and open it:

```sh
cd zuujis-game-scripts && python3 -m http.server 8000   # then open http://localhost:8000
```

The scripts ask for `/js/…` and `/assets/…` from the site root, so serve the folder as the root, not a subfolder.

This folder is the ZIP, file by file: [js/](js/) the scripts, [assets/](assets/) the asset library (each pack's details in `assets/manifest.json`), [starters/](starters/) the fifteen starters, and `index.html` the list of them.

## Scripts

| File | Global | What it does |
| --- | --- | --- |
| [game-assets.js](js/game-assets.js) | `GameAssets` | Loads art, sprite sheets and sounds from the asset library by name |
| [game-sfx.js](js/game-sfx.js) | `GameSfx` | Sound effects by meaning (`GameSfx.play('win')`), with a mute button that is remembered |
| [game-pad.js](js/game-pad.js) | `GamePad` | Maps gamepad buttons and sticks to the keys a game already reads, and reports analog sticks |
| [game-vision.js](js/game-vision.js) | `GameVision` | A painted isometric town to pan, zoom and tour, with seasons, day and night |
| [game-vision-3d.js](js/game-vision-3d.js) | `GameVision.create3d` | The same town in low-poly 3D (ES module, needs three.js) |
| [game-racing.js](js/game-racing.js) | `GameRacing` | Track themes and helpers for racing games |
| [game-fight.js](js/game-fight.js) | `Fight` | A 2D fighting engine driven by per-frame intents |
| [game-flight.js](js/game-flight.js) | `GameFlight` | Flight physics in SI units for 3D flight games |
| [three.module.min.js](js/three.module.min.js), [three-addons/](js/three-addons/) | | three.js r168, with the GLTF loader and orbit controls |

Each file starts with a comment that explains how to use it.

## Starters in the ZIP

Platformer, runner, top-down racing (three lanes), 3D racing, fighting, first person, flight, dungeon, match three, catch, a blank canvas, and four "vision" starters (explore and story, in 2D and 3D). Touch buttons show only on touch screens. Gamepad buttons send the same keys as the keyboard.

## Licences

- **The Zuujis scripts and starters** (every `game-*.js` file and `starters/`): [CC0 1.0](LICENSE). Credit is optional.
- **three.js**: MIT, © 2010-2024 three.js authors. Keep [three-LICENSE.txt](js/three-LICENSE.txt) with it.
- **The asset library** in the ZIP (`assets/`): each pack's licence is in `assets/manifest.json`. All are CC0 except the Instrument Sans font (SIL Open Font License 1.1). Packs named `kenney-…` are by Kenney (kenney.nl), CC0.

## Checking and rebuilding

- `python3 scripts/smoke.py` plays every starter in headless Firefox, at a desktop size and as a phone, and fails on a script error, a file that does not load, or a blank page. Standard library only; needs Firefox (`FIREFOX=/path/to/firefox` if it is not found).
- `scripts/build-game-scripts.sh <games-rs checkout>` rebuilds `js/`, `assets/`, `starters/` and `index.html` from the Zuujis games site's source, and writes `dist/zuujis-game-scripts.zip`.

Part of the [Zuujis free game assets](https://github.com/zuujis-cc0/free-game-assets).

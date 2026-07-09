# pz-icon-maker

Render Project Zomboid 3D item models into inventory icons that look like they belong in
the game. Point it at a mod, and it renders each item's model at the game's isometric
camera angle on a transparent background, then writes correctly named `Item_*.png` files.

It runs standalone. **No Project Zomboid instance, no Blender, no Python.**

- Interactive UI to preview and tune each icon, with live output at 32/64/128/256/512.
- Weapon **attachments**: render a bicycle decked out with wheels, chain, pedals, basket
  and crate, or a sidecar with an animal in it.
- Headless CLI to batch-render a whole mod.
- Renders straight into your mod, or into any folder for posters and promo art.

---

## Download and run

1. Grab `pz-icon-maker-<version>-win-x64.zip` from the
   [Releases](https://github.com/AlexVDefi/pz-icon-maker/releases) page and unzip it.
2. Run **`pz-icon-maker.exe`**. It asks you to pick a mod folder. Nothing to install.
3. Click **Game folder…** once and point it at your Project Zomboid install, so it can
   resolve the vanilla assets that mods reuse (see [Vanilla assets](#vanilla-assets)).

The same folder contains **`pz-icon-maker-cli.cmd`** for headless use.

## How it matches the game

The look is reverse-engineered from the game's own renderer, not eyeballed:

- **Camera** — orthographic, tilted 30 degrees and rotated 45 degrees: the same isometric
  framing the game uses when it shows an item model. The image is mirrored to match.
- **Shading** — flat ambient light plus a single directional key light, no specular and no
  shadows, exactly like the game's item shader. Texels below ~1% alpha are cut out, which
  gives a clean silhouette.
- **Handedness** — the game loads meshes into a left-handed coordinate space. Attachment
  offsets are converted accordingly, so parts land where the game would put them.
- **Framing** — the model is rendered with room to spare, then trimmed to the tight
  bounding box of its visible pixels and scaled to fill the canvas, edge to edge.

## Asset resolution

Assets are resolved from the mod's own item and model scripts, by path, exactly the way the
game resolves them. A model script's `mesh` and `texture` values are paths relative to
`media/`, so a mod is free to use whatever subfolders it likes:

```
mesh    = animals/Bicycle_Chicken   ->  media/models_x/animals/bicycle_chicken.fbx  (then .x)
texture = models_x_texture/Frame    ->  media/textures/models_x_texture/frame.png
```

Lookups are case-insensitive. Search order is the mod's own media roots first, then your
Project Zomboid install, so a mod always overrides vanilla. Nothing is matched by filename
alone, so two same-named meshes in different folders never collide.

Supported meshes: `.fbx`, `.glb`, and `.x` (converted automatically via a bundled
[assimp](https://github.com/assimp/assimp)).

### Vanilla assets

Mods routinely reuse vanilla textures and meshes. Tell the tool where the game is, once:

```
pz-icon-maker set-game-dir "D:/Games/Steam/steamapps/common/ProjectZomboid"
```

In the UI, the **Game folder…** button does the same thing. Either way it is saved to
`~/.pz-icon-maker.json` and used by every command and every launch. `--game-dir <path>`
overrides it for a single run. With nothing configured the tool auto-detects common Steam
locations; if exactly one install is found it uses it and says so, otherwise it asks you to
set it. Missing assets are always reported with the exact path expected, e.g.
`no texture media/textures/body/horsemod/horse_thoroughbredbay.png`.

Assets from other mods (a cross-mod part, say) can be resolved by adding their folder to
`defaults.extraRoots` in the config.

## The UI

Launch the app, or run `pz-icon-maker preview <modPath>`.

- **Preview** — the model renders live at the icon camera. Every enabled size is shown at
  true 1:1, over an adjustable solid backdrop so you can judge the icon on any background.
- **Adjust** — extra yaw/pitch/roll, padding, mirror, double-sided, downscale filter,
  ambient and key-light direction/brightness. Everything updates live.
- **Attachments** — for weapon items, one dropdown per attachment slot, plus Fit all /
  Clear all. Parts that cannot be resolved are hidden, with the reason available.
- **Save to config** — writes only the values you changed as a per-item override into the
  mod's `icons.config.json`, so a later batch reproduces exactly what you tuned.
- **Generate…** — renders this icon or all icons, at every enabled size, either into the
  mod's `media/textures/` as `Item_<icon>.png`, or into any folder as `<icon>_<size>.png`
  for posters and promo art. With a progress bar and a cancel button.

## Headless CLI

Use `pz-icon-maker-cli.cmd`, which sits next to the exe in the unzipped folder:

```bat
pz-icon-maker-cli set-game-dir "D:\Steam\steamapps\common\ProjectZomboid"
pz-icon-maker-cli build "C:\mods\MyMod" --write
pz-icon-maker-cli slots "C:\mods\MyMod" --item Bicycle
```

From a source checkout it is simply:

```
node src/cli.js build <modPath> [options]
```

### Commands

```
set-game-dir <path>            save your Project Zomboid install (for vanilla assets)
list    <modPath>              resolve items -> icons, show the mapping
slots   <modPath> [--item N]   list weapon attachment slots and their parts
init    <modPath>              write an icons.config.json stub
preview <modPath>              open the interactive UI
build   <modPath> [options]    render icons
```

### `build` options

```
--only a,b        only these icon names
--size N          render resolution in px (square)
--out-size N      output resolution in px (square)
--downscale K     nearest | lanczos3
--no-downscale    keep the render size
--skip-existing   skip icons whose PNG already exists in the mod
--out dir         output directory (default: ./pz-icon-maker-out/<modId>)
--write           write into <mod>/media/textures (overwrites)
--dry-run         list what would be written
--game-dir dir    PZ install for this run
--config file     use a specific icons.config.json
```

Output goes to a staging directory by default, so it never clobbers hand-made icons.
Use `--write` once you are happy.

**Headless still needs a desktop session.** Rendering uses the GPU through a hidden
window; this is "headless" in the sense of no game and no visible UI, not a
display-less server. On a machine without a GPU, try `--use-gl=swiftshader`.

## Config (`icons.config.json`)

Lives in the mod folder. `init` writes a stub. `defaults` applies to every icon; entries
under `items` override it per icon. The UI writes this file for you.

```json
{
  "defaults": { "downscale": "lanczos3", "padding": 0.03 },
  "items": {
    "SomeAxeIcon": { "extraRoll": 90 },
    "Bicycle2Icon": {
      "attachments": {
        "FrontWheel": "Bicycle_StreetWheelFrontItem",
        "RearWheel":  "Bicycle_StreetWheelRearItem",
        "Crate": "Bicycle_Crate"
      }
    }
  }
}
```

Useful keys: `downscale` (`nearest` is crisp but sparse on thin geometry; `lanczos3` is
smoother), `extraYaw`/`extraPitch`/`extraRoll`, `padding` (`0` = touch the edges), `mirror`,
`doubleSide`, `model` (force a model block), `item` (define a new icon name for an item that
shares a placeholder icon), `ambient`, `keyDir`, `keyColour`, `outSize`, `supersample`,
`extraRoots`.

## Weapon attachments

Weapon items list their parts, and the parent model declares an attachment point for each.
The tool reads both, so an item can be rendered fully assembled. `slots <modPath>` prints
every slot and the parts that fit it; the UI turns them into dropdowns.

A part is only placeable if the parent model declares the named attachment. Parts whose
mesh or texture cannot be found are reported as unavailable, with the exact path expected,
rather than silently skipped.

## Build from source

```
npm install                   # also vendors the three.js addons we use
npm start                     # the UI
node src/cli.js --help        # the CLI
npm run dist                  # Windows release zip -> dist/
```

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

This is an unofficial fan-made tool, not affiliated with or endorsed by The Indie Stone.
It ships no game assets; it reads from a mod folder and, optionally, from a Project Zomboid
installation you already own.

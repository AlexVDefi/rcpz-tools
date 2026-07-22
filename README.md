# rcpz-tools

Two standalone desktop tools for Project Zomboid modders and content creators.
**No Project Zomboid instance, no Blender, no Python.**

- **PZ Icon Maker** renders an item's 3D model into a correctly named `Item_*.png`
  inventory icon at the game's isometric camera, on a transparent background.
- **PZ Survivor Studio** assembles a full survivor (gender, skin, hair, beard,
  clothing, held weapons), plays any of the game's animation clips, and exports a
  still, a sprite sheet, or a looping GIF.

Both read straight from a mod folder, and optionally from your Project Zomboid
install for the vanilla assets that mods reuse. They share the same asset
resolution, so anything one can find, the other can too.

## Download and run

Grab whichever you want, or both, from the [Releases](https://github.com/AlexVDefi/rcpz-tools/releases)
page. Each is a self-contained zip: unzip and run the exe, nothing to install.

| Download | Run | What it is |
|---|---|---|
| `PZ-Icon-Maker-<version>-win-x64.zip` | `PZ Icon Maker.exe` | Item icon renderer (plus `pz-icon-maker-cli.cmd` for headless use) |
| `PZ-Survivor-Studio-<version>-win-x64.zip` | `PZ Survivor Studio.exe` | Character and animation studio |

The builds are unsigned, so on first run Windows SmartScreen shows an "unknown
publisher" prompt. Choose *More info -> Run anyway*.

PZ Survivor Studio also runs in the browser at
[survivor.rcpz.tools](https://survivor.rcpz.tools), with one caveat: browsers block
file access to `C:\Program Files`, so if your game lives there, use the desktop app.

---

# PZ Icon Maker

Point it at a mod, and it renders each item's model at the game's isometric camera
angle on a transparent background, then writes correctly named `Item_*.png` files.

- Interactive UI to preview and tune each icon, with live output at 32/64/128/256/512.
- Weapon **attachments**: render a weapon with any or all of its attachments,
  automatically detected from the model and item scripts.
- Headless CLI to batch-render a whole mod.
- Renders straight into your mod, or into any folder for posters and promo art.

## How it matches the game

The look is reverse-engineered from the game's own renderer, not eyeballed:

- **Camera** -- orthographic, tilted 30 degrees and rotated 45 degrees: the same
  isometric framing the game uses when it shows an item model. The image is mirrored
  to match.
- **Shading** -- flat ambient light plus a single directional key light, no specular
  and no shadows, exactly like the game's item shader. Texels below ~1% alpha are cut
  out, which gives a clean silhouette.
- **Handedness** -- the game loads meshes into a left-handed coordinate space.
  Attachment offsets are converted accordingly, so parts land where the game would put
  them.
- **Framing** -- the model is rendered with room to spare, then trimmed to the tight
  bounding box of its visible pixels and scaled to fill the canvas, edge to edge.

## Asset resolution

Assets are resolved from the mod's own item and model scripts, by path, exactly the
way the game resolves them. A model script's `mesh` and `texture` values are paths
relative to `media/`, so a mod is free to use whatever subfolders it likes:

```
mesh    = animals/Bicycle_Chicken   ->  media/models_x/animals/bicycle_chicken.fbx  (then .x)
texture = models_x_texture/Frame    ->  media/textures/models_x_texture/frame.png
```

Lookups are case-insensitive. Search order is the mod's own media roots first, then
your Project Zomboid install, so a mod always overrides vanilla. Nothing is matched by
filename alone, so two same-named meshes in different folders never collide.

### Which folder to point at

Point at the **mod folder** -- the one that holds `common/` and the version directories:

```
MyMod/
  common/media/...        assets shared by every build
  42.13/mod.info
  42.13/media/...         assets for this build; overrides common/
```

Exactly like the game, the tool picks the highest version directory and reads
`common/` underneath it, so assets in either place are found. A version directory
(`MyMod/42.13`) also works and still picks up its sibling `common/`. Only `common` and
version-named directories are ever considered, so unrelated siblings are ignored.
`list` prints which version directory it chose.

Supported meshes: `.fbx`, `.glb`, and `.x` (converted automatically via a bundled
[assimp](https://github.com/assimp/assimp)).

### Vanilla assets

Mods routinely reuse vanilla textures and meshes. Tell the tool where the game is,
once:

```
pz-icon-maker set-game-dir "D:/Games/Steam/steamapps/common/ProjectZomboid"
```

In the UI, the **Game folder...** button does the same thing. Either way it is saved to
`~/.pz-icon-maker.json` and used by every command and every launch. `--game-dir <path>`
overrides it for a single run. With nothing configured the tool auto-detects common
Steam locations; if exactly one install is found it uses it and says so, otherwise it
asks you to set it. Missing assets are always reported with the exact path expected,
e.g. `no texture media/textures/body/horsemod/horse_thoroughbredbay.png`.

Assets from another mod (a cross-mod part, say) resolve by adding that mod's folder to
`defaults.extraRoots` in the config -- again, its top-level folder:

```json
{ "defaults": { "extraRoots": ["C:/mods/HorseMod"] } }
```

## The UI

Launch the app, or run `pz-icon-maker preview <modPath>`.

- **Preview** -- the model renders live at the icon camera. Every enabled size is shown
  at true 1:1, over an adjustable solid backdrop so you can judge the icon on any
  background.
- **Adjust** -- extra yaw/pitch/roll, padding, mirror, double-sided, downscale filter,
  ambient and key-light direction/brightness. Everything updates live.
- **Attachments** -- for weapon items, one dropdown per attachment slot, plus Fit all /
  Clear all. Parts that cannot be resolved are hidden, with the reason available.
- **Save to config** -- writes only the values you changed as a per-item override into
  the mod's `icons.config.json`, so a later batch reproduces exactly what you tuned.
- **Generate...** -- renders this icon or all icons, at every enabled size, either into
  the mod's `media/textures/` as `Item_<icon>.png`, or into any folder as
  `<icon>_<size>.png` for posters and promo art. With a progress bar and a cancel
  button.

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

Lives in the mod folder. `init` writes a stub. `defaults` applies to every icon;
entries under `items` override it per icon. The UI writes this file for you.

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
smoother), `extraYaw`/`extraPitch`/`extraRoll`, `padding` (`0` = touch the edges),
`mirror`, `doubleSide`, `model` (force a model block), `item` (define a new icon name
for an item that shares a placeholder icon), `ambient`, `keyDir`, `keyColour`,
`outSize`, `supersample`, `extraRoots`.

## Weapon attachments

Weapon items list their parts, and the parent model declares an attachment point for
each. The tool reads both, so an item can be rendered fully assembled.
`slots <modPath>` prints every slot and the parts that fit it; the UI turns them into
dropdowns.

A part is only placeable if the parent model declares the named attachment. Parts whose
mesh or texture cannot be found are reported as unavailable, with the exact path
expected, rather than silently skipped.

---

# PZ Survivor Studio

A full Project Zomboid survivor you can dress, arm, animate, and export. It uses the
same asset resolution as the icon maker, so it renders the vanilla body, clothing, and
weapons your mod reuses, plus anything the mod adds. Available as a desktop app and in
the browser at [survivor.rcpz.tools](https://survivor.rcpz.tools).

- **Build the survivor** -- pick gender and skin tone; add hair, a beard, and any
  clothing item (meshed, composite, or a static hat); equip weapons and items in either
  hand.
- **Animate** -- browse the game's clips in a searchable grid, grouped into categories
  (Aim, Attack, Reload, Walk, Sneak, Sit, and more) and by actor (player, Kate,
  zombie). Hover a thumbnail to preview, click to play. Scrub, loop, and change speed on
  the transport bar.
- **Pose the shot** -- orbit freely or snap to the game's isometric camera, turn the
  survivor to any facing, and tune the scene (floor, grid, shadow, and the lighting)
  from a menu on the viewport, each control with a one-click reset.
- **Export** -- a transparent still, a sprite sheet, or a looping GIF of the current
  clip (512px, auto-optimised to stay under 1 MB).

Only human and zombie clips are loaded, since animal skeletons do not retarget to the
player body. Held items follow the hand's prop bone, so a weapon sits and swings the
way the game holds it.

## Item names

Clothing and items are labelled with their in-game display names, read from the game's
own translation files (vanilla and modded). A language picker sets the item-name
language only, not the interface: it defaults to English, loads other languages on
demand, and falls back per item to English (then to the raw type name) when a
translation is missing, exactly as the game does. Search still matches the raw type and
model names, so nothing gets harder to find.

## Point it at your mods

The mod source can be your `Zomboid/mods` folder, your `Zomboid/Workshop` folder, or
the Steam `108600` workshop folder. Each has a slightly different layout, and all three
are picked up. In the browser, folder access uses the File System Access API, which
cannot open `C:\Program Files`; the desktop app has no such restriction and reads mods
and a game install from anywhere.

## Sign in and share (optional)

Sign-in and sharing are entirely optional; everything above works signed out. With an
account you can share a render two ways:

- the **raw** `.png`, `.gif`, or `.mp4` file, or
- a **detailed view** page that shows the equipped gear (clothing and weapon, and which
  mods they come from) and the survivor's name, under a PZ Survivor Studio watermark.

A **Shared** tab collects your shared renders. You can permanently delete your account
and everything you have shared at any time.

---

## Build from source

```
npm install                   # also vendors the three.js addons we use
```

**PZ Icon Maker:**

```
npm start                     # the icon maker UI
node src/cli.js --help        # the CLI
npm run dist:iconmaker        # Windows release zip -> dist/iconmaker/
```

**PZ Survivor Studio:**

```
cd web && npm install         # once, for the web app
cd web && npm run dev         # the browser app on a dev server
npm run start:desktop         # build the web UI and launch the desktop shell
npm run dist:studio           # Windows release zip -> dist/studio/
```

`npm run dist` builds both release zips.

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Use
it however you like; keep the copyright notice.

These are unofficial fan-made tools, not affiliated with or endorsed by The Indie
Stone. They ship no game assets; they read from a mod folder and, optionally, from a
Project Zomboid installation you already own.

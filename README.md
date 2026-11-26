# Screen Utils

An invisible macOS helper for working on top of your screen. No Dock icon, no menu bar icon, no toolbar.
It used to be ScreenDraw.

| Shortcut | What it does |
| --- | --- |
| **⌥G** | Draw on the screen under your mouse, in Excalidraw's style (rough.js strokes, Excalifont text). **Esc Esc** (double-tap) clears it and drops you back where you were |
| **⌥⇧S** | Screenshot. It stays over the screen with a note bar at the bottom: type a note, `@folder` to file it, `#tag` to tag it. **Enter** saves, **Esc** drops it, **⌥G** draws on it first. While drawing, ⌥⇧S saves the drawing over its screen the same way |
| **⌥⇧D** | Search screenshots. This is the Raycast extension's hotkey (see [Raycast](#raycast)) |

## Screenshots

Screenshots are PNGs in `~/Pictures/Screen Utils`, one subfolder per `@folder`
(`defaults write dev.moulik.screendraw libraryPath /some/folder` to move it).
Notes, tags and the text read off each image live in `.screenutils.json` in that folder.
Folders you make in Finder show up as `@folder`s. Images you drop in show up in search,
and the app reads their text in the background (at launch and every 30 minutes).

In the note bar, `@` and `#` list existing folders and tags as you type: **↑↓** to move,
**Tab** (or **Enter**) to pick. Picking one, or typing a space after the name, turns it into a
chip where it stands, and Backspace removes a chip whole. A name that doesn't exist yet makes a
new folder or tag. Folder names with spaces are typed with dashes (`@Bugs-Found` is "Bugs Found").

## Raycast

`raycast/` is a Raycast extension for searching the library. Install it once with

```bash
cd raycast && npm install && npm run dev   # imports it into Raycast; Ctrl-C when it's loaded
```

Then give **Search Screenshots** a hotkey in Raycast's settings (Extensions › Screen Utils). I use ⌥⇧D.
Search matches notes, folders, tags and file names first, then text read off the images
(listed below them under **Text in Screenshots**). `@folder` and `#tag` filter, and typing part
of a folder or tag name offers it as a filter; Enter on it applies it, and Delete takes it back
off. Time phrases filter by when it was taken, and the list says what they were read as:
`today`, `yesterday`, `this morning`, `last night`, `last 3 hours`, `2d`, `4 days ago`,
`monday`, `last friday`, `since tuesday`, `this week`, `last month`, `nov 20`, `11/20`,
`october 2025`. They combine with words and filters (`login @Work yesterday`). On a screenshot:

| Key | Action |
| --- | --- |
| Enter | Paste it into the app you were in |
| ⌘⇧C | Copy it |
| ⌘Y | Quick Look |
| ⌘⇧P | Show or hide the preview |
| ⌘E | Rename or edit the note. The app shows the image with the note bar: folder and tags as chips at the front, the note selected so typing replaces it. A new folder moves the file |
| ⌘F | Show only its folder |
| ⌘O / ⌘⇧F | Open / show in Finder |
| ⌃X | Move it to the Trash |

⌘K lists them all.

## Drawing

### Drawing shortcuts

| Key | Action |
| --- | --- |
| Q | Pen (default) |
| V | Select |
| R / D / C | Rectangle / diamond / ellipse |
| A / W | Arrow / line (drag, or click-click-click then Enter) |
| T | Text |
| E | Eraser |
| Double-click | Text box anywhere; near a shape's center it labels the shape and moves with it |
| 1–5 | Stroke: red, blue, green, black, white |
| F1–F5 | Fill (a tint of that color); F6 clears. Shift+1–5 / Shift+6 do the same if your F-keys are media keys |
| X | Toggle solid / dotted |
| Tab | Draw over the live screen instead of the still of it from when you pressed ⌥G, and back. The still needs Screen Recording access, which the app asks for the first time you press ⌥G; without it you draw over the live screen |
| ⌘G | Group, or ungroup if a group is selected |
| ⌘↑ / ⌘↓ | Bring forward / send backward (add ⇧ or ⌥ for front / back) |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌘C / ⌘V / ⌘X / ⌘D | Copy / paste at cursor / cut / duplicate |
| ⌘A | Select all |
| Delete | Delete selection |
| Scroll | Size of the next things you place (stroke, pen and font size together); placed things don't change |
| ↑ / ↓ (nothing selected) | Older / newer artboards, like shell history. Editing an old board saves the edited copy as the newest; the original stays. Each board comes back over the still it was drawn on. Last 100 are kept in `~/Library/Application Support/ScreenUtils/history.json`, with their stills in `stills/` next to it |
| Arrows (with a selection) | Nudge 1px (⇧ for 5px) |
| ⌘⇧. / ⌘⇧, | Bigger / smaller text |
| Enter | Edit the selected text or shape label |

With the select tool: drag corners to resize (⇧ keeps the ratio, ⌥ resizes from the center),
drag an edge to resize one side, drag the dot above the box to rotate (⇧ snaps to 15°),
drag line/arrow points to move them and the faint midpoint dots to bend them,
⌥-drag to duplicate, ⇧-click to add to the selection, drag on empty space to box-select.

The first time it runs from Applications, Screen Utils adds itself to Login Items
(turn that off in System Settings › General › Login Items). Press ⌘Q while drawing to quit.
Opening the app again (Spotlight, Raycast) also toggles the drawing layer, and
`screenutils://draw` and `screenutils://capture` do what the shortcuts do, and
`screenutils://edit?file=<path>` opens the note bar for an image in the library.

## Build

Needs Xcode and Node.

```bash
./scripts/build.sh            # builds build/ScreenUtils.app (universal, ad-hoc signed)
./scripts/build.sh --install  # also copies it to ~/Applications and starts it
```

## Release

Releases are published to https://apps.moulik.dev/screen-draw/ with
[app-hosting](https://github.com/Moulik-Budhiraja/app-hosting). Tag a commit on main:

```bash
git tag -a v1.2.3 -m "What changed" && git push origin v1.2.3
```

The release workflow builds the app with `VERSION=1.2.3`, signs it with the Developer ID,
notarizes it, makes the DMG and publishes it. The tag message becomes the release notes.
`./scripts/release.sh 1.2.3` does the same from this Mac when the runner is down.

Installed copies update themselves with Sparkle. They check every 6 hours, download new
versions in the background and install them the next time the drawing layer is closed,
which relaunches the app in about a second. A copy installed as ScreenDraw.app renames
itself to ScreenUtils.app the first time this version runs. It keeps ScreenDraw's bundle ID
and update feed (apps.moulik.dev/screen-draw), so old installs update and keep their
Screen Recording access. Dev builds (`./scripts/build.sh` without
`VERSION`) are version 0.0.0 and don't check for updates.

The icon is drawn by `scripts/make-icon.mjs`;
run `./scripts/make-icon.sh` after changing it.

Excalifont is © Excalidraw, licensed under the SIL Open Font License (bundled as `Excalifont-OFL.txt`).

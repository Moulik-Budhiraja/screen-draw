# ScreenDraw

An invisible macOS helper for drawing on top of your screen, in Excalidraw's style
(rough.js strokes, Excalifont text). No Dock icon, no menu bar icon, no toolbar.

**⌥G** opens a transparent drawing layer on the screen under your mouse.
**Esc Esc** (double-tap) clears everything and drops you back where you were.

## Shortcuts

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
| ↑ / ↓ (nothing selected) | Older / newer artboards, like shell history. Editing an old board saves the edited copy as the newest; the original stays. Each board comes back over the still it was drawn on. Last 100 are kept in `~/Library/Application Support/ScreenDraw/history.json`, with their stills in `stills/` next to it |
| Arrows (with a selection) | Nudge 1px (⇧ for 5px) |
| ⌘⇧. / ⌘⇧, | Bigger / smaller text |
| Enter | Edit the selected text or shape label |

With the select tool: drag corners to resize (⇧ keeps the ratio, ⌥ resizes from the center),
drag an edge to resize one side, drag the dot above the box to rotate (⇧ snaps to 15°),
drag line/arrow points to move them and the faint midpoint dots to bend them,
⌥-drag to duplicate, ⇧-click to add to the selection, drag on empty space to box-select.

The first time it runs from Applications, ScreenDraw adds itself to Login Items
(turn that off in System Settings › General › Login Items). Press ⌘Q while drawing to quit.
Opening the app again (Spotlight, Raycast) also toggles the overlay.

## Build

Needs Xcode and Node.

```bash
./scripts/build.sh            # builds build/ScreenDraw.app (universal, ad-hoc signed)
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
which relaunches the app in about a second. Dev builds (`./scripts/build.sh` without
`VERSION`) are version 0.0.0 and don't check for updates.

The icon is drawn by `scripts/make-icon.mjs`;
run `./scripts/make-icon.sh` after changing it.

Excalifont is © Excalidraw, licensed under the SIL Open Font License (bundled as `Excalifont-OFL.txt`).

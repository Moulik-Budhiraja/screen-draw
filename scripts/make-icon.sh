#!/bin/bash
# Regenerates assets/icon.svg and assets/AppIcon.icns. Both are checked in, so
# the normal build doesn't need this; run it after changing scripts/make-icon.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm install
node scripts/make-icon.mjs

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
set=$work/AppIcon.iconset
mkdir -p "$set"
for pt in 16 32 128 256 512; do
  swift scripts/render-icon.swift assets/icon.svg "$set/icon_${pt}x${pt}.png" "$pt"
  swift scripts/render-icon.swift assets/icon.svg "$set/icon_${pt}x${pt}@2x.png" "$((pt * 2))"
done
iconutil -c icns "$set" -o assets/AppIcon.icns
echo "wrote assets/AppIcon.icns"

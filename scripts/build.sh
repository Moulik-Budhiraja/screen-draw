#!/bin/bash
# Builds build/ScreenDraw.app (universal: Apple silicon + Intel), ad-hoc signed.
# Pass --install to copy it to ~/Applications and (re)start it.
# VERSION and BUILD set the app's version (default 1.0 and 1).
# scripts/release.sh builds on this to make the signed, notarized DMG.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${VERSION:-1.0}
BUILD=${BUILD:-1}

[ -d node_modules ] || npm install
node scripts/build-web.mjs
arch=(--arch arm64 --arch x86_64)
swift build -c release "${arch[@]}"
bin="$(swift build -c release "${arch[@]}" --show-bin-path)/ScreenDraw"

APP=build/ScreenDraw.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$bin" "$APP/Contents/MacOS/ScreenDraw"
cp build/overlay.html "$APP/Contents/Resources/overlay.html"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp web/fonts/OFL.txt "$APP/Contents/Resources/Excalifont-OFL.txt"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.moulik.screendraw</string>
  <key>CFBundleName</key><string>ScreenDraw</string>
  <key>CFBundleDisplayName</key><string>ScreenDraw</string>
  <key>CFBundleExecutable</key><string>ScreenDraw</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© $(date +%Y) Moulik Budhiraja</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "built $APP ($VERSION, build $BUILD)"

if [ "${1:-}" = "--install" ]; then
  pkill -x ScreenDraw 2>/dev/null || true
  mkdir -p ~/Applications
  rm -rf ~/Applications/ScreenDraw.app
  cp -R "$APP" ~/Applications/
  open ~/Applications/ScreenDraw.app
  echo "installed to ~/Applications/ScreenDraw.app and started (⌥G to draw)"
fi

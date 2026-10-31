#!/usr/bin/env bash
# Builds build/ScreenDraw.app (universal: Apple silicon + Intel), ad-hoc signed.
# Pass --install to copy it to ~/Applications and (re)start it.
#
# VERSION (1.2.3) and BUILD set the app's version. BUILD defaults to
# X*100000000 + Y*100000 + Z*100, the scheme app-hosting uses. Releases come
# from the app-hosting workflow (see apps.json), which runs this with both set
# and does the real signing. Without VERSION this is a dev build: version
# 0.0.0 and no update feed, so it never replaces itself with a release.
set -euo pipefail
cd "$(dirname "$0")/.."

FEED_URL=https://apps.moulik.dev/screen-draw/appcast.xml
# From `apps create`. Sparkle checks every update against it.
PUBLIC_ED_KEY=UMOIAd1529xaEvQ3vsezoUNgNQOoHOytTgJfV+fdUU4=

if [[ -n ${VERSION:-} ]]; then
  [[ $VERSION =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "VERSION must look like 1.2.3" >&2; exit 1; }
  BUILD=${BUILD:-$(( BASH_REMATCH[1] * 100000000 + BASH_REMATCH[2] * 100000 + BASH_REMATCH[3] * 100 ))}
  feed_keys="<key>SUFeedURL</key><string>$FEED_URL</string>"
else
  VERSION=0.0.0
  BUILD=0
  feed_keys=""
fi

[ -d node_modules ] || npm install
node scripts/build-web.mjs
arch=(--arch arm64 --arch x86_64)
swift build -c release "${arch[@]}"
products=$(swift build -c release "${arch[@]}" --show-bin-path)

APP=build/ScreenDraw.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$products/ScreenDraw" "$APP/Contents/MacOS/ScreenDraw"
# ditto keeps the framework's symlinks, which its signature covers.
ditto "$products/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath @executable_path/../Frameworks "$APP/Contents/MacOS/ScreenDraw"
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
  $feed_keys
  <key>SUPublicEDKey</key><string>$PUBLIC_ED_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUAutomaticallyUpdate</key><true/>
  <key>SUScheduledCheckInterval</key><integer>21600</integer>
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

#!/usr/bin/env bash
# Builds a signed, notarized dist/ScreenDraw-<version>.dmg, ready to hand out.
#
#   APPLE_ISSUER_ID=<issuer id> ./scripts/release.sh <version> [build]
#
# Signs with the Developer ID in ~/.config/predictor-release (developer-id.p12 +
# certificate-password) and notarizes with the App Store Connect key there
# (AuthKey_<key id>.p8), the same setup hobola's local release uses.
# NOTARY_PROFILE=<name> uses a `xcrun notarytool store-credentials` profile instead.
# SIGN_ONLY=1 makes a signed DMG without notarizing it.
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:?usage: release.sh <version> [build]}
build_number=${2:-1}
sign_only=${SIGN_ONLY:-0}
config=${RELEASE_CONFIG:-$HOME/.config/predictor-release}
identity_name="Developer ID Application: Moulik Budhiraja (242F463YCQ)"

notary_auth=()
if [[ $sign_only != 1 ]]; then
  if [[ -n ${NOTARY_PROFILE:-} ]]; then
    notary_auth=(--keychain-profile "$NOTARY_PROFILE")
  else
    : "${APPLE_ISSUER_ID:?Set APPLE_ISSUER_ID (App Store Connect › Users and Access › Integrations › Keys) or NOTARY_PROFILE}"
    key_file=$(ls "$config"/AuthKey_*.p8 | head -1)
    key_id=$(basename "$key_file" .p8 | sed 's/^AuthKey_//')
    notary_auth=(--key "$key_file" --key-id "$key_id" --issuer "$APPLE_ISSUER_ID")
  fi
fi

# A throwaway keychain holding only the Developer ID identity, so codesign
# never stops to ask for keychain access.
secret_dir=$(mktemp -d)
keychain="$secret_dir/release.keychain-db"
keychain_password=$(openssl rand -hex 24)
original_keychains=()
while IFS= read -r existing; do
  original_keychains+=("$existing")
done < <(security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"$//')
cleanup() {
  security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
}
trap cleanup EXIT

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$config/developer-id.p12" -k "$keychain" -P "$(tr -d '\n' < "$config/certificate-password")" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
identity=$(security find-identity -v -p codesigning "$keychain" | awk -v n="\"$identity_name\"" 'index($0, n) {print $2}')
[[ $identity =~ ^[[:xdigit:]]{40}$ ]] || { echo "Expected one Developer ID identity in $config/developer-id.p12" >&2; exit 1; }

sign() { codesign --force --keychain "$keychain" --sign "$identity" --timestamp "$@"; }

notarize() {
  local file=$1 result="build/notary-$(basename "$1").json"
  echo "Notarizing $(basename "$file") (usually a few minutes)"
  xcrun notarytool submit "$file" "${notary_auth[@]}" --wait --output-format json > "$result"
  if ! python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1]))["status"] != "Accepted")' "$result"; then
    cat "$result" >&2
    id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id", ""))' "$result")
    [[ -n $id ]] && xcrun notarytool log "$id" "${notary_auth[@]}" >&2
    exit 1
  fi
}

VERSION=$version BUILD=$build_number ./scripts/build.sh
app=build/ScreenDraw.app

# Hardened runtime is required for notarization. No entitlements are needed:
# WebKit's JIT runs in its own process, not ours.
sign --options runtime "$app"
codesign --verify --deep --strict --verbose=2 "$app"

if [[ $sign_only != 1 ]]; then
  ditto -c -k --keepParent "$app" build/ScreenDraw.zip
  notarize build/ScreenDraw.zip
  xcrun stapler staple "$app"
fi

mkdir -p dist
dmg="dist/ScreenDraw-$version.dmg"
stage=build/dmg
rm -rf "$stage" "$dmg"
mkdir -p "$stage"
ditto "$app" "$stage/ScreenDraw.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname ScreenDraw -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
sign "$dmg"

if [[ $sign_only == 1 ]]; then
  echo "Signed (not notarized): $dmg"
  exit 0
fi

notarize "$dmg"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type execute --verbose "$app"
spctl --assess --type open --context context:primary-signature --verbose "$dmg"
echo "Ready to distribute: $dmg"

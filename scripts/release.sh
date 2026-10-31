#!/usr/bin/env bash
# Releases come from tags: `git tag -a v1.2.3 -m "notes" && git push origin v1.2.3`
# runs app-hosting's release workflow (.github/workflows/release.yml), which
# builds, signs, notarizes and publishes to https://apps.moulik.dev/screen-draw/.
#
# This runs the same steps from this Mac, for when the runner is down:
#
#   ./scripts/release.sh 1.2.3 [--notes-file notes.md]
#   DRY_RUN=1 ./scripts/release.sh 0.0.1     # build and sign only
#
# It needs a checkout of github.com/Moulik-Budhiraja/app-hosting (APPS_HOSTING,
# default ~/Documents/programming/app-hosting). Push the tag afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
tooling=${APPS_HOSTING:-$HOME/Documents/programming/app-hosting}
[[ -x $tooling/scripts/mac/release-local.sh ]] \
  || { echo "app-hosting isn't at $tooling; clone it or set APPS_HOSTING" >&2; exit 1; }
exec "$tooling/scripts/mac/release-local.sh" "$@"

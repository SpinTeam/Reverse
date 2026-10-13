#!/usr/bin/env bash
# Prepare a checksum-verified release tarball instead of the Git-root REA CLI.
set -euo pipefail

VERSION=0.2.0
DIGEST=011e78aebde2b71577286869b65719af83de888e01313445e744999d78844630
NAME="dsh-rea-bundle-$VERSION.tgz"
URL="https://github.com/xxxxxwater/rea/releases/download/dsh-v$VERSION/$NAME"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
BUNDLE_DIR="$HOME_DIR/plugin-packages"
TARGET="$BUNDLE_DIR/$NAME"
INSTALL=0

usage() {
  cat <<'HELP'
Usage: bash prepare-desktop-install.sh [--install | --help]
Default: download and verify the official REA release tarball, then show the
absolute path to paste into DeepSeek Harness Desktop > Plugins > Add plugin.
--install: run the installed Desktop-owned dsh command after fully quitting
           Desktop. The normal npm dsh cannot manage the reserved desktop profile.

Do NOT add https://github.com/xxxxxwater/rea as a plugin! The Git repository
root is the build-required rea-agents CLI; pnpm correctly blocks its prepare
script unless allowBuilds is weakened. Use the verified plugin .tgz instead.
HELP
}

case "$#" in
  0) ;;
  1)
    case "$1" in
      --install) INSTALL=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac ;;
  *) usage >&2; exit 2 ;;
esac

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
if command -v shasum >/dev/null; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
else
  echo 'SHA-256 verifier not found' >&2
  exit 1
fi

umask 077
mkdir -p "$BUNDLE_DIR"
if [[ ! -f "$TARGET" ]] || [[ "$(checksum "$TARGET")" != "$DIGEST" ]]; then
  temp="$(mktemp "$BUNDLE_DIR/.rea-download.XXXXXXXX")"
  trap 'rm -f "$temp"' EXIT
  curl --fail --location --retry 3 --silent --show-error --output "$temp" "$URL"
  if [[ "$(checksum "$temp")" != "$DIGEST" ]]; then
    echo 'REA plugin SHA-256 mismatch; refusing installation' >&2
    exit 1
  fi
  mv -f "$temp" "$TARGET"
  trap - EXIT
fi
[[ "$(checksum "$TARGET")" == "$DIGEST" ]] || {
  echo 'REA plugin SHA-256 mismatch; refusing installation' >&2
  exit 1
}
printf 'Verified REA plugin: %s\n' "$TARGET"

MANIFEST="$HOME_DIR/profiles/desktop/package.json"
if [[ -f "$MANIFEST" ]] && grep -Eq 'xxxxxwater/rea|xxxxxwater%2Frea' "$MANIFEST"; then
  echo 'WARNING: Desktop profile still references the wrong rea-agents Git checkout.' >&2
  echo 'Back up the profile; remove ONLY that bad dependency in the Desktop plugin' >&2
  echo 'manager or with its bundled dsh command. Do NOT edit allowBuilds.' >&2
fi

if [[ "$INSTALL" == 1 ]]; then
  command -v dsh >/dev/null || {
    echo 'Desktop dsh command not found. Use Desktop > Plugins > Add plugin.' >&2
    exit 2
  }
  if ! dsh plugin --profile desktop add "$TARGET"; then
    echo 'Use Desktop > Plugins > Add plugin with the verified local .tgz path above.' >&2
    echo 'Alternatively install the Desktop-owned dsh command via its app menu,' >&2
    echo 'quit Desktop completely, and rerun --install.' >&2
    exit 3
  fi
  echo 'Installed: restart DeepSeek Harness Desktop.'
else
  printf '\nDesktop > Plugins > Add plugin: paste this local path:\n%s\n' "$TARGET"
  echo 'Enable dsh-rea-bundle and restart Desktop. Do not paste the GitHub repo URL.'
fi

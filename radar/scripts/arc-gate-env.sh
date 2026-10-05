#!/usr/bin/env bash
# Write the env file Arc's own gate starts from: its token, its port (8921) and
# the model it fronts (8920). Rewritten on every install, so a leftover file
# can never start Arc's gate on the shared pair's ports (8919 -> 8918). The
# token is kept from the file if it has one, else taken from the shared gate's
# env file; it is never printed.
#
#   scripts/arc-gate-env.sh ~/.config/arc-radar/env ~/.config/stellar-radar/env
set -euo pipefail

TARGET="${1:?usage: arc-gate-env.sh target-env source-env}"
SOURCE="${2:?usage: arc-gate-env.sh target-env source-env}"

token="$(grep -hE '^RADAR_TOKEN=' "$TARGET" "$SOURCE" 2>/dev/null | head -1 || true)"
[ -n "$token" ] || { echo "no RADAR_TOKEN= line in $TARGET or $SOURCE" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")"
umask 077
tmp="$(mktemp "$TARGET.XXXXXX")"
printf '%s\nRADAR_GATE_PORT=8921\nLAYAD_ENDPOINT=http://127.0.0.1:8920\n' "$token" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$TARGET"

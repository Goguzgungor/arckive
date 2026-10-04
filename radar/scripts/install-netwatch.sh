#!/usr/bin/env bash
# Install (or update) the watchdog that keeps the model reachable through
# outages, on the Mac that serves it. Safe to run again: it replaces the
# copy and reloads the agent.
#
#   ./scripts/install-netwatch.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/arc-radar"

mkdir -p "$DEST"
cp "$HERE/netwatch.py" "$DEST/netwatch.py"
# Two copies of the same script: one for the shared model the Stellar radar
# also uses, one for Arc's own (installed only once install-arc-model.sh has
# put Arc's model in place).
labels=(com.arc-radar.netwatch)
[ -f "$HOME/Library/LaunchAgents/com.arc-radar.model.plist" ] && labels+=(com.arc-radar.netwatch-arc)
for label in "${labels[@]}"; do
  sed "s#/Users/gokbot#$HOME#g" "$HERE/$label.plist" > "$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
done
echo "netwatch installed (${labels[*]}); it logs to ~/Library/Logs/arc-radar-netwatch*.log only when something is wrong"

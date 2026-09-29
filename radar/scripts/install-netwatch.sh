#!/usr/bin/env bash
# Install (or update) the watchdog that keeps the model reachable through
# outages, on the Mac that serves it. Safe to run again: it replaces the
# copy and reloads the agent.
#
#   ./scripts/install-netwatch.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/arc-radar"
AGENT="$HOME/Library/LaunchAgents/com.arc-radar.netwatch.plist"

mkdir -p "$DEST"
cp "$HERE/netwatch.py" "$DEST/netwatch.py"
sed "s#/Users/gokbot#$HOME#g" "$HERE/com.arc-radar.netwatch.plist" > "$AGENT"

launchctl bootout "gui/$(id -u)/com.arc-radar.netwatch" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
echo "netwatch installed; it logs to ~/Library/Logs/arc-radar-netwatch.log only when something is wrong"

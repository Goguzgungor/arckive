#!/usr/bin/env bash
# Serve Arc Radar's own model on this Mac: layad on 127.0.0.1:8920 with the
# fine-tuned checkpoint, and the authenticating gate on 127.0.0.1:8921 in
# front of it. The shared model and gate the Stellar radar uses (8918/8919)
# are left exactly as they are. Safe to run again: it refreshes the gate's
# copy of the radar and reloads both agents.
#
#   ./scripts/install-arc-model.sh "$HOME/Library/Application Support/arc-radar/finetune/models/<run>/final-mlx"
set -euo pipefail

MODEL="${1:?usage: install-arc-model.sh /abs/path/to/model-dir}"
[ -f "$MODEL/rl_agent_config.json" ] || { echo "no checkpoint at $MODEL" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/arc-radar"
ENV_FILE="$HOME/.config/arc-radar/env"
AGENTS="$HOME/Library/LaunchAgents"

# The gate runs from its own installed copy of the radar, so checking out
# another branch in the repo never changes what is serving.
mkdir -p "$APP"
uv venv -q --allow-existing --python 3.12 "$APP/.venv"
uv pip install -q --python "$APP/.venv/bin/python" --reinstall "$HERE/.."

# The same token the deployed radar already sends, taken from the shared
# gate's env file. Written once, owner-only, and never printed.
if [ ! -f "$ENV_FILE" ]; then
  token="$(grep -E '^RADAR_TOKEN=' "$HOME/.config/stellar-radar/env" | head -1 || true)"
  [ -n "$token" ] || { echo "no RADAR_TOKEN= line in ~/.config/stellar-radar/env" >&2; exit 1; }
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  printf '%s\nRADAR_GATE_PORT=8921\nLAYAD_ENDPOINT=http://127.0.0.1:8920\n' "$token" > "$ENV_FILE"
fi

sed -e "s#/Users/gokbot#$HOME#g" -e "s#__MODEL_DIR__#$MODEL#g" \
  "$HERE/com.arc-radar.model.plist" > "$AGENTS/com.arc-radar.model.plist"
sed "s#/Users/gokbot#$HOME#g" "$HERE/com.arc-radar.gate.plist" > "$AGENTS/com.arc-radar.gate.plist"
for label in com.arc-radar.model com.arc-radar.gate; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
done
echo "Arc model on 127.0.0.1:8920 ($MODEL); gate on 127.0.0.1:8921"

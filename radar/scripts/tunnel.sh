#!/usr/bin/env bash
# If the existing radar's tunnel is already up on this Mac, it serves this
# app too — do not start a second one.
#
# Publish this machine's decision model to the deployment server.
#
# Nothing listens for the outside world on this machine. The Mac dials out; no
# port is opened here and none is forwarded on the router, so this adds no way
# in. What travels is one authenticated route to the model, and only while the
# connection is up.
#
#   RADAR_TOKEN=... ./scripts/tunnel.sh user@92.4.216.135
#
# What is published is the gate (radar.modelgate), never the model daemon
# itself: the daemon has no authentication, and anything else running on the
# far host can reach whatever the tunnel lands on. On the server the gate
# answers at 172.17.0.1:8919, the Docker bridge, not a public interface.
set -euo pipefail

REMOTE="${1:?usage: tunnel.sh user@host [bind-address]}"
BIND="${2:-172.17.0.1}"
PORT="${RADAR_GATE_PORT:-8919}"
: "${RADAR_TOKEN:?set RADAR_TOKEN to the same secret the gate and the server use}"

if ! curl -fsS -m 5 -H "Authorization: Bearer ${RADAR_TOKEN}" \
     "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "No authenticated gate answering on 127.0.0.1:${PORT}. Start these first:" >&2
  echo "  LAYAD_MODEL=aac6fef/laya-multilingual-mlx LAYAD_BATCH_SIZE=256 layad serve" >&2
  echo "  RADAR_TOKEN=... python -m radar.modelgate" >&2
  exit 1
fi

# GatewayPorts must be `yes` or `clientspecified` in the server's sshd_config,
# otherwise sshd silently binds the forward to its own loopback and the
# container cannot reach it.
exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R "${BIND}:${PORT}:127.0.0.1:${PORT}" \
  "${REMOTE}"

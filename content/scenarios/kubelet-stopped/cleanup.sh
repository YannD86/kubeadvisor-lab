#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
if node_exec "$WORKER1" systemctl start kubelet >/dev/null 2>&1; then
  wait_for_node_ready "$WORKER1" 120 || warn "$WORKER1 not Ready after 120s; check: docker exec $WORKER1 journalctl -u kubelet -n 50"
else
  warn "could not start kubelet on $WORKER1 (is the node container running?)"
fi
kc uncordon "$WORKER1" >/dev/null 2>&1 || true
kc delete ns lab-kubelet --ignore-not-found --wait=false || true
log "cleaned up kubelet-stopped (kubelet started on $WORKER1)"

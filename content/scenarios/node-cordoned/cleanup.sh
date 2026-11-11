#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc uncordon "$WORKER1" >/dev/null 2>&1 || warn "could not uncordon $WORKER1"
kc uncordon "$WORKER2" >/dev/null 2>&1 || warn "could not uncordon $WORKER2"
kc delete ns lab-cordon --ignore-not-found --wait=false || true
log "cleaned up node-cordoned (workers uncordoned)"

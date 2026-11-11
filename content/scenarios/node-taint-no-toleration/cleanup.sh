#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-taint --ignore-not-found --wait=false || true
# Remove every taint with key "team" and the disk label, whatever value they hold now.
kc taint node "$WORKER2" team- >/dev/null 2>&1 || true
kc label node "$WORKER2" disk- >/dev/null 2>&1 || true
log "cleaned up node-taint-no-toleration (taint and label removed from $WORKER2)"

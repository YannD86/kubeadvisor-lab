#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-secrets --ignore-not-found --wait=false
log "cleaned up"

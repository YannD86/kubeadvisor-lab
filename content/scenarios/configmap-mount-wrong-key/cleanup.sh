#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-mount --ignore-not-found --wait=false
log "cleaned up"

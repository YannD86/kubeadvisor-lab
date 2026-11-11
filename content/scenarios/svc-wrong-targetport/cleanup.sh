#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-shop2 --ignore-not-found --wait=false
log "cleaned up svc-wrong-targetport"

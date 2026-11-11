#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-dnspolicy --ignore-not-found --wait=false
log "cleaned up pod-dns-config-broken"

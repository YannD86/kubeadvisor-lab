#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-storage --ignore-not-found --wait=false
# In case a learner created the missing class anyway.
kc delete storageclass fast-ssd --ignore-not-found
log "cleaned up"

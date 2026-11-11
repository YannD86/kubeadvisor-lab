#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-helm
# Deleting the HelmRelease makes helm-controller run helm uninstall (finalizer); then the source and the namespace.
kc delete helmrelease podinfo -n "$NS" --ignore-not-found --timeout=90s >/dev/null 2>&1 || true
kc delete helmrepository podinfo -n "$NS" --ignore-not-found --timeout=30s >/dev/null 2>&1 || true
kc delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
log "cleaned up"

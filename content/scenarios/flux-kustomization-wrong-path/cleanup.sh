#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-path
REPO=flux-kustomization-wrong-path
# Deleting the Kustomization (prune=true) garbage-collects lab-prod; delete it explicitly as well.
kc delete kustomization podinfo -n "$NS" --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
kc delete gitrepository podinfo -n "$NS" --ignore-not-found --timeout=30s >/dev/null 2>&1 || true
kc delete ns "$NS" lab-prod --ignore-not-found --wait=false >/dev/null 2>&1 || true
gitea_delete_repo "$REPO"
rm -rf "${LAB_WORKDIR:-/nonexistent}/$REPO"
log "cleaned up"

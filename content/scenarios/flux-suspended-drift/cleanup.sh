#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-drift
REPO=flux-suspended-drift
# A suspended Kustomization still runs its deletion finalizer (prune); resume first so it cannot hang.
kc patch kustomization podinfo -n "$NS" --type merge -p '{"spec":{"suspend":false}}' >/dev/null 2>&1 || true
kc delete kustomization podinfo -n "$NS" --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
kc delete gitrepository podinfo -n "$NS" --ignore-not-found --timeout=30s >/dev/null 2>&1 || true
kc delete ns "$NS" lab-drift-app --ignore-not-found --wait=false >/dev/null 2>&1 || true
gitea_delete_repo "$REPO"
rm -rf "${LAB_WORKDIR:-/nonexistent}/$REPO"
log "cleaned up"

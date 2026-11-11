#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-dep
REPO=flux-dependency-missing
# app first (depends on infra), then infra (prune garbage-collects lab-dep-app), then the source.
kc delete kustomization app -n "$NS" --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
kc delete kustomization infra -n "$NS" --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
kc delete gitrepository platform -n "$NS" --ignore-not-found --timeout=30s >/dev/null 2>&1 || true
kc delete ns "$NS" lab-dep-app --ignore-not-found --wait=false >/dev/null 2>&1 || true
gitea_delete_repo "$REPO"
rm -rf "${LAB_WORKDIR:-/nonexistent}/$REPO"
log "cleaned up"

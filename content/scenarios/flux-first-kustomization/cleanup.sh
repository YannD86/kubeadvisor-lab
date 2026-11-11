#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-flux1
REPO=flux-first-kustomization
# Flux objects are learner-created (names unknown): delete every one in the scenario namespace.
# Deleting a Kustomization with prune=true garbage-collects lab-podinfo; we delete it explicitly too.
kc delete kustomization -n "$NS" --all --ignore-not-found --timeout=60s >/dev/null 2>&1 || true
kc delete gitrepository -n "$NS" --all --ignore-not-found --timeout=30s >/dev/null 2>&1 || true
kc delete ns "$NS" lab-podinfo --ignore-not-found --wait=false >/dev/null 2>&1 || true
gitea_delete_repo "$REPO"
rm -rf "${LAB_WORKDIR:-/nonexistent}/$REPO"
log "cleaned up"

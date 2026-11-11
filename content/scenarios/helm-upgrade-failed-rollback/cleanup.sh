#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-helmcli
helm --kubeconfig "$KUBECONFIG" uninstall web -n "$NS" >/dev/null 2>&1 || true
kc delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
rm -rf "${LAB_WORKDIR:-/nonexistent}/webchart"
log "cleaned up"

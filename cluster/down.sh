#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if cluster_exists; then
  log "deleting kind cluster $LAB_CLUSTER"
  kind delete cluster --name "$LAB_CLUSTER" --kubeconfig "$KUBECONFIG" || kind delete cluster --name "$LAB_CLUSTER"
else
  log "cluster $LAB_CLUSTER does not exist"
fi
rm -f "$LAB_HOME/state/scenarios.json"
log "done"

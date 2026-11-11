#!/usr/bin/env bash
# Make sure $KUBECONFIG exists for the lab cluster; lib.sh regenerates it from the
# running kind cluster when it is missing. Exit 0 when kubectl can be used.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ -f "$KUBECONFIG" ]; then
  log "kubeconfig ready: $KUBECONFIG"
  exit 0
fi
if cluster_exists; then
  die "could not export the kubeconfig for $LAB_CLUSTER (is docker running?)"
fi
die "cluster $LAB_CLUSTER does not exist: create it from the Cluster page or run cluster/up.sh"

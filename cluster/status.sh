#!/usr/bin/env bash
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
printf 'docker:   '; docker_ok && echo ok || echo DOWN
printf 'cluster:  '; cluster_exists && echo "$LAB_CLUSTER exists" || echo "absent"
if cluster_exists; then
  kc get nodes 2>/dev/null || echo "API not reachable"
  for a in metrics-server gitea flux ingress-nginx cert-manager; do
    printf 'addon %-15s ' "$a"; addon_installed "$a" && echo installed || echo "-"
  done
fi

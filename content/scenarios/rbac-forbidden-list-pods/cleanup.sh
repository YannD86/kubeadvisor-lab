#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
kc delete ns lab-rbac --ignore-not-found --wait=false
# Undo any cluster-scoped grant a learner may have added for this ServiceAccount.
kc delete clusterrolebinding -l app=pod-watcher --ignore-not-found
for crb in $(kc get clusterrolebindings -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .subjects[*]}{.namespace}/{.name}{" "}{end}{"\n"}{end}' 2>/dev/null | awk -F'\t' '$2 ~ /lab-rbac\/pod-watcher/ {print $1}'); do
  kc delete clusterrolebinding "$crb" --ignore-not-found
done
log "cleaned up"

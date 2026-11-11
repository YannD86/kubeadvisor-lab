#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
BACKUP_DIR="$LAB_HOME/backup/apiserver-etcd-wrong-port"
MANIFEST=/etc/kubernetes/manifests/kube-apiserver.yaml
PARKED=/etc/kubernetes/kube-apiserver.yaml.bak
GOOD='--etcd-servers=https://127.0.0.1:2379'
BAD='--etcd-servers=https://127.0.0.1:2389'
mkdir -p "$BACKUP_DIR"

# No app namespace: the fault is the control plane itself. Back up only while the manifest is healthy.
if node_exec "$CP_NODE" grep -q -- "$GOOD" "$MANIFEST"; then
  node_exec "$CP_NODE" cat "$MANIFEST" > "$BACKUP_DIR/kube-apiserver.yaml"
  node_exec "$CP_NODE" cp "$MANIFEST" "$PARKED"
  log "Backed up $CP_NODE:$MANIFEST to $BACKUP_DIR/kube-apiserver.yaml and $CP_NODE:$PARKED"
  # sed -i writes a temp file and renames it, so the kubelet never sees a half-written manifest.
  node_exec "$CP_NODE" sed -i "s#${GOOD}#${BAD}#" "$MANIFEST"
  log "Patched --etcd-servers to port 2389; the kubelet will restart kube-apiserver into a crash loop"
elif node_exec "$CP_NODE" grep -q -- "$BAD" "$MANIFEST"; then
  log "$MANIFEST already patched (setup re-run)"
else
  die "Unexpected --etcd-servers flag in $CP_NODE:$MANIFEST (neither 2379 nor 2389); refusing to modify it"
fi

# Wait (bounded) for the API to go away so the learner sees the symptom immediately.
deadline=$(( $(date +%s) + 120 ))
while kc get --raw /readyz --request-timeout=5s >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "API still answering after 120s; it should go down shortly"; break; fi
  sleep 5
done

log "Scenario apiserver-etcd-wrong-port is loaded: kube-apiserver on $CP_NODE cannot reach etcd; kubectl will fail until it is fixed"

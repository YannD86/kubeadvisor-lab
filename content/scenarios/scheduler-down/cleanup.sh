#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-sched
COMPONENT=kube-scheduler
MANIFEST="/etc/kubernetes/manifests/$COMPONENT.yaml"
PARKED="/etc/kubernetes/$COMPONENT.yaml.bak"
TMP="/etc/kubernetes/.$COMPONENT.yaml.restore"
BACKUP_DIR="$LAB_HOME/backup/scheduler-down"
MIRROR_POD="$COMPONENT-$CP_NODE"

node_has() { node_exec "$CP_NODE" test -f "$1"; }
# Write content to a path on the node atomically (temp file outside the manifests dir, then mv).
node_write() { node_exec "$CP_NODE" sh -c 'printf "%s\n" "$1" > "$2" && mv "$2" "$3"' _ "$1" "$TMP" "$2"; }
static_pod_ready() { [ "$(kc get pod -n kube-system "$MIRROR_POD" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)" = "true" ]; }

restore_manifest() {
  if node_has "$PARKED"; then
    log "Moving $PARKED back to $MANIFEST"
    node_exec "$CP_NODE" mv -f "$PARKED" "$MANIFEST"
  elif node_has "$MANIFEST" && static_pod_ready; then
    log "$MANIFEST present and $MIRROR_POD Ready; nothing to restore"
  elif [ -s "$BACKUP_DIR/$COMPONENT.yaml" ]; then
    log "Restoring $MANIFEST from $BACKUP_DIR/$COMPONENT.yaml"
    node_write "$(cat "$BACKUP_DIR/$COMPONENT.yaml")" "$MANIFEST"
  elif node_has "$MANIFEST"; then
    warn "$MANIFEST present but $MIRROR_POD not Ready and no backup available; leaving the file as is"
  else
    warn "No backup found anywhere; regenerating $COMPONENT manifest with kubeadm"
    if node_has /kind/kubeadm.conf; then
      node_exec "$CP_NODE" kubeadm init phase control-plane scheduler --config /kind/kubeadm.conf
    else
      node_exec "$CP_NODE" kubeadm init phase control-plane scheduler
    fi
  fi
  node_exec "$CP_NODE" rm -f "$PARKED" "$TMP" || true
}

ok=1
if ! restore_manifest; then warn "manifest restore failed on $CP_NODE"; ok=0; fi

deadline=$(( $(date +%s) + 150 ))
until static_pod_ready; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "$MIRROR_POD not Ready after 150s; inspect $CP_NODE:/etc/kubernetes/manifests"; ok=0; break; fi
  sleep 3
done

kc delete ns "$NS" --ignore-not-found --wait=false || true

if [ "$ok" = 1 ]; then
  rm -rf "$BACKUP_DIR"
  log "cleaned up scheduler-down (kube-scheduler restored and Ready)"
else
  warn "cleanup finished with warnings; backup kept in $BACKUP_DIR"
fi

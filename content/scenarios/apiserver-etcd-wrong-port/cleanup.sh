#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
BACKUP_DIR="$LAB_HOME/backup/apiserver-etcd-wrong-port"
MANIFEST=/etc/kubernetes/manifests/kube-apiserver.yaml
PARKED=/etc/kubernetes/kube-apiserver.yaml.bak
TMP=/etc/kubernetes/.kube-apiserver.yaml.restore
GOOD='--etcd-servers=https://127.0.0.1:2379'
BAD='--etcd-servers=https://127.0.0.1:2389'

node_has() { node_exec "$CP_NODE" test -f "$1"; }
# Atomic writes: stage outside the manifests dir, then mv into place.
node_write() { node_exec "$CP_NODE" sh -c 'printf "%s\n" "$1" > "$2" && mv "$2" "$3"' _ "$1" "$TMP" "$2"; }
node_copy()  { node_exec "$CP_NODE" sh -c 'cp "$1" "$2" && mv "$2" "$3"' _ "$1" "$TMP" "$2"; }

restore_manifest() {
  if node_has "$PARKED"; then
    if node_exec "$CP_NODE" sh -c 'cmp -s "$1" "$2"' _ "$PARKED" "$MANIFEST"; then
      log "$MANIFEST already identical to $PARKED"
    else
      log "Restoring $MANIFEST from $PARKED"
      node_copy "$PARKED" "$MANIFEST"
    fi
  elif [ -s "$BACKUP_DIR/kube-apiserver.yaml" ]; then
    log "Restoring $MANIFEST from $BACKUP_DIR/kube-apiserver.yaml"
    node_write "$(cat "$BACKUP_DIR/kube-apiserver.yaml")" "$MANIFEST"
  elif node_exec "$CP_NODE" grep -q -- "$BAD" "$MANIFEST"; then
    log "No backup found; reverting the --etcd-servers port by substitution"
    node_exec "$CP_NODE" sed -i "s#${BAD}#${GOOD}#" "$MANIFEST"
  else
    log "$MANIFEST does not contain the broken flag; nothing to restore"
  fi
  # Belt and braces: whatever we restored must point at 2379.
  if ! node_exec "$CP_NODE" grep -q -- "$GOOD" "$MANIFEST"; then
    warn "$MANIFEST still lacks $GOOD; applying substitution"
    node_exec "$CP_NODE" sed -i "s#${BAD}#${GOOD}#" "$MANIFEST"
  fi
  node_exec "$CP_NODE" rm -f "$PARKED" "$TMP" || true
}

ok=1
if ! restore_manifest; then warn "manifest restore failed on $CP_NODE (is the node container running?)"; ok=0; fi

# Bounded wait for the API server to come back.
deadline=$(( $(date +%s) + 180 ))
until kc get --raw /readyz --request-timeout=5s 2>/dev/null | grep -q '^ok'; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    warn "API server not ready after 180s; inspect with: docker exec $CP_NODE crictl ps -a | grep kube-apiserver"
    ok=0; break
  fi
  sleep 5
done

if [ "$ok" = 1 ]; then
  rm -rf "$BACKUP_DIR"
  log "cleaned up apiserver-etcd-wrong-port (kube-apiserver manifest restored, /readyz ok)"
else
  warn "cleanup finished with warnings; backup kept in $BACKUP_DIR"
fi

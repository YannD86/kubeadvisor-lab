#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-cm
COMPONENT=kube-controller-manager
MANIFEST="/etc/kubernetes/manifests/$COMPONENT.yaml"
PARKED="/etc/kubernetes/$COMPONENT.yaml.bak"
BACKUP_DIR="$LAB_HOME/backup/controller-manager-down"
MIRROR_POD="$COMPONENT-$CP_NODE"
mkdir -p "$BACKUP_DIR"

# Create the namespace while the controller-manager is still alive so its default ServiceAccount exists.
ensure_ns "$NS"

# 1. Back up the manifest (host copy) and park it outside the manifests dir. Idempotent.
if node_exec "$CP_NODE" test -f "$MANIFEST"; then
  node_exec "$CP_NODE" cat "$MANIFEST" > "$BACKUP_DIR/$COMPONENT.yaml"
  log "Backed up $CP_NODE:$MANIFEST to $BACKUP_DIR/$COMPONENT.yaml"
  node_exec "$CP_NODE" mv "$MANIFEST" "$PARKED"
  log "Moved $MANIFEST to $PARKED (the kubelet will stop the controller-manager)"
else
  log "$MANIFEST already absent on $CP_NODE (setup re-run)"
fi

# 2. Wait until the kubelet has removed the mirror Pod, so the Deployment below is created with no controllers alive.
deadline=$(( $(date +%s) + 90 ))
while kc get pod -n kube-system "$MIRROR_POD" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "mirror Pod $MIRROR_POD still listed after 90s; continuing"; break; fi
  sleep 3
done
log "kube-controller-manager is gone from kube-system"

# 3. Re-run safety: remove leftovers explicitly (the garbage collector is down, so delete each level ourselves).
kc delete deploy -n "$NS" api --ignore-not-found --wait=false >/dev/null
kc delete rs -n "$NS" -l app=api --ignore-not-found --wait=false >/dev/null
kc delete pods -n "$NS" -l app=api --ignore-not-found --wait=false >/dev/null
deadline=$(( $(date +%s) + 60 ))
while [ "$(kc get pods -n "$NS" -l app=api --no-headers 2>/dev/null | wc -l)" -gt 0 ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "old api Pods still terminating; continuing"; break; fi
  sleep 2
done

# 4. The victim Deployment. No ReplicaSet or Pod will ever appear: do not wait for them.
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: http }
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML

log "Scenario controller-manager-down is loaded in namespace $NS (kube-controller-manager manifest parked at $CP_NODE:$PARKED, api stays 0/3)"

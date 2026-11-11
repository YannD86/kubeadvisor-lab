#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-kubelet
ensure_ns "$NS"

# Re-run safety: make sure the kubelet is up so the Pods can land before we stop it.
node_exec "$WORKER1" systemctl start kubelet >/dev/null 2>&1 || true
wait_for_node_ready "$WORKER1" 120

kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: api
              topologyKey: kubernetes.io/hostname
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

# Healthy prerequisite: one Pod per worker, both Ready.
wait_for_pods "$NS" "app=api" 150

# The fault: stop the node agent. Containers keep running under containerd.
node_exec "$WORKER1" systemctl stop kubelet
log "kubelet stopped on $WORKER1; waiting for the node to be reported NotReady (~40-60s)"

deadline=$(( $(date +%s) + 90 ))
until [ "$(kc get node "$WORKER1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" != "True" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "$WORKER1 still reported Ready after 90s; it will flip shortly"; break; fi
  sleep 5
done

log "Scenario kubelet-stopped is loaded in namespace $NS ($WORKER1 NotReady, kubelet inactive)"

#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-cordon
ensure_ns "$NS"

# "Maintenance" left both workers cordoned.
kc cordon "$WORKER1" >/dev/null
kc cordon "$WORKER2" >/dev/null

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

# Re-run safety: Pods scheduled before a previous cordon would keep running; recycle them so the state is Pending.
if [ -n "$(kc get pods -n "$NS" -l app=api -o jsonpath='{.items[*].spec.nodeName}' 2>/dev/null)" ]; then
  kc delete pods -n "$NS" -l app=api --wait=false >/dev/null
fi

# Pods are supposed to stay Pending: do not wait for them.
log "Scenario node-cordoned is loaded in namespace $NS (both workers cordoned, api Pods Pending)"

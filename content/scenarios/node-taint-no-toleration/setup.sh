#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-taint
ensure_ns "$NS"

# The data team's reserved SSD node: label + NoSchedule taint (both intentional).
kc label node "$WORKER2" disk=ssd --overwrite >/dev/null
kc taint node "$WORKER2" team=data:NoSchedule --overwrite >/dev/null

kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingest
  labels:
    app: ingest
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ingest
  template:
    metadata:
      labels:
        app: ingest
    spec:
      nodeSelector:
        disk: ssd
      containers:
        - name: ingest
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

# Pods are supposed to stay Pending (untolerated taint): do not wait for them.
log "Scenario node-taint-no-toleration is loaded in namespace $NS ($WORKER2 tainted team=data:NoSchedule, ingest Pods Pending)"

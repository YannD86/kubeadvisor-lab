#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-capacity
ensure_ns "$NS"

# Memory request far above any node's allocatable: the Pods can never be scheduled.
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reports
  labels:
    app: reports
spec:
  replicas: 2
  selector:
    matchLabels:
      app: reports
  template:
    metadata:
      labels:
        app: reports
    spec:
      containers:
        - name: reports
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: http }
          resources:
            requests: { cpu: 10m, memory: 64Gi }
            limits: { memory: 64Gi }
YAML

# Pods are supposed to stay Pending (Insufficient memory): do not wait for them.
log "Scenario pending-insufficient-resources is loaded in namespace $NS (reports requests 64Gi memory, Pods Pending)"

#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-probes
ensure_ns "$NS"
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
  annotations:
    kubernetes.io/change-cause: "add health checks"
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          livenessProbe:
            httpGet: { path: /health, port: http }
            initialDelaySeconds: 3
            periodSeconds: 3
            failureThreshold: 2
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { memory: 64Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: http
YAML
# Do not wait for a stable Ready state: the containers are killed every few seconds.
# Bounded wait until at least one restart has been observed.
for _ in $(seq 1 30); do
  counts=$(kc get pods -n "$NS" -l app=web -o jsonpath='{.items[*].status.containerStatuses[0].restartCount}' 2>/dev/null || true)
  restarted=0
  for c in $counts; do [ "$c" -ge 1 ] 2>/dev/null && restarted=1; done
  [ "$restarted" -eq 1 ] && break
  sleep 2
done
log "Scenario liveness-wrong-path is loaded in namespace $NS (web containers restarted by a failing liveness probe)"

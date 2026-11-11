#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-config
ensure_ns "$NS"
# Recreate the ConfigMap so a key added by a previous attempt does not survive a re-run.
kc delete cm app-config -n "$NS" --ignore-not-found >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  database_url: "postgres://db.lab-config.svc:5432/shop?sslmode=require"
  log_level: info
  feature_flags: "checkout_v2,fast_search"
---
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
      terminationGracePeriodSeconds: 2
      containers:
        - name: api
          image: busybox:1.36
          command: ["sh", "-c"]
          args:
            - |
              echo "api starting (log level $LOG_LEVEL)"
              echo "connecting to $DATABASE_URL"
              while true; do sleep 30; done
          env:
            - name: LOG_LEVEL
              valueFrom:
                configMapKeyRef:
                  name: app-config
                  key: log_level
            - name: DATABASE_URL
              valueFrom:
                configMapKeyRef:
                  name: app-config
                  key: DATABASE_URL
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML
# Do not wait for Ready: the Pods are meant to be stuck. Bounded wait for the fault to surface.
for _ in $(seq 1 30); do
  reasons=$(kc get pods -n "$NS" -l app=api -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)
  case "$reasons" in *CreateContainerConfigError*) break ;; esac
  sleep 2
done
log "Scenario cm-missing-key is loaded in namespace $NS (api Pods stuck in CreateContainerConfigError)"

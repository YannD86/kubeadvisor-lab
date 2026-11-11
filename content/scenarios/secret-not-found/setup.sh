#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-secrets
ensure_ns "$NS"
# A Secret created by a previous attempt under the "expected" name must not survive a re-run.
kc delete secret api-credentials -n "$NS" --ignore-not-found >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: api-credential
  labels:
    managed-by: vault-sync
type: Opaque
stringData:
  API_KEY: pk_test_51HhLabKubeSreLabs0000000000000000
  API_SECRET: lab-api-secret-51HhLabKubeSreLabs-not-a-real-key
  PSP_ENDPOINT: https://psp.example.internal/v1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments
  labels:
    app: payments
spec:
  replicas: 2
  selector:
    matchLabels:
      app: payments
  template:
    metadata:
      labels:
        app: payments
    spec:
      terminationGracePeriodSeconds: 2
      containers:
        - name: payments
          image: busybox:1.36
          command: ["sh", "-c"]
          args:
            - |
              echo "payments starting, PSP endpoint $PSP_ENDPOINT"
              echo "api key loaded: ${API_KEY%????????????????????????????}..."
              while true; do sleep 30; done
          envFrom:
            - secretRef:
                name: api-credentials
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML
# Do not wait for Ready: the Pods are meant to be stuck. Bounded wait for the fault to surface.
for _ in $(seq 1 30); do
  reasons=$(kc get pods -n "$NS" -l app=payments -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)
  case "$reasons" in *CreateContainerConfigError*) break ;; esac
  sleep 2
done
log "Scenario secret-not-found is loaded in namespace $NS (payments Pods stuck in CreateContainerConfigError)"

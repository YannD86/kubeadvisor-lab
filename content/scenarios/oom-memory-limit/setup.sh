#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-oom
ensure_ns "$NS"
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-worker
  labels:
    app: report-worker
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: report-worker
  template:
    metadata:
      labels:
        app: report-worker
    spec:
      terminationGracePeriodSeconds: 2
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c"]
          # Loads the whole 300 MiB batch into memory (tail must buffer the single giant line), then idles.
          args:
            - "echo 'report-worker: loading batch'; head -c 300m /dev/zero | tail >/dev/null && echo 'batch done, idling' && sleep 3600"
          resources:
            requests: { cpu: 20m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML
# Do not wait for Ready: the container is OOM-killed on purpose. Bounded wait for the first kill.
for _ in $(seq 1 30); do
  reason=$(kc get pods -n "$NS" -l app=report-worker -o jsonpath='{.items[*].status.containerStatuses[0].lastState.terminated.reason}' 2>/dev/null || true)
  case "$reason" in *OOMKilled*) break ;; esac
  sleep 2
done
log "Scenario oom-memory-limit is loaded in namespace $NS (report-worker is OOMKilled on every start)"

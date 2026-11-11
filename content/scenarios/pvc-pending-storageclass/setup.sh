#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-storage
ensure_ns "$NS"
# Start clean so a re-run after a fix still produces the fault (PVC spec is immutable, apply would fail).
kc delete deploy uploads -n "$NS" --ignore-not-found --cascade=foreground --wait=true --timeout=60s >/dev/null
kc delete pvc data -n "$NS" --ignore-not-found --wait=true --timeout=60s >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
  labels:
    app: uploads
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: uploads
  labels:
    app: uploads
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: uploads
  template:
    metadata:
      labels:
        app: uploads
    spec:
      terminationGracePeriodSeconds: 2
      containers:
        - name: uploads
          image: busybox:1.36
          command: ["sh", "-c"]
          args:
            - "echo 'uploads: storage mounted at /data'; while true; do date -u +%FT%TZ >> /data/heartbeat.log; sleep 10; done"
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: data
YAML
# Do not wait for Ready: the Pod cannot be scheduled. Bounded wait for the scheduler's verdict.
for _ in $(seq 1 30); do
  phase=$(kc get pods -n "$NS" -l app=uploads -o jsonpath='{.items[*].status.phase}' 2>/dev/null || true)
  if [ "$phase" = "Pending" ] && [ -n "$(kc get events -n "$NS" --field-selector reason=FailedScheduling -o name 2>/dev/null)" ]; then break; fi
  sleep 2
done
log "Scenario pvc-pending-storageclass is loaded in namespace $NS (PVC data and Pod uploads are Pending)"

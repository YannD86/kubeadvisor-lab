#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-quota
ensure_ns "$NS"
# Quota first, so it is enforced before the Deployment creates Pods.
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
spec:
  hard:
    pods: "10"
    requests.cpu: 50m
    requests.memory: 256Mi
YAML
# Wait until the quota controller has computed usage (admission is only reliable after that).
for _ in $(seq 1 20); do
  [ -n "$(kc get resourcequota -n "$NS" team-quota -o jsonpath='{.status.hard}' 2>/dev/null)" ] && break
  sleep 1
done
# Recreate the Deployment so a re-run always starts from a fresh ReplicaSet (and fresh backoff).
kc delete deploy api -n "$NS" --ignore-not-found --cascade=foreground --wait=true --timeout=60s >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: api
spec:
  replicas: 5
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
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
          image: hashicorp/http-echo:1.0
          args: ["-listen=:5678", "-text=api ok"]
          ports:
            - name: http
              containerPort: 5678
          readinessProbe:
            httpGet: { path: /, port: http }
          resources:
            requests: { cpu: 20m, memory: 16Mi }
            limits: { memory: 32Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
    - name: http
      port: 80
      targetPort: http
YAML
# Only the two Pods that fit the quota will come up; do not wait for the rest.
wait_for_pods "$NS" "app=api" 90 || true
for _ in $(seq 1 30); do
  [ -n "$(kc get events -n "$NS" --field-selector reason=FailedCreate -o name 2>/dev/null)" ] && break
  sleep 2
done
log "Scenario resourcequota-blocks-rollout is loaded in namespace $NS (api stuck at 2/5, quota refuses the rest)"

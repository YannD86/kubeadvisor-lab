#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-rollout
ensure_ns "$NS"
# Start from a clean history so revision 1 is the healthy release and revision 2 the broken hotfix.
kc delete deploy web -n "$NS" --ignore-not-found --cascade=foreground --wait=true --timeout=90s >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
  annotations:
    kubernetes.io/change-cause: "release 2.4.0 (nginx:1.27-alpine)"
spec:
  replicas: 3
  progressDeadlineSeconds: 120
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
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
          readinessProbe:
            httpGet: { path: /, port: http }
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
# Revision 1 must be healthy before the broken hotfix lands.
wait_for_deploy "$NS" web 180
log "revision 1 is healthy; applying the broken hotfix (revision 2)"
# Strategic merge patch: only the image changes, probes/ports/resources are kept.
kc patch deploy web -n "$NS" -p '{"metadata":{"annotations":{"kubernetes.io/change-cause":"hotfix 2.4.1 (nginx:1.27-alpine-broken)"}},"spec":{"template":{"spec":{"containers":[{"name":"web","image":"nginx:1.27-alpine-broken"}]}}}}' >/dev/null
# Do not wait for the rollout: it is meant to hang. Bounded wait for the pull failure.
for _ in $(seq 1 30); do
  reasons=$(kc get pods -n "$NS" -l app=web -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)
  case "$reasons" in *ImagePullBackOff*|*ErrImagePull*) break ;; esac
  sleep 2
done
log "Scenario rollout-stuck-bad-image is loaded in namespace $NS (rollout of web stuck on revision 2)"

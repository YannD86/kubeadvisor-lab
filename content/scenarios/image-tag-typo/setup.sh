#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-images
ensure_ns "$NS"
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
  annotations:
    kubernetes.io/change-cause: "bump nginx to 1.27 alpine"
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
          image: nginx:1.27-alpnie
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
# Do not wait for Ready: the image cannot be pulled. Bounded wait for the fault to surface.
for _ in $(seq 1 30); do
  reasons=$(kc get pods -n "$NS" -l app=web -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null || true)
  case "$reasons" in *ImagePullBackOff*|*ErrImagePull*) break ;; esac
  sleep 2
done
log "Scenario image-tag-typo is loaded in namespace $NS (web Pods in ErrImagePull/ImagePullBackOff)"

#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-shop2
ensure_ns "$NS"

# Healthy Deployment (nginx listens on 80) + a Service whose targetPort points at 8080.
kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
        tier: frontend
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: 80 }
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
      targetPort: 8080
YAML

wait_for_pods "$NS" "app=web" 120
log "Scenario svc-wrong-targetport is loaded in namespace $NS (Service web -> targetPort 8080, nginx listens on 80)"

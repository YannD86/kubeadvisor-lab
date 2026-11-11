#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-netpol
ensure_ns "$NS"

kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  labels:
    app: backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: nginx
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
  name: backend
spec:
  selector:
    app: backend
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: curl
          image: curlimages/curl:8.10.1
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                curl -sS -o /dev/null -w "$(date +%T) GET http://backend -> %{http_code}\n" --max-time 3 http://backend || true
                sleep 5
              done
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
---
# The security baseline: deny all ingress to every Pod of the namespace.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  labels:
    owner: security-team
spec:
  podSelector: {}
  policyTypes: [Ingress]
YAML

wait_for_pods "$NS" "app=backend" 120
wait_for_pods "$NS" "app=frontend" 120
log "Scenario netpol-blocks-frontend is loaded in namespace $NS (default-deny-ingress drops frontend -> backend)"

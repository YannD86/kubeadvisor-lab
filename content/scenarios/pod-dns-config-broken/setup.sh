#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-dnspolicy
ensure_ns "$NS"

kc apply -n "$NS" -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  labels:
    app: backend
spec:
  replicas: 1
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
# Healthy neighbour: default dnsPolicy, same call loop.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reporting
  labels:
    app: reporting
spec:
  replicas: 1
  selector:
    matchLabels:
      app: reporting
  template:
    metadata:
      labels:
        app: reporting
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
# The broken one: detached from cluster DNS by a "performance tuning" change.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
  annotations:
    change-ticket: "CHG-2291 dns performance tuning"
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      dnsPolicy: None
      dnsConfig:
        nameservers:
          - 10.255.255.1
        searches:
          - lab-dnspolicy.svc.cluster.local
          - svc.cluster.local
          - cluster.local
        options:
          - name: ndots
            value: "2"
          - name: timeout
            value: "2"
          - name: attempts
            value: "1"
      containers:
        - name: curl
          image: curlimages/curl:8.10.1
          command: ["/bin/sh", "-c"]
          args:
            - |
              while true; do
                curl -sS -o /dev/null -w "$(date +%T) GET http://backend -> %{http_code}\n" --max-time 5 http://backend || true
                sleep 5
              done
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML

# All three Deployments reach Running (the broken app only fails inside its loop).
wait_for_pods "$NS" "app=backend" 120
wait_for_pods "$NS" "app=reporting" 120
wait_for_pods "$NS" "app=app" 120
log "Scenario pod-dns-config-broken is loaded in namespace $NS (app uses dnsPolicy None with an unreachable nameserver)"

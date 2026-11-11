#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-mount
ensure_ns "$NS"
# Recreate the ConfigMap so a key added by a previous attempt does not survive a re-run.
kc delete cm web-content -n "$NS" --ignore-not-found >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-content
data:
  index.html: |
    <!doctype html>
    <html>
      <head><title>Platform status</title></head>
      <body>
        <h1>Platform status</h1>
        <p>All systems nominal. Served from the web-content ConfigMap.</p>
        <p>all systems nominal</p>
      </body>
    </html>
  robots.txt: |
    User-agent: *
    Disallow: /
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
  annotations:
    kubernetes.io/change-cause: "tidy up volume definition"
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
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: http }
          volumeMounts:
            - name: content
              mountPath: /usr/share/nginx/html
              readOnly: true
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { memory: 64Mi }
      volumes:
        - name: content
          configMap:
            name: web-content
            items:
              - key: index.htm
                path: index.html
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
# Do not wait for Ready: the volume cannot be mounted. Bounded wait for the FailedMount event.
for _ in $(seq 1 30); do
  [ -n "$(kc get events -n "$NS" --field-selector reason=FailedMount -o name 2>/dev/null)" ] && break
  sleep 2
done
log "Scenario configmap-mount-wrong-key is loaded in namespace $NS (web Pods stuck in ContainerCreating)"

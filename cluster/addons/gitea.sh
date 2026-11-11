#!/usr/bin/env bash
# Install Gitea in namespace lab-gitea, exposed as NodePort 30080 (host: http://localhost:30080).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
GITEA_IMAGE="${GITEA_IMAGE:-gitea/gitea:1.22.6-rootless}"
NS=lab-gitea
kc get ns "$NS" >/dev/null 2>&1 || kc create ns "$NS" >/dev/null
kc apply -n "$NS" -f - <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: gitea-data
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitea
  labels: { app: gitea }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: gitea } }
  template:
    metadata:
      labels: { app: gitea }
    spec:
      securityContext: { fsGroup: 1000 }
      containers:
        - name: gitea
          image: $GITEA_IMAGE
          env:
            - { name: GITEA__security__INSTALL_LOCK, value: "true" }
            - { name: GITEA__server__ROOT_URL, value: "http://localhost:30080/" }
            - { name: GITEA__server__HTTP_PORT, value: "3000" }
            - { name: GITEA__server__DOMAIN, value: "localhost" }
            - { name: GITEA__database__DB_TYPE, value: "sqlite3" }
            - { name: GITEA__database__PATH, value: "/var/lib/gitea/data/gitea.db" }
            - { name: GITEA__service__DISABLE_REGISTRATION, value: "true" }
            - { name: GITEA__webhook__ALLOWED_HOST_LIST, value: "*" }
            - { name: GITEA__log__LEVEL, value: "Warn" }
          ports:
            - { name: http, containerPort: 3000 }
          readinessProbe:
            httpGet: { path: /api/healthz, port: http }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 512Mi }
          volumeMounts:
            - { name: data, mountPath: /var/lib/gitea }
            - { name: config, mountPath: /etc/gitea }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: gitea-data }
        - name: config
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: gitea
spec:
  type: NodePort
  selector: { app: gitea }
  ports:
    - { name: http, port: 3000, targetPort: http, nodePort: 30080 }
YAML
log "waiting for Gitea"
wait_for_deploy "$NS" gitea 300
POD=$(kc get pod -n "$NS" -l app=gitea -o jsonpath='{.items[0].metadata.name}')
# create the lab admin user (idempotent)
if ! kc exec -n "$NS" "$POD" -- gitea admin user list 2>/dev/null | awk '{print $2}' | grep -qx "$GITEA_USER"; then
  log "creating Gitea user $GITEA_USER"
  kc exec -n "$NS" "$POD" -- gitea admin user create --username "$GITEA_USER" --password "$GITEA_PASS" \
    --email "$GITEA_USER@sre-labs.local" --admin --must-change-password=false >/dev/null
fi
for i in $(seq 1 30); do gitea_ready && break; sleep 2; done
gitea_ready || die "Gitea API not reachable at $GITEA_HOST_URL"
log "Gitea ready: $GITEA_HOST_URL (user $GITEA_USER / $GITEA_PASS)"

#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-dns
BACKUP_DIR="$LAB_HOME/backup/coredns-corefile-broken"
mkdir -p "$BACKUP_DIR"
ensure_ns "$NS"

# Demo app: backend (nginx) + frontend that calls it by name in a loop.
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
YAML

# Healthy prerequisites only: the app Pods do not need DNS to start.
wait_for_pods "$NS" "app=backend" 120
wait_for_pods "$NS" "app=frontend" 120

# Back up the Corefile while it is still healthy. On a re-run (already broken)
# the existing backup is kept rather than overwritten with the broken one.
current="$(kc -n kube-system get cm coredns -o jsonpath='{.data.Corefile}')"
if printf '%s\n' "$current" | grep -q 'kubernetes cluster\.local'; then
  printf '%s\n' "$current" > "$BACKUP_DIR/Corefile"
  log "Backed up CoreDNS Corefile to $BACKUP_DIR/Corefile"
elif [ ! -s "$BACKUP_DIR/Corefile" ]; then
  warn "Corefile is not in the expected healthy state and no backup exists; cleanup will fall back to a default Corefile"
fi

# Break it: serve the wrong zone so every *.cluster.local query falls through to the upstream resolver.
broken="$(printf '%s\n' "$current" | sed 's/kubernetes cluster\.local/kubernetes cluster.wrong/')"
kc -n kube-system create configmap coredns --from-literal=Corefile="$broken" --dry-run=client -o yaml \
  | kc apply -f - >/dev/null
kc -n kube-system rollout restart deploy/coredns >/dev/null
wait_for_deploy kube-system coredns 120

log "Scenario coredns-corefile-broken is loaded: CoreDNS serves zone cluster.wrong; demo app in namespace $NS"

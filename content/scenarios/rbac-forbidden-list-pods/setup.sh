#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-rbac
ensure_ns "$NS"
# A re-run must restore the broken binding even if a learner added extra grants.
kc delete rolebinding -n "$NS" -l app=pod-watcher --ignore-not-found >/dev/null
kc delete clusterrolebinding -l app=pod-watcher --ignore-not-found >/dev/null
kc apply -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pod-watcher
  labels:
    app: pod-watcher
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  labels:
    app: pod-watcher
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-watcher-binding
  labels:
    app: pod-watcher
subjects:
  - kind: ServiceAccount
    name: pod-watcher-sa
    namespace: lab-rbac
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pod-watcher
  labels:
    app: pod-watcher
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pod-watcher
  template:
    metadata:
      labels:
        app: pod-watcher
    spec:
      serviceAccountName: pod-watcher
      terminationGracePeriodSeconds: 2
      containers:
        - name: watcher
          image: curlimages/curl:8.10.1
          command: ["sh", "-c"]
          args:
            - |
              T=/var/run/secrets/kubernetes.io/serviceaccount
              URL=https://kubernetes.default.svc/api/v1/namespaces/lab-rbac/pods
              while true; do
                code=$(curl -s -o /tmp/body -w '%{http_code}' --cacert "$T/ca.crt" \
                  -H "Authorization: Bearer $(cat "$T/token")" "$URL" || echo 000)
                echo "$(date -u +%H:%M:%S) GET /api/v1/namespaces/lab-rbac/pods -> HTTP $code"
                [ "$code" = 200 ] || sed -n 's/.*"message":"\([^"]*\)".*/  \1/p' /tmp/body
                sleep 10
              done
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
YAML
# The Pod itself is healthy; the fault is in its logs.
wait_for_pods "$NS" "app=pod-watcher" 120
for _ in $(seq 1 30); do
  logs=$(kc logs -n "$NS" deploy/pod-watcher --tail=3 2>/dev/null || true)
  case "$logs" in *"HTTP 403"*) break ;; esac
  sleep 2
done
log "Scenario rbac-forbidden-list-pods is loaded in namespace $NS (pod-watcher logs HTTP 403 on every poll)"

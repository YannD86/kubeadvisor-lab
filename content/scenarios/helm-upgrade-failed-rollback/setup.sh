#!/usr/bin/env bash
# helm-upgrade-failed-rollback: install a minimal local nginx chart (revision 1, healthy), then upgrade it
# to an image tag that does not exist. The upgrade times out, revision 2 is recorded as failed, the new Pod
# sits in ImagePullBackOff while the old ReplicaSet keeps serving. No Flux involved.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-helmcli
REL=web
CHART="$LAB_WORKDIR/webchart"
hm() { helm --kubeconfig "$KUBECONFIG" "$@"; }

ensure_ns "$NS"
# Reset a previous run so the history is always: 1 deployed -> 2 failed.
hm uninstall "$REL" -n "$NS" --wait >/dev/null 2>&1 || true

# ---- 1. A minimal chart: Chart.yaml, values.yaml, Deployment with a readiness probe, Service.
rm -rf "$CHART"
mkdir -p "$CHART/templates"
cat > "$CHART/Chart.yaml" <<'YAML'
apiVersion: v2
name: webchart
description: Minimal nginx chart used by SRE Kube Labs
type: application
version: 0.1.0
appVersion: "1.27"
YAML
cat > "$CHART/values.yaml" <<'YAML'
replicaCount: 2
image:
  repository: nginx
  tag: 1.27-alpine
service:
  port: 80
resources:
  requests:
    cpu: 20m
    memory: 32Mi
  limits:
    memory: 64Mi
YAML
cat > "$CHART/templates/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: web
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: http
            periodSeconds: 5
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
YAML
cat > "$CHART/templates/service.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
spec:
  selector:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
YAML

# ---- 2. Revision 1: healthy (this part is supposed to work, so we wait).
log "installing release $REL (revision 1)"
hm install "$REL" "$CHART" -n "$NS" --create-namespace --wait --timeout 180s >/dev/null

# ---- 3. Revision 2: an image tag that does not exist. The upgrade must fail; do not wait beyond its timeout.
log "upgrading $REL to a broken image tag (expected to fail after 40s)"
hm upgrade "$REL" "$CHART" -n "$NS" --set image.tag=1.27-alpine-broken --wait --timeout 40s >/dev/null 2>&1 || true

log "Scenario helm-upgrade-failed-rollback is loaded: release $REL in $NS is failed at revision 2 (chart source: $CHART)"

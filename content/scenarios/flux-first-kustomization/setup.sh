#!/usr/bin/env bash
# flux-first-kustomization: seed the Git repository and the Flux namespace. Nothing else:
# the learner writes the GitRepository and the Kustomization.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-flux1
REPO=flux-first-kustomization
SEED="$LAB_WORKDIR/$REPO"

# ---- 1. Seed the repository: deploy/podinfo/{namespace,deployment,service,kustomization}.yaml
rm -rf "$SEED"
mkdir -p "$SEED/deploy/podinfo"
cat > "$SEED/README.md" <<'MD'
# flux-first-kustomization

Manifests for podinfo, applied by Flux from `deploy/podinfo`.
MD
cat > "$SEED/deploy/podinfo/namespace.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lab-podinfo
YAML
cat > "$SEED/deploy/podinfo/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: lab-podinfo
  labels:
    app: podinfo
spec:
  replicas: 2
  selector:
    matchLabels:
      app: podinfo
  template:
    metadata:
      labels:
        app: podinfo
    spec:
      containers:
        - name: podinfo
          image: ghcr.io/stefanprodan/podinfo:6.7.1
          ports:
            - name: http
              containerPort: 9898
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 128Mi }
YAML
cat > "$SEED/deploy/podinfo/service.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: podinfo
  namespace: lab-podinfo
spec:
  selector:
    app: podinfo
  ports:
    - name: http
      port: 9898
      targetPort: http
YAML
cat > "$SEED/deploy/podinfo/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - deployment.yaml
  - service.yaml
YAML
gitea_push_dir "$SEED" "$REPO" main "podinfo manifests"

# ---- 2. The namespace for the learner's Flux objects. Nothing else is created on purpose.
ensure_ns "$NS"

log "Scenario $REPO is loaded: repo $(gitea_repo_cluster_url "$REPO"), namespace $NS is empty and waiting for your GitRepository + Kustomization"

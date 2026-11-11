#!/usr/bin/env bash
# flux-kustomization-wrong-path: healthy GitRepository, Kustomization pointing at ./deploy/prod
# while the repository only has ./deploy/production.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-path          # Flux objects
APP_NS=lab-prod      # created by the manifests in Git
REPO=flux-kustomization-wrong-path
SEED="$LAB_WORKDIR/$REPO"

# ---- 1. Seed the repository under deploy/production (NOT deploy/prod)
rm -rf "$SEED"
mkdir -p "$SEED/deploy/production"
cat > "$SEED/README.md" <<'MD'
# flux-kustomization-wrong-path

Production manifests for podinfo live in `deploy/production`.
MD
cat > "$SEED/deploy/production/namespace.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lab-prod
YAML
cat > "$SEED/deploy/production/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: lab-prod
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
cat > "$SEED/deploy/production/service.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: podinfo
  namespace: lab-prod
spec:
  selector:
    app: podinfo
  ports:
    - name: http
      port: 9898
      targetPort: http
YAML
cat > "$SEED/deploy/production/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - deployment.yaml
  - service.yaml
YAML
gitea_push_dir "$SEED" "$REPO" main "production manifests for podinfo"

# ---- 2. Flux source (healthy). Wait for it so the Kustomization fails on the path, not on the source.
ensure_ns "$NS"
kc apply -f - <<YAML
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: podinfo
  namespace: $NS
spec:
  interval: 30s
  url: $(gitea_repo_cluster_url "$REPO")
  ref:
    branch: main
YAML
deadline=$(( $(date +%s) + 90 ))
until [ "$(kc get gitrepository -n "$NS" podinfo -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "GitRepository podinfo not Ready yet; source-controller will retry on its own"; break; fi
  sleep 3
done

# ---- 3. The broken Kustomization: path ./deploy/prod does not exist in the artifact. Do not wait for it.
kc apply -f - <<YAML
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: podinfo
  namespace: $NS
spec:
  interval: 1m
  timeout: 2m
  sourceRef:
    kind: GitRepository
    name: podinfo
  path: ./deploy/prod
  prune: true
  wait: true
YAML
log "Scenario $REPO is loaded: Kustomization podinfo in $NS points at a path that is not in Git (app namespace $APP_NS will not appear)"

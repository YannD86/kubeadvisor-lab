#!/usr/bin/env bash
# flux-dependency-missing: GitRepository platform + Kustomization app (dependsOn infra).
# The Kustomization infra was never created, so app waits forever.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-dep            # Flux objects
APP_NS=lab-dep-app    # created by ./infra in Git
REPO=flux-dependency-missing
SEED="$LAB_WORKDIR/$REPO"

# ---- 1. Seed the repository with two layers
rm -rf "$SEED"
mkdir -p "$SEED/infra" "$SEED/app"
cat > "$SEED/README.md" <<'MD'
# flux-dependency-missing

- `infra/`: namespace `lab-dep-app` and the ConfigMap podinfo reads at start-up.
- `app/`: podinfo Deployment + Service. Must be applied after `infra/`.
MD
cat > "$SEED/infra/namespace.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lab-dep-app
YAML
cat > "$SEED/infra/configmap.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: podinfo-config
  namespace: lab-dep-app
data:
  PODINFO_UI_COLOR: "#34577c"
  PODINFO_UI_MESSAGE: "settings served by the infra layer"
YAML
cat > "$SEED/infra/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - configmap.yaml
YAML
cat > "$SEED/app/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: lab-dep-app
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
          envFrom:
            - configMapRef:
                name: podinfo-config
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
cat > "$SEED/app/service.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: podinfo
  namespace: lab-dep-app
spec:
  selector:
    app: podinfo
  ports:
    - name: http
      port: 9898
      targetPort: http
YAML
cat > "$SEED/app/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
YAML
gitea_push_dir "$SEED" "$REPO" main "split podinfo into infra and app layers"

# ---- 2. Reset a previous attempt: if a learner created infra, remove it (prune GCs lab-dep-app).
ensure_ns "$NS"
kc delete kustomization infra -n "$NS" --ignore-not-found --timeout=60s >/dev/null 2>&1 || true

# ---- 3. Source (healthy); wait for it so app fails on the dependency, not on the artifact.
kc apply -f - <<YAML
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: platform
  namespace: $NS
spec:
  interval: 30s
  url: $(gitea_repo_cluster_url "$REPO")
  ref:
    branch: main
YAML
deadline=$(( $(date +%s) + 90 ))
until [ "$(kc get gitrepository -n "$NS" platform -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "True" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then warn "GitRepository platform not Ready yet; source-controller will retry on its own"; break; fi
  sleep 3
done

# ---- 4. The app Kustomization, depending on an infra Kustomization that does not exist. Do not wait.
kc apply -f - <<YAML
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: app
  namespace: $NS
spec:
  interval: 1m
  timeout: 3m
  dependsOn:
    - name: infra
  sourceRef:
    kind: GitRepository
    name: platform
  path: ./app
  prune: true
  wait: true
YAML
log "Scenario $REPO is loaded: Kustomization app in $NS waits for a dependency 'infra' that nobody created (namespace $APP_NS will not appear)"

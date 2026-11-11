#!/usr/bin/env bash
# flux-suspended-drift: reconcile podinfo once through Flux (healthy), then suspend the
# Kustomization and scale the Deployment to 0 by hand. Flux cannot correct the drift while suspended.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-drift           # Flux objects
APP_NS=lab-drift-app   # created by the manifests in Git
REPO=flux-suspended-drift
SEED="$LAB_WORKDIR/$REPO"

ks_ready() { # ks_ready <ns> <name>: Ready=True at the current generation
  local ready obs gen
  ready=$(kc get kustomization -n "$1" "$2" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
  obs=$(kc get kustomization -n "$1" "$2" -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)
  gen=$(kc get kustomization -n "$1" "$2" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)
  [ "$ready" = "True" ] && [ -n "$obs" ] && [ "$obs" = "$gen" ]
}
wait_for_ks() { # wait_for_ks <ns> <name> [timeout]
  local deadline=$(( $(date +%s) + ${3:-180} ))
  until ks_ready "$1" "$2"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      kc get kustomization -n "$1" "$2" -o yaml 2>/dev/null | sed -n '/^status:/,$p' >&2 || true
      die "Kustomization $2 in $1 did not become Ready in ${3:-180}s"
    fi
    sleep 3
  done
}

# ---- 1. Seed the repository: Git says 2 replicas
rm -rf "$SEED"
mkdir -p "$SEED/deploy/podinfo"
cat > "$SEED/README.md" <<'MD'
# flux-suspended-drift

podinfo, reconciled by the Flux Kustomization `podinfo` in namespace `lab-drift`.
MD
cat > "$SEED/deploy/podinfo/namespace.yaml" <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lab-drift-app
YAML
cat > "$SEED/deploy/podinfo/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: lab-drift-app
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
  namespace: lab-drift-app
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
gitea_push_dir "$SEED" "$REPO" main "podinfo: 2 replicas"

# ---- 2. Flux objects. suspend is set explicitly to false so a re-run starts from the healthy state.
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
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: podinfo
  namespace: $NS
spec:
  interval: 1m
  timeout: 3m
  suspend: false
  sourceRef:
    kind: GitRepository
    name: podinfo
  path: ./deploy/podinfo
  prune: true
  wait: true
YAML

# ---- 3. This part is supposed to work: wait for the first successful reconciliation.
log "waiting for Flux to apply the repository once (healthy baseline)"
wait_for_ks "$NS" podinfo 240
wait_for_deploy "$APP_NS" podinfo 120

# ---- 4. Break it: pause Flux, then drift by hand. Make sure the drift sticks.
kc patch kustomization podinfo -n "$NS" --type merge -p '{"spec":{"suspend":true}}' >/dev/null
for _ in 1 2 3; do
  kc scale deploy -n "$APP_NS" podinfo --replicas=0 >/dev/null
  sleep 4
  [ "$(kc get deploy -n "$APP_NS" podinfo -o jsonpath='{.spec.replicas}')" = "0" ] && break
done
log "Scenario $REPO is loaded: Kustomization podinfo in $NS is suspended, Deployment podinfo in $APP_NS scaled to 0 while Git says 2"

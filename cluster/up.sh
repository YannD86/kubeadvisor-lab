#!/usr/bin/env bash
# Create the sre-labs kind cluster with Calico CNI. Idempotent.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CALICO_VERSION="${CALICO_VERSION:-v3.29.3}"
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-}"   # e.g. kindest/node:v1.32.2 ; empty = kind default

mkdir -p "$LAB_HOME" "$LAB_HOME/work" "$LAB_HOME/backup" "$LAB_HOME/state"
docker_ok || die "Docker is not running. Start Docker Desktop (or dockerd) and retry."
command -v kind >/dev/null || die "kind is not installed (brew install kind)"

if cluster_exists; then
  log "cluster $LAB_CLUSTER already exists"
else
  log "creating kind cluster $LAB_CLUSTER (3 nodes, no default CNI)"
  args=(create cluster --config "$LAB_ROOT/cluster/kind-config.yaml" --kubeconfig "$KUBECONFIG" --wait 0s)
  [ -n "$KIND_NODE_IMAGE" ] && args+=(--image "$KIND_NODE_IMAGE")
  kind "${args[@]}"
fi
kind export kubeconfig --name "$LAB_CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null
chmod 600 "$KUBECONFIG"

if ! kc get ds -n kube-system calico-node >/dev/null 2>&1; then
  log "installing Calico $CALICO_VERSION"
  kc apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" >/dev/null
fi
log "waiting for Calico to be ready (this pulls images on first run)"
kc rollout status -n kube-system ds/calico-node --timeout=300s >/dev/null
for n in "$CP_NODE" "$WORKER1" "$WORKER2"; do wait_for_node_ready "$n" 300; done
kc rollout status -n kube-system deploy/coredns --timeout=180s >/dev/null

# pre-pull the small images scenarios use so first scenario loads are fast
log "pre-pulling lab images on nodes (background)"
for img in nginx:1.27-alpine busybox:1.36 curlimages/curl:8.10.1 ghcr.io/stefanprodan/podinfo:6.7.1; do
  for n in "$WORKER1" "$WORKER2"; do
    (node_exec "$n" crictl pull "$img" >/dev/null 2>&1 || true) &
  done
done
wait || true

log "cluster $LAB_CLUSTER is ready"
kc get nodes

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
MS_VERSION="${MS_VERSION:-v0.7.2}"
if ! addon_installed metrics-server; then
  log "installing metrics-server $MS_VERSION"
  kc apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${MS_VERSION}/components.yaml" >/dev/null
  kc patch -n kube-system deploy metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
fi
wait_for_deploy kube-system metrics-server 180
log "metrics-server ready (kubectl top works after ~30s)"

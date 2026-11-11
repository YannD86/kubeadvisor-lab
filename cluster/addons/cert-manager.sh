#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
CM_VERSION="${CM_VERSION:-v1.16.2}"
if ! addon_installed cert-manager; then
  log "installing cert-manager $CM_VERSION"
  kc apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CM_VERSION}/cert-manager.yaml" >/dev/null
fi
for d in cert-manager cert-manager-webhook cert-manager-cainjector; do wait_for_deploy cert-manager "$d" 300; done
sleep 5
kc apply -f - <<'YAML'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
YAML
log "cert-manager ready with ClusterIssuer selfsigned"

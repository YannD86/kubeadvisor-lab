#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
if ! addon_installed ingress-nginx; then
  log "installing ingress-nginx (kind flavour)"
  kc apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml >/dev/null
fi
log "waiting for ingress-nginx controller"
kc wait -n ingress-nginx --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s >/dev/null
log "ingress-nginx ready on http://localhost:8080 and https://localhost:8443"

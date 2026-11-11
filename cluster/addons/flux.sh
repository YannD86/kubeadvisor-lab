#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
command -v flux >/dev/null || die "flux CLI not installed (brew install fluxcd/tap/flux)"
if addon_installed flux; then
  log "Flux already installed"
else
  log "installing Flux controllers"
  flux install --kubeconfig "$KUBECONFIG" --components-extra=image-reflector-controller,image-automation-controller
fi
flux check --kubeconfig "$KUBECONFIG" >/dev/null && log "Flux is healthy"

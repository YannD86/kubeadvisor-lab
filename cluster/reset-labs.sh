#!/usr/bin/env bash
# Remove every lab-* namespace (except lab-gitea) and Flux objects created by scenarios.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cleanup_lab_namespaces
log "lab namespaces deletion requested"

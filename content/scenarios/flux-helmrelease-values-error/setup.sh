#!/usr/bin/env bash
# flux-helmrelease-values-error: HelmRepository (public, podinfo) + HelmRelease whose values set
# replicaCount to the string "two". The rendered Deployment is rejected by the API server, Helm records
# revision 1 as failed and helm-controller marks the HelmRelease Ready=False (InstallFailed) and Stalled.
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-helm
ensure_ns "$NS"

# Reset a previous run: removing the HelmRelease makes helm-controller uninstall the failed/fixed release,
# so the symptom is always the initial install failure.
kc delete helmrelease podinfo -n "$NS" --ignore-not-found --timeout=90s >/dev/null 2>&1 || true

kc apply -f - <<'YAML'
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: podinfo
  namespace: lab-helm
spec:
  interval: 10m
  url: https://stefanprodan.github.io/podinfo
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: podinfo
  namespace: lab-helm
spec:
  interval: 1m
  timeout: 3m
  chart:
    spec:
      chart: podinfo
      version: "6.7.x"
      sourceRef:
        kind: HelmRepository
        name: podinfo
      interval: 10m
  values:
    replicaCount: "two"
    resources:
      requests:
        cpu: 10m
        memory: 32Mi
YAML
# Do not wait: the install is expected to fail.
log "Scenario flux-helmrelease-values-error is loaded: HelmRelease podinfo in $NS will fail its install (replicaCount is a string)"

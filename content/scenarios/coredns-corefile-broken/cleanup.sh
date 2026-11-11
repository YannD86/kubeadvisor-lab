#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-dns
BACKUP_DIR="$LAB_HOME/backup/coredns-corefile-broken"

# Standard kubeadm Corefile, used only if no backup exists and the live one cannot be repaired.
DEFAULT_COREFILE='.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30
    loop
    reload
    loadbalance
}'

restore_corefile() {
  local desired
  if [ -s "$BACKUP_DIR/Corefile" ]; then
    desired="$(cat "$BACKUP_DIR/Corefile")"
    log "Restoring CoreDNS Corefile from $BACKUP_DIR/Corefile"
  else
    desired="$(kc -n kube-system get cm coredns -o jsonpath='{.data.Corefile}' 2>/dev/null | sed 's/kubernetes cluster\.wrong/kubernetes cluster.local/')"
    if ! printf '%s\n' "$desired" | grep -q 'kubernetes cluster\.local'; then
      warn "No backup and live Corefile not repairable by substitution; writing the kubeadm default Corefile"
      desired="$DEFAULT_COREFILE"
    else
      log "No backup found; repaired the live Corefile by substitution"
    fi
  fi
  kc -n kube-system create configmap coredns --from-literal=Corefile="$desired" --dry-run=client -o yaml \
    | kc apply -f - >/dev/null
  kc -n kube-system rollout restart deploy/coredns >/dev/null
}

ok=1
if ! restore_corefile; then
  warn "Could not restore the coredns ConfigMap; check kube-system manually"; ok=0
fi
if ! wait_for_deploy kube-system coredns 120; then
  warn "CoreDNS did not become Ready within 120s"; ok=0
fi

kc delete ns "$NS" --ignore-not-found --wait=false || true

if [ "$ok" = 1 ]; then
  rm -rf "$BACKUP_DIR"
  log "cleaned up coredns-corefile-broken (Corefile restored, CoreDNS Ready)"
else
  warn "cleanup finished with warnings; backup kept in $BACKUP_DIR"
fi

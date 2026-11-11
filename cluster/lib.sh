#!/usr/bin/env bash
# Shared helpers for cluster scripts and scenarios. Source this file.

: "${LAB_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
: "${LAB_CLUSTER:=sre-labs}"
: "${LAB_HOME:=$HOME/.sre-labs}"
: "${KUBECONFIG:=$LAB_HOME/kubeconfig}"
export LAB_ROOT LAB_CLUSTER LAB_HOME KUBECONFIG

CP_NODE="${LAB_CLUSTER}-control-plane"
WORKER1="${LAB_CLUSTER}-worker"
WORKER2="${LAB_CLUSTER}-worker2"

log()  { printf '\033[1;34m[lab]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[lab]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[lab]\033[0m %s\n' "$*" >&2; exit 1; }

kc() { kubectl --kubeconfig "$KUBECONFIG" "$@"; }

ensure_ns() {
  local ns="$1"
  kc get ns "$ns" >/dev/null 2>&1 || kc create ns "$ns" >/dev/null
  kc label ns "$ns" sre-labs/scenario="${LAB_SCENARIO:-manual}" --overwrite >/dev/null
}

# wait_for_pods <ns> <label-selector> [timeout-seconds]
wait_for_pods() {
  local ns="$1" sel="$2" timeout="${3:-240}"
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    local total ready
    total=$(kc get pods -n "$ns" -l "$sel" --no-headers 2>/dev/null | wc -l)
    ready=$(kc get pods -n "$ns" -l "$sel" --no-headers 2>/dev/null | awk '{ split($2, a, "/"); if (a[1] == a[2] && a[1] > 0 && $3 == "Running") n++ } END { print n+0 }')
    if [ "$total" -gt 0 ] && [ "$total" -eq "$ready" ]; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "timeout waiting for pods ($sel) in $ns"; kc get pods -n "$ns" -l "$sel" || true; return 1
    fi
    sleep 2
  done
}

# wait_for_deploy <ns> <name> [timeout]
wait_for_deploy() {
  kc rollout status -n "$1" "deploy/$2" --timeout="${3:-240}s" >/dev/null
}

# node_exec <node> <cmd...>   -- run a command inside a kind node container
node_exec() {
  local node="$1"; shift
  docker exec "$node" "$@"
}

# wait_for_node_ready <node> [timeout]
wait_for_node_ready() {
  local node="$1" timeout="${2:-120}"
  local deadline=$(( $(date +%s) + timeout ))
  until kc get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q True; do
    [ "$(date +%s)" -ge "$deadline" ] && { warn "node $node not Ready after ${timeout}s"; return 1; }
    sleep 3
  done
}

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$LAB_CLUSTER"; }

docker_ok() { docker info >/dev/null 2>&1; }

# The kubeconfig lives at $LAB_HOME/kubeconfig. When it is missing while the kind
# cluster exists (LAB_HOME moved, e.g. ~/.sre-labs -> ~/.kubeadvisor, or the file
# was deleted) every kubectl in the lab fails, so regenerate it from the cluster.
ensure_kubeconfig() {
  [ -f "$KUBECONFIG" ] && return 0
  command -v kind >/dev/null 2>&1 || return 1
  cluster_exists || return 1
  warn "kubeconfig missing; regenerating $KUBECONFIG from kind cluster $LAB_CLUSTER"
  mkdir -p "$(dirname "$KUBECONFIG")"
  kind export kubeconfig --name "$LAB_CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 && chmod 600 "$KUBECONFIG"
}
ensure_kubeconfig || true

addon_installed() {
  case "$1" in
    flux)           kc get deploy -n flux-system source-controller >/dev/null 2>&1 ;;
    gitea)          kc get deploy -n lab-gitea gitea >/dev/null 2>&1 ;;
    ingress-nginx)  kc get deploy -n ingress-nginx ingress-nginx-controller >/dev/null 2>&1 ;;
    metrics-server) kc get deploy -n kube-system metrics-server >/dev/null 2>&1 ;;
    cert-manager)   kc get deploy -n cert-manager cert-manager >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Delete every lab-* namespace except the shared infra ones.
cleanup_lab_namespaces() {
  kc get ns -o name 2>/dev/null | sed 's#namespace/##' | grep -E '^lab-' | grep -vE '^lab-gitea$' \
    | xargs -r -n1 kc delete ns --ignore-not-found --wait=false >/dev/null || true
}

# ---------------- Gitea helpers (addon: gitea) ----------------
GITEA_HOST_URL="${GITEA_HOST_URL:-http://localhost:30080}"            # from the host / lab terminal
GITEA_CLUSTER_URL="${GITEA_CLUSTER_URL:-http://gitea.lab-gitea.svc.cluster.local:3000}"  # from inside the cluster (Flux)
GITEA_USER="${GITEA_USER:-lab}"
GITEA_PASS="${GITEA_PASS:-labpass123}"

gitea_api() { # gitea_api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -u "$GITEA_USER:$GITEA_PASS" -X "$method" -H 'Content-Type: application/json' "$GITEA_HOST_URL/api/v1$path" -d "$body"
  else
    curl -fsS -u "$GITEA_USER:$GITEA_PASS" -X "$method" "$GITEA_HOST_URL/api/v1$path"
  fi
}

gitea_ready() { curl -fsS "$GITEA_HOST_URL/api/v1/version" >/dev/null 2>&1; }

# gitea_create_repo <name>   (public repo under user lab; idempotent)
gitea_create_repo() {
  local name="$1"
  gitea_api GET "/repos/$GITEA_USER/$name" >/dev/null 2>&1 && return 0
  gitea_api POST "/user/repos" "{\"name\":\"$name\",\"private\":false,\"auto_init\":false,\"default_branch\":\"main\"}" >/dev/null
}

# gitea_delete_repo <name>
gitea_delete_repo() { gitea_api DELETE "/repos/$GITEA_USER/$1" >/dev/null 2>&1 || true; }

# gitea_push_dir <dir> <repo> [branch] [message]  -- force-push a directory as the repo content
gitea_push_dir() {
  local dir="$1" repo="$2" branch="${3:-main}" msg="${4:-lab seed}"
  gitea_create_repo "$repo"
  ( cd "$dir" \
    && rm -rf .git && git init -q -b "$branch" \
    && git -c user.name=lab -c user.email=lab@sre-labs.local add -A \
    && git -c user.name=lab -c user.email=lab@sre-labs.local commit -q -m "$msg" \
    && git push -q --force "http://$GITEA_USER:$GITEA_PASS@${GITEA_HOST_URL#http://}/$GITEA_USER/$repo.git" "$branch" )
}

# gitea_repo_cluster_url <repo>  -> URL Flux should use
gitea_repo_cluster_url() { echo "$GITEA_CLUSTER_URL/$GITEA_USER/$1.git"; }

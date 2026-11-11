---
title: "kube-apiserver: flags, API groups, health endpoints and fairness"
slug: kube-apiserver
realm: components
order: 3
summary: "The flags that shape a cluster, how discovery and the aggregation layer work, what /livez and /readyz tell you, how Priority and Fairness protects the server, and how to read its logs when kubectl is dead."
estimated_minutes: 18
level: intermediate
tags: [apiserver, admission, aggregation, crd, apf, audit, health]
builders: [crd-definition]
scenarios: [apiserver-etcd-wrong-port]
quiz:
  - q: "You set `--enable-admission-plugins=NodeRestriction`. Is LimitRanger still active?"
    options: ["No, only listed plugins run", "Yes, the flag adds to the default set; use --disable-admission-plugins to remove one", "Only if a LimitRange object exists", "Only in kube-system"]
    answer: 1
    explain: "The API server ships a default list of enabled plugins. --enable-admission-plugins appends to it (and controls nothing about order); --disable-admission-plugins subtracts from it."
  - q: "`kubectl get --raw /readyz?verbose` shows `[-]etcd failed`. What does the API server do with new requests?"
    options: ["Serves them from the watch cache", "Keeps serving reads and writes", "Fails readiness so load balancers stop sending traffic; requests that reach it fail with 5xx", "Restarts itself"]
    answer: 2
    explain: "/readyz is the signal for 'send me traffic'. Without etcd the server cannot serve consistent reads or any write, so it reports not-ready. kubectl sees connection errors or 'apiserver not ready'."
  - q: "Where do CustomResourceDefinitions get served?"
    options: ["By a separate apiextensions Pod you must deploy", "By kube-controller-manager", "Inside kube-apiserver itself; no extra process is needed", "By the aggregation layer forwarding to CoreDNS"]
    answer: 2
    explain: "The apiextensions server is compiled into kube-apiserver. A CRD only teaches it a new schema and a new etcd prefix. Aggregated APIs (APIService objects) are the ones that proxy to an external server."
---

# kube-apiserver

The API server is a stateless HTTP server in front of etcd, plus every
cross-cutting policy the cluster has: identity, permission, defaults,
validation, audit and fairness. It is stateless in the sense that you can run
three behind a load balancer; it is anything but simple.

## The flags that matter

kubeadm writes the command line into the static pod manifest. Read it from the
mirror Pod or from the file on the node.

| Flag | What it decides | Lab value |
|---|---|---|
| `--etcd-servers`, `--etcd-cafile/certfile/keyfile` | Where state lives and how to authenticate to it | `https://127.0.0.1:2379`, certs under `/etc/kubernetes/pki/` |
| `--service-cluster-ip-range` | The CIDR ClusterIPs are allocated from; `kubernetes.default` is its first address | `10.96.0.0/16` |
| `--service-node-port-range` | NodePort allocation range | default `30000-32767` |
| `--authorization-mode` | Which authorizers run, in order | `Node,RBAC` |
| `--enable-admission-plugins` / `--disable-admission-plugins` | Adds to or removes from the built-in default list | `NodeRestriction` enabled |
| `--service-account-issuer`, `--service-account-signing-key-file` | Who signs Pod tokens and what `iss` they carry | `https://kubernetes.default.svc.cluster.local`, `sa.key` |
| `--requestheader-*`, `--proxy-client-cert-file` | Trust between the API server and aggregated API servers | front-proxy CA |
| `--audit-policy-file`, `--audit-log-path`, `--audit-log-maxage/maxbackup/maxsize` | Whether and how requests are logged | not set by default in kubeadm |
| `--max-requests-inflight`, `--max-mutating-requests-inflight` | Global concurrency ceilings, now shared out by APF | defaults 400 / 200 |
| `--feature-gates`, `--runtime-config` | Alpha features and non-default API groups | unset |

**Gotcha:** changing a flag means editing
`/etc/kubernetes/manifests/kube-apiserver.yaml` on the node. The kubelet
notices the file change and restarts the static pod. A typo takes the API
down for everyone, and `kubectl` cannot help you fix it. Keep a copy of the
file before editing; the **apiserver-etcd-wrong-port** scenario is exactly
this failure.

Audit logging deserves one more line: the policy file has four levels
(`None`, `Metadata`, `Request`, `RequestResponse`) matched per resource and
verb, and the log is written by the API server process, so the path must be a
`hostPath` volume in the static pod manifest or the file lands inside the
container and disappears with it.

## API groups and discovery

Resources live in groups and versions: `/api/v1` for the legacy core group
(`pods`, `services`, `nodes`), `/apis/<group>/<version>` for everything else
(`apps/v1`, `batch/v1`, `networking.k8s.io/v1`). `kubectl` does not have the
list compiled in; it asks the server, caches the answer under
`~/.kube/cache/discovery`, and uses it to turn `deploy` into
`deployments.apps`.

Two mechanisms extend the API:

- **CustomResourceDefinitions** are served by code compiled into
  kube-apiserver. A CRD adds a schema, a storage prefix in etcd and a new
  entry in discovery. The `crd-definition` builder walks through writing
  one.
- **The aggregation layer** registers an `APIService` object that says "for
  group `metrics.k8s.io`, proxy to this Service". kube-apiserver
  authenticates to that backend with the front-proxy client certificate,
  which is what the `--requestheader-*` flags configure. metrics-server is
  the one you will meet; `kubectl get apiservices` shows `Local` for built-in
  groups and a Service name for aggregated ones.

## Health endpoints

| Endpoint | Meaning | Use |
|---|---|---|
| `/livez` | The process is not deadlocked | kubelet liveness probe of the static pod |
| `/readyz` | Ready to serve: etcd reachable, informers synced, not shutting down | load balancer and kubelet readiness probe |
| `/healthz` | Legacy, deprecated alias | avoid in new tooling |

Append `?verbose` to see each check, and `?exclude=<check>` to ignore one.
During a graceful shutdown `/readyz` fails first
(`--shutdown-delay-duration`) so that load balancers drain before the
listener closes.

## Priority and Fairness

A single misbehaving controller doing a tight list loop used to starve the
whole cluster. API Priority and Fairness (APF) replaces the two in-flight
counters with queues. A `FlowSchema` matches a request by user, group,
namespace or verb and assigns it to a `PriorityLevelConfiguration`, which owns
a share of the concurrency and a set of fair queues. `system` and
`leader-election` levels protect kubelets and controller leases;
`workload-low` and `global-default` absorb everything else. Rejected requests
get `429 Too Many Requests` with a `Retry-After` header, and the metrics
`apiserver_flowcontrol_rejected_requests_total` and
`apiserver_flowcontrol_current_inqueue_requests` show where pressure is.

**Why it matters:** when the API feels slow for you but kubelets are fine,
APF is doing its job: your `kubectl` traffic sits in `global-default` while
node heartbeats go first. Look at the queues before blaming etcd.

**Try it:** inspect the live server from the terminal, then from the node as
you would when `kubectl` no longer answers.

```bash
kubectl -n kube-system get pod kube-apiserver-sre-labs-control-plane -o jsonpath='{.spec.containers[0].command}' | tr ',' '\n' | grep -E 'etcd-servers|service-cluster-ip-range|admission|authorization-mode|audit'
kubectl get --raw '/livez?verbose' | tail -6
kubectl get --raw '/readyz?verbose' | grep -v '^\[+\]'           # anything printed here is a failing check
kubectl api-resources --api-group=apps
kubectl get --raw /apis | head -c 500; echo
kubectl get apiservices | grep -v ' Local '                      # aggregated backends, if any (metrics-server)
kubectl get flowschemas,prioritylevelconfigurations | head -20
kubectl get --raw /metrics | grep '^apiserver_request_total' | sort -k2 -nr | head -5
kubectl -n kube-system logs kube-apiserver-sre-labs-control-plane --tail=20
# the same logs, without the API: the container log file and crictl on the node
docker exec sre-labs-control-plane sh -c 'crictl ps -a --name kube-apiserver -q | head -1 | xargs crictl logs --tail 20'
docker exec sre-labs-control-plane sh -c 'ls /var/log/pods/ | grep apiserver'
```

## Reading API server logs on the node

When the API server is down, the mirror Pod is unreachable, so you go to the
kubelet's view. Containers write to
`/var/log/pods/kube-system_kube-apiserver-<node>_<uid>/kube-apiserver/N.log`,
with `/var/log/containers/*.log` symlinks; `crictl ps -a` lists exited
instances and `crictl logs <id>` prints them. Three messages cover most
outages:

- `transport: Error while dialing dial tcp 127.0.0.1:2379: connect: connection refused`: etcd is down or the `--etcd-servers` address is wrong.
- `x509: certificate signed by unknown authority` or `certificate has expired`: PKI, see the last lesson of this realm.
- `failed to start ... listen tcp :6443: bind: address already in use`: a previous instance did not exit; `crictl ps` shows two.

If `crictl ps -a` shows the API server restarting every few seconds, read the
*previous* instance: the error is at the end of its log, right before the
exit.

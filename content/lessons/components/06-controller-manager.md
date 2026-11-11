---
title: "kube-controller-manager: the reconcile loop, owners, and node eviction timing"
slug: controller-manager
realm: components
order: 6
summary: "The informer / work queue / reconcile pattern every controller follows, the built-in controllers you depend on daily, leader election, owner references and cascading deletion, and the exact timeline from a dead node to evicted Pods."
estimated_minutes: 18
level: intermediate
tags: [controllers, reconcile, informers, leader-election, owner-references, garbage-collection, node-lifecycle]
builders: [deployment-basics, hpa-autoscaling]
scenarios: [controller-manager-down]
quiz:
  - q: "kube-controller-manager is down. You run `kubectl scale deploy web --replicas=5`. What do you observe?"
    options: ["kubectl fails", "spec.replicas becomes 5 and nothing else happens: no ReplicaSet update, no new Pods", "Pods are created but stay Pending", "The scheduler creates the Pods"]
    answer: 1
    explain: "The API server accepts the write. The deployment and replicaset controllers, which would turn it into Pods, live in the controller-manager. Desired state changes; observed state does not."
  - q: "You delete a Deployment with `kubectl delete deploy web --cascade=orphan`. What remains?"
    options: ["Nothing", "The ReplicaSet and its Pods, with their ownerReference to the Deployment removed", "Only the Pods", "The Deployment, marked for deletion"]
    answer: 1
    explain: "Orphan propagation tells the garbage collector to strip the ownerReference instead of deleting dependents. The ReplicaSet keeps managing its Pods on its own."
  - q: "A worker node loses power. Roughly how long until its Pods are deleted from the API by default?"
    options: ["Immediately", "About 40-50 seconds", "About 5-6 minutes: the grace period to mark the node Unknown, plus the 300 s tolerationSeconds on the not-ready/unreachable taints", "Never, until the node returns"]
    answer: 2
    explain: "The node lifecycle controller waits node-monitor-grace-period before setting Ready=Unknown and tainting the node NoExecute. Every Pod carries default tolerations of 300 s for those taints; when they expire the taint manager deletes the Pods."
---

# kube-controller-manager

Kubernetes has no central brain that executes plans. It has a few dozen
small loops, each responsible for one gap between `spec` and `status`.
kube-controller-manager is the process that hosts the built-in ones. If you
understand one controller you understand them all, because they share a
single shape.

## The controller pattern

```
API server ──list+watch──▶ informer cache ──event──▶ work queue ──key──▶ reconcile(ns/name)
      ▲                                                                       │
      └──────────────────── create / update / delete ◀────────────────────────┘
```

1. An **informer** lists a resource once, then watches it. It keeps an
   in-memory cache (the *indexer*) that is the controller's view of the
   world. Reads inside the loop hit the cache, not the API server, which is
   why controllers can be fast and why they do not DDoS the API.
2. Event handlers do nothing but push a **key** (`namespace/name`) onto a
   rate-limited **work queue**. The queue deduplicates: a hundred updates
   to one object become one item.
3. Workers pop keys and call **reconcile**: read the object and everything it
   owns from the cache, compute the difference from desired, take *one*
   step through the API, return. On error the key is requeued with
   exponential backoff.

**Why it matters:** reconcile is written to be idempotent and
level-triggered. It never asks "what changed", only "what is, versus what
should be". A controller that restarts, misses events, or sees them out of
order still converges. This is also why controllers periodically *resync*
every object even with no change: it costs a cache walk and catches bugs.

## The built-in controllers

All run in one binary, selected by `--controllers` (kubeadm sets
`*,bootstrapsigner,tokencleaner`). With
`--use-service-account-credentials=true` each one authenticates as its own
ServiceAccount (`system:serviceaccount:kube-system:deployment-controller`),
bound to a `system:controller:*` ClusterRole, so audit logs and RBAC can
tell them apart.

| Controller | Watches | Produces |
|---|---|---|
| deployment | Deployments, ReplicaSets | ReplicaSets; rollout, scaling, rollback |
| replicaset | ReplicaSets, Pods | Pods, up or down to `replicas` |
| daemonset, statefulset, job, cronjob | their kinds and Pods | Pods, with per-kind guarantees (one per node, ordinal identity, completions, schedule) |
| endpointslice | Services, Pods | EndpointSlices (ready, serving, terminating per endpoint) |
| node lifecycle | Nodes, their Leases | node conditions, `not-ready` / `unreachable` taints, Pod eviction |
| namespace | Namespaces in `Terminating` | deletes every namespaced object, removes the `kubernetes` finalizer |
| serviceaccount, token cleaner | Namespaces, ServiceAccounts, bootstrap-token Secrets | the `default` ServiceAccount per namespace; deletes expired bootstrap-token Secrets (a separate legacy SA token cleaner invalidates and removes auto-generated Secret tokens unused for a year) |
| garbage collector | every resource via discovery | deletes dependents whose owners are gone |
| horizontalpodautoscaler | HPAs, metrics APIs | `spec.replicas` on the scale subresource (chapter 11 and the `hpa-autoscaling` builder) |
| persistentvolume binder, resourcequota, certificate signing, ttl-after-finished | PVC/PV, Quotas, CSRs, finished Jobs | bindings, usage status, signed certs, cleanup |

## Leader election

Running two controller-managers would double every Pod. kubeadm starts one
per control-plane node with `--leader-elect=true`; they compete for a `Lease`
named `kube-controller-manager` in `kube-system` (15 s duration, renewed
every 10 s, retried every 2 s). Only the holder runs controllers; the others
block on the lease. A stale `renewTime` means nobody is reconciling, even if
the Pod shows `Running`.

## Owner references and cascading deletion

Every child written by a controller carries
`metadata.ownerReferences[]` with the parent's `uid`, `controller: true`
and `blockOwnerDeletion: true`. The garbage collector keeps a graph of these
links and acts when an owner disappears. `kubectl delete` chooses the
policy with `--cascade`:

| `propagationPolicy` | What happens |
|---|---|
| `Background` (default) | owner deleted immediately; GC deletes dependents afterwards |
| `Foreground` | owner gets the `foregroundDeletion` finalizer and vanishes only after dependents with `blockOwnerDeletion` are gone |
| `Orphan` (`--cascade=orphan`) | dependents keep running, ownerReference removed |

**Gotcha:** a namespaced dependent may reference an owner in its own
namespace or a cluster-scoped one; a cross-namespace reference is treated as
an absent owner and the dependent is garbage-collected. A cluster-scoped
dependent may only reference cluster-scoped owners; pointing it at a
namespaced kind makes it uncollectable. Both cases log
`OwnerRefInvalidNamespace` events. Operators that hand-write
`ownerReferences` learn this the hard way. Also: adoption works through
labels (a ReplicaSet adopts matching orphan Pods), which is why relabelling
Pods under a running controller changes who owns them.

## Node lifecycle and eviction timing

This is the controller SREs most need to know by heart, because its timers
decide how long a dead node keeps "running" your Pods.

1. Each kubelet renews a `Lease` in `kube-node-lease` every 10 s and posts
   node status when it changes (at least every 5 min).
2. The node lifecycle controller checks every 5 s
   (`--node-monitor-period`). If neither lease nor status arrived within
   `--node-monitor-grace-period` (40 s historically, 50 s in recent
   releases), it sets `Ready=Unknown`.
3. The same moment it taints the node
   `node.kubernetes.io/unreachable:NoExecute` (or `not-ready:NoExecute`
   when the kubelet itself reports not ready).
4. Every Pod carries two tolerations added at admission by
   `DefaultTolerationSeconds`: tolerate those taints for 300 s. When they
   expire, the taint manager deletes the Pod object.
5. A Deployment's replicaset controller sees fewer Pods and creates
   replacements elsewhere. A StatefulSet does *not* recreate until the old
   Pod is confirmed gone, because the kubelet that could confirm it is
   unreachable; the Pod stays `Terminating` until the node returns or
   someone force-deletes it.

Eviction is rate-limited to `--node-eviction-rate` (0.1 nodes/s) and slows
further when more than 55% of a zone is unhealthy, so a network partition
does not turn into a stampede. Pods that must fail over faster set their own
`tolerationSeconds`; Pods that must never move set none and tolerate forever.

**Try it:** inspect the leader, the flags, the controllers that started, and
the default tolerations the admission chain adds.

```bash
kubectl -n kube-system get lease kube-controller-manager -o jsonpath='{.spec.holderIdentity}{"  "}{.spec.renewTime}{"\n"}'
docker exec sre-labs-control-plane grep -E -- '--controllers|--leader-elect|--use-service-account-credentials|--cluster-cidr' /etc/kubernetes/manifests/kube-controller-manager.yaml
kubectl -n kube-system logs kube-controller-manager-sre-labs-control-plane | grep -iE 'started|starting' | head -15
kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].spec.tolerations}' | tr '}' '\n'
kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].metadata.ownerReferences[0].kind}/{.items[0].metadata.ownerReferences[0].name}{"\n"}'
kubectl get clusterroles | grep '^system:controller:' | head
# cascading deletion in practice
kubectl create deployment orphan-demo --image=nginx:1.27-alpine
kubectl delete deployment orphan-demo --cascade=orphan
kubectl get rs,pods -l app=orphan-demo          # still there, with no owner
kubectl delete rs -l app=orphan-demo             # Background cascade removes the Pods
```

## When it is gone

The **controller-manager-down** scenario removes the static pod. Nothing
breaks loudly: existing Pods serve, the scheduler still binds Pods you create
by hand, `kubectl` is happy. But a scaled Deployment never changes, a deleted
Pod is never replaced, a new namespace has no `default` ServiceAccount (so
Pods in it fail admission), a Service never gets EndpointSlices, and a
finished namespace deletion hangs in `Terminating`. The stale
`kube-controller-manager` lease is the one-line diagnosis.

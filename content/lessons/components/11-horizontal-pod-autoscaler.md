---
title: "HorizontalPodAutoscaler: the loop that owns spec.replicas"
slug: horizontal-pod-autoscaler
realm: components
order: 11
summary: "What the HPA controller does every 15 seconds: where the CPU numbers come from (metrics-server), the formula and tolerance that turn them into a replica count, the scale subresource it writes, the default stabilization window and rate limits, and how to read an HPA that is not scaling."
estimated_minutes: 20
level: beginner
tags: [hpa, autoscaling, metrics-server, scale-subresource, controllers, requests, utilization]
builders: [deployment-basics, hpa-autoscaling]
scenarios: [resourcequota-blocks-rollout, rollout-stuck-bad-image]
quiz:
  - q: "Three Pods average 90% of their CPU request; the HPA targets 60%. What does the next sync write to the Deployment?"
    options: ["4 replicas", "5 replicas: ceil(3 × 90 / 60) = ceil(4.5)", "6 replicas", "Nothing until the stabilization window passes"]
    answer: 1
    explain: "desired = ceil(current × currentMetric / targetMetric). Scale-up has no stabilization window by default, so the write happens on the sync that computes it, limited only by the scale-up policy (4 Pods or 100% per 15 s, whichever is larger)."
  - q: "Load stops at 12:00 and utilization drops to 5% within a minute. The HPA has no behavior block. When does the replica count start falling?"
    options: ["At the next 15-second sync", "Around 12:05: scale-down applies the highest recommendation of the last 300 seconds", "After the Pods have been idle for 10 minutes", "Never: scale-down must be enabled explicitly"]
    answer: 1
    explain: "The default scale-down stabilization window is 300 s. Every recommendation computed during the window is kept and the highest wins, so capacity is only removed once no recommendation in the last five minutes wanted it. After that the default policy allows 100% per 15 s."
  - q: "An HPA with minReplicas 2 owns the web Deployment. Someone runs kubectl scale deploy web --replicas=0. What happens?"
    options: ["The HPA scales it back to 2 within a sync period", "Nothing: at 0 replicas the HPA deactivates itself (ScalingActive=False, reason ScalingDisabled) until the target is scaled above 0 again", "The HPA is deleted by the garbage collector", "The HPA jumps to maxReplicas because utilization is undefined"]
    answer: 1
    explain: "Scaling to 1 would be undone within a sync because the floor is 2. Zero is the documented maintenance switch: the controller stops reconciling the target until a human scales it above zero."
---

# HorizontalPodAutoscaler

A Deployment has no idea it is being autoscaled. The HorizontalPodAutoscaler
is a separate object, reconciled by a separate controller inside
kube-controller-manager, and the only thing that controller ever writes is
the replica count of its target. Everything you will observe about an HPA
follows from three facts: it is a **periodic loop**, it reads numbers from an
**aggregated metrics API** rather than from the Pods, and it writes through
the **scale subresource** rather than editing your manifest.

## The loop

```
 kubelet ──/metrics/resource──▶ metrics-server ──serves──▶ metrics.k8s.io
 (every node)                   (kube-system)                    │
                                                                 ▼ read
   every 15 s:  hpa controller ──write .../deployments/web/scale──▶ deployment controller ──▶ ReplicaSet ──▶ Pods
```

Every sync period (`--horizontal-pod-autoscaler-sync-period`, 15 s) the
controller runs this for each HPA:

1. Reads the target's **scale subresource**: current replica count and
   label selector.
2. Lists the Pods behind that selector and fetches their CPU (or memory)
   from `metrics.k8s.io`.
3. Computes a desired count *per metric* and keeps the highest.
4. Clamps it between `minReplicas` and `maxReplicas`, then applies the
   `behavior` rules.
5. Writes the result back to the scale subresource if it differs. The
   deployment controller takes it from there, exactly as if you had typed
   `kubectl scale`.

The computation is one line:

```
desiredReplicas = ceil( currentReplicas × currentMetricValue / targetMetricValue )
```

Three Pods averaging 90 % of their CPU request against a 60 % target:
`ceil(3 × 90 / 60) = ceil(4.5) = 5`. The ratio `current / target` has to
leave a tolerance band of 10 % around 1.0
(`--horizontal-pod-autoscaler-tolerance`) before anything is written, so
63 % against a 60 % target does nothing.

**Why it matters:** the loop is level-triggered and has no memory of *you*.
It does not care whether the current count came from the manifest, from
`kubectl scale`, or from its own previous decision; it compares what the
Pods are doing now with the target and writes a new count. Every surprise
in this chapter ("why did it undo my scale?", "why is it not reacting?") is
the loop doing exactly this.

## Where the numbers come from

Kubernetes does not store resource usage. The kubelet exposes the cgroup
counters of its containers at `/metrics/resource`; **metrics-server**
scrapes every kubelet every 15 s, keeps only the latest sample in memory,
and serves it as an *aggregated API*: an `APIService` named
`v1beta1.metrics.k8s.io` tells kube-apiserver to proxy that group to the
metrics-server Service. `kubectl top` and the HPA controller are its two
clients. No metrics-server, no `kubectl top`, no HPA: the controller
reports `FailedGetResourceMetric` and leaves the count alone. The lab's
**metrics-server** addon installs it with `--kubelet-insecure-tls`, because
kind's kubelets use self-signed serving certificates.

| Metric `type` | Served by | Example |
|---|---|---|
| `Resource`, `ContainerResource` | `metrics.k8s.io` (metrics-server) | CPU utilization of the Pod, or of one named container |
| `Pods`, `Object` | `custom.metrics.k8s.io` (an adapter such as prometheus-adapter) | requests per second per Pod, queue depth on a Service |
| `External` | `external.metrics.k8s.io` (adapter or KEDA) | messages waiting in a cloud queue |

Only the first row exists in this lab. The other two are what the
production playbook's *Advanced Horizontal Pod Autoscaling* lesson adds.

### Utilization is relative to requests

`target.type: Utilization` means *usage ÷ `resources.requests`*, averaged
across the Pods, as a percentage. Three things follow:

- Every container in the Pod needs a CPU **request**. One missing and the
  Pod is dropped from the average, with `missing request for cpu` in the
  HPA's events.
- It is relative to **requests, not limits**. A Pod requesting `100m` and
  burning `150m` is at 150 %.
- A Pod that is not Ready is set aside, and for its first 5 minutes
  (`--horizontal-pod-autoscaler-cpu-initialization-period`) its CPU only
  counts while it is Ready, so a JVM warming up does not scale itself up.

`AverageValue` targets an absolute quantity per Pod (`200m`) instead and
needs no request; custom metrics almost always use it.

### Why CPU, and usually not memory

The loop converges only if adding Pods lowers the metric per Pod. CPU
behaves that way for request-driven services: spread the same traffic over
more Pods and each one works less. Memory usually does not: heaps stay
allocated, caches fill to their limit, and a new Pod takes no memory away
from the old ones. A memory HPA tends to scale up and never come back down.

## What it writes: the scale subresource

The controller never touches Pods or ReplicaSets. It writes to

```
/apis/apps/v1/namespaces/<ns>/deployments/<name>/scale
```

a tiny `Scale` object with `spec.replicas`, `status.replicas` and
`status.selector`. Anything that exposes this subresource can be
autoscaled: Deployments, ReplicaSets, StatefulSets, and any CRD whose
definition declares `subresources.scale`. That is the whole contract
between an HPA and its target, and three consequences follow:

- `kubectl scale` writes the same field. Scale a Deployment to 1 while an
  HPA with `minReplicas: 2` owns it and the next sync puts it back to 2.
- A manifest that still carries `spec.replicas` fights the HPA: every
  `kubectl apply` or Flux reconciliation resets the count and the HPA raises
  it again. Remove `replicas` from the file once an HPA exists; the field is
  optional and the HPA becomes its only writer.
- During a rollout the HPA scales the **Deployment**, and the Deployment
  spreads the count across its ReplicaSets by `maxSurge` and
  `maxUnavailable`. A stuck rollout under load therefore grows the *old*
  ReplicaSet.

**Gotcha:** scaling the target to **0** is different. With `replicas: 0`
and `minReplicas` above 0, the HPA sets `ScalingActive=False` with reason
`ScalingDisabled` and stops reconciling until someone scales the target
above 0 again: the supported way to take a workload down for maintenance
without deleting the HPA. Scaling *to* zero automatically needs
`minReplicas: 0` and at least one Object or External metric (the
`HPAScaleToZero` gate is beta and on by default in recent releases), since a
workload with no Pods has no CPU to measure.

## Bounds and behavior

`minReplicas` (default 1) is the floor that absorbs the first seconds of a
burst while new Pods start, and the number your PodDisruptionBudget maths
assumes during a drain. `maxReplicas` is required and is the guard against
a broken metric: size it from node capacity and ResourceQuota, not from
optimism. At either bound the HPA reports `ScalingLimited=True`.

Between the bounds, `spec.behavior` decides how fast the count may move.
The defaults are deliberately asymmetric:

| | `scaleUp` | `scaleDown` |
|---|---|---|
| `stabilizationWindowSeconds` | 0 | 300 |
| default `policies` | the larger of 4 Pods or 100 % per 15 s | 100 % per 15 s |
| `selectPolicy` | `Max` | `Max` |

The **stabilization window** keeps every recommendation computed during the
last N seconds and, for scale-down, applies the *highest* of them. Capacity
is only removed once no recommendation in the last five minutes wanted it;
a burst is answered immediately, the cool-down is slow. **Policies**
rate-limit each step (`type: Percent` or `Pods`, a `value`, a
`periodSeconds` up to 1800). With several, `selectPolicy` picks the most
permissive (`Max`), the least (`Min`), or switches the direction off
(`Disabled`), which is how you build an autoscaler that only ever grows.
Once the window has passed, the default scale-down policy still allows
100 % per 15 s, so the fleet can halve in one step; `Percent 10 / 60` is
the usual production replacement, and the `hpa-autoscaling` builder makes
you write it.

## Reading an HPA

```
NAME   REFERENCE        TARGETS        MINPODS   MAXPODS   REPLICAS
web    Deployment/web   cpu: 12%/70%   2         10        2
```

`TARGETS` is current against target for each metric; `<unknown>` means the
metric could not be read. `REPLICAS` is what the controller last wrote. The
reasons live in `kubectl describe hpa` under *Conditions*:

| Condition | Reason | Meaning |
|---|---|---|
| `AbleToScale=False` | `FailedGetScale` | `scaleTargetRef` names a kind, apiVersion or name that does not exist |
| `ScalingActive=False` | `FailedGetResourceMetric` | metrics-server missing or not serving yet, or `missing request for cpu` |
| `ScalingActive=False` | `ScalingDisabled` | the target is at 0 replicas |
| `ScalingLimited=True` | `TooFewReplicas`, `TooManyReplicas` | clamped at `minReplicas` or `maxReplicas` |
| `ScalingLimited=True` | `ScaleUpLimit`, `ScaleDownLimit` | a behavior policy is rate-limiting the step |
| `AbleToScale=True` | `ScaleDownStabilized`, `ScaleUpStabilized` | the stabilization window is holding the count |
| `AbleToScale=True` | `ReadyForNewScale`, `SucceededRescale` | healthy; the last Event says what it wrote and why |

A ResourceQuota is a ceiling the HPA cannot see: it writes the count, the
ReplicaSet fails with `FailedCreate`, and the HPA keeps asking.

**Try it:** install the `metrics-server` addon from the Cluster page (or
run `cluster/addons/metrics-server.sh`), then watch the loop work on the
example the Kubernetes documentation uses. Use two terminals.

```bash
kubectl get apiservice v1beta1.metrics.k8s.io                       # AVAILABLE True once the aggregated API answers
kubectl top pods -n kube-system | head -5                           # the API the HPA reads
kubectl create namespace lab-hpa
kubectl -n lab-hpa create deployment php-apache --image=registry.k8s.io/hpa-example --port=80
kubectl -n lab-hpa set resources deployment php-apache --requests=cpu=200m --limits=cpu=500m
kubectl -n lab-hpa expose deployment php-apache --port=80
kubectl -n lab-hpa autoscale deployment php-apache --cpu-percent=50 --min=2 --max=6
kubectl -n lab-hpa get hpa -w                                       # <unknown>/50% for ~30 s, then cpu: 0%/50%, REPLICAS 2; Ctrl-C
kubectl get --raw /apis/apps/v1/namespaces/lab-hpa/deployments/php-apache/scale; echo   # what the controller writes
# second terminal: load
kubectl -n lab-hpa run load --rm -it --restart=Never --image=busybox:1.36 -- /bin/sh -c 'while true; do wget -q -O- http://php-apache >/dev/null; done'
# first terminal: the recommendation, the write, and the ReplicaSet following
kubectl -n lab-hpa get hpa php-apache -w                            # TARGETS climbs past 50%, REPLICAS follows; Ctrl-C
kubectl -n lab-hpa describe hpa php-apache | sed -n '/^Metrics:/,/^Events:/p'
kubectl -n lab-hpa get rs                                           # DESIRED moved; the HPA never touched this object
# the controller, not you, owns the count
kubectl -n lab-hpa scale deployment php-apache --replicas=1 && sleep 20 && kubectl -n lab-hpa get deploy php-apache
kubectl -n lab-hpa scale deployment php-apache --replicas=0 && sleep 20 && kubectl -n lab-hpa describe hpa php-apache | grep -A5 '^Conditions'
kubectl -n lab-hpa scale deployment php-apache --replicas=2         # reactivates the HPA
# Ctrl-C the load in the second terminal, then time the scale-down: nothing for 300 s, then one step
kubectl -n lab-hpa get hpa php-apache -w
kubectl delete namespace lab-hpa
```

## What the HPA is not

The HPA changes *how many* Pods run. The Vertical Pod Autoscaler changes
*how big* each one is by rewriting `requests`, and the Cluster Autoscaler
adds *nodes* when Pods are Pending. They compose, with one rule: never let
HPA and VPA both act on CPU for the same workload, because a raised request
lowers the utilization the HPA reads and the two chase each other. The
playbook's *Cluster Autoscaler and Vertical Pod Autoscaler* lesson covers
both.

## Practice

- `hpa-autoscaling` builder: write the `autoscaling/v2` manifest field by
  field, including a `behavior` block that stops it from flapping.
- `resourcequota-blocks-rollout`: the quota ceiling an autoscaler hits the
  same way a rollout does; `rollout-stuck-bad-image`: picture an HPA scaling
  it under load and ask which ReplicaSet grows.
- Troubleshooting chapter 06, *HPA interactions*, for the describe-and-fix
  version of this material; production playbook module 5 for custom
  metrics, external metrics and KEDA.

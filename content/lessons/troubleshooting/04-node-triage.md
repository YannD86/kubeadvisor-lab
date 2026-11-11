---
title: "Node triage: NotReady, pressure, taints and the scheduler's verdict"
slug: node-triage
realm: troubleshooting
order: 4
summary: "Read node conditions and taints, check kubelet and containerd on a kind node, decode the '0/3 nodes are available' message, and tell capacity from allocatable."
estimated_minutes: 18
level: intermediate
tags: [node, kubelet, containerd, taints, cordon, drain, scheduling, capacity]
builders: [deployment-basics]
scenarios: [node-cordoned, node-taint-no-toleration, kubelet-stopped, pending-insufficient-resources]
quiz:
  - q: "kubectl get nodes shows 'Ready,SchedulingDisabled' on sre-labs-worker. What is true?"
    options: ["The kubelet is down", "The node is cordoned: existing Pods keep running, no new Pod is scheduled there", "All Pods were evicted", "The node has DiskPressure"]
    answer: 1
    explain: "SchedulingDisabled is the display of spec.unschedulable=true, which cordon sets. It adds the node.kubernetes.io/unschedulable taint and nothing else."
  - q: "A Pod requesting 2 CPU is Pending with 'Insufficient cpu' while kubectl top node shows 15% usage. Why?"
    options: ["metrics-server is lying", "The scheduler sums requests against allocatable, not actual usage", "The node is NotReady", "The Pod needs a toleration"]
    answer: 1
    explain: "Scheduling is a reservation system. Allocated resources in describe node is the sum of requests; usage is irrelevant to the scheduler."
  - q: "After a kubelet stops, how long until its Pods are evicted and replaced by their controllers (default settings)?"
    options: ["Immediately", "About 50 seconds", "About 5 minutes after the node turns NotReady", "Never, until an operator drains the node"]
    answer: 2
    explain: "The node turns NotReady/Unknown after roughly 50 s without status (--node-monitor-grace-period, 50 s by default since 1.32); the not-ready/unreachable NoExecute taints are tolerated for 300 s by default before Pods are evicted."
---

# Node triage

A node is a kubelet, a container runtime and a CNI agent reporting to the API
server. When a node misbehaves you see two things: its **conditions** change,
and Pods either stop landing on it (`Pending`) or get evicted from it. The
layer below the node is the operating system; the layer above is the
scheduler. This chapter covers both edges.

## The decision table

| Symptom | First command | Likely causes |
|---|---|---|
| Node `NotReady` | `kubectl describe node <n>` → Conditions | kubelet stopped, runtime down, CNI not initialised, node unreachable |
| Node `Ready,SchedulingDisabled` | `kubectl get node <n> -o jsonpath='{.spec.unschedulable}'` | cordon left in place after maintenance |
| Pods `Pending`, `untolerated taint` | `kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints` | custom taint, pressure taint, control-plane taint |
| Pods `Pending`, `Insufficient cpu/memory` | `kubectl describe node <n>` → Allocated resources | requests exceed allocatable, one big Pod |
| Pods `Pending`, `didn't match Pod's node affinity/selector` | `kubectl get pod -o jsonpath='{.spec.nodeSelector}{.spec.affinity}'` | label absent on every node |
| Pods `Evicted` | `kubectl describe pod` → Message | MemoryPressure / DiskPressure threshold crossed |
| Pods stuck `Terminating` | `kubectl get pod -o jsonpath='{.spec.nodeName}'` then node health | kubelet on that node not running |
| `ContainerCreating` on one node only | `docker exec -it <node> crictl ps` and `journalctl -u containerd` | runtime or CNI broken on that node |
| Pods on one node stale `Running`, then `Terminating`; node `NotReady` | `kubectl get lease -n kube-node-lease` | kubelet stopped posting status |

## Conditions, the kubelet's heartbeat

`kubectl describe node` lists five conditions. `Ready` is the one that
matters; the other four are pressure signals the kubelet computes from its
`evictionHard` thresholds (upstream defaults `memory.available<100Mi`,
`nodefs.available<10%`, `nodefs.inodesFree<5%`, `imagefs.available<15%`,
`imagefs.inodesFree<5%`; kind sets them to `0%`, so you will not see
MemoryPressure/DiskPressure evictions in this lab).

- `Ready=False`, reason `KubeletNotReady` with a message such as
  `container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized`
  → the kubelet is alive but Calico is not; look at `calico-node` on that node.
- `Ready=Unknown`, reason `NodeStatusUnknown`,
  `Kubelet stopped posting node status.` → the kubelet (or the node's link to
  the API) is gone. The node controller sets it after about 50 s without a
  heartbeat (`--node-monitor-grace-period`, 50 s by default since 1.32, 40 s
  before).
- `MemoryPressure`, `DiskPressure`, `PIDPressure` = `True` → the kubelet is
  **evicting** Pods, starting with those that use more than they request
  (BestEffort first in practice), and adds a `NoSchedule` taint
  (`node.kubernetes.io/memory-pressure` and friends) so nothing new arrives.
- `NetworkUnavailable=True` → no route for the Pod CIDR; the CNI has not
  claimed the node yet.

**Why it matters:** when `Ready` becomes `False` or `Unknown`, the node
controller taints the node `node.kubernetes.io/not-ready:NoExecute` or
`unreachable:NoExecute`. Every Pod carries a default toleration of 300 s for
those taints, so five minutes later the Pods are evicted and their controllers
recreate them elsewhere. Pods without a controller (bare Pods) are simply lost.

## Kubelet and runtime: go to the node

In the lab a node is a container: `docker exec -it sre-labs-worker bash`
puts you in it as root, and `docker exec sre-labs-worker` in front of a
command runs just that command there from the lab terminal, which is what
the block below does. The kubeadm layout applies:

```bash
N="docker exec sre-labs-worker"                # inside the node (docker exec -it ... bash) drop the prefix
$N systemctl status kubelet containerd --no-pager | grep -E '\.service|Active'
$N journalctl -u kubelet -n 100 --no-pager      # last kubelet lines
$N journalctl -u containerd -n 50 --no-pager
$N crictl ps -a                                 # containers, including Exited
$N crictl pods                                  # sandboxes
$N crictl logs --tail 50 $($N crictl ps -q --name kube-proxy | head -1)   # any container id from crictl ps
$N cat /var/lib/kubelet/config.yaml             # staticPodPath, containerRuntimeEndpoint (runtime socket), evictionHard (0% in kind)
$N cat /var/lib/kubelet/kubeadm-flags.env       # node-ip, provider-id
```

Log lines worth recognising in `journalctl -u kubelet`:
`kubelet.service: Main process exited, code=exited, status=1` (crashed at
start, read the lines above it), `failed to load kubelet config file`,
`"Failed to connect to apiserver"` or `node "sre-labs-worker" not found`
(cannot reach or authenticate to the API), `PLEG is not healthy` (the runtime
stopped answering). `systemctl restart kubelet` is the fix for a stopped unit;
if it dies again, the configuration is the cause, not the process.

`kubectl debug node/sre-labs-worker -it --image=busybox:1.36` is the portable
alternative when you do not own the Docker socket: it runs a Pod in the node's
network, PID and IPC namespaces with the node filesystem at `/host`
(`chroot /host` to use the node's tools; it is not privileged, add
`--profile=sysadmin` if you need that). Delete the `node-debugger-*` Pod when done.

**Gotcha:** `kubectl delete pod` of a mirror Pod or a stuck Pod on a dead
node does nothing: the kubelet must acknowledge the deletion. The Pod stays
`Terminating` until the node comes back or you force it
(`--force --grace-period=0`), which only removes the API object.

## Cordon, drain, uncordon

`kubectl cordon <node>` sets `spec.unschedulable: true`, displayed as
`SchedulingDisabled`, implemented as the taint
`node.kubernetes.io/unschedulable:NoSchedule`. Running Pods are untouched.
`kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` cordons,
then **evicts** every Pod through the Eviction API, which respects
PodDisruptionBudgets (chapter 06 explains why a drain can hang on
`Cannot evict pod as it would violate the pod's disruption budget`).
`kubectl uncordon <node>` is the step people forget.

**Try it:** list what the scheduler sees before reading any Pending Pod.

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,SCHED:.spec.unschedulable,TAINTS:.spec.taints[*].key'
kubectl describe node sre-labs-worker | sed -n '/Taints/p;/Conditions/,/Addresses/p;/Allocated resources/,/Events/p'
```

## Taints and tolerations

A taint is `key=value:effect` on a node; a toleration on a Pod matches it by
`key`, `operator` (`Equal` needs the value, `Exists` does not) and `effect`.
`NoSchedule` blocks new Pods, `PreferNoSchedule` only discourages,
`NoExecute` also evicts running Pods that do not tolerate it (after
`tolerationSeconds` if set). The control plane carries
`node-role.kubernetes.io/control-plane:NoSchedule`, which is why the two
workers do all the work in the lab. Remove a taint with a trailing minus:
`kubectl taint nodes sre-labs-worker team=billing:NoSchedule-`.

## Reading the scheduler's verdict

A `Pending` Pod's `FailedScheduling` event is a census of every node and the
first reason each one was rejected:

```
0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: },
1 node(s) were unschedulable, 1 Insufficient cpu. preemption: 0/3 nodes are available:
1 No preemption victims found for incoming pod, 2 Preemption is not helpful for scheduling.
```

The counts sum to the node total. Fix the reason with the largest count
first; the control-plane taint is normal and accounts for one. Other reasons
you will meet: `node(s) didn't match Pod's node affinity/selector`,
`node(s) had volume node affinity conflict` (the PV lives on another node),
`node(s) didn't match pod anti-affinity rules`, `Too many pods`,
`pod has unbound immediate PersistentVolumeClaims` (chapter 07). No event at
all means the scheduler itself is not running (chapter 05). See Components →
Scheduler for the filter/score pipeline.

## Capacity vs allocatable

`describe node` shows three numbers. **Capacity** is what the kernel reports.
**Allocatable** is capacity minus `kube-reserved`, `system-reserved` and the
eviction threshold; this is the scheduler's budget. **Allocated resources**
is the sum of the **requests** of the Pods already there, not their usage.
A node at 15% CPU usage can refuse a Pod because the requests are already
booked. `kubectl top node` (metrics-server addon) shows usage and is only
useful for the eviction side of the story.

**Gotcha:** kind nodes share the host kernel, so every node reports the whole
machine as capacity. The lab's "insufficient resources" scenario therefore
uses deliberately large requests; in a real cluster the same symptom comes
from many small Pods.

## k9s tip

`:nodes` shows STATUS, taints count and the `%CPU` and `%MEM` columns, which
are usage against allocatable (metrics-server), not the requests ratio the
scheduler cares about; for that picture `d` prints conditions, taints and
allocated resources. `Enter` lists the Pods on that node. `c`/`u` cordon and
uncordon, `r` drains (confirm the dialog). `:events` filtered with
`/FailedScheduling` lists every verdict in one place.

## Practice

- `node-cordoned`: new Pods Pending on a cluster that looks healthy.
- `node-taint-no-toleration`: a taint added for a team that never came.
- `kubelet-stopped`: a worker goes NotReady; find and restart the unit on the node.
- `pending-insufficient-resources`: read the verdict, then decide between requests and capacity.

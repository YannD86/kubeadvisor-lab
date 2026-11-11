---
title: "kube-scheduler: filtering, scoring, and reading a Pending Pod"
slug: scheduler
realm: components
order: 5
summary: "How the scheduler picks a node through filter and score plugins, how to decode '0/3 nodes are available' messages, and how requests, taints, affinity, topology spread and preemption change the answer."
estimated_minutes: 18
level: intermediate
tags: [scheduler, pending, taints, affinity, topology-spread, priority, preemption]
builders: [deployment-basics]
scenarios: [scheduler-down, pending-insufficient-resources, node-taint-no-toleration, node-cordoned]
quiz:
  - q: "A Pod sets `limits.cpu: 4` and no requests. The node has 2 allocatable CPUs. Does it schedule?"
    options: ["No: the scheduler compares limits with allocatable", "No: with no explicit request the API server defaults the request to the limit (4 CPUs), which does not fit on a 2-CPU node", "Yes, the scheduler ignores resources", "Only on the control-plane node"]
    answer: 1
    explain: "The scheduler uses requests, never limits. But when only a limit is set, the API server defaults the request to the same value, so this Pod requests 4 CPUs and stays Pending with Insufficient cpu."
  - q: "`kubectl describe pod` shows: `0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 node(s) didn't match Pod's node affinity/selector.` Which plugins rejected nodes?"
    options: ["NodeResourcesFit and TaintToleration", "TaintToleration and NodeAffinity", "PodTopologySpread only", "DefaultPreemption"]
    answer: 1
    explain: "Each clause is the message of one Filter plugin with the count of nodes it rejected. Add the counts: 1 + 2 = 3 = all nodes. The control-plane taint is expected; the two workers failed a nodeSelector or nodeAffinity."
  - q: "A Pod is Pending and `kubectl describe pod` shows no events at all. What is the most likely cause?"
    options: ["Insufficient memory", "The scheduler is not running, so nothing has evaluated the Pod", "The image does not exist", "A NetworkPolicy blocks it"]
    answer: 1
    explain: "FailedScheduling is an event the scheduler writes. Silence means no scheduler looked at the Pod. Check the kube-scheduler static pod and its leader lease."
---

# kube-scheduler

The scheduler does one thing: for each Pod with an empty `spec.nodeName`, pick
a node and write a Binding. It never starts containers and never talks to a
node. Everything it knows comes from watching Pods, Nodes, PersistentVolumes
and a few other objects through the API server.

## The scheduling cycle

Pods wait in a priority-ordered *active queue*. For each one the scheduler
runs a sequence of extension points implemented by plugins, the *scheduling
framework*:

1. **PreFilter / Filter**: every node is tested; a node that fails any
   Filter plugin is out. This produces the feasible set.
2. **PostFilter**: runs only if the feasible set is empty; this is where
   preemption lives.
3. **PreScore / Score / NormalizeScore**: each feasible node gets a 0-100
   score from each scoring plugin, weighted and summed.
4. **Reserve / Permit**: the chosen node's resources are reserved in the
   scheduler's cache so the next Pod sees them as taken.
5. **PreBind / Bind / PostBind**: asynchronously, the Binding is written.
   Volumes are bound here too.

| Plugin | Phase | Rejects or scores on |
|---|---|---|
| NodeUnschedulable | Filter | `spec.unschedulable` (a cordoned node) |
| NodeName | Filter | `spec.nodeName` already set |
| TaintToleration | Filter, Score | NoSchedule / NoExecute taints vs tolerations; PreferNoSchedule as score |
| NodeAffinity | Filter, Score | `nodeSelector`, required and preferred node affinity |
| NodeResourcesFit | Filter, Score | sum of container **requests** vs node allocatable minus other Pods' requests |
| NodePorts | Filter | a `hostPort` already in use |
| VolumeBinding | Filter, PreBind | PVC can be bound to a PV reachable from the node |
| InterPodAffinity | Filter, Score | pod affinity and anti-affinity by `topologyKey` |
| PodTopologySpread | Filter, Score | `maxSkew` across a topology key |
| ImageLocality | Score | image already present on the node |
| NodeResourcesBalancedAllocation | Score | prefers even CPU/memory utilisation |
| DefaultPreemption | PostFilter | can evicting lower-priority Pods make the Pod fit |

**Why it matters:** `0/3 nodes are available:` is followed by one clause per
Filter plugin that rejected nodes, each with a count. The counts always add
up to the node total. `1 node(s) had untolerated taint
{node-role.kubernetes.io/control-plane: }` is the control-plane node and is
normal in this lab; the other clauses are your problem. A second sentence,
`preemption: 0/3 nodes are available: 3 No preemption victims found`, is the
PostFilter report.

## Requests, not limits

The scheduler takes the Pod's effective request, the larger of the sum of
the app containers' `requests` and the largest single init container
request, and compares it with `allocatable` minus what is already requested
on the node. Actual usage is
irrelevant: a node at 5% real CPU but 100% requested is full. `limits`
matter to the kubelet and the kernel, not to placement, with one twist: a
container that sets a limit and no request gets a request equal to the
limit. `kubectl describe node` prints the requested totals under
*Allocated resources*; that is the number the scheduler sees.

## Taints, affinity, spread, priority

- **Taints and tolerations.** A taint on a node (`key=value:NoSchedule`)
  keeps Pods away unless they tolerate it. `NoExecute` also evicts running
  Pods, after `tolerationSeconds` if set. `kubectl cordon` sets
  `spec.unschedulable`; the node lifecycle controller mirrors it as the
  `node.kubernetes.io/unschedulable:NoSchedule` taint, and the
  NodeUnschedulable plugin rejects Pods that do not tolerate it.
- **Node affinity.** `nodeSelector` is shorthand for a required node affinity
  term. `preferredDuringScheduling...` only scores.
- **Pod affinity and anti-affinity.** "Run near / away from Pods matching
  this selector, grouped by `topologyKey`". Anti-affinity with
  `kubernetes.io/hostname` is how you get one replica per node, and why a
  fourth replica of such a Deployment stays Pending on three nodes.
- **Topology spread.** `maxSkew: 1` with `whenUnsatisfiable: DoNotSchedule`
  turns an even spread into a hard constraint; `ScheduleAnyway` makes it a
  score.
- **PriorityClass and preemption.** Each Pod has a `priority` (default 0)
  copied from its `priorityClassName` at admission. When a high-priority Pod
  finds no feasible node, DefaultPreemption looks for a node where deleting
  lower-priority Pods would make it fit, evicts them gracefully and records
  `status.nominatedNodeName`. `preemptionPolicy: Never` opts a class out of
  evicting others while still queueing ahead.

**Gotcha:** the scheduler evaluates a Pod once and then parks it in the
unschedulable queue until something relevant changes (a node added, a Pod
deleted, a taint removed). A Pod that was Pending for *Insufficient cpu*
does not get re-tried on a timer; it is retried on events, with backoff.
Deleting and recreating the Pod is not needed, but patience of up to a few
minutes sometimes is.

## Seeing the decision

The scheduler writes two kinds of evidence: a `Scheduled` event
(`Successfully assigned default/web to sre-labs-worker2`) or a
`FailedScheduling` event, and the Pod's `PodScheduled` condition with
`reason: Unschedulable` and the same message. Its own logs at the default
verbosity only show errors; `-v=10` on the static pod prints per-plugin and
final node scores (`Plugin scored node for pod`, `Calculated node's final
score for pod`), which is useful once, in a lab, and never in production.

**Try it:** confirm the scheduler is alive, then make it fail on purpose and
read the message.

```bash
kubectl -n kube-system get pod kube-scheduler-sre-labs-control-plane
kubectl -n kube-system get lease kube-scheduler -o jsonpath='{.spec.holderIdentity}{"\n"}'
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key,CORDONED:.spec.unschedulable'
kubectl describe node sre-labs-worker | grep -A7 'Allocated resources'
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata: {name: greedy}
spec:
  containers:
  - name: app
    image: nginx:1.27-alpine
    resources: {requests: {cpu: "64"}}
EOF
sleep 3; kubectl get pod greedy
kubectl get pod greedy -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].message}{"\n"}'
kubectl get events --field-selector reason=FailedScheduling -o custom-columns='OBJ:.involvedObject.name,MSG:.message'
kubectl delete pod greedy
```

The message names two plugins: TaintToleration for the control-plane node
and NodeResourcesFit (`Insufficient cpu`) for the two workers. Each of the
four scheduler scenarios in this realm produces a different clause, or, in
**scheduler-down**, no clause at all.

## When the scheduler itself is gone

With the static pod removed, new Pods sit in `Pending` with an empty
`nodeName` and no events, and already-scheduled Pods are unaffected. The
lease in `kube-system` stops being renewed; `renewTime` more than fifteen
seconds old is your proof. A Pod with `spec.nodeName` set by hand bypasses
the scheduler entirely: the kubelet picks it up directly, which is how static
pods and some emergency tooling work, and how you can prove the rest of the
pipeline is healthy while you restore the manifest.

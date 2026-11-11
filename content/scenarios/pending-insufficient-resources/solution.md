## Diagnosis

Pending Pods: the scheduler explains itself in the events.

```bash
kubectl describe pod -n lab-capacity -l app=reports | grep -A4 Events
#   Warning  FailedScheduling  0/3 nodes are available: 1 node(s) had untolerated taint
#   {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory.
#   preemption: 0/3 nodes are available: 1 No preemption victims found for incoming pod, ...
```

"2 Insufficient memory" means both workers were rejected by the
`NodeResourcesFit` filter: the Pod's memory request does not fit in their
allocatable budget. Compare request and budget:

```bash
kubectl get deploy reports -n lab-capacity -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
# {"limits":{"memory":"64Gi"},"requests":{"cpu":"10m","memory":"64Gi"}}
kubectl describe node sre-labs-worker | grep -A6 '^Allocatable'
# Allocatable:
#   cpu:     8
#   memory:  7.6Gi (for example; depends on your machine)
```

No node in this cluster, idle or not, can reserve 64Gi for one container.
"No preemption victims found" confirms it: evicting every other Pod would
still not free enough.

## Root cause

The manifest requests `memory: 64Gi` (almost certainly a copy/paste of a
production value, or a `Gi` where `Mi` was meant). The request is a
reservation checked against each node's *allocatable* memory; it has nothing
to do with how much memory the process will use. More nodes of the same size
would change nothing.

## Fix

Right-size the request (and the limit, which inherited the same typo):

```bash
kubectl set resources deploy/reports -n lab-capacity \
  --requests=cpu=10m,memory=64Mi --limits=memory=128Mi
kubectl rollout status deploy/reports -n lab-capacity
kubectl get pods -n lab-capacity
# reports-...   1/1   Running
```

Pick the value from measurement (`kubectl top pod`, VPA recommendations,
the app's own metrics), not from another environment.

## Prevention

- `LimitRange` per namespace with `max.memory` (and sensible defaults) so a
  64Gi request is rejected at apply time with a readable error.
- `ResourceQuota` per namespace: it also surfaces the mistake immediately and
  protects neighbours.
- Alert on `kube_pod_status_unschedulable == 1` for more than a few minutes;
  the FailedScheduling event already contains the diagnosis.
- Keep per-environment values files; never copy production resource blocks
  into dev/lab manifests "to be safe".

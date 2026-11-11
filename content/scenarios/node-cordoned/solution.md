## Diagnosis

`Pending` with an empty NODE column means the scheduler has not placed the
Pod. It always explains itself in the Pod events:

```bash
kubectl get pods -n lab-cordon -o wide
# NAME       READY   STATUS    NODE
# api-...    0/1     Pending   <none>
kubectl describe pod -n lab-cordon -l app=api | grep -A4 Events
#   Warning  FailedScheduling  ...  0/3 nodes are available: 1 node(s) had untolerated
#   taint {node-role.kubernetes.io/control-plane: }, 2 node(s) were unschedulable.
#   preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.
```

Three nodes, three rejections: the control-plane node by its normal taint,
the two workers because they are *unschedulable*. Confirm on the nodes:

```bash
kubectl get nodes
# NAME                     STATUS                     ROLES           AGE   VERSION
# sre-labs-control-plane   Ready                      control-plane   ...
# sre-labs-worker          Ready,SchedulingDisabled   <none>          ...
# sre-labs-worker2         Ready,SchedulingDisabled   <none>          ...
kubectl get node sre-labs-worker -o jsonpath='{.spec.unschedulable}'
# true
```

Ready is about the kubelet's health; `SchedulingDisabled` is a separate flag
and the platform team's "all Ready" statement was true but irrelevant.

## Root cause

Both workers were cordoned for the kernel patch (`kubectl cordon` or
`kubectl drain`) and never uncordoned. Running Pods were unaffected, which is
why nobody noticed until a new release needed scheduling.

## Fix

```bash
kubectl uncordon sre-labs-worker sre-labs-worker2
kubectl get pods -n lab-cordon -w
# api-...   1/1   Running   (within seconds)
```

No change to the Deployment is needed; the Pending Pods are re-evaluated by
the scheduler as soon as nodes become schedulable.

## Prevention

- Make uncordon part of the maintenance runbook/automation, with a final
  `kubectl get nodes | grep SchedulingDisabled` gate before closing the
  change.
- Alert on `kube_node_spec_unschedulable == 1` for longer than the maintenance
  window (kube-state-metrics), and on Pods Pending for more than a few
  minutes (`kube_pod_status_phase{phase="Pending"}`).
- Deploy a canary after node maintenance so scheduling problems surface
  during the window, not at the next release.

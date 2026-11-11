## Diagnosis

Pending Pods, so read the scheduler's verdict:

```bash
kubectl describe pod -n lab-taint -l app=ingest | grep -A4 Events
#   Warning  FailedScheduling  0/3 nodes are available:
#     1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: },
#     1 node(s) had untolerated taint {team: data},
#     1 node(s) didn't match Pod's node affinity/selector.
```

Each clause is one node. The control-plane node is tainted as usual,
`sre-labs-worker` fails the `disk=ssd` nodeSelector, and the node we want,
`sre-labs-worker2`, rejects the Pod because of a taint the Pod does not
tolerate:

```bash
kubectl describe node sre-labs-worker2 | grep -A1 -E '^Taints|disk='
# Labels: ... disk=ssd ...
# Taints: team=data:NoSchedule
kubectl get deploy ingest -n lab-taint -o jsonpath='{.spec.template.spec.tolerations}'
# (empty)
```

## Root cause

The Deployment targets the reserved node with `nodeSelector: disk=ssd` but
carries no toleration for the node's `team=data:NoSchedule` taint. Selection
(attract) and toleration (be allowed in) are two separate mechanisms and
both are required. The taint is intentional: it is how the node stays
reserved for the data team.

## Fix

Add the toleration to the Pod template; leave the node alone.

```bash
kubectl patch deploy ingest -n lab-taint --type=json -p '[
  {"op":"add","path":"/spec/template/spec/tolerations","value":[
    {"key":"team","operator":"Equal","value":"data","effect":"NoSchedule"}
  ]}
]'
kubectl rollout status deploy/ingest -n lab-taint
kubectl get pods -n lab-taint -o wide
# ingest-...   1/1   Running   sre-labs-worker2
# ingest-...   1/1   Running   sre-labs-worker2
```

A toleration with `operator: Exists` on key `team` would also work; avoid a
bare `operator: Exists` with no key, which tolerates *every* taint and
defeats node reservations cluster-wide.

## Prevention

- Document reserved nodes as a pair: the taint **and** the toleration
  snippet teams must add. Publish it in the platform docs next to the label.
- Encode the pairing in templates (Helm values `nodePool: ssd` renders both
  nodeSelector and toleration) so nobody can set one without the other.
- Alert on Pods Pending with reason `Unschedulable` for more than a few
  minutes; the event text already contains the fix.
- In review, any manifest with a `nodeSelector`/affinity for a reserved pool
  without the matching toleration is a blocking comment.

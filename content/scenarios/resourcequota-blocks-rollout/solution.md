## Diagnosis

The first useful observation is a negative one: there are no Pending Pods.
The scheduler only acts on Pods that exist, so whatever is wrong happens
*before* scheduling, at creation time. Walk up the ownership chain:
Deployment -> ReplicaSet -> Pods.

```bash
kubectl get deploy,rs,pods -n lab-quota
# deployment.apps/api   2/5     2            2
# replicaset.apps/api-7d9f8b6c5   5         2         2
# pod/api-7d9f8b6c5-...  1/1  Running  (x2)

kubectl describe rs -n lab-quota -l app=api | tail -n 6
# Events:
#   Warning  FailedCreate  replicaset-controller  Error creating: pods "api-7d9f8b6c5-xk2lp" is forbidden:
#     exceeded quota: team-quota, requested: requests.cpu=20m, used: requests.cpu=40m, limited: requests.cpu=50m

kubectl get deploy api -n lab-quota -o jsonpath='{range .status.conditions[*]}{.type}={.status}: {.message}{"\n"}{end}'
# ReplicaFailure=True: pods "api-..." is forbidden: exceeded quota: team-quota, ...
```

The API server refuses the third Pod. Look at the quota itself:

```bash
kubectl describe quota team-quota -n lab-quota
# Resource         Used   Hard
# pods             2      10
# requests.cpu     40m    50m
# requests.memory  32Mi   256Mi
```

Each Pod requests 20m CPU; two Pods use 40m; a third would need 60m > 50m.
`pods` and `requests.memory` have room, which is why the team did not
notice: the limiting dimension is CPU requests.

Note the timestamps of the `FailedCreate` events: 5s, 10s, 20s, 40s apart.
The ReplicaSet controller backs off exponentially, which is why the
`rollout restart` the team tried did not help: the new ReplicaSet hit the
same wall.

## Root cause

A namespace `ResourceQuota` (`team-quota`) caps `requests.cpu` at 50m. The
quota admission plugin rejects any Pod whose request would push usage over
the cap. The Deployment and ReplicaSet are correct, the nodes are empty,
the scheduler never sees the missing Pods: the error is only visible on the
ReplicaSet (and in the Deployment's `ReplicaFailure` condition).

## Fix

Option A, raise the quota so the launch fits, including one surge Pod for
rolling updates (5 x 20m = 100m, + 20m surge):

```bash
kubectl patch resourcequota team-quota -n lab-quota --type=merge -p '{"spec":{"hard":{"requests.cpu":"200m"}}}'
# the ReplicaSet may be deep in backoff; force an immediate reconcile
kubectl rollout restart deploy/api -n lab-quota
kubectl rollout status deploy/api -n lab-quota
kubectl get deploy api -n lab-quota      # 5/5
```

Option B, right-size the workload so five replicas fit the existing budget
(5 x 10m = 50m). This creates a new ReplicaSet, so no extra kick is needed,
but it leaves no room for a surge Pod during future rollouts; combine it
with a modest quota increase:

```bash
kubectl set resources deploy/api -n lab-quota --requests=cpu=10m
```

Deleting the quota would "work" but removes the guard rail the platform team
put there on purpose; it is not a fix.

## Prevention

- Alert on `kube_resourcequota{type="used"} / kube_resourcequota{type="hard"} > 0.8`
  per namespace and resource, and on `kube_deployment_status_condition{condition="ReplicaFailure",status="true"}`.
- Make capacity part of the launch checklist: `kubectl describe quota` before
  scaling, and size quotas for `replicas + maxSurge`.
- Show quota usage on the team's dashboard; a quota nobody can see is a
  quota everybody hits at the worst time.

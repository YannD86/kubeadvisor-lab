## Diagnosis

Two Pending objects, one dependency: the Pod needs the claim, so the claim
is where to start.

```bash
kubectl get pvc,pods -n lab-storage
# persistentvolumeclaim/data   Pending                 fast-ssd   <unset>   10m
# pod/uploads-5c7b8d9f6-tq4xr  0/1     Pending   0     10m

kubectl describe pvc data -n lab-storage | tail -n 3
# Events:
#   Warning  ProvisioningFailed  persistentvolume-controller  storageclass.storage.k8s.io "fast-ssd" not found

kubectl describe pod -n lab-storage -l app=uploads | tail -n 3
#   Warning  FailedScheduling  default-scheduler  0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.
#   preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.
```

The Pod is not the problem: the scheduler refuses to place a Pod whose
claim is unbound. What can the cluster actually provision?

```bash
kubectl get storageclass
# NAME                 PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE      ...
# standard (default)   rancher.io/local-path   Delete          WaitForFirstConsumer   ...
kubectl get pvc data -n lab-storage -o jsonpath='{.spec.storageClassName}'
# fast-ssd
```

There is no `fast-ssd` class here: no provisioner is watching for that name,
so nothing will ever create a PV for the claim.

## Root cause

The manifests were copied from a cluster that had a `fast-ssd` StorageClass.
A PVC is just a request addressed to a class; with an unknown class there is
no error at apply time, no controller to act, and the claim stays Pending
forever. The Pod inherits the wait.

## Fix

`spec.storageClassName` is immutable, so the claim must be recreated. The
Pending Pod is *unscheduled*, which means the pvc-protection finalizer does
not consider it a user of the claim and the delete goes through immediately:

```bash
kubectl delete pvc data -n lab-storage
kubectl apply -n lab-storage -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
  labels: { app: uploads }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: standard
  resources: { requests: { storage: 1Gi } }
EOF
kubectl get pvc,pods -n lab-storage -w
# data   Bound   pvc-...   1Gi   RWO   standard
# uploads-...   1/1   Running
```

`standard` binds on first consumer (`WaitForFirstConsumer`): the scheduler
picks a node, local-path provisions the volume there, the Pod starts. If the
Pod does not get re-queued within a minute, `kubectl delete pod -l app=uploads`
and let the Deployment recreate it. Verify the mount:

```bash
kubectl exec -n lab-storage deploy/uploads -- sh -c 'df -h /data; tail -n 2 /data/heartbeat.log'
```

Omitting `storageClassName` entirely also works because `standard` is the
default class, but being explicit survives a change of default.

## Prevention

- Alert on `kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1` for
  more than 5 minutes, and on Pods Pending with `FailedScheduling`.
- Validate `storageClassName` against the target cluster in CI (a Conftest /
  Kyverno rule with the allowed classes), or template the class per
  environment instead of hard-coding it.
- Keep a migration checklist: StorageClasses, IngressClasses and
  PriorityClasses are cluster-scoped and never travel with namespaced manifests.

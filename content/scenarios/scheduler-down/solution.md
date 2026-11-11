## Diagnosis

Pending Pods normally carry a `FailedScheduling` event that explains the
rejection. Here there is nothing, which is a different animal:

```bash
kubectl get pods -n lab-sched -o wide
# NAME       READY   STATUS    NODE
# api-...    0/1     Pending   <none>
kubectl describe pod -n lab-sched -l app=api | grep -A2 Events
# Events:  <none>                          <-- no scheduler ever looked at them
```

No events means no component evaluated the Pod. Check the component whose
job that is:

```bash
kubectl get pods -n kube-system -l component=kube-scheduler
# No resources found in kube-system namespace.
kubectl get lease -n kube-system kube-scheduler -o jsonpath='{.spec.holderIdentity} {.spec.renewTime}{"\n"}'
# sre-labs-control-plane_1f2c...  2026-10-22T08:51:02Z     <-- renewTime frozen minutes ago
```

The scheduler is a static Pod managed by the control-plane kubelet, not by
the API, so there is no Deployment to look at. Go to the node:

```bash
docker exec -it sre-labs-control-plane bash          # real cluster: ssh
ls -la /etc/kubernetes/manifests/
# etcd.yaml  kube-apiserver.yaml  kube-controller-manager.yaml     <-- kube-scheduler.yaml missing
ls -la /etc/kubernetes/*.bak
# /etc/kubernetes/kube-scheduler.yaml.bak                          <-- the "cleanup"
crictl ps -a | grep kube-scheduler
# ... Exited ...  (stopped when the manifest vanished)
journalctl -u kubelet --no-pager | grep -i 'kube-scheduler' | tail -3
```

## Root cause

The static Pod manifest `/etc/kubernetes/manifests/kube-scheduler.yaml` was
moved out of the directory the kubelet watches. The kubelet treats a missing
file as "delete this Pod": it stopped the scheduler and removed its mirror
Pod from `kube-system`. Everything that was already placed keeps running;
everything new waits forever with `spec.nodeName` empty.

## Fix

Put the file back where the kubelet looks for it:

```bash
docker exec sre-labs-control-plane \
  mv /etc/kubernetes/kube-scheduler.yaml.bak /etc/kubernetes/manifests/kube-scheduler.yaml

kubectl get pods -n kube-system -l component=kube-scheduler -w     # appears, then 1/1 Running
kubectl get lease -n kube-system kube-scheduler                     # renewTime moving again
kubectl get pods -n lab-sched -w                                    # Pending -> Running
```

The kubelet rescans the manifests directory every 20 s, starts the Pod, the
scheduler wins the Lease and processes the Pending backlog immediately. If
the backup file were lost, `kubeadm init phase control-plane scheduler
--config /kind/kubeadm.conf` regenerates a standard manifest.

## Prevention

- Monitor the control plane as workloads: `up{job="kube-scheduler"}` or the
  age of the `kube-scheduler` Lease, plus `kube_pod_status_unschedulable`
  and "Pods Pending > 5 min with no events".
- Treat `/etc/kubernetes/manifests` as immutable infrastructure: changes go
  through `kubeadm upgrade` or configuration management, never a manual
  "cleanup". File-integrity monitoring on that directory is cheap.
- Run more than one control-plane node; a scheduler lost on one is then
  covered by leader election on another.
- Runbook: "Pending with no events" means look at kube-system and the Leases
  before anything else.

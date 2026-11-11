## Diagnosis

The API is answering, so start by walking the ownership chain the Deployment
should have produced:

```bash
kubectl get deploy,rs,pods -n lab-cm
# NAME                  READY   UP-TO-DATE   AVAILABLE
# deployment.apps/api   0/3     0            0
# (no replicasets, no pods)
kubectl get events -n lab-cm
# No resources found in lab-cm namespace.
```

A Deployment is inert data; the Deployment controller turns it into a
ReplicaSet and the ReplicaSet controller into Pods. Nothing happened at the
first step, and the side reports (namespaces stuck `Terminating`, no
`default` ServiceAccount in new namespaces) are other controllers also not
running. They all live in one binary:

```bash
kubectl get pods -n kube-system -l component=kube-controller-manager
# No resources found in kube-system namespace.
kubectl get lease -n kube-system kube-controller-manager -o jsonpath='{.spec.holderIdentity} {.spec.renewTime}{"\n"}'
# sre-labs-control-plane_7a1e...  2026-10-22T08:47:40Z      <-- frozen
```

It is a static Pod, so inspect the control-plane node itself:

```bash
docker exec -it sre-labs-control-plane bash          # real cluster: ssh
ls -la /etc/kubernetes/manifests/
# etcd.yaml  kube-apiserver.yaml  kube-scheduler.yaml        <-- kube-controller-manager.yaml missing
ls -la /etc/kubernetes/*.bak
# /etc/kubernetes/kube-controller-manager.yaml.bak
crictl ps -a | grep kube-controller-manager
# ... Exited ...
```

## Root cause

`/etc/kubernetes/manifests/kube-controller-manager.yaml` was moved out of
the kubelet's static Pod directory. The kubelet stopped the container and
removed the mirror Pod. With no controller-manager, every reconciliation
loop in the cluster is frozen: Deployments do not get ReplicaSets, deleted
namespaces never finish, new namespaces never get their `default`
ServiceAccount, garbage is not collected.
Reads and writes to the API keep working, which makes the failure look like
"nothing is wrong, nothing happens".

## Fix

```bash
docker exec sre-labs-control-plane \
  mv /etc/kubernetes/kube-controller-manager.yaml.bak /etc/kubernetes/manifests/kube-controller-manager.yaml

kubectl get pods -n kube-system -l component=kube-controller-manager -w   # 1/1 Running within ~30 s
kubectl get lease -n kube-system kube-controller-manager                   # renewTime advancing
kubectl get rs,pods -n lab-cm -w                                           # ReplicaSet appears, then 3 Pods
kubectl rollout status deploy/api -n lab-cm                                # 3/3
```

The ReplicaSet is created by the controller, so it carries an ownerReference
to the Deployment. Creating it by hand would "work" but is not a fix. If the
backup file is lost, `kubeadm init phase control-plane controller-manager
--config /kind/kubeadm.conf` regenerates the manifest with the cluster's
settings (pod CIDR, cloud flags).

## Prevention

- Alert on the control-plane Leases (`kube-controller-manager`,
  `kube-scheduler`) not being renewed for more than a minute, and on
  `up{job="kube-controller-manager"}`.
- Alert on Deployments whose `spec.replicas` and `status.replicas` disagree
  for more than a few minutes (`kube_deployment_spec_replicas` versus
  `kube_deployment_status_replicas`); it catches a dead controller-manager
  and a dozen other problems.
- Never edit `/etc/kubernetes/manifests` by hand in production; use `kubeadm
  upgrade`/configuration management and keep file-integrity monitoring on it.
- Multiple control-plane nodes make this a degraded state instead of an
  outage.

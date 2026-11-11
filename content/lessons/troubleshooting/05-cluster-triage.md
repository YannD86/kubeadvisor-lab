---
title: "Cluster triage: control plane components and what their absence looks like"
slug: cluster-triage
realm: troubleshooting
order: 5
summary: "Static pods under /etc/kubernetes/manifests, which component to suspect from the symptom, crictl when the API is down, etcd health and backups, certificate expiry, and the kube-system checklist."
estimated_minutes: 20
level: advanced
tags: [control-plane, apiserver, etcd, scheduler, controller-manager, static-pods, crictl, certificates]
builders: []
scenarios: [scheduler-down, controller-manager-down, apiserver-etcd-wrong-port]
diagram: cluster-anatomy
quiz:
  - q: "You create a Deployment; it appears, but no ReplicaSet ever shows up. Which component is down?"
    options: ["kube-scheduler", "kube-controller-manager", "kube-apiserver", "CoreDNS"]
    answer: 1
    explain: "The Deployment controller, which creates ReplicaSets, lives in kube-controller-manager. The API accepted the object; nobody is reconciling it."
  - q: "Pods stay Pending with an empty nodeName and no events at all. Which component is the suspect?"
    options: ["kube-controller-manager", "kube-scheduler", "kubelet", "etcd"]
    answer: 1
    explain: "Scheduling failures produce FailedScheduling events; total silence means nobody is scheduling. A Pod with spec.nodeName set bypasses the scheduler and would still run."
  - q: "kubectl fails with 'connection refused'. How do you read the API server's log?"
    options: ["kubectl logs -n kube-system kube-apiserver-sre-labs-control-plane", "kubectl get events -n kube-system", "docker exec into the control-plane node and use crictl ps -a / crictl logs", "Restart the kubelet"]
    answer: 2
    explain: "Every kubectl command needs the API. crictl talks to containerd directly on the node, and static pod containers are visible there even when the API is down."
---

# Cluster triage

In a kubeadm cluster the control plane is four **static pods** run by the
kubelet of the control-plane node from `/etc/kubernetes/manifests/`:
`etcd.yaml`, `kube-apiserver.yaml`, `kube-controller-manager.yaml`,
`kube-scheduler.yaml`. The kubelet watches that directory (the
`staticPodPath` in `/var/lib/kubelet/config.yaml`): edit a file and the Pod
restarts; move the file out and the Pod stops. The Pods you see in
`kube-system` (`kube-apiserver-sre-labs-control-plane`...) are **mirror
pods**, read-only reflections; deleting one changes nothing.

**Why it matters:** each component owns a distinct set of behaviours, so the
absence of a component produces a distinct silence. Learn the silences and
you will know which manifest to open.

## The decision table

| Symptom | First command | Likely causes |
|---|---|---|
| `kubectl` says `connection refused` / `EOF` / hangs | `docker exec -it sre-labs-control-plane crictl ps -a` | apiserver not running, or crashing because etcd is unreachable |
| `kubectl` works but writes fail with `etcdserver: request timed out` | `kubectl get --raw /readyz?verbose` | etcd slow, disk full, `NOSPACE` alarm |
| Pods `Pending`, empty `nodeName`, **no** events | `kubectl get lease -n kube-system kube-scheduler` | scheduler static pod down or crash-looping |
| Deployment without ReplicaSet, RS without Pods, Service without endpoints, Job without Pods | `kubectl get lease -n kube-system kube-controller-manager` | controller-manager down |
| Namespace stuck `Terminating`, PVC never binds, NotReady nodes never evict | same lease | controller-manager down |
| `x509: certificate has expired` | `kubeadm certs check-expiration` on the node | client or serving certificate past its one-year validity |
| Static pod edited, nothing happens | `journalctl -u kubelet \| grep -i manifest` | YAML error in the manifest, wrong `staticPodPath` |
| Cluster-wide DNS failure | `kubectl -n kube-system get pods -l k8s-app=kube-dns` | CoreDNS (chapter 03), not control plane |

## Tell the component from the symptom

- **kube-apiserver**: everything goes through it. If `kubectl` cannot
  connect, it is down; if it is down because it cannot reach etcd, its log
  shows `transport: Error while dialing: dial tcp 127.0.0.1:2389: connect: connection refused`
  repeated, then `context deadline exceeded`. The `--etcd-servers` flag in
  the manifest must match the client port etcd listens on (`2379`; `2380` is
  the peer port, `2381` the metrics port).
- **etcd**: the apiserver is up but slow or read-only. Lines such as
  `etcdserver: request timed out`, `mvcc: database space exceeded`,
  `wal: sync duration` point at disk or quota.
- **kube-scheduler**: new Pods are created, have no `nodeName`, and `describe`
  shows **no** events. A Pod with `spec.nodeName` set bypasses the scheduler
  and runs, which is a clean test.
- **kube-controller-manager**: objects are accepted and never acted upon.
  No ReplicaSet for a Deployment, no Pods for a ReplicaSet or Job, no
  endpoints for a Service that selects Ready Pods, no taints on a NotReady
  node, PVCs that stay `Pending`, ServiceAccount tokens not minted.

Both the scheduler and the controller-manager elect a leader through a Lease
in `kube-system`. A stale `renewTime` is the fastest proof that nobody is in
charge:

```bash
kubectl get lease -n kube-system kube-scheduler kube-controller-manager \
  -o custom-columns=NAME:.metadata.name,HOLDER:.spec.holderIdentity,RENEWED:.spec.renewTime
kubectl get pods -n kube-system -o wide | grep -E 'etcd|apiserver|scheduler|controller'
kubectl get --raw /readyz?verbose | grep -v ok      # prints only failing checks
```

`kubectl get componentstatuses` still exists but has been deprecated since
1.19 and reports from the apiserver's point of view only; do not trust it.
See Components → API server, Scheduler and Controller manager for what each
one loops over.

## When the API is down: crictl on the node

`kubectl` needs the apiserver, so the control-plane node is your only
console. Static pod containers are ordinary containerd containers:

```bash
N="docker exec sre-labs-control-plane"          # or docker exec -it sre-labs-control-plane bash, then drop the prefix
$N ls -l /etc/kubernetes/manifests/
$N crictl ps -a | grep -E 'kube-apiserver|etcd'        # STATE Exited and the restart count
$N crictl logs --tail 50 $($N crictl ps -a --name kube-apiserver -q | head -1)
$N journalctl -u kubelet --no-pager | grep -iE 'manifest|apiserver' | tail -20
$N sh -c 'ls /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/'   # rotated logs survive restarts
```

**Gotcha:** a static pod manifest with invalid YAML is **not** an error you
can see from the API. The kubelet logs `Could not process manifest file` and
keeps the previous Pod running (or nothing, if there was none). Validate with
`kubectl apply --dry-run=client -f` on another machine, or simply diff against
a sibling manifest.

## etcd health and backups

etcd stores every object. In the lab it listens on `127.0.0.1:2379` with TLS
and its data lives in the hostPath `/var/lib/etcd` on the control-plane node.
The client needs the certificates from the manifest, and the etcd image has
no shell, so exec the binary directly:

```bash
E="--endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"
kubectl -n kube-system exec etcd-sre-labs-control-plane -- etcdctl $E endpoint health
kubectl -n kube-system exec etcd-sre-labs-control-plane -- etcdctl $E endpoint status --write-out=table
```

`endpoint health` answers `is healthy: successfully committed proposal`;
`endpoint status` shows DB size, leader and the `RAFT INDEX`. A backup is one
command, `etcdctl snapshot save /var/lib/etcd/backup.db` (the hostPath keeps
it on the node), and a restore is `etcdutl snapshot restore backup.db --data-dir /var/lib/etcd-restored`
followed by pointing the `etcd.yaml` hostPath at the new directory. Practise
the restore before you need it; the snapshot alone is not a backup strategy.
See Components → etcd.

## Certificates

kubeadm issues one-year certificates for the apiserver, the
controller-manager and scheduler clients, the kubelet client and etcd; the
CAs last ten years. The signature is unambiguous:
`Unable to connect to the server: x509: certificate has expired or is not yet valid`.

```bash
docker exec -it sre-labs-control-plane kubeadm certs check-expiration
docker exec -it sre-labs-control-plane openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
```

`kubeadm certs renew all` rewrites the files under `/etc/kubernetes/pki` and
the embedded kubeconfigs (`admin.conf`, `controller-manager.conf`,
`scheduler.conf`); the static pods only pick them up after a restart, so move
the manifests out and back. The kubelet's own client certificate rotates
automatically (`/var/lib/kubelet/pki/kubelet-client-current.pem`) as long
as the controller-manager is alive to sign it.

## The kube-system checklist

**Try it:** run this on a healthy day and keep the output. On a bad day the
diff is the diagnosis.

```bash
kubectl get pods -n kube-system -o wide
kubectl get pods -n local-path-storage
```

Expected in the lab: one `etcd-`, `kube-apiserver-`, `kube-controller-manager-`
and `kube-scheduler-` Pod on `sre-labs-control-plane`; `kube-proxy` and
`calico-node` as DaemonSets with three Pods each; one
`calico-kube-controllers`; two `coredns`; `metrics-server` if the addon is
installed; `local-path-provisioner` in its own namespace. Anything with
`RESTARTS` growing or `AGE` younger than the incident is where to start.

## k9s tip

k9s dies with the API: a red `Unable to connect to context` toast means
go to the node and use `crictl`. While the API answers, `:pods` with `0`
and `/kube-` filters the control plane; `l` on a static pod reads its log,
`d` shows the `Controlled By: Node/sre-labs-control-plane` line that marks a
mirror pod. `:lease` in `kube-system` shows who holds leadership and when it
was renewed.

## Practice

- `scheduler-down`: Pods Pending with no events; find out why nobody places them.
- `controller-manager-down`: Deployments that never spawn a ReplicaSet.
- `apiserver-etcd-wrong-port`: kubectl refuses to connect; only crictl and the manifests can tell you why.

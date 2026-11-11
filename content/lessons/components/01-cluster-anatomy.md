---
title: "Cluster anatomy: control plane, nodes, and who talks to whom"
slug: cluster-anatomy
realm: components
order: 1
summary: "The components of a kubeadm cluster, how each one runs (static pod, DaemonSet or systemd), and the one rule that explains every arrow: everything goes through the API server."
estimated_minutes: 15
level: beginner
tags: [architecture, control-plane, static-pods, daemonset, addons]
builders: [hpa-autoscaling]
scenarios: [scheduler-down, controller-manager-down]
diagram: cluster-anatomy
quiz:
  - q: "Which component is the only one allowed to open a connection to etcd?"
    options: ["kube-controller-manager", "kube-scheduler", "kube-apiserver", "kubelet"]
    answer: 2
    explain: "etcd is the API server's private database. Every other component reads and writes cluster state through the API server, which is why the API server is the single place for authentication, authorization, admission and audit."
  - q: "You run `kubectl delete pod kube-scheduler-sre-labs-control-plane -n kube-system`. What happens?"
    options: ["The scheduler is gone until someone recreates it", "The Pod object disappears and immediately comes back; the process was never stopped by the delete", "kubectl refuses because the Pod is protected", "The Deployment recreates it"]
    answer: 1
    explain: "Static pods are owned by the kubelet, which reads them from /etc/kubernetes/manifests. The API object you see is a mirror pod. Deleting the mirror only makes the kubelet re-create it; to stop the process you must move the manifest file."
  - q: "kube-proxy and calico-node run as DaemonSets. What does that imply for cluster bootstrap?"
    options: ["They start before the kubelet", "They cannot start until the API server is up, because DaemonSet pods are created through the API", "They are started by containerd directly", "They run only on worker nodes"]
    answer: 1
    explain: "A DaemonSet is an API object reconciled by the controller-manager; its pods are scheduled through the API server. Static pods and systemd services exist precisely to break this chicken-and-egg problem for the control plane itself."
---

# Cluster anatomy

A Kubernetes cluster looks like a tangle of daemons until you notice that it
has one hub. Every component is a client of the API server, and the API server
is the only client of etcd. Once you hold that picture, the rest of this realm
is about what each spoke does with the state it reads.

Open the interactive diagram next to this lesson and keep it in view: it shows
the lab cluster you have in the terminal, three kind nodes running as Docker
containers.

## Two planes, one hub

| Component | Runs on | How it runs in this lab | Talks to |
|---|---|---|---|
| kube-apiserver | control-plane | static pod | etcd (the only one that does); serves everyone else |
| etcd | control-plane | static pod | nobody; it only answers the API server |
| kube-scheduler | control-plane | static pod | API server (watches unscheduled Pods, writes Bindings) |
| kube-controller-manager | control-plane | static pod | API server (watches everything, writes desired child objects) |
| kubelet | every node | systemd service | API server, and containerd over the CRI socket |
| containerd | every node | systemd service | kubelet (gRPC), CNI plugins (exec) |
| kube-proxy | every node | DaemonSet | API server (watches Services and EndpointSlices), the kernel |
| calico-node (CNI) | every node | DaemonSet | API server (its datastore), the kernel |
| CoreDNS | any node | Deployment, 2 replicas | API server (watches Services and EndpointSlices) |
| metrics-server (optional addon) | any node | Deployment | every kubelet (scrapes `/metrics/resource`), registers as an aggregated API |

**Why it matters:** the "Talks to" column has no horizontal arrows. The
scheduler never tells the kubelet to start a Pod; it writes a Binding to the
API, and the kubelet, which watches Pods with `spec.nodeName` equal to its own
name, reacts. The controller-manager never calls the scheduler. Components
cooperate by writing to and watching the same objects. This is why one slow
or dead API server stalls the whole cluster while already-running workloads
keep serving: the kubelet and kube-proxy keep what they last saw.

**Gotcha:** there is one set of arrows in the other direction. The API server
dials the kubelet on port 10250 for `kubectl logs`, `exec`, `port-forward` and
for the metrics pipeline, and it dials admission webhooks and aggregated API
servers. When `kubectl logs` fails but `kubectl get` works, the API server is
fine and the API-server-to-kubelet hop is what to inspect.

## Three ways a component can run

The bootstrap problem is circular: Pods are created through the API server,
but the API server is itself a Pod. kubeadm breaks the circle in layers.

1. **systemd services.** `containerd` and `kubelet` are plain processes
   managed by systemd inside each node. They must exist before any Pod can.
2. **Static pods.** The kubelet watches a directory, `/etc/kubernetes/manifests`
   (`staticPodPath` in its config), and runs whatever Pod manifests it finds,
   with no API server involved. kubeadm puts `etcd.yaml`,
   `kube-apiserver.yaml`, `kube-controller-manager.yaml` and
   `kube-scheduler.yaml` there. Once the API server is up, the kubelet
   creates a read-only *mirror pod* for each so that `kubectl` can see them;
   their names end with the node name.
3. **DaemonSets and Deployments.** Everything that can wait for the API:
   kube-proxy, calico-node, CoreDNS, metrics-server. These are reconciled by
   the controller-manager and scheduled by the scheduler like your own
   workloads.

**Try it:** map the table onto the real cluster.

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide                 # which pods sit on the control-plane node?
kubectl -n kube-system get ds,deploy                    # DaemonSets vs Deployments
kubectl -n kube-system get pods -o custom-columns='NAME:.metadata.name,SOURCE:.metadata.annotations.kubernetes\.io/config\.source,NODE:.spec.nodeName'
docker exec sre-labs-control-plane ls /etc/kubernetes/manifests
docker exec sre-labs-control-plane systemctl list-units --type=service --no-pager | grep -E 'kubelet|containerd'
docker exec sre-labs-worker crictl ps -o json | grep -c '"id"'   # containers the runtime knows about
```

The `SOURCE` column reads `file` for the four static pods and `<none>` for
every other Pod: the kubelet stamps that annotation only on the mirror pods
it creates itself. That single column tells you which layer owns a process.

## The add-ons: what breaks without them

The cluster is "up" without any add-on, but useless. Each add-on fills a
contract the core leaves open.

- **CNI (Calico here).** The kubelet asks containerd to create a Pod sandbox;
  containerd calls the CNI plugin to give it an interface and an IP. With no
  CNI, nodes report `NotReady` with `NetworkPluginNotReady` and every Pod
  stays `ContainerCreating`. The CNI also decides whether `NetworkPolicy` is
  enforced at all.
- **CoreDNS.** Nothing in the core resolves `my-svc.my-ns.svc.cluster.local`.
  CoreDNS watches Services and EndpointSlices and answers from memory. The
  kubelet writes its ClusterIP (`10.96.0.10`) into every Pod's
  `/etc/resolv.conf`.
- **kube-proxy.** Services are just objects until something programs the
  kernel. Without kube-proxy a ClusterIP is an address nobody answers.
- **metrics-server.** `kubectl top` and the HorizontalPodAutoscaler read
  through the `metrics.k8s.io` aggregated API. It is not installed by
  default in the lab; the `metrics-server` addon on the Cluster page
  installs it, and the `hpa-autoscaling` builder and chapter 11 require it.

## Where this lesson gets broken for you

Two scenarios in this realm remove one static pod each. In
**scheduler-down**, Pods you create stay `Pending` with no events at all,
because nobody is left to write Bindings. In **controller-manager-down**,
scaling a Deployment changes `spec.replicas` and nothing else: no new
ReplicaSet, no new Pods, and a deleted Pod is never replaced. Both clusters
answer `kubectl` normally and keep serving traffic, which is exactly why these
failures are easy to miss. The first signal in both is a missing or stale Pod
in `kubectl -n kube-system get pods`, and the fix lives in
`/etc/kubernetes/manifests`, not in the API.

The next lesson follows a single `kubectl apply` through every component in
the table, in order.

---
title: "kubelet and the container runtime: from PodSpec to processes"
slug: kubelet-and-container-runtime
realm: components
order: 7
summary: "How the kubelet turns a Pod into containers through the CRI and containerd, what the pause container and cgroups are for, who runs probes, how static pods work, and how node conditions and eviction protect the node."
estimated_minutes: 20
level: intermediate
tags: [kubelet, cri, containerd, crictl, cgroups, probes, static-pods, eviction, node-conditions]
builders: []
scenarios: [kubelet-stopped, oom-memory-limit, liveness-wrong-path]
quiz:
  - q: "A liveness probe fails three times. What does the kubelet do?"
    options: ["Deletes the Pod so the controller recreates it", "Restarts only that container in place, in the same Pod sandbox, keeping the Pod IP", "Marks the node NotReady", "Removes the Pod from Service endpoints but keeps it running"]
    answer: 1
    explain: "Liveness is container-scoped: the kubelet kills and recreates the container via the CRI; the Pod object, its IP and its sandbox stay. Removing from endpoints is what a failing readiness probe does."
  - q: "You stop the kubelet on sre-labs-worker. What happens to the nginx containers already running there?"
    options: ["They stop immediately", "They keep running under containerd; the node goes NotReady after the grace period and the Pods are evicted from the API about 5 minutes later", "containerd stops too", "They are migrated to another node"]
    answer: 1
    explain: "containerd is a separate systemd service and does not depend on the kubelet to keep containers alive. Only the reporting and reconciling stops, which is why the failure is first visible in node conditions rather than in the workloads."
  - q: "A container exits with code 137 and `Last State: Terminated, Reason: OOMKilled`. Who killed it?"
    options: ["The kubelet's eviction manager", "The scheduler", "The kernel OOM killer, because the container's memory cgroup reached its limit", "containerd, because the image was too big"]
    answer: 2
    explain: "Limits become cgroup memory.max. The kernel enforces it and SIGKILLs a process in that cgroup; the kubelet only reports the reason and applies restartPolicy. Node-level eviction by the kubelet is a different mechanism with a different Reason (Evicted)."
---

# kubelet and the container runtime

The kubelet is the only Kubernetes component that touches a process. It runs
as a systemd service on every node, including the control-plane node, and it
is the agent that makes the API server's `Pod` objects into cgroups,
namespaces and running binaries. It does not do that alone: it delegates to
a container runtime through the CRI.

## From PodSpec to containers

The kubelet merges Pods from three sources, the API server (those with its
`nodeName`), the static manifest directory, and an optional HTTP endpoint,
and runs a sync loop per Pod. For a new Pod the steps are:

1. **`RunPodSandbox`** (CRI). containerd creates the *pause* container: a
   tiny process whose only job is to hold the Pod's network and IPC
   namespaces open so app containers can come and go. containerd then
   calls the CNI plugin (`ADD`) to attach an interface and allocate the Pod
   IP. The sandbox is the Pod, as far as the kernel is concerned.
2. **`PullImage`** per container, according to `imagePullPolicy`, with
   credentials from `imagePullSecrets` or node-level config.
3. **`CreateContainer` / `StartContainer`**: containerd asks a shim to run
   `runc`, which builds the mount, PID and user namespaces, joins the
   sandbox's network namespace, applies the cgroup and execs the entrypoint.
   Init containers run to completion first, in order.
4. **Status**: the kubelet reads container states from the runtime and
   PATCHes `pod.status`.

| Layer | Process | Talks over |
|---|---|---|
| kubelet | `kubelet` (systemd) | gRPC to `unix:///run/containerd/containerd.sock` |
| CRI runtime | `containerd` (systemd), CRI plugin built in | OCI runtime spec to a shim |
| shim | `containerd-shim-runc-v2`, one per Pod | fork/exec |
| OCI runtime | `runc` | syscalls (clone, cgroups, pivot_root), then exits |

**Why it matters:** the division explains which failures survive which
restarts. Restarting the kubelet changes nothing for running containers; it
re-attaches to them through containerd. Restarting containerd does not kill
them either: each Pod's shim is a separate process that outlives the daemon
and is re-adopted when it comes back. `docker` is not in this chain at all: `crictl` is the client
that speaks CRI, and the `kubelet-stopped` scenario shows the containers
alive with the agent gone.

## cgroups and QoS

`resources.limits` become cgroup values: `cpu.max` throttles, `memory.max`
is enforced by the kernel. With the systemd cgroup driver, Pods live under
a `kubepods.slice` grouped by QoS class: `Guaranteed` Pods (requests equal
limits for every container) directly in it, the others in
`kubepods-burstable.slice` and `kubepods-besteffort.slice`. On a plain
kubeadm node that is `/sys/fs/cgroup/kubepods.slice/`; kind sets
`cgroupRoot: /kubelet` so that the node container's own processes stay
outside it, which nests everything one level down as
`/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/`. The class decides
eviction order when the node runs short, and `memory.max` decides when the
OOM killer fires for a single container. Exit code 137 with
`Reason: OOMKilled` is the kernel; the kubelet merely notices and restarts
the container per `restartPolicy`, which is the **oom-memory-limit**
scenario.

## Probes run in the kubelet

Liveness, readiness and startup probes are executed by the kubelet process
on the node, not by the API server and not inside the Pod. `httpGet` and
`tcpSocket` connect from the kubelet to the Pod IP; `exec` runs the command
through the CRI. The consequences:

- A liveness failure restarts the **container**, in place. The Pod keeps its
  IP and its sandbox. `RESTARTS` increments.
- A readiness failure flips the `Ready` condition; the endpointslice
  controller then drops the Pod from Services. Nothing restarts.
- A startup probe suspends the other two until it succeeds once.
- A probe with the wrong `path` or `port` fails identically for a healthy
  app; the event says `Liveness probe failed: HTTP probe failed with
  statuscode: 404`. That is **liveness-wrong-path**.

## Static pods and the manifest directory

`staticPodPath: /etc/kubernetes/manifests` in the kubelet config turns a
directory into a Pod source. The kubelet watches it (`fileCheckFrequency`,
20 s) and creates, updates or removes Pods as files appear, change or
vanish; it then creates *mirror pods* in the API so you can see them. Their
names get the node name appended, their annotations say
`kubernetes.io/config.source: file`, and deleting the mirror only makes the
kubelet recreate it. This is how the control plane runs with no control
plane.

## The kubelet's own configuration

- `/var/lib/kubelet/config.yaml`: the `KubeletConfiguration` object,
  written by kubeadm from the `kubelet-config` ConfigMap: `cgroupDriver`,
  `staticPodPath`, `clusterDNS`, `clusterDomain`,
  `containerRuntimeEndpoint`, `evictionHard`, `rotateCertificates`.
  Fields left at their defaults (`maxPods`, `serverTLSBootstrap`) are
  simply absent from the file.
- `/var/lib/kubelet/kubeadm-flags.env`: the few remaining command-line
  flags, here `--node-ip`, `--provider-id` (set by kind) and
  `--node-labels`; the runtime socket moved into `config.yaml` as
  `containerRuntimeEndpoint`.
- `/etc/kubernetes/kubelet.conf`: the kubeconfig the kubelet uses to reach
  the API server, pointing at a client certificate that the kubelet rotates
  itself under `/var/lib/kubelet/pki/`.

**Gotcha:** the kubelet joins the API as `system:node:<name>`. The `Node`
authorizer (`--authorization-mode=Node,RBAC`) lets it read only the Secrets,
ConfigMaps and PVCs of Pods bound to it, and the `NodeRestriction` admission
plugin limits what it may write to its own Node object and its own Pods. A
kubelet cannot read another node's Secrets. If you see
`Forbidden` in kubelet logs about an object on another node, that is the
restriction working.

## Node conditions and pressure eviction

The kubelet publishes conditions on its Node: `Ready`, `MemoryPressure`,
`DiskPressure`, `PIDPressure`, `NetworkUnavailable`. The eviction manager
compares live usage with `evictionHard` thresholds (defaults:
`memory.available<100Mi`, `nodefs.available<10%`, `imagefs.available<15%`,
`nodefs.inodesFree<5%`). When one trips, the kubelet sets the matching
condition, the node gets a `node.kubernetes.io/memory-pressure` taint, and
the kubelet starts evicting Pods on the node, BestEffort first, then
Burstable Pods using more than they requested, then the rest. Evicted Pods
show `Reason: Evicted` and stay as records until their controller or a
human deletes them. Image garbage collection runs before eviction when the
pressure is on `imagefs`. In this lab none of that fires: kind writes all
three disk thresholds as `0%` so the node container never evicts for disk,
and because an explicit `evictionHard` replaces the whole default map
rather than merging into it, `memory.available` is zeroed too (set
`mergeDefaultEvictionSettings: true` to keep the unlisted defaults). The
`grep evictionHard` below shows exactly that.

**Try it:** look at the agent, its configuration and the runtime's view of a
worker node.

```bash
docker exec sre-labs-worker systemctl status kubelet --no-pager | head -5
docker exec sre-labs-worker journalctl -u kubelet --no-pager -n 20
docker exec sre-labs-worker cat /var/lib/kubelet/kubeadm-flags.env
docker exec sre-labs-worker grep -E 'cgroupDriver|staticPodPath|clusterDNS|evictionHard|rotateCertificates' -A2 /var/lib/kubelet/config.yaml
docker exec sre-labs-worker crictl pods                          # sandboxes: one per Pod
docker exec sre-labs-worker crictl ps                            # app containers; pause is not listed
docker exec sre-labs-worker crictl images | head
CID=$(docker exec sre-labs-worker crictl ps --name calico-node -q | head -1)
docker exec sre-labs-worker crictl logs --tail 5 "$CID"
docker exec sre-labs-worker crictl inspect "$CID" | grep -E '"cgroupsPath"|"pid":' | head -3
docker exec sre-labs-worker grep -E 'cgroupRoot|cgroupDriver' /var/lib/kubelet/config.yaml
docker exec sre-labs-worker sh -c 'ls -d /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/*.slice'     # the QoS slices under kind's cgroupRoot
docker exec sre-labs-worker sh -c 'cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/*/memory.max | sort | uniq -c'   # one memory.max per burstable Pod
kubectl get nodes -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,MEM:.status.conditions[?(@.type=="MemoryPressure")].status,DISK:.status.conditions[?(@.type=="DiskPressure")].status,PIDS:.status.conditions[?(@.type=="PIDPressure")].status'
kubectl describe node sre-labs-worker | grep -A3 '^Allocatable'
```

`crictl pods` versus `crictl ps` is the sandbox-versus-container split made
visible; `crictl inspectp <pod-id>` shows the sandbox's network namespace
and IP, which is where the CNI plugged in. The next lesson follows the
packet from there.

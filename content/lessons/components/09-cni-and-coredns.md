---
title: "CNI and CoreDNS: how Pods get an address and how they find each other"
slug: cni-and-coredns
realm: components
order: 9
summary: "The CNI contract and the Pod network model, how Calico compares with kindnet and Cilium, where NetworkPolicy is actually enforced, and how CoreDNS, the Corefile, record forms, ndots:5 and dnsPolicy shape every lookup a Pod makes."
estimated_minutes: 20
level: intermediate
tags: [cni, calico, networkpolicy, coredns, dns, ndots, dnspolicy]
builders: [networkpolicy-basics, service-basics]
scenarios: [netpol-blocks-frontend, coredns-corefile-broken, pod-dns-config-broken]
quiz:
  - q: "Who enforces a NetworkPolicy object?"
    options: ["kube-apiserver at admission", "kube-proxy", "The CNI plugin's node agent (Felix for Calico), by programming the kernel; a CNI without policy support silently ignores it", "CoreDNS"]
    answer: 2
    explain: "NetworkPolicy is only data in etcd. The CNI agent on each node watches policies and Pods and writes iptables or eBPF rules. kindnet without the policy add-on, for example, accepts the object and enforces nothing."
  - q: "A Pod in namespace `shop` resolves `api.payments.example.com` with the default ndots:5. How many DNS names does the resolver try before the absolute one?"
    options: ["0", "1", "3: api.payments.example.com.shop.svc.cluster.local, .svc.cluster.local, .cluster.local", "5"]
    answer: 2
    explain: "The name has three dots, fewer than ndots, so each search-path suffix is tried first and each produces NXDOMAIN (and often both A and AAAA queries). A trailing dot or a lower ndots removes the extra round trips."
  - q: "A Pod with `hostNetwork: true` must resolve cluster Services. Which dnsPolicy do you set?"
    options: ["ClusterFirst", "Default", "ClusterFirstWithHostNet", "None"]
    answer: 2
    explain: "Host-network Pods default to Default, meaning the node's resolv.conf, which knows nothing about cluster.local. ClusterFirstWithHostNet gives them the CoreDNS nameserver and search path."
---

# CNI and CoreDNS

Two add-ons turn a set of nodes into a network: the CNI plugin gives every
Pod an IP that every other Pod can reach, and CoreDNS gives those IPs names.
Both are replaceable, both fail in ways that look like application bugs, and
neither is part of the kubelet or the API server.

## The CNI contract

CNI is not a daemon; it is a convention for executing a binary. When
containerd creates a Pod sandbox it reads the first file in
`/etc/cni/net.d/` (here `10-calico.conflist`), finds the plugin binaries in
`/opt/cni/bin/`, and runs each one in the chain with the configuration on
stdin and a handful of environment variables:

| Variable | Meaning |
|---|---|
| `CNI_COMMAND` | `ADD` when the sandbox is created, `DEL` when it is torn down, `CHECK`, `VERSION` |
| `CNI_CONTAINERID` | the sandbox id |
| `CNI_NETNS` | path of the Pod's network namespace |
| `CNI_IFNAME` | the interface to create inside it, `eth0` |

The plugin must create the interface, obtain an address from its **IPAM**
plugin (`host-local` carves from the node's `podCIDR`; `calico-ipam` hands
out blocks from an `IPPool`), set routes, and print a JSON result with the
IPs, which containerd returns to the kubelet and the kubelet writes into
`pod.status.podIP`. Chained plugins such as `portmap` (hostPort) and
`bandwidth` (ingress/egress annotations) run after the main one.

The **Pod network model** the plugin must honour has three rules: every
Pod gets its own IP, every Pod can reach every other Pod without NAT, and
agents on a node can reach every Pod on that node. How is up to the plugin.

| Plugin | Datapath | IPAM | NetworkPolicy | Where you meet it |
|---|---|---|---|---|
| Calico | veth pairs plus per-Pod `/32` routes; IPIP or VXLAN overlay, or BGP without overlay; iptables (or eBPF) | calico-ipam blocks from IPPools | yes, plus its own richer policy CRDs | this lab, many on-prem and cloud clusters |
| kindnet | `ptp` veth plus static routes between nodes, no overlay | host-local from `podCIDR` | not historically; recent kind adds a separate policy agent | kind's default |
| Cilium | eBPF programs on the veth and host, VXLAN/Geneve or native routing | cluster-pool CIDR per node | yes, including L7 (HTTP, DNS) rules; can replace kube-proxy | large clusters, service mesh adjacent |

**Gotcha:** `NetworkPolicy` is only data. Nothing in the API server or
kube-proxy acts on it; the CNI's node agent (Felix, in Calico's case) watches
policies and Pods and programs rules on each node. A policy is enforced by
drop, so the symptom is always a *timeout*, never a refusal. Once any
policy selects a Pod with `policyTypes: [Ingress]`, every ingress not
explicitly allowed is denied. Kubelet probes are the exception: they
originate on the node, and Calico, like most CNIs, exempts host-to-local-Pod
traffic from workload policy, so a deny-all does not break them and the Pod
stays Ready; traffic from other Pods, such as Prometheus scrapes or an
Ingress controller, is what you must allow explicitly. The
`networkpolicy-basics` builder and the **netpol-blocks-frontend**
scenario practise this.

## CoreDNS

CoreDNS is a Deployment in `kube-system` behind the `kube-dns` Service at
`10.96.0.10`. The kubelet writes that address into every Pod's
`/etc/resolv.conf` (from `clusterDNS` in its config). CoreDNS itself is a
plugin chain configured by the `Corefile` in the `coredns` ConfigMap:

```
.:53 {
    errors
    health { lameduck 5s }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf { max_concurrent 1000 }
    cache 30 {
        disable success cluster.local
        disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
```

- `kubernetes` answers from informers on Services and EndpointSlices; it
  never queries the API per request. `pods insecure` enables
  `<ip-dashed>.<ns>.pod.cluster.local` names without verification.
- `forward` sends everything else to the node's upstream resolvers
  (`/etc/resolv.conf` of the CoreDNS Pod, which with `dnsPolicy: Default`
  is the node's).
- `cache 30` caps forwarded answers, positive and negative, at 30 s;
  `disable success|denial cluster.local` keeps cluster names uncached, so a
  changed ClusterIP or a new endpoint is visible immediately. `loop` kills
  the process if it detects a forwarding loop, which
  is the classic cause of CoreDNS `CrashLoopBackOff` on nodes whose
  resolv.conf points at `127.0.0.53`.
- `reload` watches the Corefile; a syntax error logs an error and keeps the
  previous config, but a restart with a broken Corefile stays down, which
  is the **coredns-corefile-broken** scenario.

## Record forms

| Name | Answer |
|---|---|
| `web.shop.svc.cluster.local` | the ClusterIP (A), or the ready Pod IPs for a headless Service |
| `_http._tcp.web.shop.svc.cluster.local` | SRV records with port and target for named ports |
| `web-0.web.shop.svc.cluster.local` | one Pod of a StatefulSet behind headless Service `web` |
| `10-244-1-7.shop.pod.cluster.local` | the Pod with IP 10.244.1.7 |
| `7.1.244.10.in-addr.arpa` | PTR back to a Service or Pod name |
| `ext.shop.svc.cluster.local` for an ExternalName Service | a CNAME to the external name |

## ndots:5 and the cost of short names

A Pod's `resolv.conf` looks like:

```
nameserver 10.96.0.10
search shop.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`ndots:5` means any name with fewer than five dots is first tried with
each search suffix. `web` becomes `web.shop.svc.cluster.local` on the first
try, which is the convenience. `api.example.com` (two dots) is tried as
`api.example.com.shop.svc.cluster.local`, `api.example.com.svc.cluster.local`,
`api.example.com.cluster.local` and only then as itself; with A and AAAA in
parallel that is eight queries for one lookup. Six of them are answered
NXDOMAIN by CoreDNS itself, since it is authoritative for `cluster.local`
(and, with kubeadm's Corefile, never cached), and only the last two, the A
and AAAA of `api.example.com`, are forwarded upstream. Fixes: a trailing dot
(`api.example.com.`), or `dnsConfig.options: [{name: ndots, value: "1"}]`
for Pods that mostly talk to the outside.

## dnsPolicy

| Value | resolv.conf comes from |
|---|---|
| `ClusterFirst` (default) | CoreDNS nameserver, cluster search path, `ndots:5` |
| `ClusterFirstWithHostNet` | same, for `hostNetwork` Pods, which otherwise fall back to `Default` |
| `Default` | the node's own resolv.conf; no cluster names |
| `None` | nothing; you supply `dnsConfig` entirely, which **pod-dns-config-broken** gets wrong |

**Why it matters:** "DNS is broken" almost always decomposes into one of
four layers: the Pod's resolv.conf (dnsPolicy, dnsConfig), the path to
`10.96.0.10` (kube-proxy rules, NetworkPolicy allowing UDP/TCP 53 egress),
CoreDNS itself (Corefile, crashloop, its EndpointSlice), or the upstream it
forwards to. Each has a one-command check.

**Try it:** inspect the CNI on a node, then the resolver from inside a Pod.

```bash
docker exec sre-labs-worker ls /etc/cni/net.d/ /opt/cni/bin/
docker exec sre-labs-worker head -40 /etc/cni/net.d/10-calico.conflist
kubectl -n kube-system get ds calico-node -o wide
kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,IPIP:.spec.ipipMode,VXLAN:.spec.vxlanMode'
docker exec sre-labs-worker ip route | head -15                 # cali* /32 routes and the tunnel route to other nodes
kubectl get networkpolicies -A
kubectl -n kube-system get cm coredns -o jsonpath='{.data.Corefile}'
kubectl -n kube-system get svc kube-dns -o wide
kubectl -n kube-system get endpointslices -l kubernetes.io/service-name=kube-dns
kubectl run dnstest --rm -it --restart=Never --image=busybox:1.36 -- sh -c 'cat /etc/resolv.conf; echo; nslookup kubernetes.default; nslookup kube-dns.kube-system.svc.cluster.local; nslookup -type=srv _dns._udp.kube-dns.kube-system.svc.cluster.local'
kubectl -n kube-system logs deploy/coredns --tail=10
```

Add `log` to the Corefile in a lab to watch every query arrive with its
search-suffix expansions; remove it again before you forget, because at
production query rates it is the most expensive line in the file.

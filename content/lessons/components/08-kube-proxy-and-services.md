---
title: "kube-proxy and Services: how a ClusterIP becomes a packet rewrite"
slug: kube-proxy-and-services
realm: components
order: 8
summary: "Service types, EndpointSlices, the iptables/ipvs/nftables modes and what their rules look like, externalTrafficPolicy and session affinity, headless Services, and why 'connection refused' and 'timeout' point at different layers."
estimated_minutes: 18
level: intermediate
tags: [services, kube-proxy, endpointslices, iptables, ipvs, nftables, dns]
builders: [deployment-basics, service-basics]
scenarios: [svc-selector-mismatch, svc-wrong-targetport]
diagram: service-traffic-path
quiz:
  - q: "All Pods behind a Service are Running, but `kubectl get endpointslices -l kubernetes.io/service-name=web` shows no endpoints. What does that prove?"
    options: ["kube-proxy is down", "CoreDNS is down", "The Service layer is the problem: the selector matches nothing, or the Pods are not Ready; the network below is not yet in question", "A NetworkPolicy is blocking traffic"]
    answer: 2
    explain: "EndpointSlices are the materialised selector, written by the endpointslice controller from Pods that match and are Ready. An empty slice set means nothing to route to, regardless of what kube-proxy, the CNI or DNS are doing."
  - q: "Which statement about a headless Service (clusterIP: None) is true?"
    options: ["kube-proxy load-balances it with round robin", "It has a VIP but no DNS name", "It has no VIP and no kube-proxy rules; DNS returns the Pod IPs directly", "It only works with StatefulSets"]
    answer: 2
    explain: "With no ClusterIP there is nothing to rewrite. CoreDNS answers the Service name with the A records of the ready endpoints, and the client picks. StatefulSets use this for stable per-Pod names, but any Service can be headless."
  - q: "A LoadBalancer Service with externalTrafficPolicy: Local receives a packet on a node that has no local endpoint. What happens?"
    options: ["It is forwarded to another node", "It is dropped; the node also answers the Service's healthCheckNodePort with a failure so the external load balancer stops sending to it", "It is SNATed and forwarded", "kube-proxy restarts"]
    answer: 1
    explain: "Local means no second hop and no SNAT, so the client source IP is preserved, at the cost of only nodes with endpoints being valid targets. The healthCheckNodePort (allocated for LoadBalancer Services) tells the load balancer which nodes those are."
---

# kube-proxy and Services

A Service is a stable virtual address in front of a changing set of Pods.
That sentence hides two separate objects and one daemon: the Service you
write, the EndpointSlices a controller derives from it, and kube-proxy,
which reads both on every node and programs the kernel so that a packet to
the virtual address lands on a real Pod. The diagram next to this lesson
follows one packet through that path.

## Service types

| Type | What it adds | Who implements it |
|---|---|---|
| `ClusterIP` | a VIP from `--service-cluster-ip-range`, reachable inside the cluster | kube-proxy on every node |
| `NodePort` | ClusterIP plus a port (30000-32767) opened on every node's IP | kube-proxy |
| `LoadBalancer` | NodePort plus an external address | a cloud controller or MetalLB; `EXTERNAL-IP` stays `<pending>` in kind |
| `ExternalName` | a DNS CNAME to an outside name, no VIP, no proxying | CoreDNS only |
| headless (`clusterIP: None`) | DNS A records of the Pods, no VIP | CoreDNS only |

Each type includes the ones above it, so a `LoadBalancer` is reachable three
ways. The `service-basics` builder covers the fields; this lesson covers
what they become.

## EndpointSlices: the materialised selector

The endpointslice controller watches Services and Pods. For each Service
with a selector it writes one or more `EndpointSlice` objects, labelled
`kubernetes.io/service-name=<svc>`, each holding up to 100 endpoints with
the Pod IP, the resolved `targetPort`, the node name, and three conditions:
`ready` (Pod Ready), `serving` (passing readiness even while terminating)
and `terminating`. A Service without a selector gets no slices; you write
them by hand to point a Service at an external IP. The legacy `Endpoints`
object is still maintained for compatibility, but kube-proxy and CoreDNS
read slices.

**Why it matters:** `kubectl get endpointslices -l kubernetes.io/service-name=web`
is the single command that separates "Service misconfigured" from "network
broken". Empty means the selector matched nothing (**svc-selector-mismatch**).
Populated with the wrong port means `targetPort` does not match the
container (**svc-wrong-targetport**). Populated and correct means the
Service layer is fine and the problem is below it.

## kube-proxy modes

kube-proxy runs as a DaemonSet with `hostNetwork: true` and reads its mode
from the `kube-proxy` ConfigMap. It watches Services and EndpointSlices and
rewrites kernel state; it never carries a packet in user space.

| Mode | Mechanism | Shape of the rules | Notes |
|---|---|---|---|
| `iptables` (kind default) | nat table chains | `KUBE-SERVICES` matches VIP:port, jumps to `KUBE-SVC-<hash>`, which picks a `KUBE-SEP-<hash>` with `--probability`, which `DNAT`s to Pod IP:port | O(n) rule lists; fine to a few thousand Services |
| `ipvs` | kernel L4 load balancer | one virtual server per VIP:port on the `kube-ipvs0` dummy interface, real servers per endpoint; `ipvsadm -Ln` | O(1) lookup, several schedulers (rr, lc, sh) |
| `nftables` | one `kube-proxy` nft table with maps and verdict maps | `nft list table ip kube-proxy` | GA in 1.33; much faster rule sync on large clusters |

Masquerade is part of every mode: traffic that leaves a node toward a Pod on
another node after DNAT is marked (`KUBE-MARK-MASQ`) and SNATed so the reply
comes back through the same node. With Calico in this lab, the DNATed packet
is then routed over the Pod network like any other.

## Policies and affinity

- **`externalTrafficPolicy: Cluster`** (default) accepts NodePort or LB
  traffic on any node and forwards to any endpoint, SNATing so the Pod sees
  the node IP as source. **`Local`** forwards only to endpoints on the
  receiving node, preserving the client IP, and opens a
  `healthCheckNodePort` that answers 200 only on nodes with endpoints.
- **`internalTrafficPolicy: Local`** does the same for ClusterIP traffic
  from within the node; useful for node-local caches and log shippers.
- **`sessionAffinity: ClientIP`** pins a client address to one endpoint for
  `timeoutSeconds` (default 10800) using the `recent` match in iptables; it
  is the only affinity a Service offers. Cookies belong to an Ingress.

## Connection refused versus timeout

The two errors come from different places and you should never treat them
as the same bug.

| Symptom | Mechanism | Usual cause |
|---|---|---|
| `connection refused` immediately | something sent a TCP RST or ICMP unreachable | the Pod was reached but nothing listens on `targetPort`; or kube-proxy's REJECT rule for a Service with no ready endpoints was hit |
| hangs, then `timed out` | packets were silently dropped | NetworkPolicy, broken Pod routing or CNI, host firewall, `LoadBalancer` with no provider, wrong `externalTrafficPolicy` node |
| connects, no response | the TCP handshake worked, the app did not answer | application bug, readiness lying, upstream dependency |

kube-proxy writes the no-endpoints REJECT into the *filter* table's
`KUBE-SERVICES` chain, hooked from `OUTPUT` (node-local clients) and
`FORWARD` (Pod clients); `INPUT` gets the sibling `KUBE-EXTERNAL-SERVICES`
chain for NodePort traffic. A client on the node itself always hits it. A
client Pod's packet goes through `FORWARD`, where the CNI's own chains come
first; Calico accepts
policy-approved forwarded traffic there, so whether you see *refused* or a
hang from a Pod depends on rule order on your cluster. The experiment below
tells you what this lab does; do not assume.

**Gotcha:** readiness also feeds this table. A Pod that is `Running` but not
`Ready` is in the slice with `ready: false` and kube-proxy excludes it. If it
was the last one, the Service has no endpoints at all. Check the `READY`
column of `kubectl get pods` before blaming the network.

**Try it:** read the Service layer end to end, then the rules kube-proxy
wrote for CoreDNS's Service on a worker node.

```bash
kubectl -n kube-system get ds kube-proxy -o wide
kubectl -n kube-system get cm kube-proxy -o jsonpath='{.data.config\.conf}' | grep -E '^mode|clusterCIDR'
kubectl get svc -A
kubectl -n kube-system get endpointslices -l kubernetes.io/service-name=kube-dns -o wide
docker exec sre-labs-worker iptables -t nat -S KUBE-SERVICES | grep kube-dns
SVC=$(docker exec sre-labs-worker iptables -t nat -S KUBE-SERVICES | grep 'kube-dns:dns-tcp' | awk '{print $NF}')
docker exec sre-labs-worker iptables -t nat -S "$SVC"            # the --probability split across endpoints
SEP=$(docker exec sre-labs-worker iptables -t nat -S "$SVC" | grep -o 'KUBE-SEP-[A-Z0-9]*' | head -1)
docker exec sre-labs-worker iptables -t nat -S "$SEP"            # the DNAT to a CoreDNS Pod IP:53
docker exec sre-labs-worker iptables -t filter -S KUBE-SERVICES | grep -c REJECT   # Services with no endpoints right now
```

Now produce each row of the table on purpose. curl exits 7 for *refused*
and 28 for *timeout*.

```bash
kubectl create ns lab-svc-demo
kubectl -n lab-svc-demo create deployment web --image=nginx:1.27-alpine
kubectl -n lab-svc-demo expose deployment web --port=80
kubectl -n lab-svc-demo create service clusterip empty --tcp=80:80     # selector app=empty matches nothing
kubectl -n lab-svc-demo rollout status deploy/web
kubectl -n lab-svc-demo get endpointslices
POD_IP=$(kubectl -n lab-svc-demo get pod -l app=web -o jsonpath='{.items[0].status.podIP}')
kubectl -n lab-svc-demo run c --rm -it --restart=Never --image=curlimages/curl:8.10.1 --command -- sh -c "curl -s -o /dev/null -w 'web: HTTP %{http_code}\n' --max-time 3 http://web; curl -s --max-time 3 http://empty; echo 'empty (no endpoints) exit='\$?; curl -s --max-time 3 http://$POD_IP:8080; echo 'pod ip, closed port exit='\$?"
kubectl -n lab-svc-demo apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: deny-all-ingress}
spec: {podSelector: {}, policyTypes: [Ingress]}
EOF
kubectl -n lab-svc-demo run c --rm -it --restart=Never --image=curlimages/curl:8.10.1 --command -- sh -c 'curl -s --max-time 3 http://web; echo "web behind deny-all exit=$?"'
kubectl delete ns lab-svc-demo
```

The closed port on a real Pod IP is always exit 7: the Pod's kernel sends a
RST, which is the **svc-wrong-targetport** failure seen from the client. The
NetworkPolicy case is always exit 28: Calico drops, nothing answers. The
`empty` Service is the one to note down for this cluster; it is the
**svc-selector-mismatch** symptom.

## Headless Services

`clusterIP: None` removes kube-proxy from the picture. CoreDNS answers the
Service name with one A record per ready endpoint, and for StatefulSets
also `<pod>.<svc>.<ns>.svc.cluster.local` per Pod. Clients that resolve once
and cache (most JVMs, by default) will pin to one Pod; clients that want
all peers (databases forming a cluster, gRPC with client-side balancing)
get exactly what they need. The next lesson covers the DNS side.

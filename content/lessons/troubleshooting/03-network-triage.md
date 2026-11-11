---
title: "Network triage: from the client to the container port"
slug: network-triage
realm: troubleshooting
order: 3
summary: "Walk the request path hop by hop: DNS, Service, kube-proxy, endpoints, targetPort, NetworkPolicy, Ingress. Learn what refused, timeout and 5xx each prove."
estimated_minutes: 20
level: intermediate
tags: [service, endpoints, dns, coredns, networkpolicy, ingress, kube-proxy]
builders: [service-basics]
scenarios: [svc-selector-mismatch, svc-wrong-targetport, netpol-blocks-frontend, coredns-corefile-broken, pod-dns-config-broken]
diagram: service-traffic-path
quiz:
  - q: "curl http://web:80 from a debug Pod returns 'connection refused' immediately. Which layer is the least likely culprit?"
    options: ["The Service selects no Ready Pod", "targetPort does not match the port the process listens on", "A NetworkPolicy drops the traffic", "The process listens on 127.0.0.1 instead of 0.0.0.0"]
    answer: 2
    explain: "A policy drop produces a timeout, never a refusal. A refusal means a kernel answered: kube-proxy's reject rule for an empty Service, or the Pod itself with nothing listening on that port."
  - q: "nslookup web.lab-shop.svc.cluster.local from a Pod prints ';; connection timed out; no servers could be reached'. What does that prove?"
    options: ["The Service web does not exist", "The Pod cannot reach the nameserver in its resolv.conf at all", "CoreDNS has a wrong Corefile", "kube-proxy is down"]
    answer: 1
    explain: "NXDOMAIN would mean CoreDNS answered 'no such name'. A timeout means no DNS answer came back: wrong nameserver in dnsConfig, CoreDNS Pods down, or a policy blocking UDP/TCP 53."
  - q: "In a NetworkPolicy ingress rule, what does a single 'from' item containing both a namespaceSelector and a podSelector mean?"
    options: ["Pods matching either selector", "Pods matching the podSelector in namespaces matching the namespaceSelector (AND)", "All Pods of the namespace", "The rule is invalid"]
    answer: 1
    explain: "Selectors in the same list item are ANDed; separate list items are ORed. Mixing them up is the classic reason a policy allows more or less than intended."
---

# Network triage

A request inside the cluster crosses seven hops, each owned by a different
component. Walk them in order and the failure cannot hide:

1. **Client** resolves the name through its `/etc/resolv.conf`.
2. **DNS** (CoreDNS) answers with the Service ClusterIP.
3. **Service ClusterIP** is virtual; nothing listens on it.
4. **kube-proxy rules** (iptables, programmed on every node) DNAT the
   ClusterIP:port to one endpoint.
5. **Endpoint** = Pod IP + `targetPort`, taken from the EndpointSlice.
6. **Container port**: a process must listen on that port, on `0.0.0.0`.
7. **NetworkPolicy** (enforced by Calico at the Pod's interface) decides
   whether the packet is delivered, at egress from the client and at ingress
   to the target.

**Why it matters:** the three error words map onto these hops. *Connection
refused* means a kernel answered "nothing here": kube-proxy's reject rule for
a Service with zero ready endpoints (hop 4), or the Pod itself when
`targetPort` is wrong (hop 6). *Timeout* means the packet was dropped: a
NetworkPolicy (hop 7), a Pod on a node whose CNI is broken, or a wrong IP.
*5xx* means the TCP path works and something on the HTTP layer failed: the
app, or the Ingress controller failing to reach its upstream.

## The decision table

| Symptom | First command | Likely causes |
|---|---|---|
| `connection refused` on `svc:port` | `kubectl get endpointslices -n <ns> -l kubernetes.io/service-name=<svc>` | selector matches nothing, Pods not Ready, wrong `targetPort` |
| `connection timed out` | `kubectl get netpol -n <ns>` then `describe` | NetworkPolicy, Pod on broken node, wrong port in policy |
| `NXDOMAIN` / `server can't find` | `kubectl get svc -n <ns>` | name or namespace typo, Service absent |
| DNS `connection timed out; no servers could be reached` | `kubectl exec <pod> -- cat /etc/resolv.conf` | bad `dnsConfig`, CoreDNS down, policy blocks port 53 |
| CoreDNS Pods in `CrashLoopBackOff` | `kubectl -n kube-system logs -l k8s-app=kube-dns` | Corefile syntax error, bad plugin directive |
| Works by Pod IP, fails by Service | `kubectl get svc <svc> -o yaml` | `port`/`targetPort` mismatch, named port absent from container |
| Works from some Pods only | `kubectl describe netpol -n <ns>` | policy `from` selectors, missing namespace label |
| Ingress `404` | `kubectl describe ingress -n <ns>` | host/path rule mismatch, wrong `ingressClassName` |
| Ingress `502` / `503` | `kubectl -n ingress-nginx logs deploy/ingress-nginx-controller` | backend Service has no endpoints, wrong port |
| Ingress `504` | `kubectl logs <backend pod>` | upstream too slow, readiness lying |

## Endpoints, selectors and targetPort

A Service is a label selector plus a port mapping. The EndpointSlice is the
materialised result; empty means the selector matched no **Ready** Pod. The
examples in this chapter use the `web` Service of the `svc-selector-mismatch`
scenario in `lab-shop`: load it from the Scenarios page first, or substitute
your own namespace.

```bash
kubectl get svc web -n lab-shop -o jsonpath='{.spec.selector}{"\n"}{.spec.ports}'
kubectl get pods -n lab-shop --show-labels
kubectl get endpointslices -n lab-shop -l kubernetes.io/service-name=web -o wide
```

Read the slice carefully: the port shown is the **targetPort**, the one the
packet will hit on the Pod. If the slice says `10.244.1.5:80` and the process
listens on `8080`, the Service is wired to the wrong port and every call is
refused by the Pod's kernel. A `targetPort` given by name (`http`) must match
a `ports[].name` on the container, otherwise the slice has no port at all.

**Try it:** prove the hop with a probe Pod rather than guessing.

```bash
P="kubectl run -n lab-shop probe --rm -i --restart=Never --image=curlimages/curl:8.10.1 --"   # a one-shot probe Pod per command
$P curl -sv --max-time 5 http://web                                   # by Service name
POD_IP=$(kubectl get pods -n lab-shop -o jsonpath='{.items[0].status.podIP}')
$P curl -sv --max-time 5 http://$POD_IP:80                            # by Pod IP and container port, bypassing the Service
$P nslookup web.lab-shop.svc.cluster.local                            # DNS alone
```

For a longer session, `kubectl run -n lab-shop probe --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- sh`
opens a shell in the probe Pod and the same `curl` and `nslookup` lines
work from there.

`port-forward` success proves nothing about the Service: it talks to the Pod
directly, bypassing hops 2 to 5.

**Gotcha:** a Pod that is `Running` but `0/1` READY is silently dropped from
the slice. "All Pods are Running" is not "all Pods are endpoints". A failing
readiness probe is a network incident in disguise; see chapter 02.

## DNS

Every Pod with the default `dnsPolicy: ClusterFirst` gets a `resolv.conf`
pointing at the `kube-dns` Service (`10.96.0.10` in the lab) with a search
list `<ns>.svc.cluster.local svc.cluster.local cluster.local` and `ndots:5`.
Short names work because of the search list; cross-namespace names need
`<svc>.<ns>` at least.

Two distinct failure signatures from `nslookup` (busybox or curl images):

- `** server can't find web.lab-shop.svc.cluster.local: NXDOMAIN` → DNS works,
  the name is wrong or the Service does not exist in that namespace.
- `;; connection timed out; no servers could be reached` → no answer at all.
  Check the Pod's `resolv.conf` (a `dnsPolicy: None` with a broken
  `dnsConfig.nameservers`, or `dnsPolicy: Default` which copies the node's
  file), then CoreDNS itself, then egress policies on UDP/TCP 53.

CoreDNS reads its `Corefile` from the ConfigMap `coredns` in `kube-system`.
A syntax error does not fail silently: the Pods crash with a log line such as
`Corefile:7 - Error during parsing: Unknown directive 'forwrd'`, and every
lookup in the cluster times out. `kubectl -n kube-system get cm coredns -o yaml`
and `kubectl -n kube-system rollout status deploy/coredns` are the two checks.
See Components → CoreDNS for the plugin chain.

## kube-proxy

kube-proxy watches Services and EndpointSlices and programs iptables on each
node. It is rarely the culprit, but when it is, the symptom is node-specific:
the same Service works from Pods on one node and fails on another. Check
`kubectl -n kube-system get pods -l k8s-app=kube-proxy -o wide` and, on the
node, `docker exec -it sre-labs-worker iptables-save | grep -c KUBE-SVC`.
See Components → kube-proxy.

## NetworkPolicy

Without any policy, everything talks to everything. As soon as **one** policy
selects a Pod for a given direction (`policyTypes`), that direction becomes
deny-by-default for that Pod, except what the rules allow. Debugging questions,
in order:

1. Which policies select the *target* Pod? `kubectl get netpol -n <ns>` and
   compare each `spec.podSelector` with the Pod labels.
2. Do any select the *client* Pod with `policyTypes: [Egress]`? Egress rules
   must also allow DNS, or the client cannot even resolve the name.
3. Inside `ingress[].from`: one item with both `namespaceSelector` and
   `podSelector` is an AND; two items are an OR. A `namespaceSelector` needs
   the namespace to carry the label (`kubernetes.io/metadata.name=<ns>` is
   always there).
4. `ports` in the rule must name the **container** port, not the Service port.

Policies are namespaced: a policy in `lab-shop` cannot open traffic into
`lab-payments`. The signature is always a **timeout**, never a refusal. The
`networkpolicy-basics` builder in the Manifests realm walks the selector
grammar field by field.

## Ingress

An Ingress is only a routing table for the controller. `kubectl describe ingress`
shows each rule's backend and, next to it, the resolved endpoints; the text
`<error: endpoints "web" not found>` or an empty list is your answer. With
ingress-nginx: `404` with the nginx default page means no rule matched the
`Host` header or path (or the Ingress has no `ingressClassName`); `503`
means the backend Service has no endpoints; `502` means the controller
connected and the upstream refused or reset. Test with an explicit host:
`curl -sv -H 'Host: shop.local' http://localhost/`.

## k9s tip

`:svc` then `Enter` on a Service lists the Pods it actually selects; an empty
list is the selector mismatch. `:endpointslices` shows the
materialised addresses and ports. `:netpol` with `d` prints the resolved
selectors. `s` on any Pod opens a shell for `nslookup` and `wget -qO- host:port`
tests, and `0` widens the view to all namespaces when the backend lives
elsewhere.

## Practice

- `svc-selector-mismatch`: Pods Running, Service empty; fix the Service, not the Pods.
- `svc-wrong-targetport`: endpoints exist, every call refused by the Pod.
- `netpol-blocks-frontend`: a policy that forgot one source.
- `coredns-corefile-broken`: a single typo takes DNS down cluster-wide.
- `pod-dns-config-broken`: one Pod cannot resolve while everything else works.

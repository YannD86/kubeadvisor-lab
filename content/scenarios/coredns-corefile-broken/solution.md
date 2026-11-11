## Diagnosis

Blast radius first: *every* namespace fails at the same time and only
cluster names are affected (external names resolve). That is the signature
of the cluster resolver, not of an application. CoreDNS Pods look fine:

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
# coredns-...   1/1   Running   0   4m     (recently restarted: suspicious)
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=5
# [INFO] plugin/reload: Running configuration SHA512 = ...
```

Reproduce from a Pod and look at both sides of the contract: what the Pod
asks for and what CoreDNS serves.

```bash
kubectl run -n lab-dns dbg --rm -it --restart=Never --image=busybox:1.36 -- sh
/ # cat /etc/resolv.conf
search lab-dns.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
/ # nslookup kubernetes.default.svc.cluster.local
** server can't find kubernetes.default.svc.cluster.local: NXDOMAIN
/ # nslookup kubernetes.io
Name:   kubernetes.io   Address: ...          # forwarding works
```

NXDOMAIN (not timeout) from the right server means CoreDNS *answered* and
does not know the name. Read its configuration:

```bash
kubectl -n kube-system get cm coredns -o jsonpath='{.data.Corefile}'
# .:53 {
#     ...
#     kubernetes cluster.wrong in-addr.arpa ip6.arpa {     <-- zone is wrong
#        pods insecure
#        fallthrough in-addr.arpa ip6.arpa
#        ttl 30
#     }
#     forward . /etc/resolv.conf
#     ...
```

## Root cause

The `kubernetes` plugin in the Corefile is authoritative for `cluster.wrong`
instead of `cluster.local`. Every query for `*.cluster.local` therefore
misses the plugin, falls through to `forward . /etc/resolv.conf`, and the
upstream resolver answers NXDOMAIN. Pods, Services and the kube-dns Service
are all healthy; a single token in a ConfigMap took the cluster down.

## Fix

Restore the zone and roll CoreDNS so the change is applied deterministically:

```bash
kubectl -n kube-system edit cm coredns        # kubernetes cluster.wrong -> kubernetes cluster.local
# or non-interactively:
kubectl -n kube-system get cm coredns -o jsonpath='{.data.Corefile}' \
  | sed 's/kubernetes cluster\.wrong/kubernetes cluster.local/' > /tmp/Corefile
kubectl -n kube-system create cm coredns --from-file=Corefile=/tmp/Corefile --dry-run=client -o yaml | kubectl apply -f -

kubectl -n kube-system rollout restart deploy/coredns
kubectl -n kube-system rollout status deploy/coredns

kubectl run -n lab-dns dbg --rm -it --restart=Never --image=busybox:1.36 -- nslookup kubernetes.default.svc.cluster.local
# Name:   kubernetes.default.svc.cluster.local
# Address: 10.96.0.1
kubectl logs -n lab-dns deploy/frontend --tail=2
# 10:41:07 GET http://backend -> 200
```

The `reload` plugin would have applied the ConfigMap change by itself within
roughly 30-45 s; the restart just removes the guesswork.

## Prevention

- Treat the `coredns` ConfigMap as code: keep it in Git, apply via GitOps,
  review every diff. A one-word change in `kube-system` deserves a reviewer.
- Alert on DNS from the outside in: a blackbox probe doing
  `kubernetes.default.svc.cluster.local` from inside the cluster, plus the
  CoreDNS metrics `coredns_dns_responses_total{rcode="NXDOMAIN"}` spiking.
- Use `kubectl diff` or a dry-run before touching CoreDNS, and prefer
  `kubectl rollout restart` over deleting Pods so you keep a rollback path
  (`kubectl rollout undo`).
- Keep the cluster domain in one place (kubeadm ClusterConfiguration
  `networking.dnsDomain`) and never hand-edit the derived Corefile zone.

## Diagnosis

Scope the failure: one Deployment fails, its neighbour in the same namespace
resolving the same name succeeds, CoreDNS is untouched. The difference must
be in the failing Pods themselves. Resolver configuration is per Pod, so
compare it directly:

```bash
kubectl logs -n lab-dnspolicy deploy/app --tail=2
# curl: (6) Could not resolve host: backend
# 11:02:14 GET http://backend -> 000
kubectl logs -n lab-dnspolicy deploy/reporting --tail=1
# 11:02:16 GET http://backend -> 200

kubectl exec -n lab-dnspolicy deploy/reporting -- cat /etc/resolv.conf
# search lab-dnspolicy.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.96.0.10                      <-- kube-dns ClusterIP
# options ndots:5

kubectl exec -n lab-dnspolicy deploy/app -- cat /etc/resolv.conf
# search lab-dnspolicy.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.255.255.1                    <-- not the cluster DNS
# options ndots:2 timeout:2 attempts:1
```

The kubelet generated that file from the Pod spec:

```bash
kubectl get deploy app -n lab-dnspolicy -o jsonpath='{.spec.template.spec.dnsPolicy}{"\n"}{.spec.template.spec.dnsConfig}{"\n"}'
# None
# {"nameservers":["10.255.255.1"],"options":[...],"searches":[...]}
kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}'
# 10.96.0.10
```

## Root cause

The "performance tuning" change set `dnsPolicy: None` and a `dnsConfig` with
a nameserver (`10.255.255.1`) that does not exist in this cluster. With
`None` the kubelet does not inject the kube-dns address at all, so every
lookup goes to a black hole and curl reports `Could not resolve host`. The
search list looked right, which is why nobody noticed in review.

## Fix

Put the Pods back on cluster DNS. The cleanest change is to delete the
custom resolver block entirely:

```bash
kubectl patch deploy app -n lab-dnspolicy --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/dnsPolicy","value":"ClusterFirst"},
  {"op":"remove","path":"/spec/template/spec/dnsConfig"}
]'
kubectl rollout status deploy/app -n lab-dnspolicy
kubectl exec -n lab-dnspolicy deploy/app -- curl -s -o /dev/null -w '%{http_code}\n' http://backend
# 200
```

If the team genuinely needs `ndots`/`timeout` tuning, keep
`dnsPolicy: ClusterFirst` and provide **only** `dnsConfig.options`; the
kubelet then merges the options with the cluster nameserver and search list.

## Prevention

- Policy at admission (Kyverno/Gatekeeper/ValidatingAdmissionPolicy):
  reject `dnsPolicy: None` unless the namespace is on an allow-list, and
  reject `dnsConfig.nameservers` that are not the cluster DNS or an approved
  resolver.
- Make "exec into the Pod and `cat /etc/resolv.conf`" step one of your DNS
  runbook; it separates per-Pod from cluster-wide problems in ten seconds.
- Review `dnsPolicy`/`dnsConfig` diffs like you review security context
  diffs: small, rare and dangerous.

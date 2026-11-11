## Diagnosis

Start from the symptom, not the suspicion. `connection refused` on a Service
ClusterIP (rather than a timeout) is the signature of a Service with **no
endpoints**: kube-proxy has nothing to DNAT to, so the kernel rejects the
connection.

```bash
kubectl get svc,endpointslices -n lab-shop
# NAME          TYPE        CLUSTER-IP     PORT(S)
# service/web   ClusterIP   10.96.x.x      80/TCP
# NAME                                       ADDRESSTYPE   PORTS     ENDPOINTS
# endpointslice.discovery.k8s.io/web-xxxxx   IPv4          <unset>   <unset>      <-- empty
```

Compare both sides of the contract:

```bash
kubectl get pods -n lab-shop --show-labels
# web-...   1/1 Running   app=web-frontend,pod-template-hash=...,tier=frontend
kubectl get svc web -n lab-shop -o jsonpath='{.spec.selector}'
# {"app":"web"}
```

The Service selects `app=web`; the Pods are labelled `app=web-frontend`.

## Root cause

A selector/label mismatch. Nothing is "down": the Service simply matches zero
Pods. This usually happens when a Deployment is renamed or a Helm chart's
label scheme changes while a hand-written Service is left behind.

## Fix

Change the Service, not the Pods (the Deployment belongs to another team and
relabelling would trigger a rollout):

```bash
kubectl patch svc web -n lab-shop -p '{"spec":{"selector":{"app":"web-frontend"}}}'
kubectl get endpointslices -n lab-shop -l kubernetes.io/service-name=web   # ENDPOINTS now lists 3 IPs
kubectl run -n lab-shop t --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- -s -o /dev/null -w '%{http_code}\n' http://web
# 200
```

## Prevention

- Alert on `kube_endpoint_address_available == 0` for Services that should
  have backends (kube-state-metrics).
- Generate Service and Deployment from the same template (Helm/Kustomize) so
  labels come from one place.
- In code review, diff `spec.selector` against `spec.template.metadata.labels`
  whenever either changes.

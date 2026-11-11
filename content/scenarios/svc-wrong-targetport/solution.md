## Diagnosis

The reporter already proved two things: the Service *selects* Pods (endpoints
are not empty) and the Pods *serve* (port-forward works). So the break is in
between: the port mapping. Start by reading the endpoints completely, port
included:

```bash
kubectl get endpointslices -n lab-shop2 -l kubernetes.io/service-name=web
# NAME        ADDRESSTYPE   PORTS   ENDPOINTS               AGE
# web-7kx2p   IPv4          8080    10.244.1.7,10.244.2.5   3m        <-- 8080
```

Then ask the Pod which port it actually listens on:

```bash
kubectl exec -n lab-shop2 deploy/web -- netstat -tln
# tcp  0  0 0.0.0.0:80   0.0.0.0:*  LISTEN
kubectl get svc web -n lab-shop2 -o jsonpath='{.spec.ports}'
# [{"name":"http","port":80,"protocol":"TCP","targetPort":8080}]
```

kube-proxy faithfully DNATs `ClusterIP:80 -> PodIP:8080`; nothing listens on
8080 inside the container, so the kernel in the Pod's netns answers with a
TCP reset, which the client sees as `connection refused`.

## Root cause

`spec.ports[0].targetPort` on the Service is `8080` while the container
listens on `80`. The selector is right, the Pods are right, the endpoints
exist; only the port half of the endpoint is wrong. This typically happens
when a Service is copied from another app, or when an image is swapped for
one with a different default port.

## Fix

Edit the Service only (the Deployment belongs to the catalog team and any
change would trigger a rollout):

```bash
kubectl patch svc web -n lab-shop2 --type=json \
  -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":80}]'
# or: kubectl edit svc web -n lab-shop2   and set targetPort: 80  (or the named port "http")

kubectl get endpointslices -n lab-shop2 -l kubernetes.io/service-name=web   # PORTS now 80
kubectl run -n lab-shop2 t --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- \
  -s -o /dev/null -w '%{http_code}\n' http://web
# 200
```

Using the named port is the more robust form: `targetPort: http` resolves
against `containerPort.name` and keeps working if the number changes.

## Prevention

- Reference ports by name in Services and probes (`targetPort: http`), and
  name every `containerPort`; a rename then fails loudly at apply time.
- Keep Service and Deployment in the same chart/kustomization so the port
  comes from a single value.
- Add a synthetic check (blackbox exporter or a CronJob curl) per Service so a
  "refused" shows up as an alert minutes after a bad deploy, not as a ticket.
- In reviews, treat `connection refused` + non-empty endpoints as a port
  problem until proven otherwise.

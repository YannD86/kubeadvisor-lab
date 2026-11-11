## Diagnosis

Classify the status first. `CreateContainerConfigError` is not a crash and
not an image problem: the kubelet failed while *building the container
spec*, before any process ran. That is why there are no logs and no restarts.

```bash
kubectl get pods -n lab-config
# NAME                   READY   STATUS                       RESTARTS   AGE
# api-7c9f6d8b5-2xk4q    0/1     CreateContainerConfigError   0          3m
# api-7c9f6d8b5-ptz8n    0/1     CreateContainerConfigError   0          3m

kubectl describe pod -n lab-config -l app=api | tail -n 8
# Events:
#   Warning  Failed  ... kubelet  Error: couldn't find key DATABASE_URL in ConfigMap lab-config/app-config
```

The event names the ConfigMap and the key. Compare the two sides:

```bash
kubectl get cm app-config -n lab-config -o jsonpath='{.data}'
# {"database_url":"postgres://db.lab-config.svc:5432/shop?sslmode=require","feature_flags":"...","log_level":"info"}
kubectl get deploy api -n lab-config -o jsonpath='{.spec.template.spec.containers[0].env}'
# [... {"name":"DATABASE_URL","valueFrom":{"configMapKeyRef":{"key":"DATABASE_URL","name":"app-config"}}}]
```

The ConfigMap holds `database_url` (lower-case); the Pod asks for the key
`DATABASE_URL`. `LOG_LEVEL` works because its key (`log_level`) matches.

## Root cause

A `configMapKeyRef` has two independent names: `env[].name` is what the
application reads, `configMapKeyRef.key` is the entry inside the ConfigMap.
During the refactor the author copied the env var name into `key:`. ConfigMap
keys are case-sensitive, so the lookup fails and the kubelet refuses to start
the container. It retries on every sync loop, which is why the Pods stay in
this state instead of crashing.

## Fix

Correct the key in the Deployment (the env var name stays `DATABASE_URL`):

```bash
kubectl patch deploy api -n lab-config --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/env/1/valueFrom/configMapKeyRef/key","value":"database_url"}
]'
kubectl rollout status deploy/api -n lab-config
kubectl exec -n lab-config deploy/api -- printenv DATABASE_URL
# postgres://db.lab-config.svc:5432/shop?sslmode=require
```

Alternative: add the key `DATABASE_URL` to the ConfigMap (`kubectl edit cm
app-config -n lab-config`). The kubelet picks it up within seconds without a
rollout, but you now maintain two spellings of the same value; prefer fixing
the reference.

## Prevention

- Alert on `kube_pod_container_status_waiting_reason{reason="CreateContainerConfigError"} > 0`
  (kube-state-metrics): it fires immediately and points at the Pod.
- Render ConfigMap and Deployment from the same source (Helm/Kustomize
  `configMapGenerator`) so keys are referenced, never retyped.
- Mark required keys with `optional: false` (the default) and run
  `kubectl apply --dry-run=server` plus a policy (Kyverno/Conftest) that
  checks every `configMapKeyRef.key` exists in the referenced ConfigMap.

## Diagnosis

Start by classifying the Pod status: a Pod that is not Running, has zero
restarts and no logs never got a container. The kubelet failed before the
process started, and it says why in the Events.

```bash
kubectl get pods -n lab-secrets
# NAME                        READY   STATUS                       RESTARTS   AGE
# payments-5f6c7d9b8-hx2lm    0/1     CreateContainerConfigError   0          2m
# payments-5f6c7d9b8-q7w9z    0/1     CreateContainerConfigError   0          2m

kubectl describe pod -n lab-secrets -l app=payments | grep -A3 Events: | tail -n 2
#   Warning  Failed  ... kubelet  Error: secret "api-credentials" not found
```

Now list what actually exists:

```bash
kubectl get secrets -n lab-secrets
# NAME             TYPE     DATA   AGE
# api-credential   Opaque   3      5m
kubectl get deploy payments -n lab-secrets -o jsonpath='{.spec.template.spec.containers[0].envFrom}'
# [{"secretRef":{"name":"api-credentials"}}]
```

`api-credential` versus `api-credentials`: the Secret the Pod references does
not exist. Everything else about the Pod is fine.

## Root cause

A name mismatch between `envFrom.secretRef.name` and the Secret created by
the vault sync. `kubectl apply` cannot validate this reference (the Secret
may legitimately be created later), so the error only appears when the
kubelet tries to build the container environment. The kubelet keeps
retrying, which is why the Pods neither crash nor progress.

## Fix

Point the Deployment at the Secret that exists. The env var names come from
the Secret's keys, so nothing else changes:

```bash
kubectl patch deploy payments -n lab-secrets --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/envFrom/0/secretRef/name","value":"api-credential"}
]'
kubectl rollout status deploy/payments -n lab-secrets
kubectl exec -n lab-secrets deploy/payments -- printenv API_KEY
# pk_test_51HhLab...
```

If the application manifest is the source of truth and the sync job is the
one at fault, the alternative is to make the sync produce `api-credentials`.
Copying the Secret by hand (`kubectl get secret api-credential -o yaml`, rename,
apply) unblocks the rollout immediately but leaves two copies that will drift
on the next rotation; treat it as a stop-gap only.

## Prevention

- Alert on `kube_pod_container_status_waiting_reason{reason="CreateContainerConfigError"}`.
- Generate the Secret name and the reference from one variable in the chart
  or Kustomization; never retype resource names across files.
- Add a pre-deploy check in CI: for every `secretRef`/`secretKeyRef`, run
  `kubectl get secret <name> -n <ns>` against the target cluster, or enforce
  it with an admission policy.
- Keep `optional: false` (the default) so a missing Secret is loud rather
  than silently producing an empty environment.

## Diagnosis

Start with the object; helm-controller writes the whole Helm error into it:

```bash
kubectl get helmrelease podinfo -n lab-helm -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
# Ready=False InstallFailed: Helm install failed for release lab-helm/podinfo with chart podinfo@6.7.1:
#   1 error occurred: * Deployment in version "v1" cannot be handled as a Deployment:
#   json: cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of type int32
# Released=False InstallFailed: ...
# Stalled=True RetriesExceeded: Failed to install after 1 attempt(s)
```

Helm kept the attempt, so the CLI tells the same story:

```bash
helm history -n lab-helm podinfo
# REVISION  STATUS  CHART          DESCRIPTION
# 1         failed  podinfo-6.7.1  Release "podinfo" failed: 1 error occurred: * Deployment in version "v1" cannot be handled ...
helm get values -n lab-helm podinfo
# replicaCount: "two"
# resources: ...
kubectl get helmrelease podinfo -n lab-helm -o jsonpath='{.spec.values}'
# {"replicaCount":"two","resources":{...}}
```

`flux reconcile` does nothing because the HelmRelease is **Stalled**: with
the default `install.remediation.retries: 0`, helm-controller will not repeat
an install that already failed with the same chart and the same values.

## Root cause

`spec.values.replicaCount` is the string `"two"`. The podinfo chart ships no
`values.schema.json`, so Helm happily renders `replicas: two` into the
Deployment manifest; the API server then rejects the object because
`spec.replicas` must be an int32. Helm records revision 1 as `failed`
(the Service, created in the same batch, exists; the Deployment does not),
and helm-controller reports `InstallFailed` and stalls.

## Fix

Correct the desired state in the HelmRelease: an integer, or no override at
all (the chart default is `1`).

```bash
kubectl patch helmrelease podinfo -n lab-helm --type merge \
  -p '{"spec":{"values":{"replicaCount":2}}}'
# or: kubectl edit helmrelease podinfo -n lab-helm   ->   replicaCount: 2   (no quotes)
```

The values change resets the failure counter; helm-controller sees a failed
release whose conditions changed and performs a Helm **upgrade** (from the
failed revision 1 to a new revision 2), creating the Deployment and waiting
for it to become ready:

```bash
flux reconcile helmrelease podinfo -n lab-helm        # optional, it already reconciles on spec change
flux get helmreleases -n lab-helm
# NAME     REVISION  SUSPENDED  READY  MESSAGE
# podinfo  6.7.1     False      True   Helm upgrade succeeded for release lab-helm/podinfo with chart podinfo@6.7.1
helm status -n lab-helm podinfo | grep STATUS      # STATUS: deployed
helm history -n lab-helm podinfo                   # 1 failed, 2 deployed
kubectl get deploy -n lab-helm podinfo             # 2/2
```

## Prevention

- Add a `values.schema.json` to charts you own (and ask upstream for one):
  a schema turns this into a `values don't meet the specifications of the
  schema` error at render time, before anything is written to the cluster.
- Validate in CI with `helm template --values ... | kubeconform -strict`
  or `flux build helmrelease` + a dry-run apply; a type error in values is
  caught in a pull request instead of in production.
- Keep HelmRelease values in Git, reviewed like code, with a comment on
  anything whose type is easy to get wrong (`replicaCount`, ports, booleans).
- Alert on `gotk_resource_info{customresource_kind="HelmRelease",ready="False"}`
  (kube-state-metrics custom-resource metrics) lasting more than a few minutes:
  a stalled release reports `Ready=False` and is not going to retry by itself.

## Diagnosis

Read the condition on the object, then inventory what the dependency graph
points at:

```bash
kubectl get kustomization app -n lab-dep -o jsonpath='{.status.conditions[?(@.type=="Ready")]}' | jq
# {
#   "type": "Ready", "status": "False", "reason": "DependencyNotReady",
#   "message": "dependency 'lab-dep/infra' not found: kustomizations.kustomize.toolkit.fluxcd.io \"infra\" not found"
# }
kubectl get kustomization app -n lab-dep -o jsonpath='{.spec.dependsOn}'
# [{"name":"infra"}]
kubectl get kustomizations,gitrepositories -n lab-dep
# kustomization.kustomize.toolkit.fluxcd.io/app      False  ...
# gitrepository.source.toolkit.fluxcd.io/platform    True   stored artifact for revision 'main@sha1:...'
```

There is exactly one Kustomization in `lab-dep`. Nothing named `infra`, in
this or any other namespace (`kubectl get kustomizations -A`). Meanwhile the
repository does contain the layer:

```bash
git clone http://lab:labpass123@localhost:30080/lab/flux-dependency-missing.git
ls flux-dependency-missing/infra
# configmap.yaml  kustomization.yaml  namespace.yaml
```

Also note the absence of any event on `app` after the first one: a
dependency check that fails is not an error for Flux, it is a wait
(`Dependencies do not meet ready condition, retrying in 30s`).

## Root cause

`spec.dependsOn` references Kustomizations by name. The `app` Kustomization
waits for `lab-dep/infra`, which was never created: the team's "we applied
the infra layer" happened on another cluster or was a `kubectl apply` of the
manifests, not a Flux object. Nothing reconciles `./infra`, so the namespace
`lab-dep-app` and the ConfigMap do not exist, and `app` is (correctly)
refusing to run ahead of its dependency.

Dropping the `dependsOn` would not help: the Deployment targets a namespace
that does not exist, so the apply would fail with `namespaces "lab-dep-app" not found`.

## Fix

Create the missing link in the chain, pointing at the same source:

```bash
flux create kustomization infra -n lab-dep \
  --source=GitRepository/platform --path=./infra \
  --prune=true --wait=true --interval=1m --export | kubectl apply -f -
```

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infra
  namespace: lab-dep
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: platform
  path: ./infra
  prune: true
  wait: true
```

`infra` reconciles within seconds (a Namespace and a ConfigMap are healthy as
soon as they exist). `app` re-checks its dependencies at most 30s later and
sees that `infra` is Ready at its current generation **and** has applied the
same revision of `platform`; it then applies `./app` and waits for the
Deployment:

```bash
flux reconcile kustomization app -n lab-dep      # skip the 30s requeue
flux get kustomizations -n lab-dep
# NAME   REVISION            SUSPENDED  READY  MESSAGE
# infra  main@sha1:5b7e...   False      True   Applied revision: main@sha1:5b7e...
# app    main@sha1:5b7e...   False      True   Applied revision: main@sha1:5b7e...
kubectl get cm,deploy -n lab-dep-app --show-labels | grep kustomize.toolkit.fluxcd.io/name
# configmap/podinfo-config   ... kustomize.toolkit.fluxcd.io/name=infra
# deployment/podinfo         ... kustomize.toolkit.fluxcd.io/name=app
```

## Prevention

- Keep the Flux objects in Git next to the layers they reconcile (e.g.
  `clusters/lab/infra.yaml` and `clusters/lab/app.yaml`, applied by one
  bootstrap Kustomization): a dependency on a name that is not in the same
  directory is then visible in review.
- Lint the graph in CI: a tiny script that collects every `dependsOn.name`
  and checks it against the Kustomizations defined in the repo.
- Alert on `gotk_resource_info{customresource_kind="Kustomization",ready="False"}`
  (kube-state-metrics custom-resource metrics) for more than 10 minutes
  regardless of the reason: `DependencyNotReady` is silent by design and will
  not page you through events.
- Use `flux tree kustomization <name>` and `flux get kustomizations -A` in the
  runbook to see the chain at a glance.

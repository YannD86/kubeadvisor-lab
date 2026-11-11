---
title: "Kustomizations: apply, prune, wait, depend"
slug: kustomizations
realm: gitops
order: 4
summary: "What kustomize-controller does with an artifact: path, prune, wait and healthChecks, dependsOn, targetNamespace, postBuild substitution, server-side apply ownership, and what happens on delete."
estimated_minutes: 18
level: intermediate
tags: [flux, kustomize-controller, kustomization, prune, server-side-apply, dependsOn]
builders: [flux-kustomization, kustomize-kustomization]
scenarios: [flux-kustomization-wrong-path, flux-dependency-missing, flux-suspended-drift]
quiz:
  - q: "A Kustomization has `prune: true`. You delete a Deployment's YAML file from the repo and push. What happens at the next reconcile?"
    options: ["Nothing until the Kustomization is deleted", "The Deployment is deleted because it is in the inventory but no longer in the build", "The Deployment is scaled to zero", "Flux fails with 'object not found'"]
    answer: 1
    explain: "Pruning compares the previous inventory with the current build and deletes what disappeared. Without prune: true the object would be orphaned, still running, no longer managed."
  - q: "`dependsOn: [{name: infra}]` is set on Kustomization `apps`. What exactly does `apps` wait for?"
    options: ["The infra artifact to exist", "Kustomization infra to have Ready=True", "All Pods in the cluster to be Running", "Kustomization infra to have wait: true"]
    answer: 1
    explain: "dependsOn waits for the dependency's Ready condition. Ready means 'applied' unless infra also sets wait or healthChecks, in which case it means 'applied and healthy'."
  - q: "Your manifest in Git has `replicas: 2` and an HPA scales the Deployment to 6. What happens at the next interval?"
    options: ["Flux leaves replicas at 6 because the HPA owns the field", "Flux force-applies and replicas go back to 2", "Flux suspends the Kustomization", "The HPA is deleted"]
    answer: 1
    explain: "kustomize-controller applies with ForceOwnership on every field present in the manifest. Remove replicas from Git when another controller should own it."
---

# Kustomizations

A Flux `Kustomization` (kustomize.toolkit.fluxcd.io/v1) is not a kustomize
`kustomization.yaml`. The Flux object says *which directory of which artifact
to build and apply, how, and in what order*. The kustomize file inside that
directory says *how to assemble manifests*. The names collide; the jobs do
not.

## One reconcile, in order

Every `spec.interval` (or sooner, when the source artifact changes),
kustomize-controller runs this sequence:

1. **Download** the source artifact and extract it.
2. **Build** `spec.path` with kustomize. If there is no `kustomization.yaml`
   there, the controller generates one that includes every YAML under the
   path. An empty or missing path is a build error, not an empty apply.
3. **Decrypt** SOPS-encrypted files if `spec.decryption` is set (lesson 10).
4. **Substitute** `${VAR}` placeholders from `spec.postBuild`.
5. **Validate and apply** with **server-side apply**, in stages: CRDs,
   Namespaces and ClusterRoles first, then `*Class` kinds (StorageClass,
   IngressClass, PriorityClass…), then everything else sorted by kind
   (ServiceAccounts and RBAC before workloads, webhook configurations
   last), so that objects that depend on an earlier stage can be created
   in the same run.
6. **Wait** for health if `spec.wait` or `spec.healthChecks` ask for it.
7. **Prune** objects in the previous inventory that are absent from this
   build, if `spec.prune: true`.
8. **Record** the new inventory and the applied revision in `status`.

## The fields

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 10m                 # re-apply (and drift-correct) at least this often
  retryInterval: 1m             # back-off after a failure
  timeout: 3m                   # deadline for apply + health checks
  sourceRef:
    kind: GitRepository
    name: demo
  path: ./apps/staging          # directory inside the artifact
  prune: true                   # garbage-collect what disappears from Git
  wait: true                    # Ready only when every applied object is healthy
  healthChecks:                 # or: name specific objects instead of wait
    - apiVersion: apps/v1
      kind: Deployment
      name: podinfo
      namespace: lab-demo
  dependsOn:
    - name: infrastructure      # another Kustomization (same namespace unless given)
  targetNamespace: lab-demo     # force every namespaced object into this namespace
  postBuild:
    substitute:
      cluster_env: staging
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
        optional: true
```

- **`path`** is relative to the artifact root and must exist. A wrong path
  is the most common reason for `Ready=False` on a fresh Kustomization
  (*flux-kustomization-wrong-path* scenario).
- **`prune`** makes the object the owner of what it applies. Managed
  objects carry the labels `kustomize.toolkit.fluxcd.io/name` and
  `kustomize.toolkit.fluxcd.io/namespace`, and the full list is kept in
  `status.inventory`. Anything in the inventory but not in the next build is
  deleted. Leave `prune: false` only for things you would rather orphan
  than lose.
- **`wait`** applies kstatus health rules to *every* object (Deployments
  available, Jobs complete, custom resources with a `Ready` condition true).
  **`healthChecks`** does the same for a named subset; use it when the
  directory contains objects that never become "ready" in the kstatus sense.
  `timeout` bounds the wait; on expiry the Kustomization is `Ready=False`
  with reason `HealthCheckFailed` while the objects stay applied.
- **`dependsOn`** orders Kustomizations: this one does not build until each
  dependency reports `Ready=True`. Until then it logs
  `dependency 'flux-system/infrastructure' is not ready` and retries. A
  dependency that does not exist at all is reported as
  `dependency 'flux-system/infrastructure' not found` and blocks just the
  same (*flux-dependency-missing* scenario).
- **`targetNamespace`** sets `metadata.namespace` on every namespaced
  object, overriding what the manifests say. Declare the Namespace itself
  in Git as well so the deployment is self-contained and prunable.
- **`postBuild`** is envsubst-style substitution of `${var}` and
  `${var:=default}` in the *built* manifests, from literal `substitute`
  pairs and from ConfigMaps/Secrets via `substituteFrom`. It is how one base
  serves several clusters without a kustomize overlay per value.

**Why it matters:** `dependsOn` waits for `Ready`, and `Ready` means
"applied" unless the dependency also has `wait` or `healthChecks`. An
`infrastructure` Kustomization that installs a CRD-providing operator must
set `wait: true`, otherwise `apps` starts the moment the manifests are
accepted, before the operator's webhooks answer, and fails on the first
custom resource.

## Server-side apply and field ownership

kustomize-controller applies with server-side apply (SSA) as field manager
`kustomize-controller` and **force ownership**. Two rules follow:

1. Every field present in the manifest is owned by Flux. If anything else
   (a human with `kubectl edit`, an HPA, an operator) sets a different
   value, the next apply takes it back. That is drift correction, and it
   runs at every `interval` even when Git has not changed.
2. Fields **absent** from the manifest are not owned and are left alone. To
   let an HPA own `spec.replicas`, delete `replicas` from the manifest; to
   let cert-manager own an annotation, do not declare it.

Annotations on individual objects tune the behaviour:

| Annotation | Effect |
|---|---|
| `kustomize.toolkit.fluxcd.io/reconcile: disabled` | Skip this object on apply and drift correction; it stays in the inventory while it is in Git |
| `kustomize.toolkit.fluxcd.io/prune: disabled` | Never garbage-collect this object |
| `kustomize.toolkit.fluxcd.io/ssa: Merge` | Still SSA, but keep fields other managers add to this object (a cert-manager `caBundle`, for example); manifest fields are still enforced. `IfNotPresent` and `Ignore` are the other policies |
| `kustomize.toolkit.fluxcd.io/force: Enabled` | Delete and recreate on immutable-field errors (Jobs, some selectors) |

`kubectl get deploy podinfo -n lab-demo --show-managed-fields -o yaml` lists
the managers; seeing `kustomize-controller` next to a field explains why
your edit "did not stick".

**Gotcha:** suspending a Kustomization (`flux suspend kustomization apps`)
stops apply, drift correction *and* pruning. It is the right tool for a
controlled manual intervention, and the classic cause of "we pushed a fix
hours ago and nothing happened" (*flux-suspended-drift* scenario).

## Deletions and finalizers

Two different deletions, two different behaviours:

- **A manifest disappears from Git.** With `prune: true` the object is
  deleted at the next reconcile, in reverse dependency order (custom
  resources before CRDs, everything before Namespaces). With `prune: false`
  it is orphaned.
- **The Kustomization object is deleted.** The controller holds a finalizer
  (`finalizers.fluxcd.io`) so the delete blocks until it has run garbage
  collection on the whole inventory. `spec.deletionPolicy` (Flux 2.5+;
  `WaitForTermination` 2.6+) controls that step: `MirrorPrune` (default:
  delete the inventory only if `prune` is true), `Delete`, `Orphan`, or
  `WaitForTermination`.

`flux delete kustomization apps` asks for confirmation for this reason.
If you want to stop managing without destroying, suspend or set
`deletionPolicy: Orphan` first, then delete.

**Try it:** with the `demo` source from the previous lesson, push a
manifest and let a Kustomization apply it; then drift it by hand and watch
the correction.

```bash
git clone http://lab:labpass123@localhost:30080/lab/demo.git ~/demo-repo && cd ~/demo-repo
mkdir -p apps/podinfo
cat > apps/podinfo/namespace.yaml <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lab-demo
YAML
cat > apps/podinfo/deployment.yaml <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: lab-demo
spec:
  replicas: 1
  selector:
    matchLabels: { app: podinfo }
  template:
    metadata:
      labels: { app: podinfo }
    spec:
      containers:
        - name: podinfo
          image: ghcr.io/stefanprodan/podinfo:6.7.1
          ports: [{ containerPort: 9898 }]
YAML
git add -A && git -c user.name=lab -c user.email=lab@sre-labs.local commit -qm "add podinfo" && git push -q
flux reconcile source git demo
flux create kustomization demo --source=GitRepository/demo --path=./apps/podinfo \
  --prune=true --wait=true --interval=1m --health-check-timeout=2m
flux tree kustomization demo                      # the inventory as a tree
kubectl -n lab-demo scale deploy/podinfo --replicas=3   # drift
flux reconcile kustomization demo && kubectl -n lab-demo get deploy podinfo   # back to 1
```

## Where to go next

The three scenarios attached to this lesson each break one of these
fields. Then move on to Helm: the other consumer, with its own notion of
release and rollback. The *Flux Kustomization* builder covers the field
order of this object; the *Kustomize kustomization.yaml* builder covers the
file inside the directory.

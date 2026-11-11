---
title: "Helm fundamentals: charts, releases, revisions"
slug: helm-fundamentals
realm: gitops
order: 5
summary: "What Helm 3 actually stores and where, the install/upgrade/rollback/history commands, --atomic and --wait, the three-way merge, and when to reach for Helm instead of Kustomize."
estimated_minutes: 15
level: beginner
tags: [helm, releases, rollback, three-way-merge, kustomize]
builders: []
scenarios: [helm-upgrade-failed-rollback]
diagram: helm-flow
quiz:
  - q: "Where does Helm 3 keep the state of a release?"
    options: ["In a ConfigMap in kube-system", "In Secrets of type helm.sh/release.v1 in the release namespace, one per revision", "In ~/.helm on the operator's laptop", "In the chart repository"]
    answer: 1
    explain: "Helm 3 has no Tiller. Each revision is a Secret named sh.helm.release.v1.<name>.v<N> in the namespace of the release."
  - q: "`helm upgrade --atomic` fails because a Pod never becomes ready. What state is the release in afterwards?"
    options: ["failed, with the new manifests applied", "deployed at the previous revision, because --atomic rolled back", "pending-upgrade forever", "uninstalled"]
    answer: 1
    explain: "--atomic implies --wait and, on failure, runs a rollback to the last deployed revision. Without it the release is left failed and the broken objects stay in the cluster."
  - q: "Helm's three-way merge compares which three things?"
    options: ["Chart.yaml, values.yaml, templates/", "The previous rendered manifest, the new rendered manifest, and the live object", "Git, the cluster, and the registry", "The last three revisions"]
    answer: 1
    explain: "Including the live object lets Helm keep fields that something else (a controller, a webhook) added since the last release, instead of blindly overwriting them."
---

# Helm fundamentals

Helm is a package manager for Kubernetes manifests with one idea that
Kustomize lacks: a **release**, a named, versioned installation of a chart
whose history Helm keeps and can roll back. Flux's helm-controller drives
Helm for you (lesson 7), so understanding what Helm stores and when it
rolls back is what makes HelmRelease status readable.

## Three nouns

| Noun | What it is | Where it lives |
|---|---|---|
| **Chart** | A directory (or `.tgz`) of templates plus default values and metadata | A chart repository, an OCI registry, or a Git path |
| **Release** | A chart installed under a name into a namespace, with a set of values | The cluster, as Secrets |
| **Revision** | One version of a release: install is revision 1, each upgrade or rollback adds one | One Secret per revision |

A chart can be installed many times under different release names; each
release has its own revision history. `appVersion` in the chart is the
version of the software inside; the chart `version` is the version of the
packaging. They move independently.

## The release Secret

Helm 3 stores every revision as a Secret in the **release namespace**:

```bash
kubectl -n lab-helm get secret -l owner=helm --show-labels
# NAME                           TYPE                 LABELS
# sh.helm.release.v1.demo.v1     helm.sh/release.v1   name=demo,owner=helm,status=superseded,version=1
# sh.helm.release.v1.demo.v2     helm.sh/release.v1   name=demo,owner=helm,status=deployed,version=2
```

The `release` key holds the rendered manifest, the chart (templates
included), the user-supplied values and the status, as JSON that is gzipped
then base64-encoded (and Kubernetes base64-encodes once more):

```bash
kubectl -n lab-helm get secret sh.helm.release.v1.demo.v2 -o jsonpath='{.data.release}' \
  | base64 -d | base64 -d | gunzip | head -c 300
```

**Why it matters:** `helm list`, `helm history`, `helm get values` are all
reads of these Secrets. If they are deleted, Helm forgets the release while
the Deployments keep running; if a release is "stuck" in `pending-upgrade`,
it is because the newest Secret says so, usually after a client was killed
mid-operation. Both situations are repaired by acting on the Secrets, not
on the workloads.

## The lifecycle commands

```bash
cd ~ && { [ -d demo ] || helm create demo >/dev/null; }      # the starter chart that "Try it" below explains
helm install demo ./demo -n lab-helm --create-namespace     # revision 1
helm upgrade demo ./demo -n lab-helm --set replicaCount=2    # revision 2
helm upgrade --install demo ./demo -n lab-helm               # idempotent form used by CI and Flux
helm history demo -n lab-helm                                # revisions, statuses, descriptions
helm status demo -n lab-helm                                 # last deployed, notes, resources with --show-resources
helm rollback demo 1 -n lab-helm                             # revision 3, a copy of 1's manifest
helm get values demo -n lab-helm                             # user-supplied values; --all merges chart defaults
helm get manifest demo -n lab-helm                           # what Helm thinks is applied
helm uninstall demo -n lab-helm                              # deletes objects and the Secrets (--keep-history keeps them)
```

Release statuses you will read in `helm history`: `deployed` (the one
revision that is live), `superseded` (replaced by a later one), `failed`,
`pending-install` / `pending-upgrade` / `pending-rollback` (an operation is
in progress, or died), `uninstalled` (kept by `--keep-history`).

**Gotcha:** a rollback does not go "back"; it creates a *new* revision
whose manifest copies the target revision. Revision numbers only grow, and
`--history-max` (default 10) trims the oldest Secrets. If you need to roll
back further than that, the history is gone.

## `--wait`, `--atomic`, `--timeout`

By default `helm install` and `helm upgrade` return as soon as the API
server accepted the objects. The release is `deployed` even if every Pod
crash-loops.

- `--wait` blocks until Deployments/StatefulSets/DaemonSets reach their
  desired replicas, Pods are Ready, PVCs are Bound and LoadBalancer Services
  have an address, or `--timeout` (default `5m0s`) expires, in which case the
  release is marked `failed`.
- `--atomic` implies `--wait` and adds remediation: a failed install is
  uninstalled, a failed upgrade is rolled back to the last `deployed`
  revision.
- `--wait-for-jobs` extends the wait to Jobs; `--cleanup-on-fail` deletes
  objects that the failed upgrade *created*.

This is exactly the behaviour the *helm-upgrade-failed-rollback* scenario
asks you to apply by hand, and exactly what helm-controller's
`upgrade.remediation` automates.

## The three-way merge

On upgrade, Helm 3 computes a patch per object from **three** inputs: the
manifest of the previous revision, the new manifest, and the **live object**
read from the API server. Fields that were added outside Helm since the
last release (an annotation set by a controller, a default injected by a
webhook, a `replicas` set by an HPA) are kept unless the new manifest
explicitly sets them. Helm 2 compared only old and new manifests, which is
why upgrades used to silently undo such changes.

The consequence is a different drift model from Flux Kustomizations: plain
Helm does **not** detect or correct drift between upgrades. Something that
was changed by hand stays changed until the next `helm upgrade` touches that
field. helm-controller adds optional drift detection on top (lesson 7).

## Helm or Kustomize?

| | Helm | Kustomize |
|---|---|---|
| Mechanism | Text templating with values | Patching of plain YAML bases |
| Best for | Software you do not own: ingress-nginx, cert-manager, databases | Your own services; environment overlays; patching rendered output |
| Parameters | `values.yaml` with optional JSON Schema | Overlays, patches, `replacements`; no schema |
| Lifecycle | Releases, history, rollback, hooks, tests | None; the apply tool (kubectl or Flux) owns lifecycle |
| Failure mode | Template logic becomes a programming language | Deep overlay trees get hard to read |
| In Flux | `HelmRelease` | `Kustomization` |

They combine well: a `HelmRelease` can carry `postRenderers` with kustomize
patches for the one field the chart does not expose, and a Kustomization
can deploy HelmRelease objects as ordinary YAML. The usual split is "Helm
for third-party, Kustomize for first-party".

**Try it:** a full release lifecycle with a locally generated chart; no
network needed.

```bash
cd ~ && helm create demo                                   # a starter chart (nginx)
helm install demo ./demo -n lab-helm --create-namespace \
  --set image.tag=1.27-alpine --wait --timeout 2m
helm list -n lab-helm
kubectl -n lab-helm get secret -l owner=helm
helm upgrade demo ./demo -n lab-helm --set image.tag=1.27-alpine --set replicaCount=2 --wait
helm history demo -n lab-helm
helm upgrade demo ./demo -n lab-helm --set image.tag=does-not-exist --atomic --timeout 60s  # fails, rolls back
helm history demo -n lab-helm                             # revision 3 failed, 4 = rollback to 2
helm uninstall demo -n lab-helm
```

## Where to go next

Open the chart you just generated: the next lesson walks through every
file in it and the template functions you will meet in real charts.

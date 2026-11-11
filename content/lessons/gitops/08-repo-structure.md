---
title: "Repository structure: clusters, infrastructure, apps"
slug: repo-structure
realm: gitops
order: 8
summary: "Monorepo or per-team repos, the clusters/ infrastructure/ apps/ layout, base and overlays per environment, promotion by pull request, tenancy boundaries, and ordering with dependsOn."
estimated_minutes: 15
level: intermediate
tags: [flux, kustomize, repository, overlays, promotion, tenancy]
builders: [kustomize-kustomization]
scenarios: []
quiz:
  - q: "In the clusters/ infrastructure/ apps/ layout, what does clusters/production/apps.yaml contain?"
    options: ["The application Deployments", "A Flux Kustomization pointing at ./apps/production with dependsOn infrastructure", "The Helm charts", "The kubeconfig for production"]
    answer: 1
    explain: "The clusters/ directory holds only Flux objects (the entry points). The manifests they apply live under infrastructure/ and apps/."
  - q: "How is a change promoted from staging to production in this model?"
    options: ["By retagging the Docker image", "By running flux reconcile on production", "By a pull request that changes the production overlay (a version, a patch) after staging has run it", "By copying the staging namespace"]
    answer: 2
    explain: "Promotion is a Git change to the production overlay, reviewed like any other. Nothing is pushed to the cluster."
  - q: "Which setting makes a tenant's Kustomization apply with the tenant's permissions instead of cluster-admin?"
    options: ["spec.targetNamespace", "spec.serviceAccountName", "spec.prune: false", "spec.path"]
    answer: 1
    explain: "kustomize-controller impersonates the ServiceAccount; the RoleBinding you give that account is the tenant's boundary."
---

# Repository structure

Flux does not care how you organise Git. Your on-call engineers do. A good
layout answers three questions in under a minute: *what runs on this
cluster*, *in which order*, and *where do I change it for one environment
only*. The layout below is the one the Flux project documents as a
reference, and it answers all three.

## Monorepo or many repos

| | One repository | Repository per team (or per app) |
|---|---|---|
| Who reads it | Platform team, everyone else via `CODEOWNERS` | Each team its own |
| Flux objects | One `GitRepository`, several `Kustomization`s | One `GitRepository` per team, usually created by the platform team |
| Access control | Directory-level via review rules only | Repository-level, enforced by the Git host |
| Cross-cutting change | One PR | N PRs |
| Fits | Small to mid organisations, platform-owned clusters | Many autonomous teams, strict tenancy |

Most teams start with one repository and split when review queues or
permission boundaries force it. The directory layout is the same in both
cases; only the `sourceRef` differs.

## The reference layout

```text
├── clusters/
│   ├── staging/
│   │   ├── flux-system/            # written by flux bootstrap; do not edit by hand
│   │   ├── infrastructure.yaml     # Kustomization → ./infrastructure/controllers, then configs
│   │   └── apps.yaml               # Kustomization → ./apps/staging, dependsOn infrastructure
│   └── production/
│       ├── flux-system/
│       ├── infrastructure.yaml
│       └── apps.yaml
├── infrastructure/
│   ├── controllers/                # cert-manager, ingress-nginx… as HelmReleases
│   │   ├── cert-manager.yaml
│   │   ├── ingress-nginx.yaml
│   │   └── kustomization.yaml
│   └── configs/                    # ClusterIssuers, StorageClasses: need the controllers' CRDs
│       ├── cluster-issuers.yaml
│       └── kustomization.yaml
└── apps/
    ├── base/
    │   └── podinfo/
    │       ├── namespace.yaml
    │       ├── release.yaml        # HelmRelease or Deployment+Service
    │       └── kustomization.yaml
    ├── staging/
    │   ├── kustomization.yaml      # resources: [../base/podinfo] + patches
    │   └── podinfo-values.yaml
    └── production/
        ├── kustomization.yaml
        └── podinfo-values.yaml
```

Three rules make it work:

1. **`clusters/<name>/` contains only Flux objects.** Each file is an entry
   point: a Kustomization that names a path elsewhere in the repo. Reading
   this directory tells you everything the cluster runs.
2. **`infrastructure/` and `apps/` contain no cluster names.** They are
   reusable trees; environment differences are expressed as overlays or
   `postBuild` variables, not as copies.
3. **`base/` is complete and runnable; overlays only patch.** Resist putting
   anything in an overlay that is not a difference from base.

## Ordering with dependsOn

```yaml
# clusters/production/infrastructure.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: infra-controllers, namespace: flux-system }
spec:
  interval: 1h
  retryInterval: 1m
  timeout: 5m
  sourceRef: { kind: GitRepository, name: flux-system }
  path: ./infrastructure/controllers
  prune: true
  wait: true                      # Ready only when the HelmReleases are healthy
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: infra-configs, namespace: flux-system }
spec:
  dependsOn: [{ name: infra-controllers }]
  interval: 1h
  sourceRef: { kind: GitRepository, name: flux-system }
  path: ./infrastructure/configs
  prune: true
---
# clusters/production/apps.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: apps, namespace: flux-system }
spec:
  dependsOn: [{ name: infra-configs }]
  interval: 10m
  sourceRef: { kind: GitRepository, name: flux-system }
  path: ./apps/production
  prune: true
  wait: true
  timeout: 5m
```

**Why it matters:** `infra-configs` contains `ClusterIssuer` objects whose
CRD comes from cert-manager in `infra-controllers`. Without `wait: true` on
the first and `dependsOn` on the second, the apply of a ClusterIssuer races
the CRD registration and fails with `no matches for kind`. Keep the chain
short (two or three links); long chains turn one slow HelmRelease into a
cluster-wide stall.

## Base and overlays per environment

```yaml
# apps/base/podinfo/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: podinfo
resources: [namespace.yaml, release.yaml]
---
# apps/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [../base/podinfo]
patches:
  - path: podinfo-values.yaml       # a partial HelmRelease: only spec.values and version differ
    target: { kind: HelmRelease, name: podinfo }
```

Overlays are the place for replica counts, resource limits, hostnames and
chart version pins. A Flux `postBuild.substituteFrom` ConfigMap per cluster
(`cluster_domain`, `cluster_env`) covers the handful of values that differ
*everywhere*, without an overlay for each.

## Promotion by pull request

Promotion is a Git operation, never a cluster operation:

1. A change (a new chart version, a new image tag, a config) lands in
   `apps/staging/` by PR. Flux applies it to staging.
2. Validation runs where it belongs: smoke tests, SLO dashboards, a soak
   period.
3. A second PR copies the same change into `apps/production/`. Review is
   the gate; `CODEOWNERS` decides who can approve it.

Two refinements: pin production to **tags or semver ranges** on sources
(`ref.semver: ">=1.0.0"`, chart `version: "6.7.x"`) so that promotion is
"cut a tag", and let image automation open the staging PRs for you
(lesson 9). What you should not do is point production at the same branch
as staging and hope the ordering holds.

## Tenancy and namespaces

A tenant is a team that owns a slice of the cluster. In Flux a tenant is:

- a **Namespace** (or several), with ResourceQuota and NetworkPolicy;
- a **ServiceAccount** in it, bound by a RoleBinding to the permissions the
  team may use;
- the team's **GitRepository** and **Kustomization**, created *in the tenant
  namespace* by the platform team, with `spec.serviceAccountName` set to that
  ServiceAccount.

kustomize-controller then impersonates the ServiceAccount when applying, so
a tenant manifest that creates a ClusterRole or touches another namespace is
rejected by RBAC, not by convention. Two controller flags complete the
boundary: `--no-cross-namespace-refs=true` (a Kustomization may only use
sources in its own namespace) and `--default-service-account=<name>` (no
Kustomization runs as the controller's own identity). The Flux
`flux2-multi-tenancy` reference repository shows the full set, including
admission policies that enforce `serviceAccountName` on every Kustomization.

**Gotcha:** `targetNamespace` is not a security boundary. It overrides the
namespace of every namespaced object (lesson 4), but it does nothing for
cluster-scoped objects (ClusterRole, CRD, Namespace) and the apply still
runs as kustomize-controller. Only `serviceAccountName` plus RBAC restricts
what a tenant can write.

**Try it:** build a base plus an overlay locally and render it; this is the
same build kustomize-controller performs.

```bash
mkdir -p ~/layout/apps/{base/podinfo,staging} && cd ~/layout
cat > apps/base/podinfo/deployment.yaml <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: podinfo }
spec:
  replicas: 3
  selector: { matchLabels: { app: podinfo } }
  template:
    metadata: { labels: { app: podinfo } }
    spec:
      containers: [{ name: podinfo, image: ghcr.io/stefanprodan/podinfo:6.7.1 }]
YAML
cat > apps/base/podinfo/kustomization.yaml <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources: [deployment.yaml]
YAML
cat > apps/staging/kustomization.yaml <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: lab-staging
resources: [../base/podinfo]
patches:
  - target: { kind: Deployment, name: podinfo }
    patch: |
      - op: replace
        path: /spec/replicas
        value: 1
YAML
kubectl kustomize apps/staging          # namespace and replicas come from the overlay
```

## Where to go next

With a layout in place, day-2 operations become routine: suspending,
forcing reconciliation, diffing before merge, notifications and image
automation. The *Kustomize kustomization.yaml* builder covers the
overlay file field by field.

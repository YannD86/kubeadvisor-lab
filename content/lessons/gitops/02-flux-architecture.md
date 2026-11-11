---
title: "Flux architecture: the GitOps Toolkit and the artifact model"
slug: flux-architecture
realm: gitops
order: 2
summary: "The six controllers, how a source becomes an artifact tarball that consumers apply, install vs bootstrap, and how to read flux get and flux logs."
estimated_minutes: 15
level: beginner
tags: [flux, controllers, artifacts, source-controller, kustomize-controller, helm-controller]
builders: [flux-gitrepository, flux-kustomization]
scenarios: []
diagram: flux-flow
quiz:
  - q: "Which controller talks to Git, OCI registries and Helm repositories?"
    options: ["kustomize-controller", "source-controller", "helm-controller", "notification-controller"]
    answer: 1
    explain: "source-controller is the only one that fetches from outside the cluster. It packages what it fetched as an artifact; the others consume artifacts."
  - q: "What does `flux bootstrap` do that `flux install` does not?"
    options: ["Installs the CRDs", "Creates the flux-system namespace", "Commits the Flux manifests to a Git repository and makes Flux reconcile itself from it", "Installs the image automation controllers"]
    answer: 2
    explain: "Both install the controllers. Bootstrap additionally pushes gotk-components.yaml and gotk-sync.yaml to clusters/<name>/flux-system and creates the GitRepository + Kustomization that keep Flux managing itself."
  - q: "In `flux get all -A`, a Kustomization shows READY=True but its REVISION is older than the latest commit. Where do you look first?"
    options: ["The Deployment it manages", "The GitRepository it references: its REVISION and READY columns", "The helm-controller logs", "etcd"]
    answer: 1
    explain: "A consumer can only be as fresh as its source's artifact. If the source has not produced the new revision, the Kustomization has nothing new to apply."
---

# Flux architecture

Flux is not one program. It is a set of Kubernetes controllers, the *GitOps
Toolkit*, that each own a few CRDs and talk to each other only through the
API server and one HTTP endpoint. Once you know which controller owns which
object, every `flux` command and every error message becomes readable.

## The controllers

| Controller | Owns (CRDs) | Job |
|---|---|---|
| **source-controller** | `GitRepository`, `OCIRepository`, `HelmRepository`, `HelmChart`, `Bucket` | Fetch from outside the cluster, verify, package the result as an *artifact* |
| **kustomize-controller** | `Kustomization` | Build a directory of an artifact with kustomize, decrypt, substitute, server-side apply, prune, health-check |
| **helm-controller** | `HelmRelease` | Run Helm install/upgrade/rollback/uninstall from a chart artifact, with remediation and drift detection |
| **notification-controller** | `Provider`, `Alert`, `Receiver` | Event hub: forward events to Slack/Teams/Git providers; receive webhooks that trigger reconciliation |
| **image-reflector-controller** | `ImageRepository`, `ImagePolicy` | Scan a registry for tags, select the newest matching a policy |
| **image-automation-controller** | `ImageUpdateAutomation` | Commit the selected tag back to Git |

The first three are the core; `flux install` deploys those plus
notification-controller. The two image controllers are optional
(`--components-extra`), and the lab installs them so the Day-2 lesson can use
them.

**Why it matters:** each controller is a separate Deployment in
`flux-system` with its own logs, its own RBAC and its own failure modes. When
something is stuck you first decide *which* controller should be doing the
work, then read that one's object status and logs. Guessing across all of
them is how people lose an hour.

## The artifact model

The toolkit has one internal contract: **source → artifact → consumer**.

1. A source object (say a `GitRepository`) tells source-controller what to
   fetch and how often.
2. source-controller clones the revision, applies `spec.ignore`, optionally
   verifies signatures, and writes a **tar.gz** of the tree into its local
   storage (`/data`, an emptyDir or PVC in the source-controller Pod).
3. It records the result in the object's status:

```yaml
status:
  artifact:
    revision: main@sha1:5f3c1c8e2d0a9f0b8c7e6d5a4b3c2d1e0f9a8b7c
    digest: sha256:9b1e3f...                      # checksum of the tarball
    url: http://source-controller.flux-system.svc.cluster.local./gitrepository/flux-system/demo/5f3c1c8e.tar.gz
    lastUpdateTime: "2026-10-22T09:14:02Z"
```

4. A consumer (`Kustomization`, `HelmRelease`) references the source by
   `spec.sourceRef`, watches its status, downloads the tarball over
   plain in-cluster HTTP, extracts it and does its own work.

Consequences worth remembering:

- Consumers never contact Git. Network rules, credentials and proxies are a
  source-controller concern only.
- A consumer reconciles only when the artifact **revision changes** or its own
  `interval` elapses. A new commit that touches nothing under `spec.ignore`
  rules still yields a new revision.
- `flux reconcile source git demo` forces a fresh fetch;
  `flux reconcile kustomization demo --with-source` does both in order.

**Gotcha:** the artifact store is local to the source-controller Pod. After
a restart with emptyDir storage, every source re-fetches and consumers see a
short burst of reconciliations. That is normal, not drift.

## `flux install` vs `flux bootstrap`

| | `flux install` | `flux bootstrap <provider>` |
|---|---|---|
| Installs controllers and CRDs | yes | yes |
| Writes anything to Git | no | yes: `clusters/<name>/flux-system/{gotk-components,gotk-sync,kustomization}.yaml` |
| Creates a `GitRepository` + `Kustomization` named `flux-system` | no | yes, pointing at that path |
| Flux manages its own upgrade | no (re-run `flux install`) | yes (bump the manifests in Git) |
| Needs a Git token / deploy key | no | yes |

Bootstrap is what you run on a real cluster: after it, the Flux installation
itself is desired state in Git and principle 4 applies to Flux too. The lab
uses `flux install` so that you create sources and Kustomizations yourself
and see each piece appear. The behaviour of the controllers is identical.

## Reading `flux get all -A`

```text
NAMESPACE    NAME                      REVISION              SUSPENDED  READY  MESSAGE
flux-system  gitrepository/demo        main@sha1:5f3c1c8e    False      True   stored artifact for revision 'main@sha1:5f3c1c8e'
flux-system  kustomization/demo        main@sha1:5f3c1c8e    False      True   Applied revision: main@sha1:5f3c1c8e
flux-system  helmrelease/podinfo       6.7.1                 False      False  Helm install failed for release flux-system/podinfo with chart podinfo@6.7.1: …
```

Read it in column order:

- **REVISION** on a source is what was fetched; on a consumer it is what was
  last *applied*. When they differ, the consumer is behind or failing.
- **SUSPENDED** `True` means the controller ignores this object entirely: no
  apply, no prune, no drift correction. It is the first thing to check when
  "the change never arrived".
- **READY** `False` with the **MESSAGE** is the controller's own one-line
  diagnosis; `kubectl describe` on the object gives the full conditions and
  recent Events.

`flux get sources all -A`, `flux get kustomizations -A`, `flux get hr -A`
are the narrower forms. `flux get ... --status-selector ready=false` lists
only the broken objects.

## Reading `flux logs`

`flux logs` is `kubectl logs` across the controllers with filters:

```bash
flux logs --all-namespaces --level=error --since=10m   # every controller, errors only
flux logs --kind=Kustomization --name=demo             # one object, one controller
flux logs --kind=HelmRelease --name=podfino --follow   # typo on purpose: no output means no object
```

Each line is formatted text, `<timestamp> <level> <Kind>/<name>.<namespace> -
<msg>`; the raw JSON (keys `controller`, `controllerKind`, `name`,
`namespace`, `reconcileID`, `msg`) is what
`kubectl -n flux-system logs deploy/<controller>` prints. The message is
usually the same text as the object's `Ready` condition
plus context the status could not fit (the failing resource, the kustomize
build error, the Helm error chain).

**Try it:** map the toolkit onto your cluster.

```bash
kubectl -n flux-system get deploy                       # one Deployment per controller
kubectl api-resources | grep toolkit.fluxcd.io          # which CRDs belong to which group
flux get all -A                                         # the empty table you will fill
flux logs --all-namespaces --since=5m | head -20        # the controllers' idle loop
kubectl -n flux-system get svc source-controller        # the artifact server consumers download from
```

## Where to go next

The next lesson is about the left side of the diagram: the source kinds,
their fields, their revision formats and how to debug one that refuses to
become Ready. The *Flux GitRepository* and *Flux Kustomization* builders walk
through the two objects you will type most.

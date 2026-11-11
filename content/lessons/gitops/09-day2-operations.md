---
title: "Day-2 operations: suspend, reconcile, diff, trace, notify, automate"
slug: day2-operations
realm: gitops
order: 9
summary: "The flux CLI verbs you use in an incident, how pruning accidents happen and how to prevent them, notifications with Provider/Alert/Receiver, image update automation, and upgrading Flux itself."
estimated_minutes: 18
level: intermediate
tags: [flux, operations, suspend, reconcile, diff, notifications, image-automation, upgrade]
builders: []
scenarios: [flux-suspended-drift]
quiz:
  - q: "A Kustomization shows SUSPENDED=True. Which of these still happens?"
    options: ["Drift correction", "Pruning", "Applying new commits", "None of them; the controller ignores the object until it is resumed"]
    answer: 3
    explain: "Suspend stops the whole reconcile loop for that object. Resume triggers an immediate reconcile that applies everything that accumulated."
  - q: "What does `flux reconcile kustomization apps --with-source` do that `flux reconcile kustomization apps` does not?"
    options: ["Deletes and recreates the Kustomization", "Fetches the source first, so a commit that the source has not polled yet is picked up", "Runs kustomize build locally", "Suspends the source"]
    answer: 1
    explain: "Without --with-source the Kustomization re-applies the artifact it already has. With it, the GitRepository is reconciled first, then the Kustomization."
  - q: "You rename a Kustomization from `apps` to `applications` in Git with prune: true on both. What is the risk?"
    options: ["None; the name is cosmetic", "The old object is garbage-collected and, with it, everything in its inventory, possibly before the new one has adopted the resources", "The new object cannot be created", "The source is pruned"]
    answer: 1
    explain: "Inventory ownership follows the Kustomization name. Rename with deletionPolicy: Orphan or prune: false on the old one first, then let the new one adopt."
---

# Day-2 operations

Installing Flux takes ten minutes. Operating it is a small vocabulary of
verbs that you need to know cold at 3 a.m., and a handful of mistakes you
want to have made in a lab first.

## Suspend and resume

```bash
flux suspend kustomization apps              # stop apply, drift correction and pruning
flux suspend hr podinfo -n lab-podinfo
flux suspend source git flux-system          # bootstrap-only source (absent in the lab): freeze the artifact, consumers keep what they have
flux resume kustomization apps               # reconciles immediately on resume
kubectl get kustomizations,helmreleases,gitrepositories -A \
  -o custom-columns='KIND:.kind,NS:.metadata.namespace,NAME:.metadata.name,SUSPENDED:.spec.suspend'   # audit what is paused
```

Suspend is the right tool for a manual intervention: you need to `kubectl
edit` something during an incident and do not want Flux to revert it in
the next minute. It is also the most common cause of "we merged the fix and
nothing happened" (*flux-suspended-drift* scenario). Make a suspended object
loud: an Alert on it, a dashboard panel, a ticket that says who suspended it
and why. `flux suspend` patches `spec.suspend: true` on the cluster object only.
Because server-side apply leaves fields that Git does not declare alone,
a parent Kustomization re-applying the object from Git will **not** undo
the pause: it is durable and invisible in Git at the same time. Commit
`suspend: true` if the pause should show in the audit log, and remove it
the same way.

## Forcing a reconcile

Reconciliation runs on `interval`. To not wait:

```bash
flux reconcile source git demo                       # fetch now
flux reconcile kustomization demo --with-source      # fetch, then apply
flux reconcile hr podinfo -n lab-podinfo --with-source
flux reconcile hr podinfo -n lab-podinfo --reset     # clear failure counters after RetriesExceeded
flux reconcile hr podinfo -n lab-podinfo --force     # run an upgrade even if nothing changed
```

Under the hood the CLI sets the annotation `reconcile.fluxcd.io/requestedAt`
with a timestamp; the controller sees the change and runs. You can do the
same with `kubectl annotate` from a pipeline, and a notification-controller
`Receiver` does it from a Git webhook.

## Diff, trace, events

```bash
flux diff kustomization demo --path ~/demo-repo/apps/podinfo   # server-side dry-run of a local tree against the cluster
flux trace -n lab-demo deployment/podinfo                      # which Kustomization/HelmRelease and source own this object
flux tree kustomization demo                                   # the inventory, as a tree
flux events --for Kustomization/demo -n flux-system            # Flux events, newest last
flux stats -A                                                  # counts and storage per kind
```

`flux diff` is the pre-merge check: run it in CI against a branch and you
see exactly which fields change on the cluster before anyone approves. It
exits non-zero when it finds a difference, so it can gate a pipeline.
`flux trace` answers the incident question "who manages this Deployment?"
in one call, walking from the object through the Kustomization or
HelmRelease up to the source revision.

## Pruning accidents and how to avoid them

Prune is garbage collection driven by the inventory. It does what you
declared, which is the problem when the declaration is wrong:

| Accident | Mechanism | Guard |
|---|---|---|
| Path pointed at a directory with fewer manifests | Build succeeds, inventory shrinks, the rest is deleted | `flux diff` in CI; `wait: true` so a bad apply at least blocks dependants |
| Kustomization renamed | Old object deleted with its inventory; new one may not have adopted yet | Set `deletionPolicy: Orphan` or `prune: false` on the old name first |
| Kustomization deleted "to recreate it" | Finalizer runs GC on everything it owned | `flux suspend` and `kubectl delete` with `deletionPolicy: Orphan`, or recreate in Git |
| Namespace in the inventory | Namespace deletion takes every object in it, including those owned by other Kustomizations | `kustomize.toolkit.fluxcd.io/prune: disabled` on Namespaces, CRDs and PVCs |

**Why it matters:** the annotation `kustomize.toolkit.fluxcd.io/prune:
disabled` on the objects you can never afford to lose costs nothing and
turns a cluster-wide outage into a stale object.

## Notifications: Provider, Alert, Receiver

Three objects owned by notification-controller:

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata: { name: ops-webhook, namespace: flux-system }
spec:
  type: generic                       # slack, msteams, discord, github, gitlab, gitea, grafana, alertmanager…
  secretRef: { name: ops-webhook }    # key "address" (and "token"/"headers" when needed)
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata: { name: errors, namespace: flux-system }
spec:
  providerRef: { name: ops-webhook }
  eventSeverity: error                # info | error
  eventSources:
    - { kind: Kustomization, name: "*" }                      # name "*" = every object of that kind; namespace defaults to the Alert's
    - { kind: HelmRelease, name: "*", namespace: lab-podinfo }  # namespace is matched exactly, no wildcard: one entry per namespace
    - { kind: HelmRelease, name: "*", namespace: lab-helm }
    - { kind: GitRepository, name: "*" }
  eventMetadata:
    summary: "production cluster"     # spec.summary is deprecated in v1beta3
---
apiVersion: notification.toolkit.fluxcd.io/v1
kind: Receiver
metadata: { name: gitea-push, namespace: flux-system }
spec:
  type: github                        # Gitea sends GitHub-compatible webhooks; also gitlab, bitbucket, harbor, dockerhub, generic, generic-hmac…
  events: [push]
  secretRef: { name: webhook-token }  # validates the webhook signature
  resources:
    - { kind: GitRepository, name: demo }
```

`Provider` is *where to send*; `Alert` is *which events, at which severity,
from which objects*: `name: "*"` matches every object of a kind, but
`namespace` is compared exactly (defaulting to the Alert's own), so several
tenant namespaces mean several entries or one Alert per namespace.
`Receiver` is the inbound direction: a webhook path in
`status.webhookPath`, served by the `webhook-receiver` Service in
`flux-system`, that reconciles the listed resources when the Git host calls
it. In the lab, Gitea runs in the cluster, so a repo webhook to
`http://webhook-receiver.flux-system.svc.cluster.local/hook/<sha256>` (the
Service host plus `status.webhookPath`, which already starts with `/hook/`)
closes the push-to-apply gap without an Ingress.

## Image update automation

Three objects turn "a new image was pushed" into a commit:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1        # v1beta2 on Flux older than 2.7; check kubectl api-resources
kind: ImageRepository
metadata: { name: podinfo, namespace: flux-system }
spec:
  image: ghcr.io/stefanprodan/podinfo
  interval: 5m                                # scan the registry for tags
---
apiVersion: image.toolkit.fluxcd.io/v1
kind: ImagePolicy
metadata: { name: podinfo, namespace: flux-system }
spec:
  imageRepositoryRef: { name: podinfo }
  policy:
    semver: { range: "6.7.x" }                # or alphabetical / numerical with filterTags
---
apiVersion: image.toolkit.fluxcd.io/v1
kind: ImageUpdateAutomation
metadata: { name: demo, namespace: flux-system }
spec:
  interval: 10m
  sourceRef: { kind: GitRepository, name: demo }   # needs write credentials in its secretRef
  git:
    checkout: { ref: { branch: main } }
    commit:
      author: { name: fluxcdbot, email: fluxcd@example.com }
      messageTemplate: "chore: update images to {{ range .Changed.Changes }}{{ .NewValue }} {{ end }}"
    push: { branch: main }                    # or a feature branch that opens a PR
  update: { path: ./apps/staging, strategy: Setters }
```

The manifests opt in with a marker comment on the line to rewrite:
`image: ghcr.io/stefanprodan/podinfo:6.7.1 # {"$imagepolicy": "flux-system:podinfo"}`.
Push to a branch and open a PR from it for production; push straight to
`main` for staging. The lab installs both image controllers, so these
objects are accepted as-is; the automation needs a GitRepository whose
`secretRef` holds credentials that can push (`lab` / `labpass123` works
against the lab Gitea).

## Upgrading Flux

Flux upgrades are a CLI bump plus a re-run of what installed it:

1. Read the release notes for API promotions (`v1beta2` → `v1`) and removed
   fields; `flux check` and the controller logs warn on deprecated versions.
2. Upgrade the `flux` CLI, then `flux check --pre`.
3. Bootstrapped cluster: run `flux bootstrap` again with the same arguments;
   it commits the new `gotk-components.yaml`, and Flux upgrades itself. Lab
   or `flux install` cluster: run `flux install` again (keep the same
   `--components-extra`).
4. Bump `apiVersion` in your manifests to the new stable versions when the
   old ones are deprecated. Flux has no conversion webhooks: an old version
   stays served unchanged for a deprecation window, then is removed and the
   API server rejects it (`no matches for kind … in version …`), so bump
   before upgrading past that release.
5. `flux version` shows the CLI version, the `distribution` the cluster was
   installed from and each controller's own version (controllers are
   versioned independently, so their minors do not match the CLI's). Compare
   `flux` with `distribution`; `flux check` lists the controller images and
   CRD versions behind it.

**Try it:** with the `demo` Kustomization from lesson 4, run the incident
vocabulary end to end.

```bash
flux suspend kustomization demo
kubectl -n lab-demo scale deploy/podinfo --replicas=3 && sleep 70 && kubectl -n lab-demo get deploy podinfo   # drift survives
flux get kustomizations                                              # SUSPENDED=True
flux resume kustomization demo && kubectl -n lab-demo get deploy podinfo   # back to 1
sed -i 's/replicas: 1/replicas: 2/' ~/demo-repo/apps/podinfo/deployment.yaml
flux diff kustomization demo --path ~/demo-repo/apps/podinfo         # the change, before any commit
git -C ~/demo-repo checkout -- .                                     # drop it
flux trace -n lab-demo deployment/podinfo
flux events --for Kustomization/demo -n flux-system | tail -5
flux check                                                           # includes the image controllers
```

## Where to go next

One topic is left, and it is the one most GitOps rollouts get wrong first:
secrets. The last lesson compares SOPS, Sealed Secrets and External
Secrets, and shows a working SOPS setup with Flux decryption.

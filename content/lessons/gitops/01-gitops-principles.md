---
title: "GitOps principles: desired state, pull, reconciliation"
slug: gitops-principles
realm: gitops
order: 1
summary: "The four OpenGitOps principles, why pull beats push, what a reconciliation loop actually does with drift, and where Flux and Argo CD differ."
estimated_minutes: 12
level: beginner
tags: [gitops, principles, reconciliation, drift, flux, argocd]
builders: []
scenarios: []
quiz:
  - q: "A teammate runs `kubectl scale deploy/web --replicas=5` on a Deployment managed by a Flux Kustomization whose manifest says `replicas: 2`. What happens?"
    options: ["Nothing; Flux only acts on new commits", "At the next reconciliation Flux re-applies the manifest and replicas return to 2", "Flux commits replicas: 5 back to Git", "The Kustomization becomes Ready=False with a conflict error"]
    answer: 1
    explain: "Continuous reconciliation means the controller re-applies the desired state at every interval, not only when Git changes. Out-of-band edits are drift and get reverted."
  - q: "Which of these is NOT one of the four OpenGitOps principles?"
    options: ["Declarative", "Versioned and immutable", "Pulled automatically", "Deployed by a CI pipeline"]
    answer: 3
    explain: "A CI pipeline pushing to the cluster is exactly what GitOps replaces. The fourth principle is 'continuously reconciled'."
  - q: "Why is the pull model considered safer than push?"
    options: ["It is faster", "The cluster credentials never leave the cluster; CI only needs Git access", "It does not need Git", "It works without controllers"]
    answer: 1
    explain: "With pull, an in-cluster agent reads Git. No external system holds a kubeconfig with write access to production."
---

# GitOps principles

GitOps is a short word for a precise operating model. The OpenGitOps project
(a CNCF working group) wrote it down as four principles, and every tool in
this realm, Flux first, is an implementation of them. Learn the principles and
the tools stop looking magical.

## The four principles

| # | Principle | What it means in practice |
|---|---|---|
| 1 | **Declarative** | The desired state of the system is expressed as data (YAML manifests, Helm values, Kustomize overlays), not as a sequence of steps. |
| 2 | **Versioned and immutable** | That state lives in a store that keeps history and does not rewrite it. Git is the usual choice; an OCI registry with immutable tags also qualifies. |
| 3 | **Pulled automatically** | Software agents retrieve the desired state from the store on their own. Nobody pushes to the cluster. |
| 4 | **Continuously reconciled** | The agents keep comparing actual state to desired state and act on every difference, forever, not once at deploy time. |

**Why it matters:** principles 1 and 2 are about *what* you store; 3 and 4
are about *who applies it and how often*. A team that keeps manifests in Git
but runs `kubectl apply` from a CI job satisfies 1 and 2 only. That is
"infrastructure as code with a Git remote", not GitOps, and it is the setup
most incidents of the "someone changed it by hand" family come from.

## Push vs pull

| | Push (CI applies) | Pull (in-cluster agent) |
|---|---|---|
| Who holds cluster credentials | The CI system, outside the cluster | Nobody outside; the agent uses a ServiceAccount |
| Trigger | A pipeline run | A timer (and optionally a webhook) |
| Between runs | Nothing watches the cluster | The agent keeps reconciling |
| Failure mode | Pipeline green, cluster drifted later | Agent reports `Ready=False` until fixed |
| Rollback | Re-run an old pipeline | `git revert`; the agent does the rest |

Pull is not only a security argument (no kubeconfig in a CI secret store) but
an operational one: the pipeline knows nothing after it exits, the agent
knows the state of every object it manages at all times.

## The reconciliation loop

Every Flux controller runs the same loop, on a timer set by `spec.interval`:

1. **Fetch the desired state.** Clone the Git revision, download the chart,
   read the bucket: a *source*.
2. **Build.** Run kustomize, render the Helm templates, substitute variables.
3. **Observe the actual state.** Ask the API server what the objects look
   like now.
4. **Diff and act.** Create what is missing, update what differs, delete what
   is no longer declared (if pruning is on).
5. **Report.** Write conditions (`Ready`, `Reconciling`, `Stalled`) and emit
   Events.

Step 4 is where **drift** is handled. Drift is any difference between desired
and actual state that was not caused by Git: a `kubectl edit`, a `kubectl
scale`, an object deleted by hand, a mutating webhook, another controller
fighting over a field. The loop does not care *why* the state differs; it
re-applies. That is a feature when a late-night hotfix is forgotten, and a
surprise when the HorizontalPodAutoscaler changes `replicas` and Flux changes
it back. The lesson on Kustomizations covers field ownership for that case.

**Gotcha:** reconciliation is **not** triggered by commits. The source
controller polls Git every `interval` (1 to 10 minutes is typical). The lag
between `git push` and the cluster changing is normal; a webhook Receiver
removes it when you care.

## Git is the audit log

Because the only way to change the cluster is to change Git, the Git history
*is* the change log, with properties an SRE needs:

- **Who and when:** every commit has an author and a timestamp, signed if you
  require it.
- **Review before change:** a pull request is a change-approval board that
  leaves a trace. `CODEOWNERS` maps directories to the teams that must
  approve.
- **Rollback is a revert:** `git revert <sha>` produces a new commit; the
  agent applies it like any other. No special "rollback" tooling, no state
  outside Git.
- **Blame on a path:** `git log -- clusters/prod/apps/web.yaml` answers "what
  changed on this app" faster than any dashboard.

The condition for all of this is strict: **no write access to the cluster
except the agent**. The moment humans can `kubectl apply` in production, the
log is incomplete and the reconciler is racing against people.

## Flux and Argo CD

Both implement the four principles. They differ in shape, and the difference
matters when you choose.

| | Flux CD | Argo CD |
|---|---|---|
| Shape | A toolkit of small controllers with CRDs; no UI in the core | One application with a web UI, API and CLI |
| Core objects | `GitRepository`, `Kustomization`, `HelmRelease` | `Application`, `ApplicationSet`, `AppProject` |
| Helm | Real Helm releases: `helm history` works, hooks and tests run | Charts are rendered with `helm template` and applied as plain manifests; no release Secret |
| Sync | Always automatic, on `interval` | Manual by default; auto-sync and `selfHeal` opt-in |
| Multi-tenancy | Namespaced objects, ServiceAccount impersonation | `AppProject` boundaries, built-in RBAC and SSO |
| Extras | Notifications, image update automation, OCI artifacts | Rollouts (separate project), sync waves, resource tree UI |
| Fits | Teams that live in Git and kubectl; platform engineers | Teams that want a console for developers |

Neither is wrong. This realm uses Flux because its parts map one-to-one to
Kubernetes concepts you already know, and because `kubectl` is the UI.

**Try it:** see the agent and its loop in your lab cluster.

```bash
flux check                                  # controllers healthy, CRDs present
flux get all -A                             # nothing declared yet: that is the point
kubectl get crds | grep fluxcd              # the vocabulary of the next lessons
kubectl -n flux-system get deploy           # the controllers that run the loop
```

## Where to go next

The next lesson opens the Flux toolkit: which controller runs which part of
the loop, and how desired state travels from a repository to an object in the
API server.

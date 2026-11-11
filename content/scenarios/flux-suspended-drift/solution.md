## Diagnosis

Three sources of truth disagree; line them up.

```bash
# The cluster
kubectl get deploy -n lab-drift-app podinfo
# NAME      READY   UP-TO-DATE   AVAILABLE
# podinfo   0/0     0            0
kubectl describe deploy -n lab-drift-app podinfo | grep -A5 Events
# ScalingReplicaSet  Scaled down replica set podinfo-6c8f... to 0    <- and nothing after it

# Git
git clone http://lab:labpass123@localhost:30080/lab/flux-suspended-drift.git
grep replicas flux-suspended-drift/deploy/podinfo/deployment.yaml
#   replicas: 2

# Flux
flux get kustomizations -n lab-drift
# NAME     REVISION            SUSPENDED  READY  MESSAGE
# podinfo  main@sha1:7c0d...   True       True   Applied revision: main@sha1:7c0d...
kubectl get kustomization podinfo -n lab-drift -o jsonpath='{.spec.suspend}{" "}{.status.lastAppliedRevision}'
# true main@sha1:7c0d...
```

The Deployment was scaled down manually and nobody scaled it back: with a
non-suspended Kustomization, the kustomize-controller would have re-applied
`replicas: 2` within one interval and the event log would show a tug-of-war.
It shows one scale-down and silence.

## Root cause

The Kustomization has `spec.suspend: true`. A suspended object is skipped by
its controller: no new revisions, no periodic re-apply, no pruning. Its
`status` is frozen at the last successful reconciliation, which is why Flux
still reports `Ready=True / Applied revision ...` while the cluster has
drifted. The scale-down is only the visible consequence; the real fault is
that the control loop was switched off and forgotten.

## Fix

Fix the loop, then let the loop fix the cluster:

```bash
flux resume kustomization podinfo -n lab-drift
# ► resuming kustomization podinfo in lab-drift namespace
# ✔ kustomization resumed
# ◎ waiting for Kustomization reconciliation
# ✔ Kustomization reconciliation completed
# ✔ applied revision main@sha1:7c0d...

# equivalent without the CLI:
kubectl patch kustomization podinfo -n lab-drift --type merge -p '{"spec":{"suspend":false}}'
```

Resuming bumps the object's generation, the controller reconciles
immediately, runs a server-side apply of the artifact with `force: true` and
takes `spec.replicas` back from the `kubectl-scale` field manager:

```bash
kubectl get deploy -n lab-drift-app podinfo -w
# podinfo   0/2   2   0
# podinfo   2/2   2   2
kubectl get kustomization podinfo -n lab-drift -o jsonpath='{.spec.suspend} {.status.observedGeneration}/{.metadata.generation}'
# false 3/3
```

No `kubectl scale` was needed. If you had run it, the outcome would look the
same today, but the Kustomization would still be suspended and the next
revision pushed to Git would never reach the cluster.

## Prevention

- Time-box every suspend: `flux suspend ... --reason` plus a ticket, and an
  alert on `gotk_resource_info{customresource_kind="Kustomization",suspended="True"}`
  lasting more than an hour (Flux custom-resource metrics collected by
  kube-state-metrics; the controllers themselves do not export it).
- Prefer narrower tools to a full suspend when debugging: the
  `kustomize.toolkit.fluxcd.io/reconcile: disabled` annotation on a single
  object, or `kustomize.toolkit.fluxcd.io/ssa: Merge` to let a field such as
  `replicas` be managed outside Git (HPA-style) on purpose.
- Make `flux get all -A` (or the Flux dashboard in Grafana) the first screen
  of any "app is down" runbook: SUSPENDED and READY columns answer in seconds
  whether GitOps is in charge.
- Protect the app namespace with an admission policy that denies `scale` /
  `update` on Flux-owned objects from humans, so drift needs a deliberate
  break-glass rather than a reflex.

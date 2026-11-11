---
title: "Workload and rollout triage: Deployments, StatefulSets, Jobs, PDBs and HPAs"
slug: workload-and-rollout-triage
realm: troubleshooting
order: 6
summary: "Why a rollout hangs and how to read it from the ReplicaSets, StatefulSet ordering and PVC retention, Job and CronJob knobs, PodDisruptionBudgets that block drains, and HPAs that fight your manifests."
estimated_minutes: 20
level: intermediate
tags: [deployment, replicaset, rollout, statefulset, job, cronjob, pdb, hpa]
builders: [deployment-basics, hpa-autoscaling]
scenarios: [rollout-stuck-bad-image, resourcequota-blocks-rollout]
quiz:
  - q: "A Deployment with 3 replicas, maxSurge 1 and maxUnavailable 0 is rolling out an image that does not exist. What do users see?"
    options: ["A full outage until the image is fixed", "Nothing: three old Pods keep serving while one new Pod sits in ImagePullBackOff", "One third of requests fail", "The Deployment rolls back automatically after progressDeadlineSeconds"]
    answer: 1
    explain: "maxUnavailable 0 forbids removing an old Pod before a new one is Ready. The rollout stalls, ProgressDeadlineExceeded is reported, but nothing is rolled back for you."
  - q: "A Job has restartPolicy Never and backoffLimit 3. Its Pods keep failing. What do you expect to see?"
    options: ["One Pod with RESTARTS 3", "Up to four Pods in Error, then the Job condition Failed with reason BackoffLimitExceeded", "The Job is deleted", "The Job is suspended"]
    answer: 1
    explain: "With Never, each attempt is a new Pod and the failed ones are kept for inspection. OnFailure would restart the same Pod and count RESTARTS instead."
  - q: "kubectl drain hangs repeating 'Cannot evict pod as it would violate the pod's disruption budget'. What is the first thing to check?"
    options: ["The node's taints", "kubectl get pdb -n <ns>: ALLOWED DISRUPTIONS is 0", "The kubelet log", "The Deployment's maxUnavailable"]
    answer: 1
    explain: "The Eviction API refuses while the PDB has no disruption budget left, typically because minAvailable equals the replica count or because Pods are not Ready and already count as disrupted."
---

# Workload and rollout triage

A Deployment never touches Pods. It owns **ReplicaSets** (one per Pod
template, labelled with `pod-template-hash`) and the ReplicaSets own Pods.
Every rollout symptom is therefore visible in `kubectl get rs`: the new
ReplicaSet with DESIRED above READY is the stuck one, the old ReplicaSet
still holding replicas is why users have not noticed yet.

**Why it matters:** the Deployment columns `READY 2/3`, `UP-TO-DATE 1`,
`AVAILABLE 2` already tell the story: one Pod carries the new template and
is not available. Look at *that* Pod with the chapter 02 method; the
Deployment itself is never the wrong object, only the loud one.

## The decision table

| Symptom | First command | Likely causes |
|---|---|---|
| `rollout status` waits forever, `UP-TO-DATE` < replicas | `kubectl get rs -n <ns> -l app=<name>` then the new RS Pods | bad image, readiness failing, Pending, quota |
| Condition `Progressing=False`, `ProgressDeadlineExceeded` | `kubectl describe deploy` → Conditions | same as above, past `progressDeadlineSeconds` |
| Condition `ReplicaFailure=True`, RS event `FailedCreate` | `kubectl describe rs <new-rs>` | ResourceQuota, LimitRange, admission webhook |
| `field is immutable` on apply | `kubectl get deploy -o jsonpath='{.spec.selector}'` | changed `spec.selector`; delete/recreate or revert |
| StatefulSet `READY 1/3`, ordinal 1 Pending | `kubectl describe pod <sts>-1` | PVC Pending, ordinal 0 not Ready, bad template |
| Job `COMPLETIONS 0/1`, Pods in `Error` | `kubectl describe job` → Conditions; `kubectl logs job/<name>` | `BackoffLimitExceeded`, `DeadlineExceeded`, bad command |
| CronJob never runs | `kubectl get cj` → SUSPEND, LAST SCHEDULE | `suspend: true`, `concurrencyPolicy: Forbid` with a stuck Job, `startingDeadlineSeconds` |
| `drain` loops on `violate the pod's disruption budget` | `kubectl get pdb -A` | ALLOWED DISRUPTIONS 0 |
| HPA `TARGETS <unknown>/50%` | `kubectl describe hpa` → Conditions | metrics-server missing, no CPU requests |
| Replica count flips after every apply | `kubectl get hpa -n <ns>` | manifest sets `replicas` while an HPA owns it |

## Rollout mechanics

`strategy.rollingUpdate` has two knobs, both defaulting to `25%`:
`maxSurge` (extra Pods allowed above `replicas`, rounded up) and
`maxUnavailable` (old Pods that may be gone before new ones are Ready,
rounded down). With three replicas that means surge 1, unavailable 0: the
controller creates one new Pod, waits for it to be Ready for
`minReadySeconds`, scales the old ReplicaSet down by one, repeats. If the new
Pod never becomes Ready, the loop stops at step one and the old Pods keep
serving. That is the stuck rollout: safe for users, invisible unless you
watch.

`progressDeadlineSeconds` (default 600) only changes the **report**: after
that time the condition flips to `Progressing=False` with reason
`ProgressDeadlineExceeded` and `kubectl rollout status` exits with
`error: deployment "web" exceeded its progress deadline`. Nothing is rolled
back for you.

**Try it:** with the `rollout-stuck-bad-image` scenario loaded, the four
rollout commands in the order you use them during an incident.

```bash
kubectl rollout status deploy/web -n lab-rollout --timeout=60s
kubectl get rs -n lab-rollout -l app=web -o wide        # old vs new template, image column
kubectl rollout history deploy/web -n lab-rollout       # revisions; --revision=N prints the template
kubectl rollout undo deploy/web -n lab-rollout          # back to the previous revision now
```

`undo` restores service in seconds by scaling the previous ReplicaSet back
up; it creates a new revision rather than deleting one. Fix the manifest in
Git afterwards, otherwise the next reconciliation (Flux, CI, a colleague's
`apply`) reapplies the broken template. `rollout restart` is for "same
template, new Pods" (a ConfigMap change, chapter 02); `pause`/`resume` lets
you batch several edits into one rollout.

**Gotcha:** `spec.selector` is immutable in `apps/v1`. Renaming the `app`
label gives `field is immutable`; the only ways out are reverting the label or
deleting and recreating the Deployment (with `--cascade=orphan` if the Pods
must survive).

## StatefulSets: order and retention

A StatefulSet creates `web-0`, waits for it to be Ready, then `web-1`
(`podManagementPolicy: OrderedReady`). A rolling update goes in **reverse**
ordinal order and stops at the first Pod that fails. A bad template is thus
stuck at the highest ordinal, and the controller does not retry a new
template on a crashed Pod: fix the template, then delete the stuck Pod by
hand. `updateStrategy.rollingUpdate.partition` lets you canary ordinals above
N.

Each Pod gets a PVC named `<claim>-<sts>-<ordinal>` from
`volumeClaimTemplates`. These PVCs are **not** deleted when the StatefulSet
is scaled down or deleted (unless `persistentVolumeClaimRetentionPolicy` says
`Delete`); the recreated `web-1` reattaches `data-web-1` with whatever is on
it. Stale state surviving a "clean" redeploy is the usual surprise. Chapter
07 covers why that PVC may be `Pending`.

## Jobs and CronJobs

A Job's `restartPolicy` must be `Never` or `OnFailure`. With `Never` every
failure is a new Pod and the old ones stay (`kubectl logs job/<name>` reads
the latest); with `OnFailure` the same Pod restarts and `RESTARTS` grows.
`backoffLimit` (default 6) caps the attempts with exponential delay
(10 s, 20 s, 40 s... up to 6 min); when exceeded the Job gets condition
`Failed`, reason `BackoffLimitExceeded`, message
`Job has reached the specified backoff limit`. `activeDeadlineSeconds` is a
wall-clock cap for the whole Job, overrides `backoffLimit` and kills running
Pods with reason `DeadlineExceeded`. `suspend: true` stops Pod creation while
keeping the object; `ttlSecondsAfterFinished` deletes it after completion.

A CronJob only creates Jobs. Check `kubectl get cj` first: `SUSPEND True`
explains most "it never runs" tickets. `concurrencyPolicy` decides what
happens when the previous Job is still active: `Allow` (default) stacks,
`Forbid` skips with event `JobAlreadyActive`, `Replace` kills it. If the
controller missed more than 100 schedules (controller-manager down, clock
skew) it refuses to catch up until `startingDeadlineSeconds` is set. To test
a CronJob without waiting: `kubectl create job manual-1 --from=cronjob/<name>`.

## PodDisruptionBudgets

A PDB protects a set of Pods (by selector) against **voluntary** disruptions:
`drain`, the Eviction API, cluster autoscalers. `kubectl get pdb` shows
`ALLOWED DISRUPTIONS`; at `0` every eviction is refused with
`Cannot evict pod as it would violate the pod's disruption budget` and
`drain` retries every five seconds, forever. Three usual causes: `minAvailable`
equals the replica count, `maxUnavailable: 0`, or some Pods are not Ready and
already count as disrupted. Fix the readiness, scale up temporarily, or
relax the budget; `--disable-eviction` bypasses PDBs entirely and should be a
last resort you can explain in the postmortem.

## HPA interactions

An HPA writes `spec.replicas` on its target. If the Deployment manifest also
carries `replicas: 3`, every `kubectl apply` or Flux reconciliation resets the
count and the HPA raises it again: flapping ReplicaSets, noisy events, and a
checker that never settles. Remove `replicas` from the manifest when an HPA
exists. `kubectl describe hpa` tells the rest: `TARGETS <unknown>` with
condition `ScalingActive=False`, reason `FailedGetResourceMetric`, means the
metrics-server addon is missing or the containers have no CPU `requests`
(`missing request for cpu`); `ScalingLimited=True` means `minReplicas`,
`maxReplicas` or a `behavior` policy is the ceiling (a ResourceQuota never
shows up here: it surfaces as `FailedCreate` on the ReplicaSet, chapter 02).
During a rollout the HPA scales the Deployment, not the ReplicaSets, so a
stuck rollout with a busy HPA spreads the extra replicas across both
ReplicaSets in proportion to their size (proportional scaling), most of them
onto the **old** one. See the `hpa-autoscaling` builder for the manifest.

## k9s tip

`:deploy` then `z` lists the ReplicaSets (old vs new hash), `Enter` on a
ReplicaSet or on the Deployment lists the Pods: three keystrokes from symptom
to the stuck Pod. In the Deployment view
`r` performs a `rollout restart` and `s` scales; both ask for confirmation.
`:rs` sorted by age shows which template hash is current. `:jobs` and
`:cronjobs` (`t` triggers a CronJob now), `:pdb` for allowed disruptions,
`:hpa` for targets and conditions.

## Practice

- `rollout-stuck-bad-image`: a release that never finishes while nobody is paged.
- `resourcequota-blocks-rollout`: a scale-up to five where the quota only pays for two; also listed in chapter 02.

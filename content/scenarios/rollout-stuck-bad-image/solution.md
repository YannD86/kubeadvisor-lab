## Diagnosis

Ask the Deployment what it is waiting for, then look at the ReplicaSets it
manages: a rollout is nothing more than two ReplicaSets trading replicas.

```bash
kubectl rollout status deploy/web -n lab-rollout --timeout=10s
# Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
# error: timed out waiting for the condition

kubectl get deploy,rs,pods -n lab-rollout
# deployment.apps/web   3/3     1            3          20m      <-- READY 3/3 but UP-TO-DATE 1
# replicaset.apps/web-5b8c7d9f4   3   3   3   20m               <-- revision 1, healthy
# replicaset.apps/web-7f6d8c5b9   1   1   0   15m               <-- revision 2, 0 ready
# pod/web-7f6d8c5b9-x2kqp   0/1   ImagePullBackOff   0   15m

kubectl describe pod -n lab-rollout web-7f6d8c5b9-x2kqp | grep -E 'Image:|Failed to pull'
#     Image:  nginx:1.27-alpine-broken
#   Warning  Failed  kubelet  Failed to pull image "nginx:1.27-alpine-broken": ... docker.io/library/nginx:1.27-alpine-broken: not found
```

Confirm what changed between revisions:

```bash
kubectl rollout history deploy/web -n lab-rollout
# REVISION  CHANGE-CAUSE
# 1         release 2.4.0 (nginx:1.27-alpine)
# 2         hotfix 2.4.1 (nginx:1.27-alpine-broken)
kubectl rollout history deploy/web -n lab-rollout --revision=2 | grep Image
#     Image:  nginx:1.27-alpine-broken
```

After `progressDeadlineSeconds` (120s here) the Deployment also carries the
condition `Progressing=False, reason ProgressDeadlineExceeded`; `kubectl
rollout status` then exits with an error instead of hanging.

## Root cause

Revision 2 references an image tag that does not exist. The strategy
`maxSurge: 1, maxUnavailable: 0` means the controller may add one new Pod
but may never take an old one away until a new one is Ready. The surge Pod
sits in ImagePullBackOff, so the controller can neither progress nor scale
the old ReplicaSet down. Users are served by revision 1 throughout, which
is exactly what that strategy is for; the cost is a rollout that stays
stuck until a human decides.

## Fix

Roll back to the last known-good template. `undo` creates revision 3 with
the revision-1 template, the broken ReplicaSet is scaled to 0:

```bash
kubectl rollout undo deploy/web -n lab-rollout
kubectl rollout status deploy/web -n lab-rollout
# deployment "web" successfully rolled out
kubectl get rs -n lab-rollout
# web-5b8c7d9f4   3   3   3     <-- revision 3 reuses the revision-1 template hash
# web-7f6d8c5b9   0   0   0
kubectl rollout history deploy/web -n lab-rollout
# 2  hotfix 2.4.1 (nginx:1.27-alpine-broken)
# 3  release 2.4.0 (nginx:1.27-alpine)
```

Rolling forward with the right tag is equally valid when the hotfix is
needed: `kubectl set image deploy/web web=nginx:1.27-alpine -n lab-rollout`
(use the tag the hotfix actually built). Either way the stuck Pod disappears
and the Service never lost an endpoint.

## Prevention

- Alert on `kube_deployment_status_condition{condition="Progressing",status="false"}`
  and on `kube_deployment_spec_replicas != kube_deployment_status_replicas_updated`
  for more than 10 minutes.
- Keep `maxUnavailable: 0` and a short `progressDeadlineSeconds` on
  user-facing Deployments: a bad image then costs a failed pipeline, not an
  outage.
- Resolve images to digests in CI (`crane digest`) before writing them into
  manifests, and have the pipeline run `kubectl rollout undo` automatically
  when `rollout status` fails.

## Diagnosis

Ask Helm what it knows, then ask Kubernetes why the new Pods never came up.

```bash
helm history web -n lab-helmcli
# REVISION  UPDATED  STATUS      CHART           APP VERSION  DESCRIPTION
# 1         ...      superseded  webchart-0.1.0  1.27         Install complete
# 2         ...      failed      webchart-0.1.0  1.27         Upgrade "web" failed: context deadline exceeded

helm get values web -n lab-helmcli --revision 2
# image:
#   tag: 1.27-alpine-broken
helm get values web -n lab-helmcli --revision 1
# null   (defaults only: nginx:1.27-alpine)

kubectl get pods -n lab-helmcli
# web-5d8c...-abcde   1/1   Running            0   10m    <- old ReplicaSet
# web-5d8c...-fghij   1/1   Running            0   10m
# web-7f9a...-klmno   0/1   ImagePullBackOff   0   3m     <- new ReplicaSet
kubectl describe pod -n lab-helmcli -l app.kubernetes.io/instance=web | grep -A3 'Events' | tail -3
# Failed to pull image "nginx:1.27-alpine-broken": ... manifest unknown
kubectl rollout status -n lab-helmcli deploy/web --timeout=5s
# Waiting for deployment "web" rollout to finish: 1 out of 2 new replicas have been updated...
```

The service still answers because the RollingUpdate strategy
(`maxUnavailable: 25%` of 2 rounds down to 0) never scaled the old
ReplicaSet down before a new Pod was Ready.

## Root cause

Revision 2 set `image.tag` to `1.27-alpine-broken`, a tag that does not
exist in the registry. `helm upgrade --wait --timeout 40s` waited for the
Deployment to become ready, gave up, and recorded revision 2 as `failed`.
Helm does **not** revert anything on failure unless `--atomic` is used, so the
Deployment keeps the broken Pod template and the rollout stays stuck.

## Fix

Helm stores the complete manifest of every revision in the release Secrets
(`sh.helm.release.v1.web.v1`, `.v2`), so you can go back without the chart:

```bash
helm rollback web 1 -n lab-helmcli --wait
# Rollback was a success! Happy Helming!
helm history web -n lab-helmcli
# 1  superseded  Install complete
# 2  failed      Upgrade "web" failed: context deadline exceeded
# 3  deployed    Rollback to 1
```

Rollback re-applies the revision-1 manifest as **revision 3**: the
Deployment's Pod template is identical to the old ReplicaSet's, so Kubernetes
reuses it and scales the broken ReplicaSet to 0 immediately.

```bash
kubectl rollout status -n lab-helmcli deploy/web     # deployment "web" successfully rolled out
kubectl get pods -n lab-helmcli                        # 2/2 Running, the ImagePullBackOff Pod is gone
helm status web -n lab-helmcli | grep STATUS           # STATUS: deployed
```

Going forward instead of back is equally valid when the chart is at hand:
`helm upgrade web <chart-dir> -n lab-helmcli --set image.tag=1.27-alpine --wait`
produces a deployed revision 3 as well. What is not valid is
`kubectl set image`: the Pods would recover, but Helm would still consider
the release failed and the next pipeline run would start from a lie.

## Prevention

- Deploy with `helm upgrade --install --atomic --timeout 5m`: on failure Helm
  rolls back by itself and the pipeline fails clean instead of leaving a
  half-rolled Deployment.
- Resolve images to digests or verify the tag exists before deploying
  (`crane manifest nginx:1.27-alpine` or an image-promotion step); a CI job
  should never be the first thing to pull a tag.
- Keep `maxUnavailable: 0` (or a PodDisruptionBudget) for user-facing
  Deployments so a bad rollout degrades instead of taking the service down.
- Alert on `kube_pod_container_status_waiting_reason{reason="ImagePullBackOff"}`
  and on Deployments whose `updated_replicas < replicas` for more than 10 minutes.

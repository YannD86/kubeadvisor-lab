## Diagnosis

The Pod status already narrows the layer: the kubelet asked the container
runtime for an image and did not get it.

```bash
kubectl get pods -n lab-images
# NAME                   READY   STATUS             RESTARTS   AGE
# web-6d4b9c7f8-4nq2s    0/1     ImagePullBackOff   0          2m
# web-6d4b9c7f8-s8zjt    0/1     ErrImagePull       0          2m
```

Never stop at the status; the registry's answer is in the event text:

```bash
kubectl describe pod -n lab-images -l app=web | grep -E 'Image:|Failed|Back-off' | head
#     Image:  nginx:1.27-alpnie
#   Warning  Failed   kubelet  Failed to pull image "nginx:1.27-alpnie": failed to pull and unpack image
#            "docker.io/library/nginx:1.27-alpnie": failed to resolve reference
#            "docker.io/library/nginx:1.27-alpnie": docker.io/library/nginx:1.27-alpnie: not found
#   Warning  Failed   kubelet  Error: ErrImagePull
#   Normal   BackOff  kubelet  Back-off pulling image "nginx:1.27-alpnie"
#   Warning  Failed   kubelet  Error: ImagePullBackOff
```

`not found` (or `manifest unknown`) is the registry saying that *this
reference* does not exist. It reached Docker Hub fine; the tag is misspelt:
`alpnie` instead of `alpine`.

## Root cause

A typo in the image tag introduced by the version bump. Kubernetes cannot
validate tags at apply time, so the mistake only shows when the kubelet
pulls. This is the first revision of the Deployment, so there is no previous
ReplicaSet to keep serving and the service went dark. In a real version bump
the default RollingUpdate strategy (`maxUnavailable: 25%`, rounded down to 0
for 2 replicas) would have kept the old Pods up and left the rollout stuck
instead.

## Fix

```bash
kubectl set image deploy/web web=nginx:1.27-alpine -n lab-images
kubectl rollout status deploy/web -n lab-images
# deployment "web" successfully rolled out
kubectl run -n lab-images t --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- -s -o /dev/null -w '%{http_code}\n' http://web
# 200
```

`kubectl rollout undo` would also work if a healthy revision existed in the
history; here the typo is in the first revision, so the image must be fixed.

## Prevention

- Alert on `kube_pod_container_status_waiting_reason{reason=~"ImagePullBackOff|ErrImagePull"}`.
- Let CI resolve the tag before it reaches a manifest: `crane digest nginx:1.27-alpine`
  or `docker manifest inspect` fails fast on a typo; even better, pin by digest.
- Set `maxUnavailable: 0` on user-facing Deployments so a bad image cannot
  take down the old Pods, and keep `progressDeadlineSeconds` short enough
  for the pipeline to fail loudly.

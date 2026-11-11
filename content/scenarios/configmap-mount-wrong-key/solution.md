## Diagnosis

`ContainerCreating` that lasts more than a minute is the kubelet stuck in
sandbox preparation: image pull, network, or volumes. The image is cached
and the CNI works for every other Pod, so look at the volume events.

```bash
kubectl get pods -n lab-mount
# NAME                   READY   STATUS              RESTARTS   AGE
# web-7f8c9d6b5-2lq8r    0/1     ContainerCreating   0          12m
# web-7f8c9d6b5-m4xzt    0/1     ContainerCreating   0          12m

kubectl describe pod -n lab-mount -l app=web | tail -n 4
# Events:
#   Warning  FailedMount  kubelet  MountVolume.SetUp failed for volume "content" : configmap references non-existent config key: index.htm
#   Warning  FailedMount  kubelet  Unable to attach or mount volumes: unmounted volumes=[content], unattached volumes=[], failed to process volumes=[]: timed out waiting for the condition
```

The kubelet names the volume and the key it cannot find. Compare with the
ConfigMap and the Deployment:

```bash
kubectl get cm web-content -n lab-mount -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
# index.html
# robots.txt
kubectl get deploy web -n lab-mount -o jsonpath='{.spec.template.spec.volumes[0].configMap}'
# {"items":[{"key":"index.htm","path":"index.html"}],"name":"web-content"}
```

The ConfigMap has `index.html`; the volume projects `index.htm`.

## Root cause

The "tidy up" introduced an `items:` list on the ConfigMap volume. With
`items:`, the kubelet projects only the listed keys and refuses to set up
the volume if any `key:` is missing from the ConfigMap. The volume never
mounts, so the container is never created; the Pod stays in
`ContainerCreating` while the kubelet retries every few seconds, and the
Service has no Ready endpoints.

## Fix

Correct the key; keep `path: index.html` so nginx still finds its index:

```bash
kubectl patch deploy web -n lab-mount --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/volumes/0/configMap/items/0/key","value":"index.html"}
]'
kubectl rollout status deploy/web -n lab-mount
kubectl run -n lab-mount t --rm -it --restart=Never --image=curlimages/curl:8.10.1 -- -s http://web | grep nominal
# <p>all systems nominal</p>
```

Dropping `items:` altogether also works (every key becomes a file, including
`robots.txt`). Adding an `index.htm` key to the ConfigMap would unblock the
mount too, but leaves two copies of the page to keep in sync.

## Prevention

- Alert on Pods in `ContainerCreating`/`Pending` for more than 5 minutes
  (`kube_pod_status_phase` + `kube_pod_container_status_waiting_reason`), and
  on `FailedMount` events.
- Generate the ConfigMap and the volume from the same source
  (Kustomize `configMapGenerator`), so keys cannot be retyped.
- Only use `items:` when you need a subset or a rename; otherwise mount the
  whole ConfigMap and let the key names be the file names.

## Diagnosis

Restarts with a clean application log mean the process did not decide to
exit: something sent it a signal. Three sources do that in Kubernetes: the
OOM killer, a failed liveness probe, and an eviction. `describe` tells them
apart.

```bash
kubectl get pods -n lab-probes
# NAME                   READY   STATUS             RESTARTS      AGE
# web-55d8c6c9d-7h2kp    0/1     CrashLoopBackOff   4 (25s ago)   2m
# web-55d8c6c9d-xq9vb    1/1     Running            5 (8s ago)    2m

kubectl describe pod -n lab-probes -l app=web | grep -E 'Last State|Reason|Exit Code|Liveness|killing' 
#     Last State:     Terminated
#       Reason:       Completed            <-- nginx shut down cleanly on SIGQUIT (its STOPSIGNAL)
#       Exit Code:    0
#     Liveness:       http-get http://:http/health delay=3s timeout=1s period=3s #success=1 #failure=2
#   Warning  Unhealthy  kubelet  Liveness probe failed: HTTP probe failed with statuscode: 404
#   Normal   Killing    kubelet  Container web failed liveness probe, will be restarted
```

Exit code 0, no OOM, and an explicit `Killing ... failed liveness probe`
event. The killed instance's own log confirms what it was asked:

```bash
kubectl logs -n lab-probes <pod> --previous | tail -n 3
# 10.244.1.1 - - [..] "GET /health HTTP/1.1" 404 153 "-" "kube-probe/1.37"
# 10.244.1.1 - - [..] "GET /health HTTP/1.1" 404 153 "-" "kube-probe/1.37"
# ... signal 3 (SIGQUIT) received, shutting down
```

The user agent `kube-probe` requests `/health`; stock nginx has no such
location and answers 404. Two consecutive failures and the kubelet restarts
the container, every ~10 seconds, forever.

## Root cause

The new liveness probe points at `/health`, a path the container does not
serve. The probe is "working" exactly as designed: it reports the app as
dead, so the kubelet kills it. Each restart adds to the counter, the backoff
grows (CrashLoopBackOff), and because the Pod is Ready in between, traffic
hits a container that is about to be killed, hence the intermittent errors.

## Fix

Probe something nginx actually serves. The root path is fine for a static
server:

```bash
kubectl patch deploy web -n lab-probes --type=json -p '[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/httpGet/path","value":"/"}
]'
kubectl rollout status deploy/web -n lab-probes
kubectl get pods -n lab-probes -w     # restarts stay at 0
```

If the team wants a dedicated endpoint, add it instead of removing the
probe: mount a ConfigMap with a `server` block containing
`location = /health { return 200 'ok'; }` under `/etc/nginx/conf.d/`, keep
`/health` in the probe. Also consider a `readinessProbe` so a Pod is only
routed to once it answers, and more generous `failureThreshold`/`periodSeconds`
so a single slow response does not trigger a restart.

## Prevention

- Alert on `increase(kube_pod_container_status_restarts_total[15m]) > 3` and
  on `kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}`.
- Review rule: a liveness probe path must exist in the image or in the config
  shipped with it; test probes locally (`curl -i localhost/health`) before
  adding them.
- Prefer readiness probes for traffic control; add liveness only for
  deadlock-prone processes, with conservative thresholds.

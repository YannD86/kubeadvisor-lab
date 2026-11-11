## Diagnosis

A container that dies without a final log line was killed by a signal. The
exit code tells you which one, and `Last State` tells you who sent it.

```bash
kubectl get pods -n lab-oom
# NAME                             READY   STATUS             RESTARTS      AGE
# report-worker-6b8d7c5f4-k2m9p    0/1     CrashLoopBackOff   3 (20s ago)   2m

kubectl describe pod -n lab-oom -l app=report-worker | grep -A6 'Last State'
#     Last State:     Terminated
#       Reason:       OOMKilled
#       Exit Code:    137
#       Started:      ...
#       Finished:     ...   (a few seconds later)
#     Ready:          False
#     Restart Count:  3
kubectl describe pod -n lab-oom -l app=report-worker | grep -A2 Limits
#     Limits:
#       memory:  32Mi
```

`137 = 128 + 9` (SIGKILL) and `Reason: OOMKilled`: the kernel enforced the
cgroup memory limit of 32Mi. Now look at what the batch does:

```bash
kubectl get deploy report-worker -n lab-oom -o jsonpath='{.spec.template.spec.containers[0].args[0]}'
# echo 'report-worker: loading batch'; head -c 300m /dev/zero | tail >/dev/null && ... sleep 3600
```

`tail` has to buffer its entire input (one 300 MiB "line" without a newline)
before it can print the last lines, so the worker legitimately peaks at
~300 MiB. With `kubectl top pod -n lab-oom` (metrics-server addon) you would
see usage climbing to the limit right before each kill.

## Root cause

The memory limit was set to a placeholder value (32Mi) when the workload was
migrated, far below the real peak of the batch step. The limit is enforced
by the kernel, not by Kubernetes: once the cgroup exceeds it the OOM killer
sends SIGKILL, the container exits 137, the kubelet restarts it under an
exponential backoff, and the loop never ends. Nothing is wrong with the
command, the node or the image.

## Fix

Keep the request small (the job is bursty) and raise the limit above the
real peak with some headroom:

```bash
kubectl set resources deploy/report-worker -n lab-oom --limits=memory=512Mi
kubectl rollout status deploy/report-worker -n lab-oom
kubectl get pods -n lab-oom -w
# report-worker-...   1/1   Running   0   30s      <-- restarts stay at 0
kubectl logs -n lab-oom deploy/report-worker
# report-worker: loading batch
# batch done, idling
```

Removing the limit altogether would also stop the kills but violates the
namespace policy and lets a regression eat the whole node; size it instead.

## Prevention

- Alert on `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}`
  and on `container_memory_working_set_bytes / kube_pod_container_resource_limits{resource="memory"} > 0.9`.
- Install metrics-server (`kubectl top`) and a VPA in recommendation mode;
  set limits from observed p99 usage plus headroom, not from a template.
- Document the memory profile of batch steps next to the command; a limit
  change should be part of the same review as a command change.

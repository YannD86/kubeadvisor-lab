---
title: "Config triage: ConfigMaps, Secrets, images, probes and resources"
slug: config-triage
realm: troubleshooting
order: 2
summary: "The failures the kubelet produces while building a container: missing keys, bad image tags, probes that kill healthy apps, OOMKilled, quotas and LimitRanges."
estimated_minutes: 18
level: beginner
tags: [configmap, secret, image, probes, resources, oom, quota, limitrange]
builders: [deployment-basics, configmap-basics]
scenarios: [cm-missing-key, secret-not-found, image-tag-typo, liveness-wrong-path, oom-memory-limit, resourcequota-blocks-rollout, configmap-mount-wrong-key]
quiz:
  - q: "A Pod shows RESTARTS climbing, the application log is clean and Last State says Exit Code 137 with Reason Error (not OOMKilled). What is the most likely cause?"
    options: ["The memory limit is too low", "A liveness probe is failing and the kubelet kills the container", "The image tag does not exist", "A ResourceQuota blocks the Pod"]
    answer: 1
    explain: "OOM kills are labelled OOMKilled. A 137/143 with a quiet log and a Killing event mentioning the liveness probe means the kubelet, not the app, ended the process."
  - q: "You fix a typo in a ConfigMap key consumed through env.valueFrom. The Pod is still in CreateContainerConfigError. Why?"
    options: ["ConfigMaps are immutable", "The kubelet retries on its own; wait for the next sync and it will recover", "Env vars are only read at container creation, so the Pod must be recreated", "The Secret must be fixed too"]
    answer: 1
    explain: "The kubelet keeps retrying container creation with back-off; once the key exists the container starts. Only already-running containers never see env changes."
  - q: "A Deployment is stuck at 2/3 and the ReplicaSet shows the event 'Error creating: pods ... is forbidden: exceeded quota'. Which object do you inspect first?"
    options: ["The Pod", "The LimitRange", "kubectl describe quota -n <ns>", "The node's allocatable"]
    answer: 2
    explain: "The message names a ResourceQuota. describe quota shows used vs hard per resource and tells you whether to raise the quota, lower requests, or scale something else down."
---

# Config triage

Config failures sit between the scheduler and the running process. The Pod has
a node, so scheduling is not the problem; the **kubelet** is trying to build
the container and cannot, or builds it and then kills it. Every signal in this
chapter is produced by the kubelet and shows up in two places:
`kubectl describe pod` (State, Last State, Events) and `kubectl logs --previous`.

**Why it matters:** these are the most frequent failures in any cluster and
they all look alike from the outside (the app is down). The STATUS word and
the event reason tell them apart in seconds if you know what to read.

## The decision table

| Symptom (STATUS / event) | First command | Likely causes |
|---|---|---|
| `CreateContainerConfigError` | `kubectl describe pod` → Events | ConfigMap/Secret missing, key missing in `valueFrom` |
| `ContainerCreating` + `FailedMount` | `kubectl describe pod` → Events | volume ConfigMap/Secret missing, `items:` key absent |
| `ErrImagePull` → `ImagePullBackOff` | `kubectl describe pod` → `Failed to pull image` | tag typo, private registry, node cannot reach registry |
| `Running`, `0/1` READY, no restarts | `kubectl describe pod` → `Readiness probe failed` | wrong path/port, app slow to start |
| `Running`, RESTARTS climbing, `Killing` event | `kubectl logs --previous` | liveness probe wrong, app really crashing |
| `OOMKilled`, exit code 137 | `kubectl describe pod` → Last State | memory limit below real usage, leak |
| Running but slow, no restarts | `kubectl top pod` (metrics-server) | CPU limit throttling |
| `Evicted` | `kubectl describe pod` → Message | node pressure; BestEffort/Burstable evicted first |
| Deployment stuck, RS event `FailedCreate ... exceeded quota` | `kubectl describe quota -n <ns>` | ResourceQuota full, rollout surge needs headroom |
| `forbidden: maximum ... per Container is` | `kubectl get limitrange -n <ns> -o yaml` | LimitRange min/max/default conflicts with the Pod |

## ConfigMaps and Secrets

A container can consume a ConfigMap or Secret as **environment variables**
(`env.valueFrom`, `envFrom`) or as **files** (a volume). The failure signature
differs:

- Env reference broken → STATUS `CreateContainerConfigError`, event
  `Error: configmap "app-config" not found` or
  `Error: couldn't find key DATABASE_URL in ConfigMap lab-config/app-config`
  (same wording with `secret` / `Secret`).
- Volume reference broken → STATUS stays `ContainerCreating`, event
  `FailedMount`: `MountVolume.SetUp failed for volume "config" : configmap "app-config" not found`,
  or, when `items:` lists a key that does not exist,
  `references non-existent config key: nginx.conf`. After a couple of minutes
  you also get `Unable to attach or mount volumes: unmounted volumes=[config]`.

The kubelet keeps retrying with back-off; create or fix the object and the
Pod recovers by itself. Use `optional: true` only when the app can really
start without it.

**Gotcha:** a running container never sees an updated env var. Mounted files
are refreshed by the kubelet (roughly every minute), **except** `subPath`
mounts, which are copied once and never updated. If you changed a ConfigMap
and nothing happened, that is why. `kubectl rollout restart deploy/<name>`
is the honest fix.

**Try it:** compare what the Pod asks for with what the object holds.

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.containers[*].env[*].valueFrom}' | tr '}' '\n'
kubectl get cm <name> -n <ns> -o jsonpath='{.data}' | tr ',' '\n'
kubectl get secret <name> -n <ns> -o jsonpath='{.data}' | tr ',' '\n'    # values are base64
```

## Images

`ErrImagePull` is the first failed attempt; `ImagePullBackOff` is the kubelet
waiting (10 s, 20 s, 40 s... capped at 5 min) before trying again. Read the
`Failed to pull image` event to the end; the last clause is the cause:

- `... : not found` or `manifest unknown` → the tag does not exist (typo, or
  the tag was deleted). Check `kubectl get deploy -o jsonpath='{..image}'`.
- `pull access denied` / `unauthorized: authentication required` → private
  image without a valid `imagePullSecrets` entry on the Pod (or on the
  ServiceAccount).
- `dial tcp ... i/o timeout` / `no such host` → the **node** cannot reach the
  registry. Test from the node: `docker exec -it sre-labs-worker crictl pull nginx:1.27-alpine`.

`imagePullPolicy` defaults to `IfNotPresent`, except when the tag is `latest`
or absent, where it becomes `Always` and the registry is asked every time.

## Probes: who killed the container?

Three probes, three different consequences:

- **readiness** fails → the Pod is removed from Service endpoints. It is **not**
  restarted. You see `Running` with `0/1` READY and the event
  `Readiness probe failed: HTTP probe failed with statuscode: 404`.
- **liveness** fails → the kubelet kills the container (`Killing` event:
  `Container web failed liveness probe, will be restarted`) and the Pod
  enters a restart loop that ends in `CrashLoopBackOff`.
- **startup** fails → same kill, but the other two probes are paused until it
  succeeds. `failureThreshold × periodSeconds` is the maximum start-up time.

A liveness loop is easy to confuse with a crashing app. The difference: the
app log (`logs --previous`) stops mid-sentence with no error, and
`Last State` shows exit code 137 or 143 with `Reason: Error`, not `OOMKilled`.
Defaults are tight (`timeoutSeconds: 1`, `failureThreshold: 3`,
`periodSeconds: 10`): thirty seconds of slowness is enough to be killed.

**Gotcha:** a liveness probe that checks a dependency (database, downstream
API) turns one outage into a restart storm. Liveness should answer "is this
process stuck?", nothing more.

## Resources: OOMKilled, throttling, QoS

Memory limits are a hard ceiling enforced by the cgroup: exceed it and the
kernel kills the process. Signature: `Last State: Terminated`,
`Reason: OOMKilled`, `Exit Code: 137`. CPU limits do not kill; they
**throttle** (CFS quota), so the Pod stays `Running` but latency climbs and
`kubectl top pod` shows usage pinned at the limit.

The QoS class is derived from requests and limits and is a good proxy for who
the kubelet evicts first under node pressure (the kubelet actually ranks Pods by
usage above requests, then priority, then usage relative to requests):

- `Guaranteed`: requests equal limits for CPU and memory in every container.
- `Burstable`: at least one request or limit set.
- `BestEffort`: nothing set. Evicted first, scheduled anywhere.

An eviction is not an OOM kill: the Pod shows STATUS `Evicted` and
`describe` says `The node was low on resource: memory` (or
`ephemeral-storage`). See chapter 04 for the node side.

**Try it:** find the OOM kills and the biggest consumers in one go.

```bash
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}{end}' | grep OOMKilled
kubectl top pod -A --sort-by=memory | head        # needs the metrics-server addon
kubectl get pod <pod> -n <ns> -o jsonpath='{.status.qosClass}'
```

## Quotas and LimitRanges

Both act at **admission**, when a Pod is created, so the loud object is never
the Pod: it is the ReplicaSet (or Job) that failed to create it.

- **ResourceQuota** caps the sum per namespace. Signature on the ReplicaSet:
  `FailedCreate` with `Error creating: pods "api-..." is forbidden: exceeded quota: team-quota, requested: requests.cpu=20m, used: requests.cpu=40m, limited: requests.cpu=50m`.
  The Deployment shows condition `ReplicaFailure=True`. A quota that counts
  `requests.cpu` also **rejects** Pods that do not set a request
  (`must specify requests.cpu`).
- **LimitRange** sets defaults and bounds per container. It silently injects
  `limits` into Pods that have none (hello, unexpected `OOMKilled`) and rejects
  with `maximum memory usage per Container is 512Mi, but limit is 1Gi` or
  `minimum cpu usage per Container is 100m, but request is 50m`.

**Gotcha:** quotas bite during rollouts. With three replicas and `maxSurge: 1`
the new ReplicaSet needs room for a fourth Pod. If the quota is sized exactly
for three, the rollout hangs with the old version serving. Chapter 06 covers
the rollout side.

## k9s tip

`:pods` then `d` on the Pod shows State, Last State and Events together; `l`
opens the logs and `p` on the Pod (not inside the log view) opens the logs of
the previous instance.
`:events` with `/BackOff` or `/Failed` filters the noise. `:cm` and `:secrets`
with `y` show the keys; in the secret view `x` decodes the values. `:quota`
and `:limitrange` show the admission constraints of the namespace.

## Practice

- `cm-missing-key`: a Pod references a ConfigMap key that was renamed.
- `secret-not-found`: the Secret exists, but not where the Pod looks.
- `image-tag-typo`: `ImagePullBackOff` on a tag that never existed.
- `liveness-wrong-path`: a healthy app restarted every few seconds.
- `oom-memory-limit`: exit code 137 and a limit that was never measured.
- `resourcequota-blocks-rollout`: a scale-up stuck at two of five because the namespace quota is full.
- `configmap-mount-wrong-key`: a volume `items:` entry pointing at a key that is not there.

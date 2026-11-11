---
title: "The troubleshooting loop: observe, hypothesise, test, fix, prevent"
slug: method
realm: troubleshooting
order: 1
summary: "A repeatable method for any Kubernetes incident, and the five commands you run before you think."
estimated_minutes: 12
level: beginner
tags: [method, triage, kubectl, events]
builders: []
scenarios: [svc-selector-mismatch]
quiz:
  - q: "A Pod is in CrashLoopBackOff. Which command shows what the previous container instance printed before it died?"
    options: ["kubectl describe pod", "kubectl logs --previous", "kubectl get events", "kubectl top pod"]
    answer: 1
    explain: "--previous reads the log of the last terminated container; describe shows the exit code and reason but not the application output."
  - q: "What is the first thing to establish when a user reports 'the service is down'?"
    options: ["Which node the Pod runs on", "The blast radius: who and what is affected, since when", "The container image version", "Whether etcd is healthy"]
    answer: 1
    explain: "Scope first. It decides priority and usually points at the layer that broke."
---

# The troubleshooting loop

Kubernetes failures look chaotic because the system is made of independent
controllers that each react to the same desired state. The trick is to stop
guessing and walk the layers in order. The loop below is what you will apply in
every scenario of this lab.

## 1. Observe: establish the blast radius

Before touching anything, answer three questions:

- **Who is affected?** One Pod, one Service, one namespace, one node, or the
  whole cluster? The answer tells you which layer to open.
- **Since when?** `kubectl get events -A --sort-by=.lastTimestamp | tail -30`
  shows what the controllers were doing in the last minutes.
- **What changed?** Deployments, ConfigMaps, nodes, Flux reconciliations.
  `kubectl rollout history`, `flux get all -A`, `kubectl get nodes` are the
  usual suspects.

**Try it:** these five commands cover most first minutes of an incident.

```bash
kubectl get nodes -o wide
kubectl get pods -A | grep -vE 'Running|Completed' | head -40   # by STATUS word: CrashLoopBackOff and friends keep phase Running, so do not filter on phase
kubectl get events -A --sort-by=.lastTimestamp | tail -30
kubectl describe pod <pod> -n <ns>        # look at State, Last State, Events
kubectl logs <pod> -n <ns> --previous      # the output of the crashed instance
```

## 2. Hypothesise: pick the layer

Map the symptom to a layer and you will know what to inspect:

| Symptom | Layer | First look |
|---|---|---|
| Pod `Pending` | Scheduling | `describe pod` Events: Insufficient cpu, taints, affinity, PVC |
| `ImagePullBackOff` / `ErrImagePull` | Image/registry | tag, registry auth, network from node |
| `CreateContainerConfigError` | Config | missing ConfigMap/Secret key |
| `CrashLoopBackOff` | Application / config | `logs --previous`, exit code, probes |
| `OOMKilled` | Resources | limits vs actual usage, `kubectl top` |
| Running but no traffic | Service / network | endpoints, selector, targetPort, NetworkPolicy, DNS |
| Node `NotReady` | Node | kubelet, container runtime, disk/memory pressure |
| Nothing gets scheduled or created | Control plane | scheduler, controller-manager, apiserver static pods |

**Why it matters:** each layer is owned by a different component. A symptom
at layer N is produced by the component at layer N, but often *caused* by
layer N-1. The table gives you the component to question first.

## 3. Test: one change, one observation

Make the smallest experiment that confirms or rejects the hypothesis. Prefer
read-only tests:

- `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` proves whether a Service selects anything.
- `kubectl run tmp --rm -it --image=curlimages/curl:8.10.1 -- curl -sv http://svc:port` tests the path from inside the cluster.
- `kubectl auth can-i --as=system:serviceaccount:<ns>:<sa> list pods` tests RBAC without deploying anything.
- `kubectl debug node/<node> -it --image=busybox` opens a shell on a node (host namespaces, node filesystem at `/host`).

**Gotcha:** `kubectl exec` into a running Pod changes nothing, but
`kubectl edit` does. Edit only when the test confirmed the hypothesis.

## 4. Fix: the smallest reversible change

Fix the object that is wrong, not the object that is loud. In the
*Service has no endpoints* scenario the Pods are the loud part (users see
errors) but the Service is the wrong part. Patch the Service; do not relabel
Pods owned by someone else.

Record what you did. In the lab, the checker verifies both that the symptom is
gone and that you did not break the contract (for example, that Pods keep their
labels).

## 5. Prevent: close the loop

Every fix should produce one of:

- an **alert** (an SLO burn or a kube-state-metrics signal),
- a **policy** (a Kyverno/Gatekeeper rule or an admission check),
- a **test** (a conformance check in CI, `kubeconform`, a smoke test), or
- a **template change** so that the mistake cannot be typed again.

The solution pages of every scenario end with a *Prevention* section for this
reason. Get in the habit of writing it.

## Where to go next

Run the first scenario, **Service has no endpoints**, with the method above.
Then read the chapters on network, config, node and cluster triage; each one
lists the specific signals of its layer and the scenarios to practice on.

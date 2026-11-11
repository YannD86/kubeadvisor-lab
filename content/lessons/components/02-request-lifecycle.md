---
title: "Request lifecycle: from kubectl apply to a running container"
slug: request-lifecycle
realm: components
order: 2
summary: "Follow one write through authentication, authorization, admission, etcd, watches, controllers, the scheduler and the kubelet, and see why 'desired versus observed' is the whole model."
estimated_minutes: 18
level: beginner
tags: [apiserver, admission, rbac, controllers, scheduler, kubelet, reconciliation]
builders: [deployment-basics]
scenarios: []
diagram: request-lifecycle
quiz:
  - q: "In which order does the API server process a write?"
    options: ["authz, authn, validation, admission", "authn, authz, mutating admission, schema validation, validating admission, etcd write", "schema validation, authn, authz, admission", "admission webhooks, authn, authz, etcd write"]
    answer: 1
    explain: "Identity first (who), then permission (may they), then mutation (defaults, injected fields), then the object is checked against its schema, then validating admission gets the final shape, and only then is it persisted."
  - q: "`kubectl apply` of a Deployment returns successfully but the Pods are Pending. What did the API server promise you?"
    options: ["That the containers are running", "That the image exists", "Only that the desired state was recorded in etcd", "That the scheduler accepted the Pods"]
    answer: 2
    explain: "The request ends at the etcd write. Everything after it is asynchronous reconciliation by other components reacting to watch events."
  - q: "Which component sets spec.nodeName on a Pod?"
    options: ["kubelet", "kube-controller-manager", "kube-scheduler, through the pods/binding subresource", "kubectl"]
    answer: 2
    explain: "The scheduler watches Pods with an empty nodeName, picks a node and POSTs a Binding; the API server copies the target into spec.nodeName. The kubelet only starts Pods whose nodeName is its own."
---

# Request lifecycle

`kubectl apply -f deploy.yaml` returns in under a second. Thirty seconds
later, three containers are serving traffic on two nodes. Nothing in between
was a direct call. This lesson walks the chain so that, when it stalls, you
know which link to look at.

## Stage 1: the API server handles the request

Only the first stage is synchronous. `kubectl` reads your kubeconfig, builds
an HTTPS request to the `server` it names (kind publishes the control-plane
container's port 6443 on a localhost port) and sends the object. With `-v=7` you can
see the verbs and status codes. Inside the API server the request passes a
fixed pipeline.

| Step | Question answered | In this lab |
|---|---|---|
| Authentication | Who are you? | Your client certificate from `admin.conf`: `CN=kubernetes-admin`, group `kubeadm:cluster-admins`. Pods use projected ServiceAccount tokens. |
| Authorization | May you do this verb on this resource? | `--authorization-mode=Node,RBAC`. Test with `kubectl auth can-i`. |
| Mutating admission | What should be filled in? | `ServiceAccount` injects the token volume, `LimitRanger` adds default requests, `DefaultTolerationSeconds` adds the 300 s not-ready tolerations, mutating webhooks run last. |
| Schema validation | Is the object well-formed? | OpenAPI schema of `apps/v1 Deployment`; unknown fields are rejected (strict field validation). |
| Validating admission | Is it allowed in its final shape? | `NodeRestriction`, `ResourceQuota`, `PodSecurity`, `ValidatingAdmissionPolicy`, validating webhooks. |
| Persist | Write it | Serialised to protobuf at `/registry/deployments/<ns>/<name>` in etcd; `resourceVersion` is the etcd revision. |

**Why it matters:** the ordering explains several everyday surprises.
Built-in mutating plugins (`LimitRanger`, `ServiceAccount`,
`DefaultTolerationSeconds`) run before mutating webhooks, which run before
every validating step, so a validating webhook sees the final object,
including other webhooks' mutations. RBAC denial comes back as `403 Forbidden`
before any admission plugin runs, so a quota error proves your credentials
work. And `resourceVersion` is why concurrent edits fail with `409 Conflict`:
the write carries the version you read, and etcd refuses if it moved.

**Gotcha:** the request is finished when etcd acknowledges the write. The
`200`/`201` you get back means "desired state recorded", nothing more. Every
later failure, from `ImagePullBackOff` to `Pending`, is invisible to the
`apply` call.

## Stage 2: watches fan the change out

Every control-plane component and every kubelet holds long-lived `watch`
connections to the API server. The API server keeps a watch cache per
resource and streams `ADDED`, `MODIFIED`, `DELETED` events the moment etcd
confirms a write. Nobody polls, nobody is called. You can see the raw stream
yourself with `kubectl get pods -w --output-watch-events`.

## Stage 3: controllers build the children

1. The **deployment controller** sees a Deployment with no matching
   ReplicaSet and creates one, copying the Pod template and adding a
   `pod-template-hash` label.
2. The **replicaset controller** sees a ReplicaSet with `replicas: 3` and
   zero Pods and creates three Pod objects, each with an `ownerReference`
   back to the ReplicaSet and an empty `spec.nodeName`.

Each of these is itself a full request through Stage 1, authenticated as
`system:serviceaccount:kube-system:replicaset-controller` and so on. The
controllers run inside kube-controller-manager; the next lessons cover how.

## Stage 4: the scheduler binds

The scheduler watches Pods whose `nodeName` is empty. For each one it filters
nodes (enough allocatable CPU and memory for the *requests*, tolerated taints,
matching affinity), scores the survivors and POSTs a `Binding` to the
`pods/<name>/binding` subresource. The API server writes `spec.nodeName`.
That is the entire interaction: the scheduler never contacts a node.

## Stage 5: the kubelet makes it real

The kubelet on `sre-labs-worker` watches Pods with
`spec.nodeName=sre-labs-worker`. For a new Pod it calls containerd over the
CRI socket: `RunPodSandbox` (which starts the `pause` container and triggers
the CNI `ADD` that assigns the Pod IP), `PullImage`, `CreateContainer`,
`StartContainer`. It then owns the Pod's probes and restarts.

## Stage 6: status flows back

The kubelet PATCHes `pod.status`: phase, `podIP`, container states,
`Ready` condition. The endpointslice controller sees a Ready Pod matching a
Service selector and writes an EndpointSlice; kube-proxy on every node sees
the slice and programs the kernel. The replicaset controller counts ready
Pods and updates `status.readyReplicas`; the deployment controller marks the
rollout complete. Only now does `kubectl rollout status` return.

**Try it:** create a Deployment and read the trail each component left.

```bash
kubectl create deployment hello --image=nginx:1.27-alpine --replicas=2 -v=7 2>&1 | grep -E 'POST|Response Status'
kubectl get deploy,rs,pods -l app=hello -o wide
kubectl get events --sort-by=.lastTimestamp -o wide | grep hello | tail -8      # SOURCE column: who did what
kubectl get rs -l app=hello -o jsonpath='{.items[0].metadata.ownerReferences[0].kind}{"\n"}'
kubectl get pods -l app=hello -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP,RV:.metadata.resourceVersion'
kubectl auth can-i create pods --as=system:serviceaccount:default:default    # RBAC check, no admission involved
kubectl delete deployment hello
```

In the events you will read, in order: `ScalingReplicaSet` from
`deployment-controller`, `SuccessfulCreate` from `replicaset-controller`,
`Scheduled` from `default-scheduler`, then `Pulling`, `Pulled`, `Created`,
`Started` from `kubelet`. That list is Stages 3 to 5, signed.

## Desired versus observed is the whole model

Every object has a `spec` you write and a `status` someone else writes. No
component executes your request; each one compares the `spec` it cares about
with the world it can see and takes one step toward closing the gap, then
looks again. The pattern is *level-triggered*: a controller that restarts
mid-way, or misses ten events, still converges, because it reasons about
state rather than about commands.

**Why it matters:** this is why the troubleshooting method in the other
realm walks layers. A stuck rollout is a gap between a `spec` and a `status`,
and the question is always *which component should be closing this gap, and
why is it not*. `Pending` with no events points at the scheduler.
`Scheduled` but no `Pulling` points at the kubelet on that node. Pods Ready
but no endpoints points at the endpointslice controller or the Service
selector. The `deployment-basics` builder shows the Deployment side of this
contract; the rest of this realm shows the component side.

**Gotcha:** because the chain is asynchronous, "it worked" in CI means only
that Stage 1 succeeded. Gate on `kubectl rollout status --timeout` or on the
`Available` condition, never on the exit code of `apply`.

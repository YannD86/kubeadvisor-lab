---
title: "Storage and RBAC triage: Pending claims, failed mounts and 403s"
slug: storage-and-rbac-triage
realm: troubleshooting
order: 7
summary: "Why a PVC stays Pending and what the provisioner needs, access modes and mount errors, then RBAC: reading a 403, kubectl auth can-i --as, ServiceAccount tokens and the binding mistakes everybody makes once."
estimated_minutes: 20
level: intermediate
tags: [pvc, storageclass, local-path, volumes, rbac, serviceaccount, rolebinding, auth]
builders: [deployment-basics]
scenarios: [pvc-pending-storageclass, rbac-forbidden-list-pods]
quiz:
  - q: "A PVC in the kind lab shows 'waiting for first consumer to be created before binding'. What should you do?"
    options: ["Create a PV by hand", "Nothing yet: the standard class uses WaitForFirstConsumer; it binds when a Pod uses the claim", "Change storageClassName", "Restart local-path-provisioner"]
    answer: 1
    explain: "WaitForFirstConsumer delays provisioning until the scheduler picks a node, so a local volume lands where the Pod runs. Pending without a consumer is the designed state."
  - q: "kubectl, run from inside a Pod, prints 'User \"system:anonymous\" cannot list resource \"pods\"'. Where is the problem?"
    options: ["The Role lacks the list verb", "The RoleBinding is in the wrong namespace", "No credentials were presented: the ServiceAccount token is not mounted or not sent", "The ClusterRole is not aggregated"]
    answer: 2
    explain: "anonymous means authentication produced no identity. Fix the token (automountServiceAccountToken, the kubeconfig in use) before touching any Role."
  - q: "A RoleBinding in lab-rbac references Role pod-reader, but the Role was created in default. What happens?"
    options: ["The API server rejects the binding", "The binding is accepted and grants nothing; the subject gets 403", "The Role is copied into lab-rbac", "The binding grants cluster-wide access"]
    answer: 1
    explain: "roleRef is resolved by name in the binding's namespace and is never validated against existing Roles. A dangling roleRef is silent."
---

# Storage and RBAC triage

Two domains that share one trait: the loud object (a Pod that will not start,
a `kubectl` command that fails) is several hops away from the wrong object (a
StorageClass name, a subject's namespace). Both are solved by reading the
message to the end, then checking the chain link by link.

## The decision table

| Symptom | First command | Likely causes |
|---|---|---|
| PVC `Pending`, event `storageclass ... not found` | `kubectl get sc` | class name typo, class not installed |
| PVC `Pending`, `waiting for first consumer` | `kubectl get pods -n <ns>` | normal until a Pod uses it (WaitForFirstConsumer) |
| PVC `Pending`, `no persistent volumes available ... no storage class is set` | `kubectl get pv` | `storageClassName: ""`, no default class, no PV matching size/modes |
| PVC `Pending`, `waiting for a volume to be created ... external provisioner` | `kubectl -n local-path-storage logs deploy/local-path-provisioner` | provisioner down or misconfigured |
| Pod `Pending`, `pod has unbound immediate PersistentVolumeClaims` | `kubectl describe pvc -n <ns>` | the PVC above |
| Pod `Pending`, `volume node affinity conflict` | `kubectl get pv <pv> -o jsonpath='{.spec.nodeAffinity}'` | local volume lives on another node |
| Pod `ContainerCreating`, `FailedMount` / `Multi-Attach error` | `kubectl describe pod` → Events | RWO volume used by a Pod on another node, wrong claim name |
| `spec is immutable after creation` on apply | `kubectl get pvc -o yaml` | changed `storageClassName`/`accessModes`; recreate the claim |
| `Error from server (Forbidden)` (403) | `kubectl auth can-i <verb> <resource> --as=<subject> -n <ns>` | missing Role rule, binding in wrong namespace, wrong subject |
| `You must be logged in to the server (Unauthorized)` (401) | `kubectl auth whoami` | expired/invalid token, wrong kubeconfig context |
| `User "system:anonymous"` in a 403 | `kubectl get pod -o jsonpath='{.spec.automountServiceAccountToken}'` | no token presented |
| Binding edit fails with `cannot change roleRef` | `kubectl delete rolebinding` then recreate | `roleRef` is immutable by design |

## Storage: the binding chain

A Pod references a **PVC**; the PVC must be `Bound` to a **PV**; the PV is
either created by a provisioner named in a **StorageClass** (dynamic) or
pre-created by an administrator (static). `kubectl describe pvc` is the
single most useful command: the Events section says exactly which link is
missing.

In the kind lab there is one class, `standard`, marked default, provisioner
`rancher.io/local-path`, `volumeBindingMode: WaitForFirstConsumer`,
`reclaimPolicy: Delete`. The provisioner runs as a Deployment in
`local-path-storage` and creates a directory under
`/var/local-path-provisioner/` on the node where the Pod is scheduled. The
resulting PV carries a `nodeAffinity` for that node: the Pod is pinned there
for life, and a Pod that must run elsewhere gets
`1 node(s) had volume node affinity conflict`.

**Gotcha:** omitting `storageClassName` and setting it to `""` are different
requests. Omitted means "use the default class" (injected at admission);
empty string means "no dynamic provisioning, match me a static PV", and the
claim waits forever with
`no persistent volumes available for this claim and no storage class is set`.

**Try it:** the three listings that show the whole chain at once.

```bash
kubectl get sc
kubectl get pvc -A
kubectl get pv -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,CLAIM-NS:.spec.claimRef.namespace,CLAIM:.spec.claimRef.name,SC:.spec.storageClassName,MODES:.spec.accessModes,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]
kubectl describe pvc <name> -n <ns> | sed -n '/Events/,$p'
```

A PV in `Released` keeps its `claimRef` to the deleted PVC and will not bind
again until you clear it (`kubectl patch pv <pv> -p '{"spec":{"claimRef":null}}'`),
which is the trade-off of `reclaimPolicy: Retain`.

## Access modes and immutability

`ReadWriteOnce` means one **node**, not one Pod: two Pods on the same node
can share it, two Pods on different nodes get `Multi-Attach error for volume`
or the affinity conflict above. `ReadWriteMany` needs a backend that supports
it (NFS, a CSI driver); local-path does not, and a RWX claim never matches a
RWO volume. `ReadWriteOncePod` locks the volume to a single Pod.

Almost everything in a PVC spec is immutable once created:
`storageClassName`, `accessModes`, `volumeMode`, `volumeName`. Only
`resources.requests.storage` may grow, and only when the class has
`allowVolumeExpansion: true`. The error is
`spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims`
(followed by a diff of what you tried to change).
The fix is delete and recreate, which deletes the data under a `Delete`
reclaim policy: copy first, or set the PV to `Retain` before deleting the
claim. For a StatefulSet, `volumeClaimTemplates` is immutable too; create the
PVC by hand with the exact `<claim>-<sts>-<ordinal>` name before the Pod
needs it.

## RBAC: four coordinates in every 403

Authorization is `subject → binding → role → rule`. A **Role** is
namespaced, a **ClusterRole** is not; a **RoleBinding** grants a Role or a
ClusterRole **inside its own namespace**, a **ClusterRoleBinding** grants a
ClusterRole everywhere. Binding the built-in `view`, `edit` and `admin`
ClusterRoles through a RoleBinding is the normal way to give namespace
access.

A 403 hands you everything you need:

```
Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:lab-rbac:pod-watcher"
cannot list resource "pods" in API group "" in the namespace "lab-rbac"
```

Subject, verb, resource with API group, namespace. Reproduce it without
deploying anything, then enumerate what the subject *can* do:

```bash
kubectl auth can-i list pods --as=system:serviceaccount:lab-rbac:pod-watcher -n lab-rbac
kubectl auth can-i --list --as=system:serviceaccount:lab-rbac:pod-watcher -n lab-rbac
kubectl get rolebindings,clusterrolebindings -A -o wide | grep -E 'pod-watcher|ROLE'
kubectl describe role pod-reader -n lab-rbac
```

**Why it matters:** `kubectl get pods` is a `list`, `kubectl get pod web` is
a `get`, k9s and controllers also need `watch`, `kubectl logs` is `get` on
the subresource `pods/log`, and `exec` is `create` on `pods/exec`. The
verb in the 403 must appear in a rule for that exact resource and API group
(`deployments` live in `apps`, `ingresses` in `networking.k8s.io`, Pods in
`""`).

## 401 vs 403, and tokens

**401 Unauthorized** means authentication failed: the token is invalid or
expired, or the kubeconfig points at the wrong cluster. **403 Forbidden**
means the identity is known and has no rule. A 403 naming
`system:anonymous` is a 401 in disguise: no credential was presented, and
the cause is in the Pod (`automountServiceAccountToken: false`, a custom
`serviceAccountName` that does not exist, a kubeconfig that ignores the
mounted token at `/var/run/secrets/kubernetes.io/serviceaccount/token`).

Since 1.24 ServiceAccounts no longer get a long-lived Secret; Pods receive a
projected, time-bound token and `kubectl create token pod-watcher -n lab-rbac`
mints one for tests. `kubectl auth whoami` shows the identity your current
credentials resolve to.

## Binding mistakes, ranked by frequency

1. **Subject namespace**: a ServiceAccount subject must name the namespace
   where the ServiceAccount **lives**. In a RoleBinding an omitted namespace
   defaults to the binding's namespace, so copying a subject from another
   namespace silently points at a non-existent account.
2. **Binding namespace**: `roleRef` is resolved by name in the binding's
   namespace and never validated. A Role created in `default` and a binding
   in `lab-rbac` produce a binding that grants nothing.
3. **Role vs ClusterRole**: a ClusterRoleBinding cannot reference a Role
   (`roleRef.kind: Unsupported value: "Role"`); a Role cannot grant
   cluster-scoped resources such as `nodes` or `namespaces` list.
4. **Immutable roleRef**: changing it gives `cannot change roleRef`; delete
   and recreate the binding.
5. **Aggregated ClusterRoles**: `view`, `edit` and `admin` are assembled by
   the controller-manager from ClusterRoles labelled
   `rbac.authorization.k8s.io/aggregate-to-view: "true"` and similar. Editing
   their `rules` directly is overwritten on the next sync; add a labelled
   ClusterRole instead, which is also how CRDs join them.

## k9s tip

`:pvc` and `:pv` show STATUS and the bound pair side by side; `:sc` shows the
default marker and binding mode. `:sa`, `:role`, `:rolebinding`,
`:clusterrolebinding` list the chain, and `Enter` on a Role or ClusterRole
prints its rules as a table. When k9s itself shows empty views with a red
`Forbidden` toast, your own identity is the subject to test with
`kubectl auth can-i --list`.

## Practice

- `pvc-pending-storageclass`: a claim that waits for a class nobody installed.
- `rbac-forbidden-list-pods`: a pod-watcher ServiceAccount that cannot list what it was given.

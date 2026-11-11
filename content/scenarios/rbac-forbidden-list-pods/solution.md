## Diagnosis

A 403 from the API server is never vague: the body says who was refused,
which verb, which resource, where.

```bash
kubectl logs -n lab-rbac deploy/pod-watcher --tail=4
# 14:02:11 GET /api/v1/namespaces/lab-rbac/pods -> HTTP 403
#   pods is forbidden: User "system:serviceaccount:lab-rbac:pod-watcher" cannot list resource "pods" in API group "" in the namespace "lab-rbac"
```

So RBAC is on, the token is valid (otherwise it would be 401), and the
identity is `system:serviceaccount:lab-rbac:pod-watcher`. Reproduce the
decision without the Pod:

```bash
kubectl auth can-i list pods -n lab-rbac --as=system:serviceaccount:lab-rbac:pod-watcher
# no
```

Now walk the chain link by link:

```bash
kubectl get sa -n lab-rbac
# NAME          SECRETS   AGE
# default       0         5m
# pod-watcher   0         5m
kubectl describe role pod-reader -n lab-rbac | tail -n 3
#   Resources  Non-Resource URLs  Resource Names  Verbs
#   pods       []                 []              [get list watch]      <-- rules are fine
kubectl describe rolebinding pod-watcher-binding -n lab-rbac
# Role:
#   Kind:  Role
#   Name:  pod-reader
# Subjects:
#   Kind            Name            Namespace
#   ServiceAccount  pod-watcher-sa  lab-rbac                                <-- no such SA
```

The Role is correct and the binding points at the right Role, but its
subject is `pod-watcher-sa`, a ServiceAccount that does not exist. The
actual identity, `pod-watcher`, is bound to nothing.

## Root cause

A RoleBinding with a misspelt subject. Kubernetes accepts bindings to
subjects that do not exist (they may be created later), so nothing failed at
apply time; the grant simply applies to nobody. Every call made with the
real ServiceAccount is evaluated against zero rules and refused.

The sibling mistake is a Role that grants `get` but not `list`: `get` is for
a single named object, `list` for the collection the watcher polls. The
403 body tells you which verb is missing.

## Fix

Repair the subject; the Role and the Deployment are fine:

```bash
kubectl patch rolebinding pod-watcher-binding -n lab-rbac --type=json -p '[
  {"op":"replace","path":"/subjects/0/name","value":"pod-watcher"}
]'
kubectl auth can-i list pods -n lab-rbac --as=system:serviceaccount:lab-rbac:pod-watcher
# yes
kubectl logs -n lab-rbac deploy/pod-watcher --tail=1      # within 10s
# 14:05:31 GET /api/v1/namespaces/lab-rbac/pods -> HTTP 200
```

RBAC changes take effect immediately, no restart needed. Resist the
"just bind cluster-admin" shortcut: it would make a read-only poller able
to delete anything in the cluster.

## Prevention

- Review rule: every RoleBinding subject must reference an existing
  ServiceAccount; a CI step with `kubectl auth can-i --as=system:serviceaccount:<ns>:<sa>`
  for each permission the workload needs catches both the subject typo and
  the missing verb.
- Alert on `apiserver_request_total{code="403"}` by user and namespace;
  a steady 403 rate from one ServiceAccount is a broken binding, not an attack.
- Generate SA, Role and RoleBinding from one template (Helm/Kustomize) so
  the name is written once; audit periodically for bindings to non-existent
  subjects and for ClusterRoleBindings to `cluster-admin`.

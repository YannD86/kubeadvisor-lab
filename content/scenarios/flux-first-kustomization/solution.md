## Diagnosis

This is a build, so "diagnosis" means reading the brief as a specification
and mapping it onto Flux objects:

| Requirement | Flux object | Controller |
|---|---|---|
| "pull the repository every 30s, branch main" | `GitRepository` (source) | source-controller |
| "apply `deploy/podinfo`, prune, wait for health" | `Kustomization` | kustomize-controller |

Check what you start from:

```bash
kubectl get ns lab-flux1 lab-podinfo        # lab-flux1 exists, lab-podinfo does not (yet)
kubectl get gitrepositories,kustomizations -n lab-flux1   # No resources found
git clone http://lab:labpass123@localhost:30080/lab/flux-first-kustomization.git
tree flux-first-kustomization/deploy        # namespace.yaml deployment.yaml service.yaml kustomization.yaml
```

Note that the Namespace is part of the Git content: Flux will create
`lab-podinfo` for you, the Kustomization only needs a place to live (`lab-flux1`).

## Root cause

What each object does in the chain:

- **GitRepository** (`source.toolkit.fluxcd.io/v1`): source-controller clones
  the branch at `spec.interval`, packages the tree into a tarball served from
  its own HTTP endpoint and publishes the revision (`main@sha1:...`) in
  `status.artifact`. It never applies anything.
- **Kustomization** (`kustomize.toolkit.fluxcd.io/v1`): kustomize-controller
  watches the source's artifact, runs `kustomize build` on `spec.path`,
  server-side-applies the result, labels every object with
  `kustomize.toolkit.fluxcd.io/name|namespace`, prunes what disappeared from
  Git (`prune: true`) and, with `wait: true`, holds `Ready` until every applied
  object reports healthy (kstatus).

## Fix

Generate the manifests with the CLI (`--export` prints, it does not apply),
review them, apply them:

```bash
flux create source git podinfo -n lab-flux1 \
  --url=http://gitea.lab-gitea.svc.cluster.local:3000/lab/flux-first-kustomization.git \
  --branch=main --interval=30s --export > gitrepository.yaml

flux create kustomization podinfo -n lab-flux1 \
  --source=GitRepository/podinfo --path=./deploy/podinfo \
  --prune=true --wait=true --interval=1m --export > kustomization.yaml

kubectl apply -f gitrepository.yaml -f kustomization.yaml
```

The equivalent hand-written YAML:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: podinfo
  namespace: lab-flux1
spec:
  interval: 30s
  url: http://gitea.lab-gitea.svc.cluster.local:3000/lab/flux-first-kustomization.git
  ref:
    branch: main
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: podinfo
  namespace: lab-flux1
spec:
  interval: 1m
  timeout: 2m
  sourceRef:
    kind: GitRepository
    name: podinfo
  path: ./deploy/podinfo
  prune: true
  wait: true
```

No secret is needed: the Gitea repository is public and the URL is plain HTTP
inside the cluster.

Verify the chain end to end:

```bash
flux get sources git -n lab-flux1
# NAME     REVISION            SUSPENDED  READY  MESSAGE
# podinfo  main@sha1:3f2c...   False      True   stored artifact for revision 'main@sha1:3f2c...'
flux get kustomizations -n lab-flux1
# podinfo  main@sha1:3f2c...   False      True   Applied revision: main@sha1:3f2c...
kubectl get deploy,svc -n lab-podinfo
kubectl get deploy -n lab-podinfo podinfo -o jsonpath='{.metadata.labels}'
# {"app":"podinfo","kustomize.toolkit.fluxcd.io/name":"podinfo","kustomize.toolkit.fluxcd.io/namespace":"lab-flux1"}
```

Prove that Git is now the source of truth: `kubectl scale deploy podinfo -n lab-podinfo --replicas=5`,
wait one interval, and watch Flux put it back to 2.

## Prevention

Going further, what a team would add around this:

- Keep the Flux objects themselves in Git too (a `clusters/<name>/` directory
  reconciled by a bootstrap Kustomization) so the GitRepository and
  Kustomization you just typed are not the next piece of hand-applied drift.
- Set `spec.timeout` explicitly when `wait: true`; the default (the interval)
  is often shorter than an image pull on a cold node.
- Alert on `gotk_resource_info{ready="False"}` (the Flux custom-resource
  metrics collected by kube-state-metrics; the controllers themselves do not
  export a Ready metric), and wire the notification-controller to Slack so a
  broken revision is seen before a user reports it.
- Protect the application namespace with an admission policy (Kyverno/Gatekeeper)
  that rejects writes whose manager is not `kustomize-controller`.

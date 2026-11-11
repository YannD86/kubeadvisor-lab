## Diagnosis

Split the GitOps pipeline in two and check each half. The source first:

```bash
flux get sources git -n lab-path
# NAME     REVISION            SUSPENDED  READY  MESSAGE
# podinfo  main@sha1:9a1e...   False      True   stored artifact for revision 'main@sha1:9a1e...'
```

source-controller cloned the repository and stored an artifact: Git access,
branch and URL are fine. Now the consumer:

```bash
kubectl get kustomization podinfo -n lab-path -o yaml | yq '.spec.path, .status.conditions'
# ./deploy/prod
# - type: Ready
#   status: "False"
#   reason: ArtifactFailed
#   message: 'kustomization path not found: stat /tmp/kustomization-2381170524/deploy/prod: no such file or directory'
```

The controller extracted the artifact to a temp directory and looked for
`deploy/prod` inside it. Compare with the repository:

```bash
git clone http://lab:labpass123@localhost:30080/lab/flux-kustomization-wrong-path.git
find flux-kustomization-wrong-path -name kustomization.yaml
# flux-kustomization-wrong-path/deploy/production/kustomization.yaml
```

`deploy/production` exists; `deploy/prod` does not.

## Root cause

`spec.path` of the Kustomization (`./deploy/prod`) does not match the
directory committed in Git (`./deploy/production`). Nothing was ever applied:
the controller fails before `kustomize build`, so there is no Deployment, no
Namespace, and no partial state to clean up. The GitRepository is innocent:
a source only proves that the tree was fetched, not that a given path exists
in it.

## Fix

Change the path on the Kustomization only (the GitRepository is shared):

```bash
kubectl patch kustomization podinfo -n lab-path --type merge \
  -p '{"spec":{"path":"./deploy/production"}}'
# or: kubectl edit kustomization podinfo -n lab-path

flux reconcile kustomization podinfo -n lab-path   # optional, the spec change already triggers one
flux get kustomizations -n lab-path
# podinfo  main@sha1:9a1e...  False  True  Applied revision: main@sha1:9a1e...
kubectl get deploy -n lab-prod podinfo    # 2/2 after the image pull
```

In a real setup the Kustomization itself would be in Git; the same one-line
change would then be a commit to the cluster repository, not a `kubectl patch`.

## Prevention

- Validate before pushing: `kustomize build ./deploy/production` in CI, and
  `flux build kustomization podinfo --path ./deploy/production` renders exactly
  what the controller would apply.
- Keep paths and directory names boring and consistent across repositories
  (`deploy/<env>`), and reference them from a single place (a `clusters/<env>/`
  Kustomization) rather than retyping them.
- Alert on `gotk_resource_info{customresource_kind="Kustomization",ready="False"} == 1`
  (kube-state-metrics custom-resource metrics, see the Flux monitoring docs)
  for more than 5 minutes; a Kustomization that has never been Ready is a
  deploy that silently never happened.
- Use `flux check` and `flux get all -A` as the first two commands of any
  GitOps incident: they tell you in one screen which half of the pipeline is broken.

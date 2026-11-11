---
title: "HelmRelease with Flux: helm-controller end to end"
slug: helmrelease-with-flux
realm: gitops
order: 7
summary: "HelmRepository plus HelmRelease: version ranges, values and valuesFrom, install/upgrade remediation, drift detection, how to read the conditions, and the failures you will actually meet."
estimated_minutes: 18
level: intermediate
tags: [flux, helm-controller, helmrelease, helmrepository, remediation, drift]
builders: [flux-helmrepository, flux-helmrelease]
scenarios: [flux-helmrelease-values-error]
quiz:
  - q: "A HelmRelease install failed and `install.remediation.retries` is 0 (the default). What does helm-controller do at the next interval?"
    options: ["Retries the install with the same chart and values", "Nothing: it stays Ready=False (reason InstallFailed) with Stalled=True (reason RetriesExceeded, 'Failed to install after 1 attempt(s)') until the chart version or values change, or you run flux reconcile hr --reset", "Uninstalls the release", "Rolls back"]
    answer: 1
    explain: "helm-controller does not re-run an identical failed action forever. New inputs (a chart revision or a values digest) or an explicit --reset restart the attempt counter."
  - q: "Two sources set the same value: `spec.values` and a ConfigMap in `spec.valuesFrom`. Which wins?"
    options: ["valuesFrom, because it is more specific", "spec.values, which is merged last", "The chart default", "helm-controller refuses the HelmRelease"]
    answer: 1
    explain: "Merge order is chart defaults, then valuesFrom entries in list order, then spec.values. Later wins."
  - q: "A HelmRelease is Ready=False with 'field is immutable' on a Deployment selector after a chart upgrade. What fixes it?"
    options: ["upgrade.remediation.retries: 5", "Set driftDetection.mode: enabled", "Delete the Deployment (or the release) so the next reconcile recreates it with the new selector", "Bump spec.interval"]
    answer: 2
    explain: "Immutable fields cannot be patched or replaced in place. Only a recreate works, and Helm does not do that for you."
---

# HelmRelease with Flux

helm-controller runs the Helm lifecycle from lesson 5 as a reconciliation
loop. Two objects are involved, plus one the controller creates for you.

```text
HelmRepository ──► (source-controller) ──► HelmChart artifact ──► HelmRelease ──► Helm install/upgrade
   (where)                                   (the .tgz)           (what, with which values, how to recover)
```

When you create a HelmRelease, helm-controller asks source-controller for
a `HelmChart` named `<hr-namespace>-<hr-name>` in the source's namespace.
source-controller resolves the version range, downloads the chart and
publishes it as an artifact. Only then does helm-controller run Helm.
`flux get sources chart -A` shows these intermediate objects; a chart that
cannot be resolved stops the pipeline there, with the HelmRelease reporting
`ArtifactFailed`.

## The two manifests

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: podinfo
  namespace: flux-system
spec:
  interval: 1h                                   # how often to refresh index.yaml
  url: https://stefanprodan.github.io/podinfo    # or oci://ghcr.io/stefanprodan/charts with type: oci
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: podinfo
  namespace: lab-podinfo
spec:
  interval: 10m                                  # drift check / re-reconcile cadence
  timeout: 5m                                    # per Helm action; Helm --wait is on by default
  chart:
    spec:
      chart: podinfo
      version: "6.7.x"                           # semver range; resolved by source-controller
      sourceRef:
        kind: HelmRepository
        name: podinfo
        namespace: flux-system
      interval: 5m                               # how often to re-check the range
  values:
    replicaCount: 2
    ui:
      message: "hello from Flux"
  valuesFrom:
    - kind: ConfigMap
      name: podinfo-env                          # key "values.yaml" by default
    - kind: Secret
      name: podinfo-creds
      valuesKey: password                        # a single key…
      targetPath: redis.auth.password            # …injected at this path
      optional: true
  install:
    createNamespace: true
    remediation:
      retries: 3                                 # uninstall and retry up to 3 times
  upgrade:
    cleanupOnFail: true
    remediation:
      retries: 3
      strategy: rollback                         # or uninstall
  driftDetection:
    mode: enabled                                # disabled (default) | warn | enabled
    ignore:
      - paths: ["/spec/replicas"]                # let an HPA own this
        target:
          kind: Deployment
```

Charts kept in Git work the same way with `sourceRef.kind: GitRepository`
and `chart: ./charts/podinfo`; `spec.chartRef` can point at an
`OCIRepository` directly for charts published as OCI artifacts.

### Version ranges

| `version` | Resolves to |
|---|---|
| `6.7.1` | exactly that; the safe choice for production |
| `6.7.x` or `~6.7.0` | newest patch of 6.7 |
| `>=6.0.0 <7.0.0` or `6.x` | newest minor in the major |
| `*` (default when omitted) | newest version at all, prereleases excluded |
| `>=6.7.0-0` | include prereleases |

**Gotcha:** for charts in Git, `reconcileStrategy` defaults to
`ChartVersion`: source-controller rebuilds the chart only when `version` in
`Chart.yaml` changes. Editing a template and pushing does nothing until you
bump the version, or set `reconcileStrategy: Revision` to rebuild on every
commit.

### Values

Merge order, lowest to highest precedence: chart defaults, then each
`valuesFrom` entry in list order, then inline `values`. A referenced
ConfigMap or Secret that is missing blocks the release unless
`optional: true`. Changing any of them changes the values digest and
triggers an upgrade; helm-controller records that digest as
`status.lastAttemptedConfigDigest`, which is how it knows the inputs are new.

## Remediation

Plain Helm stops at a failed release. helm-controller follows a policy:

- **Install fails:** with `retries: N` it uninstalls and reinstalls up to N
  times. With `retries: 0` the release is left `failed` and the controller
  waits for new inputs.
- **Upgrade fails:** `strategy: rollback` (default) rolls back to the last
  deployed revision, `uninstall` removes the release; `retries` bounds the
  number of attempts. `remediateLastFailure` decides whether the final failed
  attempt is also remediated (true when `retries > 0`).
- **Retries exhausted:** `Ready=False` with reason `InstallFailed` or
  `UpgradeFailed` (the Helm error, mirrored from `Released=False`), plus
  `Stalled=True`, reason `RetriesExceeded`, message `Failed to install after
  1 attempt(s)` (or `to upgrade`). The controller
  does not try again until the chart revision or the values digest changes,
  or you run `flux reconcile hr <name> --reset` (which clears the counters;
  add `--force` to run an upgrade even if nothing changed).

**Why it matters:** this is the difference between a self-healing
deployment and a loop that hammers a broken release every interval. The
counters make failures visible and bounded; `--reset` makes the retry an
explicit human decision.

## Drift detection

Helm's three-way merge only acts at upgrade time. With
`driftDetection.mode: enabled`, helm-controller dry-runs a server-side apply
of the last rendered manifest at every `interval`, and if the cluster
differs it corrects it; `warn` only reports. `ignore` lists JSON pointers
(optionally per `target` kind/name) to exclude fields owned by something
else: HPA replicas, webhook-injected sidecars, cert-manager annotations.

## Reading a HelmRelease

```bash
flux get hr -A                                                  # REVISION = chart version, MESSAGE = last action
kubectl -n lab-podinfo describe hr podinfo                      # Conditions + Events
kubectl -n lab-podinfo get hr podinfo -o jsonpath='{.status.history[0]}' # last release snapshot
flux events --for HelmRelease/podinfo -n lab-podinfo            # the Helm action log
helm -n lab-podinfo history podinfo                             # Helm's own view
```

| Condition | Meaning |
|---|---|
| `Ready` | Summary: the release is at the desired revision and healthy |
| `Released` | The last install/upgrade attempt succeeded (`False` → it failed; the reason says how) |
| `Remediated` | A rollback or uninstall was performed after a failure |
| `Stalled` | `True` with reason `RetriesExceeded`: retries are used up; the controller waits for new inputs or `--reset` |
| `TestSuccess` | `helm test` passed (only when `spec.test.enable` is set) |

Reasons you will read: `InstallSucceeded`, `UpgradeSucceeded`,
`InstallFailed`, `UpgradeFailed`, `RollbackSucceeded`, `ArtifactFailed`,
`DependencyNotReady`, `RetriesExceeded`.

**Gotcha:** the release Secrets live in the HelmRelease's
`storageNamespace`, which defaults to the HelmRelease's namespace, not to
`targetNamespace`. A HelmRelease in `flux-system` with
`targetNamespace: lab-podinfo` deploys Pods into `lab-podinfo` while
`helm list -n lab-podinfo` shows nothing; look in `flux-system`.

## Common failures

| Message (abridged) | Cause | Fix |
|---|---|---|
| `values don't meet the specifications of the schema(s)` | A value violates the chart's `values.schema.json` | Fix the value or key name in `values`/`valuesFrom` |
| `cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas` | A value of the wrong type reached the API server (chart has no schema, so Helm rendered it as-is) | Same fix: correct the type in `values` (*flux-helmrelease-values-error*) |
| `context deadline exceeded` / `timed out waiting for the condition` | `--wait` ran past `spec.timeout`; Pods never became ready | Read the Pods, not Flux; raise `timeout` only if the chart is legitimately slow |
| `field is immutable` | Chart changed a selector, a PVC size, a Service clusterIP | Delete the object or the release; Helm cannot recreate it for you |
| `chart … not found` / `no chart version found for …` | Name or range matches nothing in the index | Check `helm search repo` or the index; widen the range |
| `another operation (install/upgrade/rollback) is in progress` | A revision stuck in `pending-*` | Roll back with `helm rollback`, or delete the pending release Secret |
| `dependency … is not ready` | `spec.dependsOn` targets a HelmRelease that is not Ready | Fix the dependency first |

**Try it:** publish the chart from lesson 6 through the Gitea `demo` repo
and let Flux release it; then break the upgrade and read the conditions.

```bash
cd ~/demo-repo && mkdir -p charts && cp -r ~/demo charts/demo
git add -A && git -c user.name=lab -c user.email=lab@sre-labs.local commit -qm "add demo chart" && git push -q
flux reconcile source git demo
printf 'replicaCount: 2\nimage:\n  tag: 1.27-alpine\n' > /tmp/demo-values.yaml
flux create hr demo --source=GitRepository/demo --chart=./charts/demo \
  --target-namespace=lab-helm --create-target-namespace \
  --values=/tmp/demo-values.yaml --interval=1m
flux get hr demo && flux get sources chart
helm -n flux-system history demo                       # storage namespace = HelmRelease namespace
# break the next upgrade with an image that cannot be pulled, and a short timeout
kubectl -n flux-system patch hr demo --type merge \
  -p '{"spec":{"timeout":"60s","values":{"image":{"tag":"nope"}}}}'
flux reconcile hr demo; flux get hr demo
kubectl -n flux-system get hr demo -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
helm -n flux-system history demo                       # a failed revision, no rollback (retries: 0)
kubectl -n flux-system patch hr demo --type merge -p '{"spec":{"values":{"image":{"tag":"1.27-alpine"}}}}'
flux reconcile hr demo                                 # new values digest: the controller tries again
```

## Where to go next

You now have both consumers. The next lesson steps back to the repository:
how to lay out clusters, infrastructure and applications so that
`dependsOn`, overlays and promotion stay simple. The *Flux HelmRepository*
and *Flux HelmRelease* builders drill the two manifests above.

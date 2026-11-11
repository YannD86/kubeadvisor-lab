---
title: "Chart anatomy: Chart.yaml, values, templates and helpers"
slug: chart-anatomy
realm: gitops
order: 6
summary: "Every file in a Helm chart and what reads it, the template functions that do the real work, dependencies and Chart.lock, and helm lint / helm template as CI steps."
estimated_minutes: 15
level: intermediate
tags: [helm, charts, templates, values, schema, dependencies]
builders: [helm-chart-yaml]
scenarios: []
quiz:
  - q: "Why is `include \"demo.labels\" . | nindent 4` used instead of `template \"demo.labels\" .`?"
    options: ["template is deprecated", "include returns a string that can be piped to functions like nindent; template writes output directly and cannot be piped", "include is faster", "template only works in _helpers.tpl"]
    answer: 1
    explain: "template is an action, not a function, so it cannot appear in a pipeline. include is a Helm addition that returns the rendered text."
  - q: "You change a template in a chart stored in Git but forget to bump `version` in Chart.yaml. What does a consumer that pins by chart version see?"
    options: ["The new template on the next reconcile", "Nothing: the chart version is unchanged, so the chart is considered unchanged", "A lint error", "A schema error"]
    answer: 1
    explain: "Chart version is the identity of the package. Repositories generally refuse to re-publish an existing version, and Flux's default reconcileStrategy only rebuilds when the version changes."
  - q: "What does values.schema.json add that values.yaml does not?"
    options: ["Default values", "Validation of user-supplied values on install, upgrade, lint and template", "Documentation only", "Secrets encryption"]
    answer: 1
    explain: "The schema is enforced by Helm itself, so a typo like replicaCount: 'two' fails before anything reaches the cluster."
---

# Chart anatomy

Run `helm create demo` and you get the canonical layout. Every file has one
reader (Helm, Kubernetes, or a human) and one job.

```text
demo/
├── Chart.yaml            # identity: name, version, appVersion, dependencies
├── Chart.lock            # exact resolved dependency versions (generated)
├── values.yaml           # default parameters
├── values.schema.json    # JSON Schema that user values must satisfy (optional)
├── .helmignore           # files excluded from the package
├── charts/               # downloaded dependency charts (generated)
├── crds/                 # CRDs installed first, never templated, never upgraded or deleted
└── templates/
    ├── NOTES.txt         # printed after install/upgrade; not a Kubernetes object
    ├── _helpers.tpl      # named templates; files starting with _ render nothing
    ├── deployment.yaml
    ├── service.yaml
    ├── serviceaccount.yaml
    ├── hpa.yaml
    ├── ingress.yaml
    └── tests/
        └── test-connection.yaml   # Pods run by `helm test`
```

## Chart.yaml

```yaml
apiVersion: v2                 # Helm 3 charts; v1 is Helm 2
name: demo
description: A Helm chart for Kubernetes
type: application              # or library: templates only, cannot be installed
version: 0.1.0                 # SemVer of the chart; bump on every change
appVersion: "1.16.0"           # version of the software; informational, used as default image tag
kubeVersion: ">=1.25.0-0"      # refuse to install on older clusters
dependencies:
  - name: redis
    version: "19.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: redis.enabled   # install only when .Values.redis.enabled is true
    alias: cache               # the sub-chart's values live under .Values.cache
```

**Why it matters:** `version` is the identity of the package. Most chart
repositories refuse to overwrite an existing version, Flux decides whether
a chart changed by looking at it, and `helm history` records it. Every
edit to `templates/` or `values.yaml` that you want anyone to receive needs
a version bump. `appVersion` is free text and nothing enforces it.

## Dependencies and Chart.lock

`helm dependency update` reads `dependencies`, resolves each range to a
concrete version, downloads the `.tgz` into `charts/` and writes
`Chart.lock` with the exact versions and a digest. `helm dependency build`
reproduces `charts/` from the lock file without re-resolving. Commit
`Chart.lock`; treat `charts/` as a build output. Values for a dependency sit
under its name (or `alias`) in your `values.yaml`, and global values go
under `global:`.

## values.yaml and values.schema.json

`values.yaml` is the default. Users override with `-f`/`--values` files
(merged in order) and `--set` (highest precedence). Keep it flat where you
can and comment every key; `helm show values <chart>` is how operators
read it.

`values.schema.json` is JSON Schema (draft 7) that Helm validates the
*merged* values against on `install`, `upgrade`, `lint` and `template`:

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["image"],
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 },
    "image": {
      "type": "object",
      "required": ["repository"],
      "properties": { "repository": { "type": "string" }, "tag": { "type": "string" } }
    }
  }
}
```

A violation stops the release before anything is rendered, with a message
like `values don't meet the specifications of the schema(s)`. Charts without
a schema (podinfo is one) let a wrong type through to the API server, which
rejects it with a much less friendly `cannot unmarshal string into Go struct
field` error; the *flux-helmrelease-values-error* scenario shows that path.

## Templates and the functions that matter

Templates are Go `text/template` with the Sprig library and a few Helm
additions. The objects available: `.Values`, `.Release` (`Name`,
`Namespace`, `IsInstall`, `IsUpgrade`, `Revision`), `.Chart` (the parsed
Chart.yaml) and `.Capabilities` (`KubeVersion`, `APIVersions.Has`).

| Function | Use | Example |
|---|---|---|
| `include` | Render a named template to a string you can pipe | `{{ include "demo.labels" . \| nindent 4 }}` |
| `toYaml` | Emit a values sub-tree as YAML | `{{ toYaml .Values.resources \| nindent 12 }}` |
| `nindent` / `indent` | Fix indentation of multi-line output (`nindent` adds the leading newline) | as above |
| `default` | Fallback when a value is empty | `{{ .Values.image.tag \| default .Chart.AppVersion }}` |
| `required` | Fail rendering with a message when a value is empty | `{{ required "image.repository is required" .Values.image.repository }}` |
| `quote` | Make a string safe (`"true"` vs `true`) | `value: {{ .Values.env.DEBUG \| quote }}` |
| `tpl` | Render a value that itself contains template syntax | `{{ tpl .Values.configTemplate . }}` |
| `lookup` | Read a live object (empty during `helm template`) | `{{ lookup "v1" "Secret" .Release.Namespace "existing" }}` |

`_helpers.tpl` holds `define` blocks. The three you see in every chart are
`<chart>.fullname` (release name + chart name, truncated to 63 chars),
`<chart>.labels` and `<chart>.selectorLabels`. Keep them: tools and
dashboards rely on `app.kubernetes.io/name` and
`app.kubernetes.io/instance`.

**Gotcha:** `selectorLabels` end up in `spec.selector` of Deployments and
Services, and a Deployment's selector is **immutable**. Changing that
helper, or anything that flows into it (a renamed chart, a new label in the
selector), makes every upgrade fail with `field is immutable` until the
Deployment is deleted and recreated. Add labels to `labels`, never to
`selectorLabels`, once a chart is in use.

`NOTES.txt` is a template too, rendered after a successful install or
upgrade and shown by `helm status`. Put the "how do I reach it" commands
there; it is the one piece of chart output humans actually read.

## `helm lint` and `helm template` as CI steps

Charts are code; test them before they reach a cluster.

```bash
cd ~ && { [ -d demo ] || helm create demo >/dev/null; }      # the starter chart from chapter 05
helm lint ./demo --strict                        # schema, required fields, best-practice warnings as errors
helm dependency build ./demo                     # fail if Chart.lock is stale
helm template demo ./demo --set replicaCount=2 | grep -E '^kind|replicas'   # render with each environment's values: -f ci/values-prod.yaml in CI
helm template demo ./demo | kubeconform -strict -summary   # validate rendered YAML against the API schemas
helm template demo ./demo --set image.repository=  # would fail on a chart with a `required` guard; the starter chart has none and renders image: ":1.16.0"
```

`helm template` renders client-side without a cluster: `.Capabilities`
reports the Helm default Kubernetes version (`--kube-version` to override)
and `lookup` returns empty. For templates that depend on live state, use
`helm install --dry-run=server` against a cluster instead. The `helm
unittest` plugin adds assertion-based tests on rendered output; `helm
package` produces the `.tgz` you publish.

**Try it:** inspect and render the chart you generated in the previous
lesson (or run `helm create demo` again).

```bash
cd ~/demo && cat Chart.yaml && sed -n '1,40p' templates/_helpers.tpl
helm lint . --strict
helm template demo . --set image.tag=1.27-alpine | grep -E '^kind:|image:|app.kubernetes.io/instance' | sort | uniq -c
helm template demo . --set service.type=NodePort --show-only templates/service.yaml
helm template demo . --set image.repository= 2>&1 | tail -3          # the starter chart has no required guard: note what renders
helm show values . | head -30
```

## Where to go next

With charts understood, the next lesson hands them to Flux: `HelmRelease`
objects that install, upgrade, remediate and detect drift on your behalf.
The *Helm Chart.yaml* builder drills the metadata file field by field.

# SRE Kube Labs — Content Guide

All learning content lives under `content/` as plain files (YAML + Markdown).
The API loads them at startup and on change; nothing is stored in a database
except learner progress. Keep every file self-contained and valid.

```
content/
├── realms.yaml                       # catalog of the 5 realms (do not add realms casually)
├── builders/<id>.yaml                # manifest-builder activities (CRD nomenclature)
├── lessons/<realm>/<NN>-<slug>.md    # markdown lessons with frontmatter
└── scenarios/<id>/
    ├── scenario.yaml                 # metadata, brief, hints, checks
    ├── setup.sh                      # prepares/breaks the cluster (idempotent)
    ├── cleanup.sh                    # removes everything setup.sh created
    └── solution.md                   # full walkthrough (markdown)
```

Conventions
- ids and slugs: lowercase kebab-case, unique across the whole tree.
- Namespaces created by scenarios are prefixed `lab-` (e.g. `lab-shop`).
- Every script starts with `#!/usr/bin/env bash` and `set -euo pipefail`, and
  sources `"$LAB_ROOT/cluster/lib.sh"` which provides `log`, `kc` (kubectl with
  the lab kubeconfig), `wait_for_pods`, `ensure_ns`, `node_exec`.
- Scripts receive env vars: `LAB_ROOT` (repo root), `KUBECONFIG`,
  `LAB_SCENARIO` (id), `LAB_WORKDIR` (per-scenario scratch dir), `LAB_CLUSTER`
  (kind cluster name, default `sre-labs`).
- Scripts must be idempotent: running setup twice yields the same broken state.
- Never touch namespaces that are not `lab-*`, `flux-system` or `kube-system`
  (the latter only in `cluster`-category scenarios, and always reversibly).
- Images: use only small public images: `nginx:1.27-alpine`, `busybox:1.36`,
  `registry.k8s.io/e2e-test-images/agnhost:2.47`, `hashicorp/http-echo:1.0`,
  `ghcr.io/stefanprodan/podinfo:6.7.1`, `redis:7-alpine`, `curlimages/curl:8.10.1`.

---------------------------------------------------------------------------

## 1. Builder activities (`content/builders/<id>.yaml`)

A builder teaches the *nomenclature* of a manifest: the learner starts from an
empty editor and adds fields in a prescribed order. Each step explains **why**
the field exists and why it comes now. Hints are short and only appear when
the learner highlights the step or the matching line.

```yaml
id: flux-gitrepository
title: "Flux GitRepository: declare a source"
kind: GitRepository                 # the Kubernetes kind being built
apiVersion: source.toolkit.fluxcd.io/v1
realm: manifests                    # always "manifests" for builders
track: flux                         # grouping tab: core | crd | flux | helm | networking | observability | security
difficulty: beginner                # beginner | intermediate | advanced
estimated_minutes: 12
summary: >
  One-paragraph description shown on the catalog card.
intro: |
  Markdown shown before the first step. Explain what this object does in the
  system (who reads it, what it produces) in 5-10 lines.
prerequisites: [deployment-basics]   # other builder ids (optional)
crd: true                            # true if this kind is a CustomResource
docs_url: https://fluxcd.io/flux/components/source/gitrepositories/
steps:
  - path: apiVersion                 # dot path; list index with [0]
    title: "API group and version"
    prompt: "Declare which API this object speaks."
    why: |
      Markdown. 2-6 sentences. Why this field, why now, what breaks without it.
    hint: "Flux sources live under source.toolkit.fluxcd.io; v1 is stable."
    expect:                          # how the learner's value is checked
      type: equals                   # equals | regex | oneOf | any | exists | integer | boolean | list
      value: source.toolkit.fluxcd.io/v1
    reveal: "apiVersion: source.toolkit.fluxcd.io/v1"   # exact line(s) shown if the learner gives up
  - path: metadata.name
    title: "Name"
    prompt: "Give the source a name other objects will reference."
    why: ...
    hint: "Other Flux objects reference this exact name in spec.sourceRef.name."
    expect: { type: regex, value: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" }
    reveal: |
      metadata:
        name: podinfo
    gotchas:                          # optional list of common mistakes
      - "Names are namespaced: the Kustomization must be in the same namespace or set sourceRef.namespace."
final_manifest: |                     # the complete, valid reference manifest
  apiVersion: source.toolkit.fluxcd.io/v1
  kind: GitRepository
  metadata:
    name: podinfo
    namespace: flux-system
  spec:
    interval: 1m
    url: https://github.com/stefanprodan/podinfo
    ref:
      branch: master
apply:                                # optional: what to do when the learner clicks Apply (needs cluster)
  mode: dry-run                        # dry-run | create
  requires_addons: [flux]              # cluster addons that must be installed (flux | gitea | ingress-nginx | metrics-server | cert-manager)
quiz:                                  # optional, 2-4 questions
  - q: "What happens if spec.interval is omitted?"
    options: ["Defaults to 1m", "Validation error: interval is required", "Reconciles once", "Reconciles every 10m"]
    answer: 1
    explain: "interval is a required field in the GitRepository schema."
```

Rules for steps
- Order matters: top-level keys in canonical order `apiVersion, kind, metadata,
  spec` then spec fields in the order a practitioner writes them (identity →
  source/target → behaviour → tuning).
- Between 8 and 18 steps. Each `why` must teach something a reader could not
  guess from the field name.
- `expect.type`:
  - `equals`: strict equality after YAML parsing (strings, numbers, booleans).
  - `regex`: Python regex, full-match against the string form.
  - `oneOf`: `value` is a list of accepted values.
  - `exists`: key present, any value.
  - `integer` / `boolean`: type check.
  - `list`: `value.min_items` (int) and optional `value.item_keys` (keys each
    item must have).
  - `any`: no check (use sparingly).
- `hint` ≤ 120 characters. It is a nudge, not the answer.
- `reveal` is the exact YAML (with indentation relative to column 0) that
  satisfies the step and can be pasted into the editor at the right place.
- `final_manifest` must be valid YAML, contain every step path, and satisfy
  every `expect`. The validator (`scripts/validate_content.py`) enforces this.

## 2. Lessons (`content/lessons/<realm>/<NN>-<slug>.md`)

```markdown
---
title: "Flux CD architecture: sources, kustomizations, releases"
slug: flux-architecture          # must equal filename without NN- prefix
realm: gitops                    # gitops | components | troubleshooting
order: 1
summary: "One or two sentences for the card."
estimated_minutes: 15
level: beginner
tags: [flux, gitops, controllers]
builders: [flux-gitrepository, flux-kustomization]   # related builder ids
scenarios: [flux-first-kustomization]                # related scenario ids
diagram: flux-flow               # optional: name of a built-in interactive diagram
quiz:
  - q: "Which controller fetches Git repositories?"
    options: ["kustomize-controller", "source-controller", "helm-controller", "notification-controller"]
    answer: 1
    explain: "source-controller produces artifacts; the others consume them."
---

# Body in GitHub-flavoured Markdown

Use `## ` sections. Code blocks with a language (`yaml`, `bash`).
Callouts: start a paragraph with **Why it matters:**, **Gotcha:**, **Try it:**.
A `Try it:` callout should contain commands the learner can paste into the lab
terminal. Keep lessons 600-1500 words; link to the hands-on instead of
describing it in full.

Every `bash` block in a realm lesson gets a "Run" button in the local runner,
which types the block into the lab terminal on the host. So each block must
work as written from there: prefix node-side commands with
`docker exec sre-labs-worker`, exec binaries directly in distroless images
(no `sh -c` in etcd or the control-plane pods), use one-shot probe Pods
rather than interactive shells, and say which scenario a block assumes.
Lines with `<placeholders>` are left out by Run; keep them in reference blocks
only. `scripts/sweep_lessons.py` runs every block and reports failures.
```

## 3. Scenarios (`content/scenarios/<id>/`)

### scenario.yaml

```yaml
id: svc-selector-mismatch
title: "Service has no endpoints"
realm: scenarios
category: network                # node | cluster | network | config | workload | storage | rbac | gitops | helm
type: troubleshoot               # troubleshoot (something is broken, fix it) | build (nothing broken, build it)
difficulty: beginner
estimated_minutes: 10
tags: [service, endpoints, labels]
requires_addons: []              # subset of [flux, gitea, ingress-nginx, metrics-server, cert-manager]
summary: "One or two sentences for the catalog card."
brief: |
  Markdown. Written like an on-call ticket: symptom, impact, what the
  reporter already tried. Do NOT reveal the root cause. End with
  "## Your task" and a bullet list that mirrors the checks below.
namespace: lab-shop              # the namespace k9s opens in; also used by `lab` CLI
hints:                           # progressively more specific; 3-5 entries
  - "Where does a Service find its backends? Look at what it selects."
  - "kubectl get endpoints -n lab-shop web   # empty?"
  - "kubectl get pods -n lab-shop --show-labels and compare with the Service selector"
checks:                          # run in order with bash -c; exit 0 = pass. All must pass.
  - name: "Service web has at least one endpoint"
    cmd: test -n "$(kubectl get endpoints -n lab-shop web -o jsonpath='{.subsets[*].addresses[*].ip}')"
  - name: "Pods still carry their original labels (fix the Service, not the pods)"
    cmd: test "$(kubectl get pods -n lab-shop -l app=web-frontend --no-headers | wc -l)" -ge 2
  - name: "HTTP 200 from inside the cluster"
    cmd: kubectl run -n lab-shop probe-$RANDOM --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- -s -o /dev/null -w '%{http_code}' http://web | grep -q 200
concepts:                        # 2-4 short bullets displayed after success
  - "A Service is just a label selector plus a port mapping; the Endpoints/EndpointSlice object is the materialised result."
related_lessons: [troubleshooting/services-and-dns]
```

### setup.sh / cleanup.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$LAB_ROOT/cluster/lib.sh"
NS=lab-shop
ensure_ns "$NS"
kc apply -n "$NS" -f - <<'YAML'
...
YAML
wait_for_pods "$NS" "app=web-frontend" 90
log "Scenario ready"
```

`cleanup.sh` deletes the namespace (`kc delete ns "$NS" --ignore-not-found
--wait=false`) and reverts anything else (uncordon, untaint, restore kubelet,
restore static pod manifests...). Cleanup must succeed even if setup failed
halfway.

Node/cluster scenarios interact with kind nodes through
`node_exec <node> <cmd...>` (wrapper around `docker exec`). Node names are
`sre-labs-control-plane`, `sre-labs-worker`, `sre-labs-worker2`.

### solution.md

Markdown. Sections: `## Diagnosis` (the commands and what they show),
`## Root cause`, `## Fix` (commands/manifests), `## Prevention` (what an SRE
would add: alert, policy, test, review habit).

## 4. Validation

Run `python3 scripts/validate_content.py` before committing. It checks ids,
frontmatter, step/expect consistency, final manifests, script shebangs and
`bash -n` syntax.

## 5. GitOps scenarios: Gitea + Flux contract

When `requires_addons` contains `gitea` and/or `flux`, the engine guarantees
before `setup.sh` runs:

- Gitea is reachable from the host and the lab terminal at `http://localhost:30080`
  and from inside the cluster at `http://gitea.lab-gitea.svc.cluster.local:3000`.
  User `lab`, password `labpass123`. Repos are public, so Flux needs no secret.
- Flux controllers are installed in `flux-system` (`flux install`); the `flux`
  CLI is available in the terminal.

`cluster/lib.sh` offers: `gitea_create_repo <name>`, `gitea_delete_repo <name>`,
`gitea_push_dir <dir> <repo> [branch] [msg]` (force-pushes a directory as the
whole repo), `gitea_repo_cluster_url <repo>` (the URL to put in a
GitRepository `spec.url`). Seed repos from `$LAB_WORKDIR/<repo>` and name them
after the scenario (`<scenario-id>` or `<scenario-id>-app`). Cleanup must
delete the Flux objects it created (in namespace `lab-*` or `flux-system`, by
scenario-specific names) and the Gitea repo.

Learners push with: `git clone http://lab:labpass123@localhost:30080/lab/<repo>.git`.

## 6. Built-in interactive diagrams (lesson `diagram:` field)

Only these names exist: `cluster-anatomy`, `request-lifecycle`, `flux-flow`,
`helm-flow`, `service-traffic-path`. A lesson may reference at most one.

## 7. Step paths with dotted keys

Keys that contain dots or slashes are addressed with a quoted bracket segment:
`metadata.annotations["nginx.ingress.kubernetes.io/rewrite-target"]`,
`data["nginx.conf"]`. Numeric brackets stay list indexes: `containers[0].image`.

## 8. Products, courses, assessments, exercises

Imported once from the KubeAdvisor database by `scripts/import_kubeadvisor.py`
and maintained as files afterwards (re-running the importer overwrites these
four subtrees). Full field tables live in `PLATFORM_CONTRACT.md` section 2;
`scripts/validate_content.py` enforces them. Shared rules: ids are kebab-case
and equal the file stem (minus the `NN-` prefix where there is one); `product`
must name an existing `content/products/<id>.yaml`; every `scenario`,
`scenarios`, `suggested_scenario` and `builders` entry must resolve to an
existing scenario or builder id; quiz `answer` is a 0-based index into
`options`; multi-line strings use `|` block scalars.

### 8.1 Product (`content/products/<id>.yaml`)

```yaml
id: cka-exam-prep                 # == file stem; the KubeAdvisor slug
title: "CKA Exam Preparation Course"   # never "certified" / "certification"
kind: course                      # course | bundle
status: active                    # active | draft
order: 1
featured: true
price_cents: 19900
currency: usd
tagline: "One line for the catalog card."
description: |
  Markdown shown on the product page.
features: ["23 lessons mapped to the CKA domains"]
difficulty: intermediate          # beginner | intermediate | advanced
duration_hours: 40
includes: []                      # bundles only: product ids it unlocks (never another bundle)
exam_domains:                     # optional; weights should sum to 100
  - { id: troubleshooting, title: "Troubleshooting", weight: 30 }
source: { system: kubeadvisor, product_id: "aa443ca9-...", product_type: CKA_TRAINING }
```

### 8.2 Course lesson (`content/courses/<product>/NN-<slug>.md`)

Same frontmatter family as realm lessons (section 2) plus `product`, `module`,
`module_title`, `preview`, `objectives`, `prerequisites`, `domain`, `source`.
`order` must equal the `NN` prefix and be unique within the product; exactly
one lesson per product should carry `preview: true` (the validator warns when
none does). `domain` must be one of the product's `exam_domains` ids.

```markdown
---
title: "ETCD Backup and Restore"
slug: etcd-backup-restore
product: cka-exam-prep
order: 2
module: 1
module_title: "Cluster Architecture"
summary: "One or two sentences for the curriculum card."
estimated_minutes: 20
level: intermediate
tags: [etcdctl, snapshot]
preview: false
objectives: ["Take a snapshot with etcdctl"]
prerequisites: []
domain: cluster_architecture
quiz:
  - q: "Which etcdctl subcommand writes a snapshot?"
    options: ["snapshot save", "snapshot restore", "backup", "export"]
    answer: 0
    explain: "snapshot save writes the db file; snapshot restore rebuilds a data dir from it."
scenarios: [apiserver-etcd-wrong-port]
source: { system: kubeadvisor, model: gemini-2.0-flash, generated_at: "2026-03-02", review: pending }
---

## Body in GitHub-flavoured Markdown (no leading H1: the title is rendered by the app)
```

`source.review: pending` marks machine-generated text that nobody has read
yet; the validator warns on it. Set it to `reviewed` after a human pass.

Course bodies are mostly worked examples for clusters that do not exist
(`etcd-node1`, `10.0.0.10`, `/opt/etcd-backup.db`), so the lesson viewer does
not offer "Run" on their `bash` blocks. A block written for the lab's kind
cluster is fenced as ```` ```bash lab ```` and gets the button; everything
else keeps "Copy" only. Exercise setup and solution commands are always
runnable.

### 8.3 Assessment (`content/courses/<product>/assessments/<id>.yaml`)

```yaml
id: cka-domain-storage            # == file stem; prefixed with the product short name
title: "CKA Domain: Storage"
product: cka-exam-prep
kind: domain                      # pre | final | domain | practice
description: "One paragraph."
time_limit_minutes: 12            # 0 = untimed
pass_percent: 70
domain: storage                   # required for kind: domain, else null
order: 6
questions:
  - q: "Which access mode allows read-write by a single node?"
    options: [ReadWriteMany, ReadWriteOnce, ReadOnlyMany, ReadWriteOncePod]
    answer: 1
    explain: "RWO is one node read-write; RWOP narrows it to one Pod."
    domain: storage               # optional, feeds the per-domain result breakdown
    difficulty: medium            # optional: easy | medium | hard
```

Per-lesson quizzes are embedded in the lesson `quiz:` block, never written as
assessments.

### 8.4 Exercise (`content/exercises/<product>/NN-<id>.yaml`)

Task definitions imported from KubeAdvisor's CLI exercises. `mode: legacy`
shows task + hints + solution; `mode: scenario` runs the loaded scenario named
in `scenario`. `suggested_scenario` is the importer's best match: a human
checks it, then promotes it to `scenario` and flips `mode`.

```yaml
id: troubleshoot-control-plane-components
title: "Troubleshoot Control Plane Components"
product: cka-exam-prep
order: 1
domain: cluster_architecture
difficulty: advanced              # beginner | intermediate | advanced
objective: "Troubleshoot cluster component failure"
description: "The kube-apiserver is not responding. Investigate and fix the issue."
task: |
  1. Examine the kube-apiserver static pod manifest in /etc/kubernetes/manifests/
  2. Fix the --etcd-servers port and verify with kubectl get nodes
hints: ["Static pod manifests live in /etc/kubernetes/manifests/"]
solution_commands: ["sed -i 's/2389/2379/' /etc/kubernetes/manifests/kube-apiserver.yaml"]
time_limit_minutes: 20
points: 100
mode: legacy                      # legacy | scenario
scenario: null
suggested_scenario: apiserver-etcd-wrong-port
legacy:                           # raw KubeAdvisor fields, never shown to learners
  initial_state: {}
  setup_commands: []
  validation_rules: {}
source: { system: kubeadvisor, exercise_id: "a89ab031-..." }
```

### 8.5 Realm access

Each realm in `realms.yaml` carries `access: free | pro` (default `free`).
The `scenarios` realm is `pro`; builders, gitops, components and
troubleshooting are `free`.

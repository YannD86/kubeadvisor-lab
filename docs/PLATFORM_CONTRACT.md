# KubeAdvisor Platform — contract

This repository is the commercial fusion of two projects:

- **SRE Kube Labs** (the lab engine): kind cluster, web terminal + k9s, manifest
  builders, realm lessons, loaded troubleshooting scenarios, file-based content.
- **KubeAdvisor** (the storefront): accounts, products, purchases, courses
  (CKA / CKAD / interview / production playbook / bundle), assessments.

One codebase, two roles, selected by environment variables:

| Role | `KA_AUTH_MODE` | `KA_LAB_MODE` | Used for |
|---|---|---|---|
| **Platform** (SaaS) | `accounts` | `hosted` | kubeadvisor.dev: sells courses + Pro, serves lessons, stores every user's progress. No cluster on the host. |
| **Runner** (local) | `local` | `local` | A learner's own machine (or Yann's dev box): drives the kind cluster, terminal, scenarios. Optionally syncs progress to the platform with a lab token. |
| **Demo / staging** | `accounts` | `local` | Multi-user UI against one shared cluster on the same host. Terminal is then admin-only. |

Everything below is the contract between the API (`api/`), the web app (`web/`),
the content tree (`content/`) and the import tooling (`scripts/`). Agents working
in parallel implement against this document; do not invent other shapes.

---

## 1. Settings (environment)

Lab engine (unchanged names, new defaults):

| Var | Default | Meaning |
|---|---|---|
| `LAB_HOME` | `~/.kubeadvisor` | state, kubeconfig, work dirs, sqlite db |
| `LAB_CLUSTER` | `sre-labs` | kind cluster name (shared with the SRE Kube Labs checkout; run one at a time) |
| `LAB_API_PORT` / `LAB_WEB_PORT` | `10201` / `10200` | ports |
| `LAB_API_URL` | `http://localhost:10201` | what scripts/web use to call the API |

Platform:

| Var | Default | Meaning |
|---|---|---|
| `KA_AUTH_MODE` | `local` | `local` = implicit single admin user `local@runner`; `accounts` = email+password accounts, JWT cookie/bearer |
| `KA_LAB_MODE` | `local` | `local` = cluster/terminal/scenario routes active on this host; `hosted` = those routes answer `409 {"error":"lab_mode_hosted"}` |
| `KA_DATABASE_URL` | `sqlite:///$LAB_HOME/platform.db` | SQLAlchemy URL (sync drivers); Postgres: `postgresql+psycopg://user:pw@host/db` |
| `KA_SECRET_KEY` | *(dev value, warns)* | JWT signing key. In `accounts` mode with `KA_ENV=production` the API refuses to start without it. |
| `KA_ENV` | `development` | `development` \| `production` |
| `KA_WEB_ORIGIN` | `http://localhost:$LAB_WEB_PORT` | CORS origin + cookie domain decisions |
| `KA_COOKIE_SECURE` | `0` | set `1` behind HTTPS |
| `KA_STRIPE_SECRET_KEY` | *(unset)* | billing disabled when unset: checkout answers `409 {"error":"billing_disabled"}`; **never** a free grant |
| `KA_STRIPE_WEBHOOK_SECRET` | *(unset)* | webhook signature; webhook answers 503 when unset |
| `KA_STRIPE_PRO_PRICE_ID` | *(unset)* | recurring price for Pro |
| `KA_PLATFORM_URL` + `KA_LAB_TOKEN` | *(unset)* | runner → platform progress sync |
| `KA_ADMIN_EMAILS` | *(unset)* | comma list; these accounts get `role=admin` at signup/login |

`GET /api/meta` exposes the effective modes so the web app can adapt.

---

## 2. Content tree

Existing (unchanged, see `CONTENT_GUIDE.md`):

```
content/realms.yaml                 realms, tracks, categories, addons  (+ new `access` field)
content/builders/<id>.yaml          manifest builders
content/lessons/<realm>/NN-slug.md  realm lessons (gitops, components, troubleshooting)
content/scenarios/<id>/...          loaded scenarios
```

New (imported from the KubeAdvisor database by `scripts/import_kubeadvisor.py`, then
maintained as files):

```
content/products/<product-id>.yaml
content/courses/<product-id>/NN-<lesson-slug>.md
content/courses/<product-id>/assessments/<assessment-id>.yaml
content/exercises/<product-id>/NN-<exercise-id>.yaml
```

### 2.1 `realms.yaml` additions

Each realm gets `access: free | pro`. Default when missing: `free`.
`scenarios` realm is `pro`. Builders, gitops, components, troubleshooting are `free`.

### 2.2 Product — `content/products/<product-id>.yaml`

```yaml
id: cka-exam-prep                 # == file stem, kebab-case; the KubeAdvisor slug
title: "CKA Exam Preparation Course"
kind: course                      # course | bundle
status: active                    # active | draft   (draft = hidden from catalog, still loadable by admins)
order: 1
featured: true
price_cents: 19900
currency: usd
tagline: "One line for the catalog card"
description: |
  Markdown. Several paragraphs allowed.
features:                         # bullet list for the product page
  - "23 lessons mapped to the CKA domains"
difficulty: intermediate          # beginner | intermediate | advanced
duration_hours: 40
includes: []                      # bundle only: list of product ids it unlocks
exam_domains:                     # optional; for courses mapped to an exam
  - { id: cluster_architecture, title: "Cluster Architecture, Installation & Configuration", weight: 25 }
source:                           # provenance, optional
  system: kubeadvisor
  product_id: "aa443ca9-..."
```

Trademark rule: titles say "Exam Preparation", never "certified"/"certification".
A `disclaimer` field is optional; the web app shows a generic one for products with `exam_domains`.

### 2.3 Course lesson — `content/courses/<product-id>/NN-<slug>.md`

```yaml
---
title: "etcd backup and restore"
slug: etcd-backup-restore          # == file stem without NN-
product: cka-exam-prep
order: 7                           # == NN
module: 2                          # 1-based module index (KubeAdvisor section_index + 1)
module_title: "Cluster Architecture"
summary: "One or two sentences."
estimated_minutes: 25
level: intermediate                # beginner | intermediate | advanced
tags: [etcd, backup]
preview: false                     # true = readable without entitlement (first lesson of each product is preview)
objectives:                        # optional
  - "Take a snapshot with etcdctl"
prerequisites: []                  # optional, free text
domain: cluster_architecture       # optional, exam domain id
quiz:                              # optional, same shape as realm lessons
  - q: "…"
    options: ["a", "b", "c", "d"]
    answer: 1
    explain: "…"
scenarios: [apiserver-etcd-wrong-port]   # optional, related loaded scenarios
builders: []                             # optional, related builders
source:
  system: kubeadvisor
  model: gemini-2.0-flash
  generated_at: "2026-03-02"
  review: pending                  # pending | reviewed
---

# Body in GitHub-flavoured Markdown. ```mermaid blocks are rendered as diagrams.
```

### 2.4 Assessment — `content/courses/<product-id>/assessments/<assessment-id>.yaml`

```yaml
id: cka-final-assessment           # == file stem
title: "CKA Final Assessment"
product: cka-exam-prep
kind: final                        # pre | final | domain | practice
description: "Markdown, one paragraph."
time_limit_minutes: 60             # 0 = untimed
pass_percent: 70
domain: null                       # for kind: domain
order: 2
questions:
  - q: "…"
    options: ["…", "…", "…", "…"]
    answer: 2                      # index into options
    explain: "…"
    domain: troubleshooting        # optional
    difficulty: medium             # optional: easy | medium | hard
```

Lesson-level quizzes from KubeAdvisor (the 5-question CKA per-lesson quizzes) are
embedded into the matching lesson's `quiz:` block, not written as assessments.

### 2.5 Exercise — `content/exercises/<product-id>/NN-<exercise-id>.yaml`

Imported CLI exercises. They are **task definitions**, not runnable scenarios yet.

```yaml
id: troubleshoot-control-plane     # == file stem without NN-
title: "Troubleshoot Control Plane Components"
product: cka-exam-prep
order: 1
domain: troubleshooting
difficulty: advanced               # beginner | intermediate | advanced
objective: "One line."
task: |
  Markdown instructions shown to the learner.
hints:
  - "…"
solution_commands:
  - "kubectl -n kube-system get pods"
time_limit_minutes: 20
points: 100
mode: legacy                       # legacy = read-only task + solution; scenario = runs the linked loaded scenario
scenario: null                     # scenario id when mode: scenario
suggested_scenario: svc-selector-mismatch   # importer's best match (or null); a human promotes it to `scenario:`
legacy:                            # raw KubeAdvisor fields kept for conversion; the API surfaces setup_commands, the rest is never shown
  initial_state: {...}
  setup_commands: [...]
  validation_rules: [...]
source: { system: kubeadvisor, exercise_id: "..." }
```

### 2.6 Validation

`scripts/validate_content.py` validates all of the above (ids == file stems,
required fields, enum values, `product` references an existing product,
`includes`/`scenario`/`scenarios`/`builders` references resolve, quiz/assessment
answers in range, lesson `order` unique per product, `preview` present).
Exit code 1 on ERROR. WARN for `source.review: pending`.

---

## 3. API contract

Base URL `/api`. JSON everywhere. Errors: `{"detail": {"error": "<code>", "message": "..."}}`
or `{"detail": "..."}` for plain 404s. Codes used: `unauthenticated` (401),
`forbidden` (403), `payment_required` (402), `billing_disabled` (409),
`lab_mode_hosted` (409), `cluster_unavailable` (409), `missing_addons` (409).

### 3.1 Identity

`User` object:
```json
{"id":"uuid","email":"a@b.c","name":"Ada","role":"user|admin","tier":"free|pro","created_at":1730000000.0}
```
`Entitlements` object:
```json
{"pro":false,"products":["cka-exam-prep"],"admin":false}
```
Resolution: `admin` → everything. `tier == pro` (active subscription) → every course, every realm.
A purchase of a bundle grants its `includes`. `products` is the flattened list.

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/meta` | → `{"product":"KubeAdvisor","version":"...","auth_mode":"local|accounts","lab_mode":"local|hosted","billing_enabled":bool,"signup_enabled":bool}` |
| POST | `/api/auth/signup` | `{email,password,name?}` → `{"user":User,"entitlements":Entitlements}` + sets cookie `ka_session` (httpOnly, SameSite=Lax). 409 `email_taken`. Password ≥ 8 chars. 404 in `local` mode. |
| POST | `/api/auth/login` | `{email,password}` → same as signup + `"token":"<jwt>"` (for CLI/runner use). 401 `invalid_credentials`. |
| POST | `/api/auth/logout` | → `{"ok":true}`, clears cookie |
| GET | `/api/auth/me` | → `{"user":User,"entitlements":Entitlements}`; 401 `unauthenticated` in accounts mode when anonymous; in `local` mode always the local admin |

Auth transport: cookie `ka_session` **or** `Authorization: Bearer <jwt>` **or**
`Authorization: Bearer kal_<lab-token>` (lab tokens, see 3.6). JWT lifetime 30 days.

### 3.2 Products & courses

| Method | Path | Response |
|---|---|---|
| GET | `/api/products` | `{"products":[ProductSummary], "pro": {"price_cents":1900,"currency":"usd","interval":"month","enabled":bool}}` |
| GET | `/api/products/{id}` | `ProductDetail` (404 if unknown; drafts only for admins) |

`ProductSummary` = product yaml fields (minus `source`) + `{"lesson_count":n,"assessment_count":n,"exercise_count":n,"owned":bool,"via":"purchase|bundle|pro|admin|null","progress_percent":0-100}`.

`ProductDetail` = `ProductSummary` + :
```json
"lessons":[{"slug":"...","title":"...","order":1,"module":1,"module_title":"...","estimated_minutes":20,"preview":true,"locked":false,"completed":false,"summary":"..."}],
"assessments":[{"id":"...","title":"...","kind":"final","question_count":40,"time_limit_minutes":60,"pass_percent":70,"locked":false,"best_percent":null,"attempts":0}],
"exercises":[{"id":"...","title":"...","order":1,"domain":"...","difficulty":"...","mode":"legacy|scenario","scenario":null,"locked":false,"status":"idle|done"}],
"included_products":[ProductSummary]      // bundles only
```
`locked` = `!(preview || owned)`. Progress is per current user (all false/0 when anonymous).

### 3.3 Lessons, assessments, exercises

| Method | Path | Response |
|---|---|---|
| GET | `/api/courses/{product}/lessons/{slug}` | `Lesson` = frontmatter (minus source.model details) + `{"body": markdown, "prev":{slug,title}|null, "next":{slug,title}|null, "completed":bool, "scenario_items":[ScenarioSummary], "builder_items":[BuilderSummary]}`. **402 `payment_required`** with `{"product": id}` when locked. 401 when anonymous and not preview. |
| GET | `/api/courses/{product}/assessments/{id}` | assessment without `answer`/`explain` fields + `{"attempts":n,"best_percent":x|null}`; 402 when locked |
| POST | `/api/courses/{product}/assessments/{id}/submit` | `{"answers":{"0":2,"1":0}}` (question index → option index, missing = unanswered) → `{"score":n,"total":n,"percent":x,"passed":bool,"results":[{"index":0,"correct":true,"answer":2,"chosen":2,"explain":"..."}],"by_domain":{"<domain>":{"correct":n,"total":n}}}`; records a `quiz_attempts` row |
| GET | `/api/courses/{product}/exercises/{id}` | exercise yaml minus `legacy` + `{"setup_commands":[string],"locked":bool,"scenario_item":ScenarioSummary|null}` (`setup_commands` = `legacy.setup_commands`, the objects the task assumes) ; 402 when locked |

### 3.4 Realm content (existing routes, now access-aware)

`/api/realms`, `/api/builders`, `/api/lessons/{realm}`, `/api/scenarios` keep
their shapes. Each realm summary gains `"access":"free|pro"` and `"locked":bool`.
Scenario `load`/`reset` and builder `apply` return **402 `payment_required`**
(`{"product":"pro"}`) when the realm is `pro` and the user lacks entitlement
(never in `local` auth mode).

### 3.5 Progress (per user)

Existing shapes, now scoped to the current user and extended:

| Method | Path | Response |
|---|---|---|
| GET | `/api/progress` | `{"items":[ProgressItem],"totals":{builders,scenarios,lessons,course_lessons},"done":{...same keys},"courses":{"<product>":{"completed":n,"total":n,"percent":x}}}` |
| POST | `/api/progress` | `{kind,item_id,status,data?}` → ProgressItem. kinds: `builder`, `scenario`, `lesson` (realm lessons: `item_id = "<realm>/<slug>"`), `course_lesson` (`item_id = "<product>/<slug>"`), `exercise` (`"<product>/<id>"`), `assessment` (`"<product>/<id>"`) |
| DELETE | `/api/progress` | resets the current user's progress |

Lesson completion: `POST /api/progress {kind:"course_lesson", item_id:"cka-exam-prep/etcd-backup-restore", status:"completed", data:{"time_spent_s":600}}`.

### 3.6 Lab tokens & sync (runner ↔ platform)

| Method | Path | Response |
|---|---|---|
| GET | `/api/lab-tokens` | `{"tokens":[{"id","name","created_at","last_used_at"}]}` |
| POST | `/api/lab-tokens` | `{"name":"my laptop"}` → `{"id","name","token":"kal_..."}` (token shown once) |
| DELETE | `/api/lab-tokens/{id}` | `{"ok":true}` |
| POST | `/api/sync/progress` | Bearer `kal_...` only. `{"items":[{kind,item_id,status,data,updated_at}]}` → `{"accepted":n}`. Newer `updated_at` wins. |
| GET | `/api/sync/status` | runner side: `{"configured":bool,"platform_url":"...","last_sync":ts|null,"last_error":str|null}` |

Runner behaviour: when `KA_PLATFORM_URL` and `KA_LAB_TOKEN` are set, every local
progress write is also queued and pushed to the platform (fire-and-forget, retried
on the next write; failures never block the local write).

### 3.7 Billing (Stripe)

| Method | Path | Response |
|---|---|---|
| POST | `/api/billing/checkout` | `{"product":"<product-id>" \| "pro"}` → `{"url": "https://checkout.stripe.com/..."}`; 409 `billing_disabled` when Stripe is not configured; 409 `already_owned` |
| POST | `/api/billing/webhook` | Stripe-signed (`Stripe-Signature`). Handles `checkout.session.completed` (one-time → purchase row; subscription → tier pro), `customer.subscription.updated|deleted` (tier), `invoice.paid`. Idempotent via `webhook_events`. 400 on bad signature, 503 when unconfigured. |
| GET | `/api/billing/portal` | `{"url"}` (Stripe billing portal) |
| GET | `/api/billing/purchases` | `{"purchases":[{"product","amount_cents","currency","granted_at","expires_at"}],"subscription":{"status","current_period_end"}|null}` |

### 3.8 Admin (role admin)

| Method | Path | Response |
|---|---|---|
| GET | `/api/admin/users?q=` | `{"users":[User + {"purchases":[ids]}]}` |
| POST | `/api/admin/grant` | `{"email":"...","product":"<id>" \| "pro","note":"manual"}` → `{"ok":true}` — replaces KubeAdvisor's open purchase webhook |
| POST | `/api/admin/revoke` | same body → `{"ok":true}` |

### 3.9 Lab routes in hosted mode

`/api/cluster/*` (except `GET /api/cluster/status`, which returns
`{"lab_mode":"hosted","exists":false,...}`), `/api/scenarios/{id}/load|reset|cleanup|check|hint`,
`/api/builders/{id}/apply|lint`, and the `/ws/terminal` websocket answer
`409 {"error":"lab_mode_hosted","message":"Labs run in your local KubeAdvisor runner. Open Account → Lab runner."}`.
`GET` content routes keep working so the platform can show briefs, hints count, solutions (gated), etc.

---

## 4. Web app

Next.js 16, same shell/theme as the lab UI (dark ops console). Brand: **KubeAdvisor**.
All data goes through `web/src/lib/api.ts` (`req()` already attaches credentials;
cookies carry the session). `useMeta()` and `useAuth()` contexts expose modes and user.

Pages (new, in addition to the existing lab routes):

| Route | Purpose |
|---|---|
| `/` | landing: hero, the five realms, featured courses, Pro pitch, "run labs locally" explainer |
| `/courses` | catalog of products (cards: title, tagline, price or "Included in Pro" or "Owned", counts, progress) |
| `/courses/[product]` | product page: description, features, curriculum grouped by module with lock/check icons, assessments, exercises, buy / open buttons, exam-prep disclaimer |
| `/courses/[product]/[lesson]` | lesson viewer: markdown with Mermaid, objectives, quiz, prev/next, "mark complete", time tracking; paywall card on 402. "Run" (local runner) only on blocks fenced ```` ```bash lab ````: imported course blocks are mostly worked examples for fictional clusters |
| `/courses/[product]/assessments/[id]` | timed (if `time_limit_minutes>0`) multi-question exam; result screen with per-domain breakdown; attempts history |
| `/courses/[product]/exercises/[id]` | set-up block (runnable in the lab terminal) + task + hints (progressive) + solution reveal; if `mode: scenario`, a button that opens the scenario page; "mark done" |
| `/pricing` | Free vs Pro table + course cards; CTAs call checkout or route to signup; shows "billing not configured" state cleanly |
| `/login`, `/signup` | forms; redirect back to `?next=` |
| `/account` | profile, tier, purchases, Stripe portal link, lab tokens (create/copy once/revoke), runner setup snippet (`KA_PLATFORM_URL=… KA_LAB_TOKEN=… ./start.sh`), delete progress |
| `/progress` | existing page, now includes courses section |

Behaviour rules:
- In `auth_mode=local` hide login/signup/account-billing; show "Local runner" badge in the top bar.
- In `lab_mode=hosted`, lab pages (scenario detail, builder apply, cluster page) render a `RunnerBanner` explaining how to run locally, with a link to `/account#runner`; never show a dead terminal.
- Locked content shows a `Paywall` card (product title, price, "Buy course" + "Get Pro") and, when anonymous, "Sign in".
- Mermaid: `Markdown` component renders ```mermaid fences via dynamic import of `mermaid` (dark theme), client-only, with a fallback `<pre>` on error.
- Keep ESLint / `tsc --noEmit` / `next build` clean.

---

## 5. Repository layout

```
api/            FastAPI (lab engine + platform)
web/            Next.js
content/        all learning content (files are the source of truth)
cluster/ bin/   lab engine scripts (unchanged)
scripts/        validate_content.py, smoke_scenarios.py, import_kubeadvisor.py
deploy/         Dockerfiles, docker-compose.yml, example env files
docs/           CONTENT_GUIDE.md, PLATFORM_CONTRACT.md (this), MIGRATION.md
.github/        CI: api tests, web lint+build, content validation
```

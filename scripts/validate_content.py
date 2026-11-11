#!/usr/bin/env python3
"""Validate everything under content/. Exit 1 on any error.

Checks: unique ids, required fields, builder steps vs final_manifest,
lesson frontmatter, scenario scripts (shebang + bash -n), cross references,
and (PLATFORM_CONTRACT.md section 2) products, course lessons, assessments
and exercises: ids == file stems, enums, product/bundle/scenario/builder
references, quiz answer ranges, lesson order unique and == NN prefix,
one preview lesson per product (WARN), source.review pending (WARN).
"""
from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "content"
errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load_yaml(p: Path):
    try:
        return yaml.safe_load(p.read_text())
    except Exception as e:  # noqa: BLE001
        err(f"{p}: invalid YAML: {e}")
        return None


# ---------- path helpers (shared logic with api/app/services/validate.py) ----------
TOKEN = re.compile(r'\["([^"]+)"\]|\[(\d+)\]|([^.\[\]]+)')


def parse_path(path: str) -> list[str | int]:
    out: list[str | int] = []
    for m in TOKEN.finditer(path):
        if m.group(1) is not None:      # ["dotted.key"]
            out.append(m.group(1))
        elif m.group(2) is not None:    # [0]
            out.append(int(m.group(2)))
        else:
            out.append(m.group(3))
    return out


MISSING = object()


def get_path(doc, path: str):
    cur = doc
    for tok in parse_path(path):
        if isinstance(tok, int):
            if not isinstance(cur, list) or tok >= len(cur):
                return MISSING
            cur = cur[tok]
        else:
            if not isinstance(cur, dict) or tok not in cur:
                return MISSING
            cur = cur[tok]
    return cur


def check_expect(value, expect: dict) -> tuple[bool, str]:
    t = expect.get("type", "any")
    v = expect.get("value")
    if value is MISSING:
        return False, "field is missing"
    if t == "any":
        return True, ""
    if t == "exists":
        return True, ""
    if t == "equals":
        return (value == v, f"expected {v!r}, got {value!r}")
    if t == "regex":
        s = str(value) if not isinstance(value, bool) else str(value).lower()
        return (re.fullmatch(v, s) is not None, f"{value!r} does not match /{v}/")
    if t == "oneOf":
        return (value in v, f"{value!r} not in {v!r}")
    if t == "integer":
        return (isinstance(value, int) and not isinstance(value, bool), f"expected integer, got {type(value).__name__}")
    if t == "boolean":
        return (isinstance(value, bool), f"expected boolean, got {type(value).__name__}")
    if t == "list":
        if not isinstance(value, list):
            return False, "expected a list"
        cfg = v or {}
        if len(value) < cfg.get("min_items", 1):
            return False, f"need at least {cfg.get('min_items', 1)} item(s)"
        for k in cfg.get("item_keys", []):
            for i, item in enumerate(value):
                if not isinstance(item, dict) or k not in item:
                    return False, f"item {i} lacks key {k!r}"
        return True, ""
    return False, f"unknown expect type {t!r}"


# ---------- realms ----------
realms_doc = load_yaml(CONTENT / "realms.yaml") or {}
realm_ids = {r["id"] for r in realms_doc.get("realms", [])}
track_ids = {t["id"] for t in realms_doc.get("tracks", [])}
category_ids = {c["id"] for c in realms_doc.get("categories", [])}
addon_ids = {a["id"] for a in realms_doc.get("addons", [])}

# ---------- builders ----------
builder_ids: set[str] = set()
EXPECT_TYPES = {"equals", "regex", "oneOf", "any", "exists", "integer", "boolean", "list"}
for p in sorted((CONTENT / "builders").glob("*.yaml")):
    b = load_yaml(p)
    if not isinstance(b, dict):
        continue
    bid = b.get("id")
    if bid != p.stem:
        err(f"{p}: id {bid!r} must equal filename stem {p.stem!r}")
    if bid in builder_ids:
        err(f"{p}: duplicate builder id {bid}")
    builder_ids.add(bid)
    for f in ["title", "kind", "apiVersion", "track", "difficulty", "estimated_minutes", "summary", "intro", "steps", "final_manifest"]:
        if f not in b:
            err(f"{p}: missing field {f!r}")
    if b.get("realm", "manifests") != "manifests":
        err(f"{p}: realm must be manifests")
    if b.get("track") not in track_ids:
        err(f"{p}: unknown track {b.get('track')!r}")
    if b.get("difficulty") not in {"beginner", "intermediate", "advanced"}:
        err(f"{p}: bad difficulty")
    steps = b.get("steps") or []
    if not (6 <= len(steps) <= 20):
        warn(f"{p}: {len(steps)} steps (guide says 8-18)")
    try:
        final = yaml.safe_load(b.get("final_manifest") or "")
    except Exception as e:  # noqa: BLE001
        err(f"{p}: final_manifest invalid YAML: {e}")
        final = None
    if isinstance(final, dict):
        if "kind" in final and final.get("kind") != b.get("kind"):
            err(f"{p}: final_manifest.kind != kind")
        if "apiVersion" in final and final.get("apiVersion") != b.get("apiVersion"):
            err(f"{p}: final_manifest.apiVersion != apiVersion")
    seen_paths: set[str] = set()
    for i, s in enumerate(steps):
        where = f"{p} step {i+1} ({s.get('path')})"
        for f in ["path", "title", "prompt", "why", "hint", "expect", "reveal"]:
            if f not in s:
                err(f"{where}: missing {f!r}")
        if s.get("path") in seen_paths:
            err(f"{where}: duplicate path")
        seen_paths.add(s.get("path"))
        if len(str(s.get("hint", ""))) > 140:
            warn(f"{where}: hint longer than 140 chars")
        ex = s.get("expect") or {}
        if ex.get("type") not in EXPECT_TYPES:
            err(f"{where}: bad expect.type {ex.get('type')!r}")
        if ex.get("type") == "regex":
            try:
                re.compile(ex.get("value", ""))
            except re.error as e:
                err(f"{where}: bad regex: {e}")
        if isinstance(final, dict) and s.get("path"):
            ok, msg = check_expect(get_path(final, s["path"]), ex)
            if not ok:
                err(f"{where}: final_manifest fails expect: {msg}")
        try:
            yaml.safe_load(s.get("reveal") or "")
        except Exception as e:  # noqa: BLE001
            err(f"{where}: reveal is not valid YAML: {e}")
    for pre in b.get("prerequisites") or []:
        if not (CONTENT / "builders" / f"{pre}.yaml").exists():
            warn(f"{p}: prerequisite {pre!r} does not exist")
    for a in (b.get("apply") or {}).get("requires_addons", []) or []:
        if a not in addon_ids:
            err(f"{p}: unknown addon {a!r}")
    for i, q in enumerate(b.get("quiz") or []):
        if not isinstance(q.get("answer"), int) or not (0 <= q["answer"] < len(q.get("options", []))):
            err(f"{p}: quiz {i+1} answer index out of range")

# ---------- lessons ----------
FM = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)
lesson_ids: set[str] = set()
for p in sorted((CONTENT / "lessons").rglob("*.md")):
    realm = p.parent.name
    m = FM.match(p.read_text())
    if not m:
        err(f"{p}: missing frontmatter")
        continue
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except Exception as e:  # noqa: BLE001
        err(f"{p}: bad frontmatter: {e}")
        continue
    body = m.group(2)
    for f in ["title", "slug", "realm", "order", "summary", "estimated_minutes", "level"]:
        if f not in fm:
            err(f"{p}: frontmatter missing {f!r}")
    stem_slug = re.sub(r"^\d+-", "", p.stem)
    if fm.get("slug") != stem_slug:
        err(f"{p}: slug {fm.get('slug')!r} must equal {stem_slug!r}")
    if fm.get("realm") != realm:
        err(f"{p}: realm {fm.get('realm')!r} must equal directory {realm!r}")
    if realm not in realm_ids:
        err(f"{p}: unknown realm dir {realm}")
    key = f"{realm}/{fm.get('slug')}"
    if key in lesson_ids:
        err(f"{p}: duplicate lesson {key}")
    lesson_ids.add(key)
    words = len(body.split())
    if words < 300:
        warn(f"{p}: only {words} words")
    for bq in fm.get("builders") or []:
        if bq not in builder_ids:
            err(f"{p}: unknown builder ref {bq!r}")
    for i, q in enumerate(fm.get("quiz") or []):
        if not isinstance(q.get("answer"), int) or not (0 <= q["answer"] < len(q.get("options", []))):
            err(f"{p}: quiz {i+1} answer index out of range")

# ---------- scenarios ----------
scenario_ids: set[str] = set()
scenario_lesson_refs: list[tuple[Path, str]] = []
lesson_scenario_refs: list[tuple[Path, str]] = []
for d in sorted((CONTENT / "scenarios").iterdir()):
    if not d.is_dir():
        continue
    sy = d / "scenario.yaml"
    if not sy.exists():
        err(f"{d}: missing scenario.yaml")
        continue
    s = load_yaml(sy)
    if not isinstance(s, dict):
        continue
    sid = s.get("id")
    if sid != d.name:
        err(f"{sy}: id {sid!r} must equal directory {d.name!r}")
    scenario_ids.add(sid)
    for f in ["title", "category", "type", "difficulty", "estimated_minutes", "summary", "brief", "namespace", "hints", "checks"]:
        if f not in s:
            err(f"{sy}: missing {f!r}")
    if s.get("category") not in category_ids:
        err(f"{sy}: unknown category {s.get('category')!r}")
    if s.get("type") not in {"troubleshoot", "build"}:
        err(f"{sy}: type must be troubleshoot|build")
    if s.get("difficulty") not in {"beginner", "intermediate", "advanced"}:
        err(f"{sy}: bad difficulty")
    for a in s.get("requires_addons") or []:
        if a not in addon_ids:
            err(f"{sy}: unknown addon {a!r}")
    ns = str(s.get("namespace", ""))
    if not (ns.startswith("lab-") or ns in {"flux-system", "kube-system", "default"}):
        warn(f"{sy}: namespace {ns!r} not lab-* prefixed")
    if "## Your task" not in str(s.get("brief", "")):
        warn(f"{sy}: brief lacks '## Your task' section")
    hints = s.get("hints") or []
    if not (2 <= len(hints) <= 6):
        warn(f"{sy}: {len(hints)} hints (guide says 3-5)")
    for i, c in enumerate(s.get("checks") or []):
        if not isinstance(c, dict) or "name" not in c or "cmd" not in c:
            err(f"{sy}: check {i+1} needs name and cmd")
    for rl in s.get("related_lessons") or []:
        scenario_lesson_refs.append((sy, rl))
    for script in ["setup.sh", "cleanup.sh"]:
        sp = d / script
        if not sp.exists():
            err(f"{d}: missing {script}")
            continue
        text = sp.read_text()
        if not text.startswith("#!/usr/bin/env bash"):
            err(f"{sp}: must start with #!/usr/bin/env bash")
        if "set -euo pipefail" not in text:
            err(f"{sp}: missing set -euo pipefail")
        if 'cluster/lib.sh' not in text:
            warn(f"{sp}: does not source cluster/lib.sh")
        r = subprocess.run(["bash", "-n", str(sp)], capture_output=True, text=True)
        if r.returncode != 0:
            err(f"{sp}: bash -n failed: {r.stderr.strip()}")
    if not (d / "solution.md").exists():
        err(f"{d}: missing solution.md")
    else:
        sol = (d / "solution.md").read_text()
        for sec in ["## Diagnosis", "## Root cause", "## Fix", "## Prevention"]:
            if sec not in sol:
                warn(f"{d}/solution.md: missing section {sec}")

for p, ref in scenario_lesson_refs:
    if ref not in lesson_ids:
        warn(f"{p}: related lesson {ref!r} not found")

# lessons -> scenarios
for p in sorted((CONTENT / "lessons").rglob("*.md")):
    m = FM.match(p.read_text())
    if not m:
        continue
    fm = yaml.safe_load(m.group(1)) or {}
    for sc in fm.get("scenarios") or []:
        if sc not in scenario_ids:
            warn(f"{p}: scenario ref {sc!r} not found")

# ---------- realms: access ----------
for r in realms_doc.get("realms", []):
    if "access" in r and r.get("access") not in {"free", "pro"}:
        err(f"realms.yaml: realm {r.get('id')} access must be free|pro")

# ---------- products ----------
LEVEL_SET = {"beginner", "intermediate", "advanced"}
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
CERT_RE = re.compile(r"certif(ied|ication)", re.I)
NN_RE = re.compile(r"^(\d{2})-(.+)$")
PRODUCTS = CONTENT / "products"
products: dict[str, dict] = {}
if PRODUCTS.exists():
    for p in sorted(PRODUCTS.glob("*.yaml")):
        d = load_yaml(p)
        if not isinstance(d, dict):
            err(f"{p}: not a mapping")
            continue
        pid = d.get("id")
        if pid != p.stem:
            err(f"{p}: id {pid!r} must equal filename stem {p.stem!r}")
        if not isinstance(pid, str) or not ID_RE.match(pid):
            err(f"{p}: id must be kebab-case")
        if pid in products:
            err(f"{p}: duplicate product id {pid}")
        products[pid] = d
        for f in ["title", "kind", "status", "order", "price_cents", "currency", "description", "difficulty"]:
            if f not in d:
                err(f"{p}: missing field {f!r}")
        if d.get("kind") not in {"course", "bundle"}:
            err(f"{p}: kind must be course|bundle")
        if d.get("status") not in {"active", "draft"}:
            err(f"{p}: status must be active|draft")
        if d.get("difficulty") not in LEVEL_SET:
            err(f"{p}: bad difficulty {d.get('difficulty')!r}")
        if not isinstance(d.get("price_cents"), int) or isinstance(d.get("price_cents"), bool) or d["price_cents"] < 0:
            err(f"{p}: price_cents must be a non-negative integer")
        if not isinstance(d.get("order"), int):
            err(f"{p}: order must be an integer")
        if CERT_RE.search(str(d.get("title", ""))):
            err(f"{p}: title must say 'Exam Preparation', never 'certified'/'certification'")
        if CERT_RE.search(str(d.get("tagline", ""))):
            warn(f"{p}: tagline uses 'certified'/'certification' wording")
        inc = d.get("includes") or []
        if d.get("kind") == "bundle" and not inc:
            err(f"{p}: a bundle must list the products it includes")
        if d.get("kind") != "bundle" and inc:
            warn(f"{p}: includes is only meaningful for bundles")
        doms = d.get("exam_domains") or []
        seen_dom: set[str] = set()
        for i, ed in enumerate(doms):
            if not isinstance(ed, dict) or not {"id", "title", "weight"} <= set(ed):
                err(f"{p}: exam_domains[{i}] needs id, title, weight")
                continue
            if ed["id"] in seen_dom:
                err(f"{p}: duplicate exam domain {ed['id']}")
            seen_dom.add(ed["id"])
        if doms and sum(int(ed.get("weight", 0)) for ed in doms if isinstance(ed, dict)) != 100:
            warn(f"{p}: exam domain weights do not sum to 100")
    for pid, d in products.items():
        for inc in d.get("includes") or []:
            if inc not in products:
                err(f"products/{pid}.yaml: includes unknown product {inc!r}")
            elif products[inc].get("kind") == "bundle":
                err(f"products/{pid}.yaml: a bundle cannot include another bundle ({inc})")
    for o, n in Counter(d.get("order") for d in products.values()).items():
        if n > 1:
            warn(f"products: order {o} is used by {n} products")


def product_domains(pid: str) -> set[str]:
    return {ed.get("id") for ed in (products.get(pid, {}).get("exam_domains") or []) if isinstance(ed, dict)}


def check_questions(where: str, qs, domains: set[str]) -> None:
    if not isinstance(qs, list):
        err(f"{where}: questions must be a list")
        return
    for i, q in enumerate(qs):
        tag = f"{where}: question {i + 1}"
        if not isinstance(q, dict):
            err(f"{tag}: not a mapping")
            continue
        for f in ["q", "options", "answer", "explain"]:
            if f not in q:
                err(f"{tag}: missing {f!r}")
        opts = q.get("options")
        if not isinstance(opts, list) or len(opts) < 2:
            err(f"{tag}: needs at least 2 options")
        ans = q.get("answer")
        if not isinstance(ans, int) or isinstance(ans, bool) or not (0 <= ans < len(opts or [])):
            err(f"{tag}: answer index out of range")
        if "difficulty" in q and q["difficulty"] not in {"easy", "medium", "hard"}:
            err(f"{tag}: difficulty must be easy|medium|hard")
        if q.get("domain") and domains and q["domain"] not in domains:
            warn(f"{tag}: domain {q['domain']!r} is not an exam domain of the product")


# ---------- course lessons + assessments ----------
COURSES = CONTENT / "courses"
course_lesson_count = 0
assessment_count = 0
if COURSES.exists():
    for pdir in sorted(COURSES.iterdir()):
        if not pdir.is_dir():
            continue
        pid = pdir.name
        if pid not in products:
            err(f"{pdir}: no product {pid!r} in content/products")
        domains = product_domains(pid)
        orders: dict = {}
        slugs: set[str] = set()
        previews = 0
        n_lessons = 0
        for p in sorted(pdir.glob("*.md")):
            n_lessons += 1
            m = FM.match(p.read_text())
            if not m:
                err(f"{p}: missing frontmatter")
                continue
            try:
                fm = yaml.safe_load(m.group(1)) or {}
            except Exception as e:  # noqa: BLE001
                err(f"{p}: bad frontmatter: {e}")
                continue
            body = m.group(2)
            for f in ["title", "slug", "product", "order", "module", "module_title", "summary", "estimated_minutes", "level", "preview"]:
                if f not in fm:
                    err(f"{p}: frontmatter missing {f!r}")
            nm = NN_RE.match(p.stem)
            if not nm:
                err(f"{p}: filename must be NN-<slug>.md")
                continue
            nn, stem_slug = int(nm.group(1)), nm.group(2)
            if fm.get("slug") != stem_slug:
                err(f"{p}: slug {fm.get('slug')!r} must equal {stem_slug!r}")
            if not ID_RE.match(str(fm.get("slug"))):
                err(f"{p}: slug must be kebab-case")
            if fm.get("product") != pid:
                err(f"{p}: product {fm.get('product')!r} must equal directory {pid!r}")
            if fm.get("order") != nn:
                err(f"{p}: order {fm.get('order')!r} must equal filename prefix {nn}")
            if fm.get("order") in orders:
                err(f"{p}: order {fm.get('order')} already used by {orders[fm.get('order')]}")
            orders[fm.get("order")] = p.name
            if fm.get("slug") in slugs:
                err(f"{p}: duplicate slug {fm.get('slug')!r} in product")
            slugs.add(fm.get("slug"))
            if not isinstance(fm.get("module"), int) or isinstance(fm.get("module"), bool) or fm["module"] < 1:
                err(f"{p}: module must be an integer >= 1")
            if fm.get("level") not in LEVEL_SET:
                err(f"{p}: bad level {fm.get('level')!r}")
            if not isinstance(fm.get("preview"), bool):
                err(f"{p}: preview must be true|false")
            elif fm["preview"]:
                previews += 1
            if fm.get("domain"):
                if domains and fm["domain"] not in domains:
                    err(f"{p}: domain {fm['domain']!r} is not an exam domain of {pid}")
                elif not domains:
                    warn(f"{p}: domain set but product {pid} has no exam_domains")
            for sc in fm.get("scenarios") or []:
                if sc not in scenario_ids:
                    err(f"{p}: unknown scenario ref {sc!r}")
            for b in fm.get("builders") or []:
                if b not in builder_ids:
                    err(f"{p}: unknown builder ref {b!r}")
            if fm.get("quiz"):
                check_questions(str(p), fm["quiz"], domains)
            src = fm.get("source") or {}
            if src:
                if src.get("review", "pending") == "pending":
                    warn(f"{p}: source.review pending")
                elif src.get("review") != "reviewed":
                    err(f"{p}: source.review must be pending|reviewed")
            if CERT_RE.search(str(fm.get("title", ""))):
                warn(f"{p}: title uses 'certified'/'certification' wording")
            words = len(body.split())
            if words < 100:
                warn(f"{p}: only {words} words")
            course_lesson_count += 1
        if n_lessons and previews == 0:
            warn(f"{pdir}: no lesson has preview: true")
        if previews > 1:
            warn(f"{pdir}: {previews} lessons have preview: true (expected exactly one)")

        adir = pdir / "assessments"
        a_orders: dict = {}
        if adir.exists():
            for p in sorted(adir.glob("*.yaml")):
                a = load_yaml(p)
                if not isinstance(a, dict):
                    err(f"{p}: not a mapping")
                    continue
                if a.get("id") != p.stem:
                    err(f"{p}: id {a.get('id')!r} must equal filename stem {p.stem!r}")
                if not ID_RE.match(str(a.get("id"))):
                    err(f"{p}: id must be kebab-case")
                for f in ["title", "product", "kind", "time_limit_minutes", "pass_percent", "order", "questions"]:
                    if f not in a:
                        err(f"{p}: missing field {f!r}")
                if a.get("product") != pid:
                    err(f"{p}: product {a.get('product')!r} must equal directory {pid!r}")
                if a.get("kind") not in {"pre", "final", "domain", "practice"}:
                    err(f"{p}: kind must be pre|final|domain|practice")
                pp = a.get("pass_percent")
                if not isinstance(pp, int) or isinstance(pp, bool) or not (0 <= pp <= 100):
                    err(f"{p}: pass_percent must be an integer 0-100")
                tl = a.get("time_limit_minutes")
                if not isinstance(tl, int) or isinstance(tl, bool) or tl < 0:
                    err(f"{p}: time_limit_minutes must be an integer >= 0 (0 = untimed)")
                if a.get("kind") == "domain" and not a.get("domain"):
                    err(f"{p}: kind domain requires a domain")
                if a.get("domain"):
                    if domains and a["domain"] not in domains:
                        err(f"{p}: domain {a['domain']!r} is not an exam domain of {pid}")
                    elif not domains:
                        warn(f"{p}: domain set but product {pid} has no exam_domains")
                if not a.get("questions"):
                    err(f"{p}: no questions")
                check_questions(str(p), a.get("questions") or [], domains)
                if CERT_RE.search(str(a.get("title", ""))):
                    warn(f"{p}: title uses 'certified'/'certification' wording")
                if a.get("order") in a_orders:
                    warn(f"{p}: order {a.get('order')} already used by {a_orders[a.get('order')]}")
                a_orders[a.get("order")] = p.name
                assessment_count += 1
for pid, d in products.items():
    if d.get("kind") == "course" and not (COURSES / pid).is_dir():
        warn(f"products/{pid}.yaml: course has no content/courses/{pid}/ directory")

# ---------- exercises ----------
EXERCISES = CONTENT / "exercises"
exercise_count = 0
if EXERCISES.exists():
    for pdir in sorted(EXERCISES.iterdir()):
        if not pdir.is_dir():
            continue
        pid = pdir.name
        if pid not in products:
            err(f"{pdir}: no product {pid!r} in content/products")
        orders = {}
        ex_ids: set[str] = set()
        for p in sorted(pdir.glob("*.yaml")):
            e = load_yaml(p)
            if not isinstance(e, dict):
                err(f"{p}: not a mapping")
                continue
            nm = NN_RE.match(p.stem)
            if not nm:
                err(f"{p}: filename must be NN-<id>.yaml")
                continue
            nn, stem_id = int(nm.group(1)), nm.group(2)
            if e.get("id") != stem_id:
                err(f"{p}: id {e.get('id')!r} must equal {stem_id!r}")
            if not ID_RE.match(str(e.get("id"))):
                err(f"{p}: id must be kebab-case")
            if e.get("id") in ex_ids:
                err(f"{p}: duplicate exercise id {e.get('id')!r} in product")
            ex_ids.add(e.get("id"))
            for f in ["title", "product", "order", "domain", "difficulty", "objective", "task", "hints",
                      "solution_commands", "time_limit_minutes", "points", "mode"]:
                if f not in e:
                    err(f"{p}: missing field {f!r}")
            if e.get("product") != pid:
                err(f"{p}: product {e.get('product')!r} must equal directory {pid!r}")
            if e.get("order") != nn:
                err(f"{p}: order {e.get('order')!r} must equal filename prefix {nn}")
            if e.get("order") in orders:
                err(f"{p}: order {e.get('order')} already used by {orders[e.get('order')]}")
            orders[e.get("order")] = p.name
            if e.get("difficulty") not in LEVEL_SET:
                err(f"{p}: bad difficulty {e.get('difficulty')!r}")
            if e.get("mode") not in {"legacy", "scenario"}:
                err(f"{p}: mode must be legacy|scenario")
            sc = e.get("scenario")
            if e.get("mode") == "scenario" and not sc:
                err(f"{p}: mode scenario requires a scenario id")
            if sc is not None and sc not in scenario_ids:
                err(f"{p}: unknown scenario {sc!r}")
            ss = e.get("suggested_scenario")
            if ss is not None and ss not in scenario_ids:
                err(f"{p}: unknown suggested_scenario {ss!r}")
            for f in ["hints", "solution_commands"]:
                if not isinstance(e.get(f), list):
                    err(f"{p}: {f} must be a list")
            for f in ["time_limit_minutes", "points"]:
                v = e.get(f)
                if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                    err(f"{p}: {f} must be a non-negative integer")
            if not isinstance(e.get("legacy"), dict):
                warn(f"{p}: legacy block missing")
            exercise_count += 1

print(
    f"builders={len(builder_ids)} lessons={len(lesson_ids)} scenarios={len(scenario_ids)} "
    f"products={len(products)} course_lessons={course_lesson_count} assessments={assessment_count} "
    f"exercises={exercise_count}"
)
for w in warnings:
    print(f"WARN  {w}")
for e in errors:
    print(f"ERROR {e}")
sys.exit(1 if errors else 0)

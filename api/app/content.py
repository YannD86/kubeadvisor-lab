"""Load realms, builders, lessons and scenarios from content/ with mtime caching."""
from __future__ import annotations

import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from app.config import CONTENT_DIR

FM_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)
_cache: dict[str, tuple[float, Any]] = {}
_last_scan = 0.0


def _tree_mtime() -> float:
    """Newest mtime under content/ (cheap enough for a few hundred files)."""
    global _last_scan
    now = time.time()
    if now - _last_scan < 2.0 and "tree" in _cache:
        return _cache["tree"][1]
    newest = 0.0
    for p in CONTENT_DIR.rglob("*"):
        if p.is_file():
            m = p.stat().st_mtime
            if m > newest:
                newest = m
    _cache["tree"] = (now, newest)
    _last_scan = now
    return newest


def _cached(key: str, loader):
    mt = _tree_mtime()
    hit = _cache.get(key)
    if hit and hit[0] == mt:
        return hit[1]
    val = loader()
    _cache[key] = (mt, val)
    return val


# ---------------- realms ----------------
def realms_doc() -> dict:
    return _cached("realms", lambda: yaml.safe_load((CONTENT_DIR / "realms.yaml").read_text()) or {})


def list_realms() -> list[dict]:
    rs = sorted(realms_doc().get("realms", []), key=lambda r: r.get("order", 0))
    counts = {
        "manifests": len(list_builders()),
        "scenarios": len(list_scenarios()),
    }
    out = []
    for r in rs:
        r = dict(r)
        r["access"] = r.get("access") or "free"
        if r["kind"] == "lessons":
            r["item_count"] = len(list_lessons(r["id"]))
        else:
            r["item_count"] = counts.get(r["id"], 0)
        out.append(r)
    return out


def get_realm(rid: str) -> dict | None:
    return next((r for r in list_realms() if r["id"] == rid), None)


# ---------------- builders ----------------
def _load_builders() -> dict[str, dict]:
    out = {}
    for p in sorted((CONTENT_DIR / "builders").glob("*.yaml")):
        try:
            b = yaml.safe_load(p.read_text())
        except Exception as e:  # noqa: BLE001
            b = {"id": p.stem, "title": f"INVALID: {p.name}", "error": str(e), "steps": []}
        if isinstance(b, dict):
            b.setdefault("id", p.stem)
            b["step_count"] = len(b.get("steps") or [])
            out[b["id"]] = b
    return out


def list_builders() -> list[dict]:
    bs = _cached("builders", _load_builders)
    tracks = {t["id"]: i for i, t in enumerate(realms_doc().get("tracks", []))}
    diff = {"beginner": 0, "intermediate": 1, "advanced": 2}
    summary_fields = ["id", "title", "kind", "apiVersion", "track", "difficulty", "estimated_minutes", "summary", "crd", "step_count", "prerequisites", "docs_url"]
    items = [{k: b.get(k) for k in summary_fields} for b in bs.values()]
    return sorted(items, key=lambda b: (tracks.get(b["track"], 99), diff.get(b["difficulty"], 9), b["title"]))


def get_builder(bid: str) -> dict | None:
    return _cached("builders", _load_builders).get(bid)


# ---------------- lessons ----------------
def _parse_lesson(p: Path) -> dict | None:
    m = FM_RE.match(p.read_text())
    if not m:
        return None
    fm = yaml.safe_load(m.group(1)) or {}
    fm["body"] = m.group(2)
    fm["realm"] = fm.get("realm") or p.parent.name
    fm.setdefault("slug", re.sub(r"^\d+-", "", p.stem))
    fm["word_count"] = len(m.group(2).split())
    return fm


def _load_lessons() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for d in sorted((CONTENT_DIR / "lessons").iterdir()):
        if not d.is_dir():
            continue
        items = [l for l in (_parse_lesson(p) for p in sorted(d.glob("*.md"))) if l]
        items.sort(key=lambda l: l.get("order", 0))
        out[d.name] = items
    return out


def list_lessons(realm: str) -> list[dict]:
    items = _cached("lessons", _load_lessons).get(realm, [])
    fields = ["title", "slug", "realm", "order", "summary", "estimated_minutes", "level", "tags", "builders", "scenarios", "diagram", "word_count"]
    return [{k: l.get(k) for k in fields} | {"quiz_count": len(l.get("quiz") or [])} for l in items]


def get_lesson(realm: str, slug: str) -> dict | None:
    items = _cached("lessons", _load_lessons).get(realm, [])
    for i, l in enumerate(items):
        if l.get("slug") == slug:
            out = dict(l)
            out["prev"] = {"slug": items[i - 1]["slug"], "title": items[i - 1]["title"]} if i > 0 else None
            out["next"] = {"slug": items[i + 1]["slug"], "title": items[i + 1]["title"]} if i + 1 < len(items) else None
            return out
    return None


# ---------------- scenarios ----------------
def _load_scenarios() -> dict[str, dict]:
    out = {}
    for d in sorted((CONTENT_DIR / "scenarios").iterdir()):
        sy = d / "scenario.yaml"
        if not d.is_dir() or not sy.exists():
            continue
        try:
            s = yaml.safe_load(sy.read_text())
        except Exception as e:  # noqa: BLE001
            s = {"id": d.name, "title": f"INVALID: {d.name}", "error": str(e)}
        if not isinstance(s, dict):
            continue
        s.setdefault("id", d.name)
        s["dir"] = str(d)
        s["has_setup"] = (d / "setup.sh").exists()
        s["has_cleanup"] = (d / "cleanup.sh").exists()
        s["has_solution"] = (d / "solution.md").exists()
        s["check_count"] = len(s.get("checks") or [])
        s["hint_count"] = len(s.get("hints") or [])
        out[s["id"]] = s
    return out


def list_scenarios() -> list[dict]:
    ss = _cached("scenarios", _load_scenarios)
    cats = {c["id"]: i for i, c in enumerate(realms_doc().get("categories", []))}
    diff = {"beginner": 0, "intermediate": 1, "advanced": 2}
    fields = ["id", "title", "category", "type", "difficulty", "estimated_minutes", "tags", "requires_addons", "summary", "namespace", "check_count", "hint_count", "related_lessons"]
    items = [{k: s.get(k) for k in fields} for s in ss.values()]
    return sorted(items, key=lambda s: (cats.get(s["category"], 99), diff.get(s["difficulty"], 9), s["title"]))


def get_scenario(sid: str) -> dict | None:
    s = _cached("scenarios", _load_scenarios).get(sid)
    if not s:
        return None
    return dict(s)


def scenario_solution(sid: str) -> str | None:
    s = get_scenario(sid)
    if not s:
        return None
    p = Path(s["dir"]) / "solution.md"
    return p.read_text() if p.exists() else None


# ---------------- products / courses / assessments / exercises ----------------
PRODUCT_SUMMARY_FIELDS = ["id", "title", "kind", "status", "order", "featured", "price_cents", "currency", "tagline",
                          "difficulty", "duration_hours", "includes", "exam_domains", "features", "disclaimer"]


def _load_products() -> dict[str, dict]:
    out: dict[str, dict] = {}
    d = CONTENT_DIR / "products"
    if not d.exists():
        return out
    for p in sorted(d.glob("*.yaml")):
        try:
            prod = yaml.safe_load(p.read_text())
        except Exception as e:  # noqa: BLE001
            prod = {"id": p.stem, "title": f"INVALID: {p.name}", "error": str(e)}
        if isinstance(prod, dict):
            prod.setdefault("id", p.stem)
            prod.setdefault("kind", "course")
            prod.setdefault("status", "active")
            prod.setdefault("includes", [])
            out[prod["id"]] = prod
    return out


def list_products(include_draft: bool = False) -> list[dict]:
    ps = _cached("products", _load_products).values()
    items = [dict(p) for p in ps if include_draft or p.get("status", "active") == "active"]
    return sorted(items, key=lambda p: (p.get("order", 99), p.get("title", "")))


def get_product(pid: str) -> dict | None:
    p = _cached("products", _load_products).get(pid)
    return dict(p) if p else None


def _load_courses() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    root = CONTENT_DIR / "courses"
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        items = []
        for p in sorted(d.glob("*.md")):
            l = _parse_lesson(p)
            if not l:
                continue
            l.pop("realm", None)
            l["product"] = l.get("product") or d.name
            l.setdefault("preview", False)
            l.setdefault("module", 1)
            items.append(l)
        items.sort(key=lambda l: (l.get("order", 0), l.get("title", "")))
        out[d.name] = items
    return out


COURSE_LESSON_FIELDS = ["title", "slug", "product", "order", "module", "module_title", "summary", "estimated_minutes",
                        "level", "tags", "preview", "domain", "scenarios", "builders", "word_count"]


def list_course_lessons(pid: str) -> list[dict]:
    items = _cached("courses", _load_courses).get(pid, [])
    return [{k: l.get(k) for k in COURSE_LESSON_FIELDS} | {"quiz_count": len(l.get("quiz") or [])} for l in items]


def get_course_lesson(pid: str, slug: str) -> dict | None:
    items = _cached("courses", _load_courses).get(pid, [])
    for i, l in enumerate(items):
        if l.get("slug") == slug:
            out = dict(l)
            out["prev"] = {"slug": items[i - 1]["slug"], "title": items[i - 1]["title"]} if i > 0 else None
            out["next"] = {"slug": items[i + 1]["slug"], "title": items[i + 1]["title"]} if i + 1 < len(items) else None
            return out
    return None


def _load_yaml_dir(sub: str, strip_prefix: bool) -> dict[str, list[dict]]:
    """content/<sub>/<product>/*.yaml  (assessments live under courses/<product>/assessments)."""
    out: dict[str, list[dict]] = {}
    root = CONTENT_DIR / sub
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        files = sorted((d / "assessments").glob("*.yaml")) if sub == "courses" else sorted(d.glob("*.yaml"))
        items = []
        for p in files:
            try:
                obj = yaml.safe_load(p.read_text())
            except Exception as e:  # noqa: BLE001
                obj = {"id": p.stem, "title": f"INVALID: {p.name}", "error": str(e)}
            if not isinstance(obj, dict):
                continue
            obj.setdefault("id", re.sub(r"^\d+-", "", p.stem) if strip_prefix else p.stem)
            obj["product"] = obj.get("product") or d.name
            items.append(obj)
        items.sort(key=lambda o: (o.get("order", 99), o.get("title", "")))
        out[d.name] = items
    return out


def list_assessments(pid: str) -> list[dict]:
    return [dict(a) for a in _cached("assessments", lambda: _load_yaml_dir("courses", False)).get(pid, [])]


def get_assessment(pid: str, aid: str) -> dict | None:
    return next((dict(a) for a in list_assessments(pid) if a.get("id") == aid), None)


def list_exercises(pid: str) -> list[dict]:
    return [dict(e) for e in _cached("exercises", lambda: _load_yaml_dir("exercises", True)).get(pid, [])]


def get_exercise(pid: str, eid: str) -> dict | None:
    return next((dict(e) for e in list_exercises(pid) if e.get("id") == eid), None)

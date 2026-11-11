"""Manifest-builder validation: step checks, YAML parsing, kubeconform and kubectl apply."""
from __future__ import annotations

import asyncio
import re
import shutil
from typing import Any

import yaml

from app.config import KUBECONFIG

TOKEN = re.compile(r'\["([^"]+)"\]|\[(\d+)\]|([^.\[\]]+)')
MISSING = object()


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


def get_path(doc: Any, path: str) -> Any:
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


def check_expect(value: Any, expect: dict) -> tuple[bool, str]:
    t = (expect or {}).get("type", "any")
    v = (expect or {}).get("value")
    if value is MISSING:
        return False, "field is missing"
    if t in ("any", "exists"):
        return True, "present"
    if t == "equals":
        return (value == v, "ok" if value == v else f"expected {v!r}, got {value!r}")
    if t == "regex":
        s = str(value).lower() if isinstance(value, bool) else str(value)
        ok = re.fullmatch(v, s) is not None
        return ok, "ok" if ok else f"{value!r} does not match the expected pattern"
    if t == "oneOf":
        ok = value in (v or [])
        return ok, "ok" if ok else f"{value!r} is not one of {v!r}"
    if t == "integer":
        ok = isinstance(value, int) and not isinstance(value, bool)
        return ok, "ok" if ok else f"expected an integer, got {type(value).__name__} ({value!r}); unquoted numbers only"
    if t == "boolean":
        ok = isinstance(value, bool)
        return ok, "ok" if ok else f"expected true/false, got {type(value).__name__} ({value!r})"
    if t == "list":
        if not isinstance(value, list):
            return False, "expected a YAML list (items start with '- ')"
        cfg = v or {}
        if len(value) < cfg.get("min_items", 1):
            return False, f"need at least {cfg.get('min_items', 1)} item(s)"
        for k in cfg.get("item_keys", []):
            for i, item in enumerate(value):
                if not isinstance(item, dict) or k not in item:
                    return False, f"item {i + 1} lacks key '{k}'"
        return True, "ok"
    return False, f"unknown expect type {t!r}"


def parse_yaml(text: str) -> tuple[Any, str | None]:
    try:
        docs = list(yaml.safe_load_all(text))
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark else ""
        problem = getattr(e, "problem", None) or str(e)
        return None, f"YAML error{where}: {problem}"
    docs = [d for d in docs if d is not None]
    if not docs:
        return None, "The document is empty."
    if len(docs) > 1:
        return None, "Only one document (one object) is expected in this activity."
    if not isinstance(docs[0], dict):
        return None, "The top level must be a mapping (key: value lines)."
    return docs[0], None


def evaluate_steps(builder: dict, text: str) -> dict:
    """Evaluate every step against the learner's YAML. Returns per-step results."""
    doc, err = parse_yaml(text)
    steps = builder.get("steps") or []
    if err:
        return {
            "parse_ok": False,
            "error": err,
            "steps": [{"index": i, "path": s["path"], "status": "unknown", "message": ""} for i, s in enumerate(steps)],
            "passed": 0,
            "total": len(steps),
            "complete": False,
        }
    results = []
    passed = 0
    for i, s in enumerate(steps):
        val = get_path(doc, s["path"])
        if val is MISSING:
            results.append({"index": i, "path": s["path"], "status": "missing", "message": "not present yet"})
            continue
        ok, msg = check_expect(val, s.get("expect") or {})
        results.append({"index": i, "path": s["path"], "status": "pass" if ok else "fail", "message": msg})
        if ok:
            passed += 1
    kind_ok = doc.get("kind") == builder.get("kind") if "kind" in doc else True
    return {
        "parse_ok": True,
        "error": None,
        "steps": results,
        "passed": passed,
        "total": len(steps),
        "complete": passed == len(steps) and kind_ok,
    }


async def _run(cmd: list[str], stdin: str | None = None, timeout: int = 40, env: dict | None = None) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin.encode() if stdin is not None else None), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, f"timed out after {timeout}s"
    return proc.returncode or 0, out.decode(errors="replace")


async def kubeconform(text: str, crd: bool) -> dict:
    """Schema-validate with kubeconform when available (core kinds strictly, CRDs leniently)."""
    if not shutil.which("kubeconform"):
        return {"available": False, "ok": None, "output": "kubeconform is not installed"}
    cmd = ["kubeconform", "-strict", "-summary", "-output", "text"]
    if crd:
        cmd += ["-ignore-missing-schemas", "-schema-location", "default",
                "-schema-location", "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"]
    rc, out = await _run(cmd + ["-"], stdin=text, timeout=45)
    return {"available": True, "ok": rc == 0, "output": out.strip()}


async def kubectl_apply(text: str, mode: str) -> dict:
    """Apply (or server dry-run) the manifest with the lab kubeconfig."""
    if not shutil.which("kubectl"):
        return {"ok": False, "output": "kubectl is not installed"}
    if not KUBECONFIG.exists():
        return {"ok": False, "output": "No lab cluster kubeconfig. Create the cluster from the Cluster page first."}
    env = {"KUBECONFIG": str(KUBECONFIG), "PATH": __import__("os").environ.get("PATH", "")}
    doc, err = parse_yaml(text)
    if err:
        return {"ok": False, "output": err}
    ns = (doc.get("metadata") or {}).get("namespace")
    if ns and mode == "create":
        await _run(["kubectl", "create", "ns", ns], timeout=20, env=env)  # ignore "already exists"
    cmd = ["kubectl", "apply", "-f", "-"]
    if mode != "create":
        cmd.append("--dry-run=server")
    rc, out = await _run(cmd, stdin=text, timeout=45, env=env)
    return {"ok": rc == 0, "output": out.strip(), "mode": mode}

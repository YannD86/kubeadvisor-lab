"""Smoke tests for the SRE Kube Labs API (no cluster needed)."""
import os
import tempfile

os.environ.setdefault("LAB_HOME", tempfile.mkdtemp(prefix="sre-labs-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.services.manifest import check_expect, evaluate_steps, get_path, MISSING  # noqa: E402

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_realms_and_catalogs():
    r = client.get("/api/realms").json()
    ids = {x["id"] for x in r["realms"]}
    assert {"manifests", "gitops", "components", "scenarios", "troubleshooting"} <= ids
    assert client.get("/api/builders").json()["builders"]
    assert client.get("/api/scenarios").json()["scenarios"]


def test_builder_evaluate_progression():
    b = client.get("/api/builders/deployment-basics").json()
    assert b["step_count"] >= 8
    empty = client.post("/api/builders/deployment-basics/evaluate", json={"yaml": ""}).json()
    assert empty["parse_ok"] is False
    partial = client.post("/api/builders/deployment-basics/evaluate", json={"yaml": "apiVersion: apps/v1\nkind: Deployment\n"}).json()
    assert partial["parse_ok"] and partial["passed"] == 2 and not partial["complete"]
    full = client.post("/api/builders/deployment-basics/evaluate", json={"yaml": b["final_manifest"]}).json()
    assert full["complete"], full
    bad = client.post("/api/builders/deployment-basics/evaluate", json={"yaml": "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 'three'\n"}).json()
    assert any(s["status"] == "fail" and s["path"] == "spec.replicas" for s in bad["steps"])


def test_every_builder_final_manifest_completes():
    for b in client.get("/api/builders").json()["builders"]:
        full = client.get(f"/api/builders/{b['id']}").json()
        res = client.post(f"/api/builders/{b['id']}/evaluate", json={"yaml": full["final_manifest"]}).json()
        assert res["complete"], (b["id"], [s for s in res["steps"] if s["status"] != "pass"])


def test_path_and_expect_helpers():
    doc = {"metadata": {"annotations": {"a.b/c": "x"}}, "spec": {"containers": [{"name": "n", "image": "i:1"}]}}
    assert get_path(doc, 'metadata.annotations["a.b/c"]') == "x"
    assert get_path(doc, "spec.containers[0].image") == "i:1"
    assert get_path(doc, "spec.containers[1].image") is MISSING
    assert check_expect(3, {"type": "integer"})[0]
    assert not check_expect(True, {"type": "integer"})[0]
    assert check_expect("apps/v1", {"type": "regex", "value": r"^apps/v1$"})[0]
    assert check_expect([{"name": "a", "image": "b"}], {"type": "list", "value": {"min_items": 1, "item_keys": ["name", "image"]}})[0]


def test_scenario_detail_hides_hints_until_revealed():
    s = client.get("/api/scenarios/svc-selector-mismatch").json()
    assert s["hints"] is None and s["revealed_hints"] == []
    h = client.post("/api/scenarios/svc-selector-mismatch/hint?index=0").json()
    assert h["hints_revealed"] == 1
    s2 = client.get("/api/scenarios/svc-selector-mismatch").json()
    assert len(s2["revealed_hints"]) == 1
    assert "## Diagnosis" in client.get("/api/scenarios/svc-selector-mismatch/solution").json()["markdown"]


def test_lessons():
    l = client.get("/api/lessons/troubleshooting").json()
    assert l["lessons"][0]["slug"] == "method"
    d = client.get("/api/lessons/troubleshooting/method").json()
    assert d["body"].startswith("\n# ") or "# The troubleshooting loop" in d["body"]
    assert d["next"] is not None or len(l["lessons"]) == 1


def test_progress_roundtrip():
    client.post("/api/progress", json={"kind": "lesson", "item_id": "troubleshooting/method", "status": "completed"})
    p = client.get("/api/progress").json()
    assert any(i["item_id"] == "troubleshooting/method" for i in p["items"])
    assert p["done"]["lessons"] >= 1


def test_reconcile_marks_interrupted_scenarios_as_error():
    from app.services import scenarios as svc

    svc._save_state({
        "svc-selector-mismatch": {"status": "loading", "hints_revealed": 0, "attempts": 0},
        "a": {"status": "loading", "hints_revealed": 1, "attempts": 2},
        "b": {"status": "cleaning", "hints_revealed": 0, "attempts": 0},
        "c": {"status": "loaded", "hints_revealed": 0, "attempts": 0},
        "d": {"status": "idle", "hints_revealed": 0, "attempts": 0},
    })
    try:
        assert sorted(svc.reconcile_on_startup()) == ["a", "b", "svc-selector-mismatch"]
        st = svc.all_states()
        assert st["a"]["status"] == "error" and "restarted" in st["a"]["error"] and "loading" in st["a"]["error"]
        assert st["a"]["hints_revealed"] == 1 and st["a"]["attempts"] == 2  # untouched
        assert st["b"]["status"] == "error" and "cleaning up" in st["b"]["error"]
        assert st["c"]["status"] == "loaded" and "error" not in st["c"]
        assert st["d"]["status"] == "idle"
        assert svc.reconcile_on_startup() == []  # idempotent
        # the API surfaces the explanation to the UI
        states = {s["id"]: s["state"] for s in client.get("/api/scenarios").json()["scenarios"]}
        assert states["svc-selector-mismatch"] == "error"
        detail = client.get("/api/scenarios/svc-selector-mismatch").json()
        assert detail["state"]["status"] == "error" and "restarted" in detail["state"]["error"]
    finally:
        svc._save_state({})

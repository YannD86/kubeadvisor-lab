"""Accounts mode: signup/login, entitlements, course gating, lab tokens + sync, billing events, admin grants, hosted mode."""
import os
import tempfile
import time

os.environ.setdefault("LAB_HOME", tempfile.mkdtemp(prefix="ka-test-"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import config, content, db  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import billing  # noqa: E402


@pytest.fixture()
def accounts(monkeypatch):
    """Fresh database, accounts mode, local lab mode, no billing."""
    tmp = tempfile.mkdtemp(prefix="ka-accounts-")
    db.reset_engine()
    monkeypatch.setattr(config, "DATABASE_URL", f"sqlite:///{tmp}/platform.db")
    monkeypatch.setattr(config, "AUTH_MODE", "accounts")
    monkeypatch.setattr(config, "LAB_MODE", "local")
    monkeypatch.setattr(config, "STRIPE_SECRET_KEY", "")
    monkeypatch.setattr(config, "FIRST_USER_ADMIN", False)
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"admin@example.com"})
    db.init()
    yield
    db.reset_engine()


def _client() -> TestClient:
    return TestClient(app)


def _signup(c: TestClient, email: str, password: str = "correct horse battery") -> dict:
    r = c.post("/api/auth/signup", json={"email": email, "password": password, "name": email.split("@")[0]})
    assert r.status_code == 200, r.text
    return r.json()


def _course_with_lessons() -> tuple[str, list[dict]]:
    for p in content.list_products():
        ls = content.list_course_lessons(p["id"])
        if p.get("kind") == "course" and len(ls) >= 2:
            return p["id"], ls
    pytest.skip("no imported course content yet")


# ---------------------------------------------------------------- auth
def test_meta_and_anonymous(accounts):
    c = _client()
    m = c.get("/api/meta").json()
    assert m["auth_mode"] == "accounts" and m["billing_enabled"] is False and m["signup_enabled"] is True
    assert c.get("/api/auth/me").status_code == 401
    assert c.get("/api/progress").status_code == 401
    # anonymous may still browse
    assert c.get("/api/realms").status_code == 200
    assert c.get("/api/products").status_code == 200


def test_signup_login_cookie_and_bearer(accounts):
    c = _client()
    out = _signup(c, "ada@example.com")
    assert out["user"]["role"] == "user" and out["user"]["tier"] == "free" and out["entitlements"] == {"pro": False, "admin": False, "products": []}
    assert c.get("/api/auth/me").json()["user"]["email"] == "ada@example.com"       # cookie
    assert c.post("/api/auth/signup", json={"email": "ada@example.com", "password": "another password"}).status_code == 409
    assert c.post("/api/auth/login", json={"email": "ada@example.com", "password": "wrong password!"}).status_code == 401
    token = c.post("/api/auth/login", json={"email": "ADA@example.com", "password": "correct horse battery"}).json()["token"]
    fresh = _client()
    assert fresh.get("/api/auth/me").status_code == 401
    assert fresh.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["user"]["email"] == "ada@example.com"
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").status_code == 401
    assert c.post("/api/auth/signup", json={"email": "x@example.com", "password": "short"}).status_code == 422


def test_admin_email_becomes_admin(accounts):
    c = _client()
    out = _signup(c, "admin@example.com")
    assert out["user"]["role"] == "admin" and out["entitlements"]["admin"] is True and out["entitlements"]["pro"] is True


# ---------------------------------------------------------------- courses & gating
def test_course_gating_preview_purchase_and_pro(accounts):
    pid, lessons = _course_with_lessons()
    preview = next(l for l in lessons if l.get("preview"))
    locked = next(l for l in lessons if not l.get("preview"))
    anon = _client()
    assert anon.get(f"/api/courses/{pid}/lessons/{preview['slug']}").status_code == 200
    assert anon.get(f"/api/courses/{pid}/lessons/{locked['slug']}").status_code == 401

    c = _client()
    _signup(c, "bob@example.com")
    detail = c.get(f"/api/products/{pid}").json()
    assert detail["owned"] is False and any(l["locked"] for l in detail["lessons"]) and not next(l for l in detail["lessons"] if l["preview"])["locked"]
    r = c.get(f"/api/courses/{pid}/lessons/{locked['slug']}")
    assert r.status_code == 402 and r.json()["detail"]["error"] == "payment_required" and r.json()["detail"]["product"] == pid
    # checkout is refused (billing disabled), never granted
    r = c.post("/api/billing/checkout", json={"product": pid})
    assert r.status_code == 409 and r.json()["detail"]["error"] == "billing_disabled"

    # admin grants the course manually
    admin = _client()
    _signup(admin, "admin@example.com")
    assert admin.post("/api/admin/grant", json={"email": "bob@example.com", "product": pid}).status_code == 200
    assert c.post("/api/admin/grant", json={"email": "bob@example.com", "product": pid}).status_code == 403  # bob is not admin
    me = c.get("/api/auth/me").json()
    assert pid in me["entitlements"]["products"]
    r = c.get(f"/api/courses/{pid}/lessons/{locked['slug']}")
    assert r.status_code == 200 and r.json()["access_via"] == "purchase" and "body" in r.json()
    detail = c.get(f"/api/products/{pid}").json()
    assert detail["owned"] is True and detail["via"] == "purchase" and not any(l["locked"] for l in detail["lessons"])

    # progress: complete a lesson → product progress and /api/progress courses summary move
    c.post("/api/progress", json={"kind": "course_lesson", "item_id": f"{pid}/{locked['slug']}", "status": "completed", "data": {"time_spent_s": 42}})
    assert c.get(f"/api/products/{pid}").json()["lessons_completed"] == 1
    prog = c.get("/api/progress").json()
    assert prog["courses"][pid]["completed"] == 1 and prog["done"]["course_lessons"] == 1

    # revoke → locked again; pro grant → everything open again
    admin.post("/api/admin/revoke", json={"email": "bob@example.com", "product": pid})
    assert c.get(f"/api/courses/{pid}/lessons/{locked['slug']}").status_code == 402
    admin.post("/api/admin/grant", json={"email": "bob@example.com", "product": "pro"})
    assert c.get(f"/api/courses/{pid}/lessons/{locked['slug']}").json()["access_via"] == "pro"
    assert c.get("/api/realms").json()["realms"][0]["locked"] is False


def test_bundle_unlocks_children(accounts):
    bundle = next((p for p in content.list_products() if p.get("kind") == "bundle" and p.get("includes")), None)
    if not bundle:
        pytest.skip("no bundle in content")
    child = bundle["includes"][0]
    admin, c = _client(), _client()
    _signup(admin, "admin@example.com")
    _signup(c, "carol@example.com")
    admin.post("/api/admin/grant", json={"email": "carol@example.com", "product": bundle["id"]})
    ent = c.get("/api/auth/me").json()["entitlements"]
    assert bundle["id"] in ent["products"] and child in ent["products"]
    assert c.get(f"/api/products/{child}").json()["via"] == "bundle"
    assert c.get(f"/api/products/{bundle['id']}").json()["included_products"][0]["owned"] is True


def test_assessment_submit_and_attempts(accounts):
    pid = next((p["id"] for p in content.list_products() if content.list_assessments(p["id"])), None)
    if not pid:
        pytest.skip("no assessments in content")
    a = content.list_assessments(pid)[0]
    admin, c = _client(), _client()
    _signup(admin, "admin@example.com")
    _signup(c, "dan@example.com")
    assert c.get(f"/api/courses/{pid}/assessments/{a['id']}").status_code == 402
    admin.post("/api/admin/grant", json={"email": "dan@example.com", "product": pid})
    q = c.get(f"/api/courses/{pid}/assessments/{a['id']}").json()
    assert q["question_count"] == len(a["questions"]) and "answer" not in q["questions"][0] and q["attempts"] == 0
    # all correct
    answers = {str(i): qq["answer"] for i, qq in enumerate(a["questions"])}
    res = c.post(f"/api/courses/{pid}/assessments/{a['id']}/submit", json={"answers": answers}).json()
    assert res["passed"] and res["percent"] == 100 and res["score"] == res["total"] and res["attempts"] == 1
    # all wrong-ish (empty) → fail, attempts 2, best stays 100
    res2 = c.post(f"/api/courses/{pid}/assessments/{a['id']}/submit", json={"answers": {}}).json()
    assert not res2["passed"] and res2["attempts"] == 2 and res2["best_percent"] == 100
    d = c.get(f"/api/products/{pid}").json()
    row = next(x for x in d["assessments"] if x["id"] == a["id"])
    assert row["attempts"] == 2 and row["best_percent"] == 100


# ---------------------------------------------------------------- realms: scenarios are pro
def test_scenario_actions_need_pro(accounts):
    sid = content.list_scenarios()[0]["id"]
    c = _client()
    _signup(c, "eve@example.com")
    r = c.post(f"/api/scenarios/{sid}/hint", params={"index": 0})
    assert r.status_code == 402 and r.json()["detail"]["product"] == "pro"
    assert c.get(f"/api/scenarios/{sid}").status_code == 200           # brief stays readable
    assert c.get("/api/realms/scenarios").json()["locked"] is True
    assert _client().post(f"/api/scenarios/{sid}/check").status_code == 401


# ---------------------------------------------------------------- lab tokens + sync
def test_lab_token_sync(accounts):
    c = _client()
    _signup(c, "fay@example.com")
    t = c.post("/api/lab-tokens", json={"name": "laptop"}).json()
    assert t["token"].startswith("kal_") and c.get("/api/lab-tokens").json()["tokens"][0]["name"] == "laptop"
    runner = _client()
    hdr = {"Authorization": f"Bearer {t['token']}"}
    assert runner.get("/api/auth/me", headers=hdr).json()["user"]["email"] == "fay@example.com"
    assert runner.post("/api/lab-tokens", json={"name": "nope"}, headers=hdr).status_code == 403   # tokens cannot mint tokens
    now = time.time()
    r = runner.post("/api/sync/progress", headers=hdr, json={"items": [
        {"kind": "scenario", "item_id": "svc-selector-mismatch", "status": "passed", "data": {"attempts": 2}, "updated_at": now},
        {"kind": "bogus", "item_id": "x", "status": "y"},
    ]})
    assert r.json() == {"accepted": 1}
    items = {i["item_id"]: i for i in c.get("/api/progress").json()["items"]}
    assert items["svc-selector-mismatch"]["status"] == "passed"
    # an older write must not clobber the newer one
    runner.post("/api/sync/progress", headers=hdr, json={"items": [{"kind": "scenario", "item_id": "svc-selector-mismatch", "status": "attempted", "data": {}, "updated_at": now - 100}]})
    assert {i["item_id"]: i for i in c.get("/api/progress").json()["items"]}["svc-selector-mismatch"]["status"] == "passed"
    assert c.post("/api/sync/progress", json={"items": []}).status_code == 401                    # cookie session is not a lab token
    c.delete(f"/api/lab-tokens/{t['id']}")
    assert runner.get("/api/auth/me", headers=hdr).status_code == 401


# ---------------------------------------------------------------- billing events
def test_stripe_events_idempotent_and_signed(accounts, monkeypatch):
    pid, _ = _course_with_lessons()
    c = _client()
    uid = _signup(c, "gus@example.com")["user"]["id"]
    ev = {"id": "evt_1", "type": "checkout.session.completed", "data": {"object": {
        "id": "cs_1", "mode": "payment", "customer": "cus_1", "payment_intent": "pi_1", "amount_total": 19900, "currency": "usd",
        "client_reference_id": uid, "metadata": {"user_id": uid, "product": pid}}}}
    assert billing.apply_event(ev)["status"] == "ok"
    assert billing.apply_event(ev)["status"] == "already_processed"
    assert pid in c.get("/api/auth/me").json()["entitlements"]["products"]
    p = c.get("/api/billing/purchases").json()
    assert p["purchases"][0]["product"] == pid and p["purchases"][0]["amount_cents"] == 19900
    # subscription lifecycle by customer id
    billing.apply_event({"id": "evt_2", "type": "customer.subscription.updated", "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "active", "current_period_end": time.time() + 86400}}})
    assert c.get("/api/auth/me").json()["user"]["tier"] == "pro"
    billing.apply_event({"id": "evt_3", "type": "customer.subscription.deleted", "data": {"object": {"id": "sub_1", "customer": "cus_1", "status": "canceled"}}})
    assert c.get("/api/auth/me").json()["user"]["tier"] == "free"
    # webhook endpoint: unconfigured → 503; configured with a bad signature → 400
    assert c.post("/api/billing/webhook", content=b"{}", headers={"stripe-signature": "t=1,v1=bad"}).status_code == 503
    monkeypatch.setattr(config, "STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(config, "STRIPE_WEBHOOK_SECRET", "whsec_x")
    assert c.post("/api/billing/webhook", content=b"{}", headers={"stripe-signature": "t=1,v1=bad"}).status_code == 400


# ---------------------------------------------------------------- hosted mode
def test_hosted_mode_blocks_lab_routes(accounts, monkeypatch):
    monkeypatch.setattr(config, "LAB_MODE", "hosted")
    admin = _client()
    _signup(admin, "admin@example.com")
    st = admin.get("/api/cluster/status").json()
    assert st["lab_mode"] == "hosted" and st["exists"] is False
    r = admin.post("/api/cluster/up")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "lab_mode_hosted"
    sid = content.list_scenarios()[0]["id"]
    assert admin.post(f"/api/scenarios/{sid}/load").status_code == 409
    assert admin.post(f"/api/scenarios/{sid}/check").status_code == 409
    assert admin.get(f"/api/scenarios/{sid}").status_code == 200
    with admin.websocket_connect("/ws/terminal?mode=shell") as ws:
        assert "lab_mode_hosted" in ws.receive_text()


def test_terminal_admin_only_on_shared_instance(accounts):
    user = _client()
    _signup(user, "hal@example.com")
    with user.websocket_connect("/ws/terminal?mode=shell") as ws:
        assert "forbidden" in ws.receive_text()


# ---------------------------------------------------------------- exercises expose their setup
def test_exercise_exposes_setup_commands(accounts):
    found = next(((p["id"], e) for p in content.list_products() for e in content.list_exercises(p["id"])
                  if (e.get("legacy") or {}).get("setup_commands")), None)
    if not found:
        pytest.skip("no exercise with setup commands")
    pid, e = found
    admin, c = _client(), _client()
    _signup(admin, "admin@example.com")
    _signup(c, "ivy@example.com")
    admin.post("/api/admin/grant", json={"email": "ivy@example.com", "product": "pro"})
    r = c.get(f"/api/courses/{pid}/exercises/{e['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["setup_commands"] == e["legacy"]["setup_commands"]
    assert "legacy" not in body

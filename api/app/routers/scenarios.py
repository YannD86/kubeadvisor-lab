from fastapi import APIRouter, Depends, HTTPException

from app import auth, content
from app.services import access
from app.services import cluster as cluster_svc
from app.services import scenarios as svc

router = APIRouter(prefix="/api/scenarios", tags=["scenarios"])


@router.get("")
def list_scenarios():
    states = svc.all_states()
    items = []
    for s in content.list_scenarios():
        st = states.get(s["id"], {})
        items.append(s | {"state": st.get("status", "idle"), "passed_at": st.get("passed_at")})
    return {"scenarios": items, "categories": content.realms_doc().get("categories", [])}


@router.get("/{sid}")
def get_scenario(sid: str):
    s = content.get_scenario(sid)
    if not s:
        raise HTTPException(404, "scenario not found")
    s = dict(s)
    s.pop("dir", None)
    st = svc.state_of(sid)
    s["state"] = st
    s["revealed_hints"] = (s.get("hints") or [])[: st.get("hints_revealed", 0)]
    s["hints"] = None  # never ship unrevealed hints to the client
    s["checks"] = [{"name": c["name"]} for c in s.get("checks") or []]
    s["lesson_items"] = []
    for ref in s.get("related_lessons") or []:
        if "/" in ref:
            realm, slug = ref.split("/", 1)
            l = content.get_lesson(realm, slug)
            if l:
                s["lesson_items"].append({"realm": realm, "slug": slug, "title": l["title"]})
    return s


@router.post("/{sid}/load")
async def load(sid: str, ident: auth.Identity = Depends(auth.require_user)):
    access.hosted_guard()
    access.require_realm(access.entitlements_for(ident), "scenarios", anonymous=False)
    s = content.get_scenario(sid)
    if not s:
        raise HTTPException(404, "scenario not found")
    st = await cluster_svc.status()
    if not st["api_reachable"]:
        raise HTTPException(409, {"error": "cluster_unavailable", "message": "The lab cluster is not running. Create it from the Cluster page."})
    missing = [a for a in (s.get("requires_addons") or []) if not st["addons"].get(a)]
    if missing:
        raise HTTPException(409, {"error": "missing_addons", "missing": missing, "message": f"Install the required addons first: {', '.join(missing)}"})
    return svc.load(sid).to_dict()


@router.post("/{sid}/cleanup")
async def cleanup(sid: str, ident: auth.Identity = Depends(auth.require_user)):
    access.hosted_guard()
    try:
        return svc.cleanup(sid).to_dict()
    except KeyError:
        raise HTTPException(404, "scenario not found")


@router.post("/{sid}/reset")
async def reset(sid: str, ident: auth.Identity = Depends(auth.require_user)):
    access.hosted_guard()
    access.require_realm(access.entitlements_for(ident), "scenarios", anonymous=False)
    try:
        return svc.reset(sid).to_dict()
    except KeyError:
        raise HTTPException(404, "scenario not found")


@router.post("/{sid}/check")
async def check(sid: str, ident: auth.Identity = Depends(auth.require_user)):
    access.hosted_guard()
    access.require_realm(access.entitlements_for(ident), "scenarios", anonymous=False)
    try:
        return await svc.run_checks(sid, ident.id)
    except KeyError:
        raise HTTPException(404, "scenario not found")


@router.post("/{sid}/hint")
def hint(sid: str, index: int = 0, ident: auth.Identity = Depends(auth.require_user)):
    access.require_realm(access.entitlements_for(ident), "scenarios", anonymous=False)
    try:
        return svc.reveal_hint(sid, index)
    except KeyError:
        raise HTTPException(404, "scenario not found")


@router.get("/{sid}/solution")
def solution(sid: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    access.require_realm(access.entitlements_for(ident), "scenarios", anonymous=ident is None)
    text = content.scenario_solution(sid)
    if text is None:
        raise HTTPException(404, "solution not found")
    svc._update(sid, solution_viewed=True)
    return {"markdown": text}

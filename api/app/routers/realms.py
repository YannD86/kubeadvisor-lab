from fastapi import APIRouter, Depends, HTTPException

from app import auth, content
from app.services import access

router = APIRouter(prefix="/api", tags=["realms"])


def _with_lock(realms: list[dict], ident: auth.Identity | None) -> list[dict]:
    ent = access.entitlements_for(ident)
    return [r | {"locked": access.realm_locked(ent, r)} for r in realms]


@router.get("/realms")
def realms(ident: auth.Identity | None = Depends(auth.current_user_optional)):
    doc = content.realms_doc()
    return {"realms": _with_lock(content.list_realms(), ident), "tracks": doc.get("tracks", []),
            "categories": doc.get("categories", []), "addons": doc.get("addons", [])}


@router.get("/realms/{rid}")
def realm(rid: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    r = content.get_realm(rid)
    if not r:
        raise HTTPException(404, "realm not found")
    out = _with_lock([dict(r)], ident)[0]
    if r["kind"] == "lessons":
        out["lessons"] = content.list_lessons(rid)
    elif r["kind"] == "builders":
        out["builders"] = content.list_builders()
        out["tracks"] = content.realms_doc().get("tracks", [])
    elif r["kind"] == "scenarios":
        out["scenarios"] = content.list_scenarios()
        out["categories"] = content.realms_doc().get("categories", [])
    return out

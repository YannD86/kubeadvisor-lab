from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import auth, content, db
from app.services import access, manifest

router = APIRouter(prefix="/api/builders", tags=["builders"])


class ManifestIn(BaseModel):
    yaml: str


@router.get("")
def list_builders():
    return {"builders": content.list_builders(), "tracks": content.realms_doc().get("tracks", [])}


@router.get("/{bid}")
def get_builder(bid: str):
    b = content.get_builder(bid)
    if not b:
        raise HTTPException(404, "builder not found")
    return b


@router.post("/{bid}/evaluate")
def evaluate(bid: str, body: ManifestIn, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    b = content.get_builder(bid)
    if not b:
        raise HTTPException(404, "builder not found")
    res = manifest.evaluate_steps(b, body.yaml)
    if res["parse_ok"]:
        status = "completed" if res["complete"] else "in_progress"
        if ident is not None:
            db.set_progress(ident.id, "builder", bid, status, {"passed": res["passed"], "total": res["total"]})
    return res


@router.post("/{bid}/lint")
async def lint(bid: str, body: ManifestIn):
    b = content.get_builder(bid)
    if not b:
        raise HTTPException(404, "builder not found")
    return await manifest.kubeconform(body.yaml, bool(b.get("crd")))


@router.post("/{bid}/apply")
async def apply(bid: str, body: ManifestIn, ident: auth.Identity = Depends(auth.require_user)):
    access.hosted_guard()
    b = content.get_builder(bid)
    if not b:
        raise HTTPException(404, "builder not found")
    mode = ((b.get("apply") or {}).get("mode")) or "dry-run"
    res = await manifest.kubectl_apply(body.yaml, mode)
    if res.get("ok"):
        db.set_progress(ident.id, "builder", bid, "applied", {"mode": mode})
    return res

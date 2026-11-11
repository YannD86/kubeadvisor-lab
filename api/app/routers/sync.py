from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import auth, db
from app.routers.progress import KINDS
from app.services import sync as sync_svc

router = APIRouter(prefix="/api/sync", tags=["sync"])


class Item(BaseModel):
    kind: str = Field(max_length=40)
    item_id: str = Field(min_length=1, max_length=200)
    status: str = Field(min_length=1, max_length=40)
    data: dict = Field(default_factory=dict)
    updated_at: float | None = None


class SyncIn(BaseModel):
    items: list[Item] = Field(max_length=500)


@router.post("/progress")
def push(body: SyncIn, ident: auth.Identity = Depends(auth.require_lab_token)):
    """Platform side: a local runner pushes progress rows. Newer ``updated_at`` wins."""
    accepted = 0
    for it in body.items:
        if it.kind not in KINDS:
            continue
        db.set_progress(ident.id, it.kind, it.item_id, it.status, it.data, updated_at=it.updated_at, only_if_newer=True, propagate=False)
        accepted += 1
    return {"accepted": accepted}


@router.get("/status")
def status(_: auth.Identity = Depends(auth.require_user)):
    """Runner side: is this runner pushing to a platform, and how is it going."""
    return sync_svc.status()


@router.post("/flush")
def flush(_: auth.Identity = Depends(auth.require_user)):
    ok = sync_svc.flush_once()
    return {"ok": ok, **sync_svc.status()}

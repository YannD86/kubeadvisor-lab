from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app import auth, db

router = APIRouter(prefix="/api/lab-tokens", tags=["lab-tokens"])


class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


def _row(t: db.LabToken) -> dict:
    return {"id": t.id, "name": t.name, "prefix": t.prefix, "created_at": t.created_at, "last_used_at": t.last_used_at}


@router.get("")
def list_tokens(ident: auth.Identity = Depends(auth.require_user)):
    with db.session() as s:
        rows = s.execute(select(db.LabToken).where(db.LabToken.user_id == ident.id).order_by(db.LabToken.created_at.desc())).scalars().all()
        return {"tokens": [_row(t) for t in rows]}


@router.post("")
def create_token(body: TokenIn, ident: auth.Identity = Depends(auth.require_user)):
    if ident.via == "lab_token":
        raise auth.err(403, "forbidden", "A lab token cannot create other tokens.")
    plain, h, prefix = auth.new_lab_token()
    with db.session() as s:
        t = db.LabToken(user_id=ident.id, name=body.name, token_hash=h, prefix=prefix)
        s.add(t)
        s.flush()
        out = _row(t)
    out["token"] = plain
    return out


@router.delete("/{tid}")
def revoke(tid: str, ident: auth.Identity = Depends(auth.require_user)):
    with db.session() as s:
        t = s.get(db.LabToken, tid)
        if not t or t.user_id != ident.id:
            raise HTTPException(404, "token not found")
        s.delete(t)
    return {"ok": True}

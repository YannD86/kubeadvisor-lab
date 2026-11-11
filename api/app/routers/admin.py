import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select

from app import auth, content, db

router = APIRouter(prefix="/api/admin", tags=["admin"])


class GrantIn(BaseModel):
    email: EmailStr
    product: str = Field(min_length=1, max_length=100)   # product id or "pro"
    note: str | None = Field(default=None, max_length=200)


def _user(s, email: str) -> db.User:
    u = s.execute(select(db.User).where(db.User.email == email.lower())).scalar_one_or_none()
    if not u:
        raise HTTPException(404, "user not found")
    return u


@router.get("/users")
def users(q: str = "", _: auth.Identity = Depends(auth.require_admin)):
    with db.session() as s:
        stmt = select(db.User).order_by(db.User.created_at.desc()).limit(200)
        if q:
            stmt = stmt.where(db.User.email.contains(q.lower()))
        rows = s.execute(stmt).scalars().all()
        now = time.time()
        out = []
        for u in rows:
            purchases = s.execute(select(db.Purchase).where(db.Purchase.user_id == u.id)).scalars().all()
            out.append(auth.identity_of(u, "admin").to_dict() | {"subscription_status": u.subscription_status,
                                                                 "purchases": [p.product_id for p in purchases if p.active(now)]})
        return {"users": out}


@router.post("/grant")
def grant(body: GrantIn, admin: auth.Identity = Depends(auth.require_admin)):
    with db.session() as s:
        u = _user(s, body.email)
        if body.product == "pro":
            u.tier = "pro"
            u.subscription_status = u.subscription_status or "manual"
        else:
            if not content.get_product(body.product):
                raise HTTPException(404, "product not found")
            s.add(db.Purchase(user_id=u.id, product_id=body.product, amount_cents=0, currency="usd", note=body.note or f"manual grant by {admin.email}"))
    return {"ok": True}


@router.post("/revoke")
def revoke(body: GrantIn, _: auth.Identity = Depends(auth.require_admin)):
    now = time.time()
    with db.session() as s:
        u = _user(s, body.email)
        if body.product == "pro":
            u.tier = "free"
            u.subscription_status = "revoked"
        else:
            for p in s.execute(select(db.Purchase).where(db.Purchase.user_id == u.id, db.Purchase.product_id == body.product)).scalars().all():
                if p.active(now):
                    p.revoked_at = now
    return {"ok": True}

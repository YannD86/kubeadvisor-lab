"""Entitlements: who may read which course / run which realm.

Resolution order: admin → everything; tier ``pro`` → every course and every realm;
a purchase of a bundle grants its ``includes``; a purchase of a course grants that course.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from sqlalchemy import select

from app import config, content, db
from app.auth import Identity, err


@dataclass
class Entitlements:
    pro: bool = False
    admin: bool = False
    products: list[str] = field(default_factory=list)
    direct: dict[str, str] = field(default_factory=dict)  # product -> "purchase" | "bundle"

    def to_dict(self) -> dict:
        return {"pro": self.pro, "admin": self.admin, "products": sorted(self.products)}


def entitlements_for(ident: Identity | None) -> Entitlements:
    if ident is None:
        return Entitlements()
    admin = ident.is_admin
    pro = ident.tier == "pro" or admin
    direct: dict[str, str] = {}
    now = time.time()
    with db.session() as s:
        rows = s.execute(select(db.Purchase).where(db.Purchase.user_id == ident.id)).scalars().all()
        owned = [p.product_id for p in rows if p.active(now)]
    for pid in owned:
        direct.setdefault(pid, "purchase")
        prod = content.get_product(pid)
        if prod and prod.get("kind") == "bundle":
            for child in prod.get("includes") or []:
                direct.setdefault(child, "bundle")
    return Entitlements(pro=pro, admin=admin, products=list(direct.keys()), direct=direct)


def product_access(ent: Entitlements, product_id: str) -> str | None:
    """How the user may open a product: admin | pro | purchase | bundle | None."""
    if ent.admin:
        return "admin"
    if product_id in ent.direct:
        return ent.direct[product_id]
    if ent.pro:
        return "pro"
    return None


def realm_locked(ent: Entitlements, realm: dict) -> bool:
    return (realm.get("access") or "free") == "pro" and not ent.pro


def require_product(ent: Entitlements, product_id: str, *, anonymous: bool) -> str:
    via = product_access(ent, product_id)
    if via:
        return via
    if anonymous:
        raise err(401, "unauthenticated", "Sign in to open this course.", product=product_id)
    raise err(402, "payment_required", "This course is not included in your plan.", product=product_id)


def require_realm(ent: Entitlements, realm_id: str, *, anonymous: bool) -> None:
    realm = content.get_realm(realm_id) or {}
    if not realm_locked(ent, realm):
        return
    if anonymous:
        raise err(401, "unauthenticated", "Sign in to run labs.", product="pro")
    raise err(402, "payment_required", "Loaded scenarios are part of Pro.", product="pro")


def hosted_guard() -> None:
    if config.LAB_MODE == "hosted":
        raise err(409, "lab_mode_hosted", "Labs run in your local KubeAdvisor runner. Open Account → Lab runner.")

"""Stripe billing: one-time course purchases and the Pro subscription.

Without ``KA_STRIPE_SECRET_KEY`` checkout answers 409 ``billing_disabled`` and the
webhook answers 503. There is no code path that grants access for free; manual
grants go through the admin router.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app import auth, config, content, db
from app.services import access

router = APIRouter(prefix="/api/billing", tags=["billing"])


class CheckoutIn(BaseModel):
    product: str


def _stripe():
    if not config.billing_enabled():
        raise auth.err(409, "billing_disabled", "Purchases are not enabled on this instance yet.")
    import stripe  # local import: optional at runtime

    stripe.api_key = config.STRIPE_SECRET_KEY
    return stripe


def _customer_kwargs(ident: auth.Identity) -> dict:
    with db.session() as s:
        u = s.get(db.User, ident.id)
        if u and u.stripe_customer_id:
            return {"customer": u.stripe_customer_id}
    return {"customer_email": ident.email}


@router.post("/checkout")
def checkout(body: CheckoutIn, ident: auth.Identity = Depends(auth.require_user)):
    stripe = _stripe()
    ent = access.entitlements_for(ident)
    common = dict(client_reference_id=ident.id, allow_promotion_codes=True,
                  success_url=f"{config.WEB_ORIGIN}/account?checkout=success",
                  cancel_url=f"{config.WEB_ORIGIN}/pricing?checkout=cancelled", **_customer_kwargs(ident))
    if body.product == "pro":
        if ent.pro and not ident.is_admin:
            raise auth.err(409, "already_owned", "You already have Pro.")
        if not config.STRIPE_PRO_PRICE_ID:
            raise auth.err(409, "billing_disabled", "The Pro subscription price is not configured.")
        session = stripe.checkout.Session.create(mode="subscription", line_items=[{"price": config.STRIPE_PRO_PRICE_ID, "quantity": 1}],
                                                 metadata={"user_id": ident.id, "product": "pro"}, **common)
        return {"url": session.url}
    p = content.get_product(body.product)
    if not p or p.get("status", "active") != "active":
        raise HTTPException(404, "product not found")
    if access.product_access(ent, p["id"]) in ("purchase", "bundle"):
        raise auth.err(409, "already_owned", "You already own this course.")
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"quantity": 1, "price_data": {"currency": p.get("currency", "usd"), "unit_amount": int(p["price_cents"]),
                                                   "product_data": {"name": p["title"], "description": (p.get("tagline") or "")[:500]}}}],
        metadata={"user_id": ident.id, "product": p["id"]}, **common)
    return {"url": session.url}


@router.post("/webhook")
async def webhook(request: Request):
    if not config.billing_enabled() or not config.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "billing webhook not configured")
    import stripe

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, config.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")
    return apply_event(event.to_dict_recursive() if hasattr(event, "to_dict_recursive") else dict(event))


# ---------------- event handling (pure, testable) ----------------
def _find_user(s, obj: dict) -> db.User | None:
    uid = (obj.get("metadata") or {}).get("user_id") or obj.get("client_reference_id")
    u = s.get(db.User, uid) if uid else None
    if not u and obj.get("customer"):
        u = s.execute(select(db.User).where(db.User.stripe_customer_id == obj["customer"])).scalar_one_or_none()
    if not u:
        email = obj.get("customer_email") or (obj.get("customer_details") or {}).get("email")
        if email:
            u = s.execute(select(db.User).where(db.User.email == email.lower())).scalar_one_or_none()
    return u


def _on_checkout(s, obj: dict) -> None:
    u = _find_user(s, obj)
    if not u:
        return
    if obj.get("customer"):
        u.stripe_customer_id = obj["customer"]
    product = (obj.get("metadata") or {}).get("product")
    if obj.get("mode") == "subscription" or product == "pro":
        u.tier = "pro"
        u.stripe_subscription_id = obj.get("subscription")
        u.subscription_status = "active"
        return
    if not product or not content.get_product(product):
        return
    if s.execute(select(db.Purchase).where(db.Purchase.stripe_session_id == obj.get("id"))).scalar_one_or_none():
        return
    s.add(db.Purchase(user_id=u.id, product_id=product, amount_cents=int(obj.get("amount_total") or 0), currency=obj.get("currency") or "usd",
                      stripe_session_id=obj.get("id"), stripe_payment_intent=obj.get("payment_intent"), note="stripe"))


ACTIVE_SUB = {"active", "trialing", "past_due"}  # past_due keeps access while Stripe retries the card


def _on_subscription(s, obj: dict) -> None:
    u = None
    if obj.get("customer"):
        u = s.execute(select(db.User).where(db.User.stripe_customer_id == obj["customer"])).scalar_one_or_none()
    if not u and obj.get("id"):
        u = s.execute(select(db.User).where(db.User.stripe_subscription_id == obj["id"])).scalar_one_or_none()
    if not u:
        return
    status = obj.get("status") or "canceled"
    u.stripe_subscription_id = obj.get("id")
    u.subscription_status = status
    u.subscription_period_end = obj.get("current_period_end")
    u.tier = "pro" if status in ACTIVE_SUB else "free"


def apply_event(event: dict) -> dict:
    """Idempotent: each Stripe event id is processed once."""
    eid, etype = event.get("id"), event.get("type", "")
    obj = ((event.get("data") or {}).get("object")) or {}
    with db.session() as s:
        if eid and s.get(db.WebhookEvent, eid):
            return {"status": "already_processed"}
        if eid:
            s.add(db.WebhookEvent(id=eid, type=etype))
        if etype == "checkout.session.completed":
            _on_checkout(s, obj)
        elif etype in ("customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.created"):
            _on_subscription(s, obj)
    return {"status": "ok", "type": etype}


@router.get("/portal")
def portal(ident: auth.Identity = Depends(auth.require_user)):
    stripe = _stripe()
    with db.session() as s:
        u = s.get(db.User, ident.id)
        cid = u.stripe_customer_id if u else None
    if not cid:
        raise auth.err(409, "no_customer", "No billing account yet. Buy something first.")
    session = stripe.billing_portal.Session.create(customer=cid, return_url=f"{config.WEB_ORIGIN}/account")
    return {"url": session.url}


@router.get("/purchases")
def purchases(ident: auth.Identity = Depends(auth.require_user)):
    now = time.time()
    with db.session() as s:
        rows = s.execute(select(db.Purchase).where(db.Purchase.user_id == ident.id).order_by(db.Purchase.granted_at.desc())).scalars().all()
        u = s.get(db.User, ident.id)
        items = [{"id": p.id, "product": p.product_id, "title": (content.get_product(p.product_id) or {}).get("title", p.product_id),
                  "amount_cents": p.amount_cents, "currency": p.currency, "granted_at": p.granted_at, "expires_at": p.expires_at,
                  "active": p.active(now), "note": p.note} for p in rows]
        sub = {"status": u.subscription_status, "current_period_end": u.subscription_period_end, "tier": u.tier} if u and (u.subscription_status or u.tier == "pro") else None
    return {"purchases": items, "subscription": sub, "billing_enabled": config.billing_enabled()}

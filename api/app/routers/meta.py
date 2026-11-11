from fastapi import APIRouter

from app import config

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/meta")
def meta():
    return {
        "product": config.PRODUCT_NAME,
        "version": config.VERSION,
        "env": config.ENV,
        "auth_mode": config.AUTH_MODE,
        "lab_mode": config.LAB_MODE,
        "billing_enabled": config.billing_enabled(),
        "signup_enabled": config.AUTH_MODE == "accounts" and config.SIGNUP_ENABLED,
        "pro": {"price_cents": config.PRO_PRICE_CENTS, "currency": config.PRO_CURRENCY, "interval": "month", "enabled": config.billing_enabled() and bool(config.STRIPE_PRO_PRICE_ID)},
    }

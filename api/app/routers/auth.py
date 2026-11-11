from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app import auth, config, db
from app.services.access import entitlements_for

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


def _accounts_only() -> None:
    if config.AUTH_MODE != "accounts":
        raise auth.err(404, "not_available", "Accounts are disabled on this runner (KA_AUTH_MODE=local).")


def _payload(ident: auth.Identity, token: str | None = None) -> dict:
    out = {"user": ident.to_dict(), "entitlements": entitlements_for(ident).to_dict()}
    if token:
        out["token"] = token
    return out


@router.post("/signup")
def signup(body: SignupIn, response: Response):
    _accounts_only()
    if not config.SIGNUP_ENABLED:
        raise auth.err(403, "signup_disabled", "Sign-up is disabled on this instance.")
    email = body.email.lower()
    with db.session() as s:
        if s.execute(select(db.User).where(db.User.email == email)).scalar_one_or_none():
            raise auth.err(409, "email_taken", "An account with this email already exists.")
        others = s.execute(select(func.count()).select_from(db.User).where(db.User.email != config.LOCAL_USER_EMAIL)).scalar() or 0
        role = "admin" if auth.is_admin_email(email) or (config.FIRST_USER_ADMIN and others == 0) else "user"
        u = db.User(email=email, name=body.name, password_hash=auth.hash_password(body.password), role=role)
        s.add(u)
        s.flush()
        ident = auth.identity_of(u, "cookie")
    token = auth.make_jwt(ident.id)
    auth.set_session_cookie(response, token)
    return _payload(ident, token)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    _accounts_only()
    ip = request.client.host if request.client else "?"
    auth.throttle_check(ip)
    with db.session() as s:
        u = s.execute(select(db.User).where(db.User.email == body.email.lower())).scalar_one_or_none()
        if not u or not auth.verify_password(body.password, u.password_hash):
            auth.throttle_fail(ip)
            raise auth.err(401, "invalid_credentials", "Email or password is incorrect.")
        if auth.is_admin_email(u.email) and u.role != "admin":
            u.role = "admin"
        ident = auth.identity_of(u, "cookie")
    token = auth.make_jwt(ident.id)
    auth.set_session_cookie(response, token)
    return _payload(ident, token)


@router.post("/logout")
def logout(response: Response):
    auth.clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(ident: auth.Identity = Depends(auth.require_user)):
    return _payload(ident)

"""Identity: password hashing, JWT sessions, lab tokens, FastAPI dependencies.

Two modes (``config.AUTH_MODE``):
- ``local``    every request is the built-in admin user ``local@runner`` (single-user runner / dev box)
- ``accounts`` cookie ``ka_session`` or ``Authorization: Bearer <jwt>``; ``Bearer kal_...`` is a lab token
"""
from __future__ import annotations

import hashlib
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

import bcrypt
import jwt
from fastapi import HTTPException, Request, Response
from sqlalchemy import select

from app import config, db


def err(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, {"error": code, "message": message, **extra})


@dataclass
class Identity:
    id: str
    email: str
    name: str | None
    role: str
    tier: str
    created_at: float
    via: str  # local | cookie | bearer | lab_token

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def to_dict(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name, "role": self.role, "tier": self.tier, "created_at": self.created_at}


def identity_of(u: db.User, via: str) -> Identity:
    return Identity(id=u.id, email=u.email, name=u.name, role=u.role, tier=u.tier, created_at=u.created_at, via=via)


# ---------------- passwords / tokens ----------------
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, h: str | None) -> bool:
    if not h:
        return False
    try:
        return bcrypt.checkpw(pw.encode(), h.encode())
    except ValueError:
        return False


def make_jwt(user_id: str) -> str:
    now = int(time.time())
    return jwt.encode({"sub": user_id, "iat": now, "exp": now + config.JWT_TTL_S}, config.SECRET_KEY, algorithm="HS256")


def parse_jwt(token: str) -> str | None:
    try:
        return jwt.decode(token, config.SECRET_KEY, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        return None


def new_lab_token() -> tuple[str, str, str]:
    """(plaintext, sha256, display prefix). Plaintext is shown once and never stored."""
    plain = "kal_" + secrets.token_urlsafe(32)
    return plain, hash_token(plain), plain[:12]


def hash_token(plain: str) -> str:
    return hashlib.sha256(plain.encode()).hexdigest()


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(config.COOKIE_NAME, token, max_age=config.JWT_TTL_S, httponly=True, samesite="lax", secure=config.COOKIE_SECURE, path="/")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(config.COOKIE_NAME, path="/")


# ---------------- login throttling (per client ip, in-process) ----------------
_failures: dict[str, deque] = defaultdict(deque)
FAIL_WINDOW_S, FAIL_MAX = 60, 8


def throttle_check(ip: str) -> None:
    q = _failures[ip]
    now = time.time()
    while q and now - q[0] > FAIL_WINDOW_S:
        q.popleft()
    if len(q) >= FAIL_MAX:
        raise err(429, "too_many_attempts", "Too many failed sign-in attempts. Try again in a minute.")


def throttle_fail(ip: str) -> None:
    _failures[ip].append(time.time())


# ---------------- users ----------------
def is_admin_email(email: str) -> bool:
    return email.lower() in config.ADMIN_EMAILS


def ensure_local_user() -> Identity:
    with db.session() as s:
        u = s.execute(select(db.User).where(db.User.email == config.LOCAL_USER_EMAIL)).scalar_one_or_none()
        if u is None:
            u = db.User(email=config.LOCAL_USER_EMAIL, name="Local runner", role="admin", tier="pro")
            s.add(u)
            s.flush()
        return identity_of(u, "local")


def _user_by_id(s, uid: str) -> db.User | None:
    return s.get(db.User, uid)


def resolve(request: Request) -> Identity | None:
    """Who is calling. None when anonymous (accounts mode only)."""
    if config.AUTH_MODE == "local":
        return ensure_local_user()
    token: str | None = None
    via = "cookie"
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token, via = auth[7:].strip(), "bearer"
    elif config.COOKIE_NAME in request.cookies:
        token = request.cookies[config.COOKIE_NAME]
    if not token:
        return None
    if token.startswith("kal_"):
        h = hash_token(token)
        with db.session() as s:
            lt = s.execute(select(db.LabToken).where(db.LabToken.token_hash == h)).scalar_one_or_none()
            if not lt:
                return None
            lt.last_used_at = time.time()
            u = _user_by_id(s, lt.user_id)
            return identity_of(u, "lab_token") if u else None
    uid = parse_jwt(token)
    if not uid:
        return None
    with db.session() as s:
        u = _user_by_id(s, uid)
        return identity_of(u, via) if u else None


# ---------------- dependencies ----------------
def current_user_optional(request: Request) -> Identity | None:
    return resolve(request)


def require_user(request: Request) -> Identity:
    ident = resolve(request)
    if ident is None:
        raise err(401, "unauthenticated", "Sign in to continue.")
    return ident


def require_admin(request: Request) -> Identity:
    ident = require_user(request)
    if not ident.is_admin:
        raise err(403, "forbidden", "Admin only.")
    return ident


def require_lab_token(request: Request) -> Identity:
    ident = resolve(request)
    if ident is None or ident.via != "lab_token":
        raise err(401, "unauthenticated", "A lab token (Bearer kal_...) is required.")
    return ident

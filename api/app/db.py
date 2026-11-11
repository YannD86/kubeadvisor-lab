"""Platform database: users, purchases, per-user progress, assessment attempts, lab tokens.

Sync SQLAlchemy 2.0. SQLite by default (``KA_DATABASE_URL=sqlite:///...``), Postgres in
production (``postgresql+psycopg://...``). Tables are created with ``create_all`` at
startup; ``api/alembic`` holds migrations for schema changes after the first release.
"""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app import config

_engine: Engine | None = None
_Session: sessionmaker[Session] | None = None


def new_id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="user")        # user | admin
    tier: Mapped[str] = mapped_column(String(20), default="free")        # free | pro
    stripe_customer_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    subscription_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    subscription_period_end: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class Purchase(Base):
    __tablename__ = "purchases"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"), index=True)
    product_id: Mapped[str] = mapped_column(String(100), index=True)
    amount_cents: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String(10), default="usd")
    stripe_session_id: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    stripe_payment_intent: Mapped[str | None] = mapped_column(String(200), nullable=True)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    granted_at: Mapped[float] = mapped_column(Float, default=time.time)
    expires_at: Mapped[float | None] = mapped_column(Float, nullable=True)
    revoked_at: Mapped[float | None] = mapped_column(Float, nullable=True)

    def active(self, now: float | None = None) -> bool:
        now = now or time.time()
        return self.revoked_at is None and (self.expires_at is None or self.expires_at > now)


class Progress(Base):
    __tablename__ = "progress"
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    status: Mapped[str] = mapped_column(String(40))
    data: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


class QuizAttempt(Base):
    __tablename__ = "quiz_attempts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"), index=True)
    product_id: Mapped[str] = mapped_column(String(100), index=True)
    assessment_id: Mapped[str] = mapped_column(String(100), index=True)
    score: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    percent: Mapped[float] = mapped_column(Float)
    passed: Mapped[bool] = mapped_column(Boolean)
    answers: Mapped[str] = mapped_column(Text, default="{}")
    by_domain: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class LabToken(Base):
    __tablename__ = "lab_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(32), ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    last_used_at: Mapped[float | None] = mapped_column(Float, nullable=True)


class WebhookEvent(Base):
    __tablename__ = "webhook_events"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)   # stripe event id
    type: Mapped[str] = mapped_column(String(100))
    received_at: Mapped[float] = mapped_column(Float, default=time.time)


# ---------------------------------------------------------------------------
def get_engine() -> Engine:
    global _engine, _Session
    if _engine is None:
        url = config.DATABASE_URL
        kw: dict = {"future": True}
        if url.startswith("sqlite"):
            kw["connect_args"] = {"check_same_thread": False}
        _engine = create_engine(url, **kw)
        if url.startswith("sqlite"):
            @event.listens_for(_engine, "connect")
            def _pragmas(dbapi_conn, _):  # noqa: ANN001
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
        Base.metadata.create_all(_engine)
    return _engine


def init() -> None:
    get_engine()


def reset_engine() -> None:
    """Tests: drop the cached engine so a new DATABASE_URL takes effect."""
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _Session = None


@contextmanager
def session() -> Iterator[Session]:
    get_engine()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


# ---------------- progress ----------------
def _row(r: Progress) -> dict:
    return {"kind": r.kind, "item_id": r.item_id, "status": r.status, "data": json.loads(r.data or "{}"), "updated_at": r.updated_at}


def set_progress(user_id: str, kind: str, item_id: str, status: str, data: dict | None = None, *,
                 updated_at: float | None = None, only_if_newer: bool = False, propagate: bool = True) -> dict:
    """Upsert one progress row for a user, merging ``data`` into what is stored.

    ``only_if_newer`` is used by the sync endpoint so an older runner write never
    overwrites a newer platform state. ``propagate`` lets the local runner push the
    write to the platform (see services.sync); the sync endpoint passes False.
    """
    now = updated_at or time.time()
    with session() as s:
        row = s.get(Progress, (user_id, kind, item_id))
        if row is None:
            row = Progress(user_id=user_id, kind=kind, item_id=item_id, status=status, data="{}", updated_at=now)
            s.add(row)
        elif only_if_newer and row.updated_at >= now:
            return _row(row)
        merged = json.loads(row.data or "{}")
        merged.update(data or {})
        row.status = status
        row.data = json.dumps(merged)
        row.updated_at = now
        out = {"kind": kind, "item_id": item_id, "status": status, "data": merged, "updated_at": now}
    if propagate:
        from app.services import sync  # local import: sync imports config only

        sync.enqueue(out)
    return out


def get_all(user_id: str) -> list[dict]:
    with session() as s:
        rows = s.execute(select(Progress).where(Progress.user_id == user_id).order_by(Progress.updated_at.desc())).scalars().all()
        return [_row(r) for r in rows]


def reset_all(user_id: str) -> None:
    with session() as s:
        for r in s.execute(select(Progress).where(Progress.user_id == user_id)).scalars().all():
            s.delete(r)
        for r in s.execute(select(QuizAttempt).where(QuizAttempt.user_id == user_id)).scalars().all():
            s.delete(r)

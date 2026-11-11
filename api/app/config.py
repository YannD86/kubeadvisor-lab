"""Settings for the KubeAdvisor API: lab engine paths (LAB_*) and platform settings (KA_*).

Values are read at import time but kept as plain module attributes so tests can
monkeypatch them (e.g. ``app.config.AUTH_MODE = "accounts"``). Code must read
``config.X`` at call time rather than copying values into other modules.
"""
from __future__ import annotations

import os
import secrets
import warnings
from pathlib import Path

VERSION = "0.2.0"
PRODUCT_NAME = "KubeAdvisor"

ROOT = Path(__file__).resolve().parents[2]
CONTENT_DIR = ROOT / "content"
CLUSTER_DIR = ROOT / "cluster"
BIN_DIR = ROOT / "bin"

# ---- lab engine -------------------------------------------------------------
LAB_HOME = Path(os.environ.get("LAB_HOME", str(Path.home() / ".kubeadvisor")))
KUBECONFIG = Path(os.environ.get("KUBECONFIG_LAB", str(LAB_HOME / "kubeconfig")))
WORK_DIR = LAB_HOME / "work"
STATE_DIR = LAB_HOME / "state"
CLUSTER_NAME = os.environ.get("LAB_CLUSTER", "sre-labs")

API_PORT = int(os.environ.get("LAB_API_PORT", "10201"))
WEB_PORT = int(os.environ.get("LAB_WEB_PORT", "10200"))
API_URL = os.environ.get("LAB_API_URL", f"http://localhost:{API_PORT}")

ADDON_IDS = ["metrics-server", "gitea", "flux", "ingress-nginx", "cert-manager"]

for d in (LAB_HOME, WORK_DIR, STATE_DIR, LAB_HOME / "backup"):
    d.mkdir(parents=True, exist_ok=True)

# ---- platform ---------------------------------------------------------------
ENV = os.environ.get("KA_ENV", "development")                       # development | production
AUTH_MODE = os.environ.get("KA_AUTH_MODE", "local")                 # local | accounts
LAB_MODE = os.environ.get("KA_LAB_MODE", "local")                   # local | hosted
SIGNUP_ENABLED = os.environ.get("KA_SIGNUP_ENABLED", "1") == "1"
FIRST_USER_ADMIN = os.environ.get("KA_FIRST_USER_ADMIN", "1" if ENV == "development" else "0") == "1"
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("KA_ADMIN_EMAILS", "").split(",") if e.strip()}

DATABASE_URL = os.environ.get("KA_DATABASE_URL", f"sqlite:///{LAB_HOME / 'platform.db'}")
# accept the async spellings too, we use the sync drivers
DATABASE_URL = DATABASE_URL.replace("sqlite+aiosqlite://", "sqlite://").replace("postgresql+asyncpg://", "postgresql+psycopg://")

SECRET_KEY = os.environ.get("KA_SECRET_KEY", "")
if not SECRET_KEY:
    if ENV == "production" and AUTH_MODE == "accounts":
        raise RuntimeError("KA_SECRET_KEY is required in production with KA_AUTH_MODE=accounts")
    SECRET_KEY = secrets.token_hex(32)  # per-process dev key: sessions do not survive a restart
    if AUTH_MODE == "accounts":
        warnings.warn("KA_SECRET_KEY not set: using a random per-process key (sessions reset on restart)", stacklevel=1)

JWT_TTL_S = int(os.environ.get("KA_JWT_TTL_S", str(30 * 24 * 3600)))
COOKIE_NAME = "ka_session"
COOKIE_SECURE = os.environ.get("KA_COOKIE_SECURE", "0") == "1"
WEB_ORIGIN = os.environ.get("KA_WEB_ORIGIN", f"http://localhost:{WEB_PORT}")

STRIPE_SECRET_KEY = os.environ.get("KA_STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("KA_STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRO_PRICE_ID = os.environ.get("KA_STRIPE_PRO_PRICE_ID", "")
PRO_PRICE_CENTS = int(os.environ.get("KA_PRO_PRICE_CENTS", "1900"))
PRO_CURRENCY = os.environ.get("KA_PRO_CURRENCY", "usd")

PLATFORM_URL = os.environ.get("KA_PLATFORM_URL", "").rstrip("/")
LAB_TOKEN = os.environ.get("KA_LAB_TOKEN", "")

LOCAL_USER_EMAIL = "local@runner"


def billing_enabled() -> bool:
    return bool(STRIPE_SECRET_KEY)


def script_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for every script / shell the API spawns."""
    env = dict(os.environ)
    env.update(
        {
            "LAB_ROOT": str(ROOT),
            "LAB_HOME": str(LAB_HOME),
            "LAB_CLUSTER": CLUSTER_NAME,
            "KUBECONFIG": str(KUBECONFIG),
            "LAB_API_URL": API_URL,
            "PATH": f"{BIN_DIR}:{env.get('PATH', '')}",
            "TERM": env.get("TERM", "xterm-256color"),
        }
    )
    if extra:
        env.update(extra)
    return env

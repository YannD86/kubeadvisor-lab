"""KubeAdvisor API: lab engine (builders, scenarios, cluster, terminal) + platform (accounts, courses, billing)."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import config, db
from app.routers import (admin, auth, billing, builders, cluster, courses, lab_tokens, lessons, meta, products, progress,
                         realms, scenarios, sync, terminal)
from app.services import scenarios as scenario_svc
from app.services import sync as sync_svc
from app.services.jobs import bind_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    bind_loop(asyncio.get_running_loop())
    stuck = scenario_svc.reconcile_on_startup()
    if stuck:
        print(f"[reconcile] marked interrupted scenarios as error: {', '.join(stuck)}")
    sync_svc.start()
    print(f"{config.PRODUCT_NAME} API {config.VERSION} on :{config.API_PORT}  auth={config.AUTH_MODE} lab={config.LAB_MODE} "
          f"billing={'on' if config.billing_enabled() else 'off'} sync={'on' if sync_svc.configured() else 'off'}  "
          f"content={config.CONTENT_DIR}  home={config.LAB_HOME}")
    yield


app = FastAPI(title=f"{config.PRODUCT_NAME} API", version=config.VERSION, lifespan=lifespan,
              docs_url="/docs" if config.ENV != "production" else None, redoc_url=None)

_origins = {config.WEB_ORIGIN, f"http://localhost:{config.WEB_PORT}", f"http://127.0.0.1:{config.WEB_PORT}"}
app.add_middleware(CORSMiddleware, allow_origins=sorted(_origins), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

for r in (meta, auth, realms, builders, lessons, scenarios, cluster, progress, terminal, products, courses, lab_tokens, sync, billing, admin):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"status": "ok", "version": config.VERSION, "auth_mode": config.AUTH_MODE, "lab_mode": config.LAB_MODE}

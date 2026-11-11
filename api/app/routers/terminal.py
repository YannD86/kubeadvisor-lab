import json

from fastapi import APIRouter, WebSocket

from app import auth, config
from app.services.terminal import bridge, build_session

router = APIRouter(tags=["terminal"])


async def _refuse(ws: WebSocket, code: int, error: str, message: str) -> None:
    await ws.accept()
    await ws.send_text(json.dumps({"error": error, "message": message}))
    await ws.close(code=code)


@router.websocket("/ws/terminal")
async def terminal(ws: WebSocket, mode: str = "shell", scenario: str | None = None, namespace: str | None = None, cols: int = 120, rows: int = 32):
    if config.LAB_MODE == "hosted":
        await _refuse(ws, 4409, "lab_mode_hosted", "Labs run in your local KubeAdvisor runner.")
        return
    if config.AUTH_MODE == "accounts":
        # a shell on this host: only admins, and only on an instance that runs the lab engine locally
        ident = auth.resolve(ws)  # type: ignore[arg-type]  (WebSocket exposes headers/cookies like Request)
        if ident is None or not ident.is_admin:
            await _refuse(ws, 4403, "forbidden", "The terminal is admin-only on a shared instance.")
            return
    await ws.accept()
    session = build_session(mode, scenario or None, namespace or None, cols, rows)
    await bridge(ws, session)

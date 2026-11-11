"""The PTY websocket bridge: banner, command echo, resize control frame."""
import json
import os
import re
import tempfile

os.environ.setdefault("LAB_HOME", tempfile.mkdtemp(prefix="sre-labs-test-"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def _read_until(ws, needle: str, max_frames: int = 60) -> str:
    buf = ""
    for _ in range(max_frames):
        msg = ws.receive()
        if msg.get("type") == "websocket.close":
            break
        data = msg.get("bytes") or (msg.get("text") or "").encode()
        buf += data.decode(errors="replace")
        if needle in ANSI.sub("", buf):
            break
    return ANSI.sub("", buf)


def test_shell_session_roundtrip():
    with TestClient(app) as client:
        with client.websocket_connect("/ws/terminal?mode=shell&scenario=svc-selector-mismatch&namespace=lab-shop&cols=90&rows=24") as ws:
            banner = _read_until(ws, "scenario:")
            assert "SRE Kube Labs terminal" in banner
            assert "svc-selector-mismatch" in banner
            ws.send_text("echo MARK_$LAB_NAMESPACE\n")
            out = _read_until(ws, "MARK_lab-shop\r\n")
            assert "MARK_lab-shop" in out
            ws.send_text("\x01" + json.dumps({"resize": [132, 43]}))
            ws.send_text("stty size\n")
            out = _read_until(ws, "43 132")
            assert "43 132" in out
            ws.send_text("exit\n")

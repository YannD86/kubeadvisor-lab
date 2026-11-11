"""Runner → platform progress sync.

When ``KA_PLATFORM_URL`` and ``KA_LAB_TOKEN`` are set, every local progress write is
queued and pushed to ``POST {platform}/api/sync/progress`` from a background thread.
Failures are remembered and retried on the next write; they never block the local write.
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque

import httpx

from app import config

_lock = threading.Lock()
_queue: deque[dict] = deque(maxlen=5000)
_state = {"last_sync": None, "last_error": None, "pending": 0, "sent": 0}
_wake = threading.Event()
_thread: threading.Thread | None = None
_stop = False


def configured() -> bool:
    return bool(config.PLATFORM_URL and config.LAB_TOKEN)


def status() -> dict:
    with _lock:
        return {"configured": configured(), "platform_url": config.PLATFORM_URL or None, "pending": len(_queue), **_state}


def enqueue(item: dict) -> None:
    if not configured():
        return
    with _lock:
        _queue.append(item)
        _state["pending"] = len(_queue)
    _wake.set()
    start()


def flush_once(timeout: float = 10.0) -> bool:
    """Push everything queued in one request. Returns True on success (or nothing to send)."""
    with _lock:
        if not _queue:
            return True
        batch = list(_queue)
    try:
        r = httpx.post(f"{config.PLATFORM_URL}/api/sync/progress", json={"items": batch},
                       headers={"Authorization": f"Bearer {config.LAB_TOKEN}"}, timeout=timeout)
        r.raise_for_status()
        accepted = int(r.json().get("accepted", 0))
    except Exception as e:  # noqa: BLE001
        with _lock:
            _state["last_error"] = f"{type(e).__name__}: {str(e)[:200]}"
        return False
    with _lock:
        for _ in range(min(len(batch), len(_queue))):
            _queue.popleft()
        _state.update({"last_sync": time.time(), "last_error": None, "pending": len(_queue), "sent": _state["sent"] + accepted})
    return True


def _loop() -> None:
    backoff = 1.0
    while not _stop:
        _wake.wait(timeout=30)
        _wake.clear()
        time.sleep(0.3)  # coalesce bursts (a check writes several rows)
        if flush_once():
            backoff = 1.0
        else:
            time.sleep(min(backoff, 60))
            backoff *= 2


def start() -> None:
    global _thread
    if not configured() or (_thread and _thread.is_alive()):
        return
    _thread = threading.Thread(target=_loop, name="ka-sync", daemon=True)
    _thread.start()


def debug_dump() -> str:
    return json.dumps(status())

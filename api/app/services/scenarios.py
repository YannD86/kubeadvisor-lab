"""Scenario lifecycle: load (setup.sh), check, hints, reset, cleanup. State in LAB_HOME/state/scenarios.json."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from app.config import STATE_DIR, WORK_DIR, script_env
from app.content import get_scenario
from app.services.jobs import Job, lock_for, running_jobs, start_job
from app import db

STATE_FILE = STATE_DIR / "scenarios.json"


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _save_state(st: dict) -> None:
    STATE_FILE.write_text(json.dumps(st, indent=2))


def state_of(sid: str) -> dict:
    return _load_state().get(sid, {"status": "idle", "hints_revealed": 0, "attempts": 0})


def all_states() -> dict:
    return _load_state()


def _update(sid: str, **kw) -> dict:
    st = _load_state()
    cur = st.get(sid, {"status": "idle", "hints_revealed": 0, "attempts": 0})
    cur.update(kw)
    st[sid] = cur
    _save_state(st)
    return cur


INTERRUPTIBLE = {"loading": "loading", "cleaning": "cleaning up"}


def reconcile_on_startup() -> list[str]:
    """Jobs live in memory, so an API restart during setup/cleanup leaves a scenario stuck in
    'loading' or 'cleaning' forever. Flip those to 'error' with an explanation so the UI offers Reset."""
    st = _load_state()
    fixed: list[str] = []
    for sid, cur in st.items():
        phase = INTERRUPTIBLE.get(cur.get("status"))
        if not phase:
            continue
        cur["status"] = "error"
        cur["error"] = (f"The API restarted while this scenario was {phase}, so that job never finished. "
                        "Resources may be partially in place: run Reset to reload cleanly, or Clean up.")
        fixed.append(sid)
    if fixed:
        _save_state(st)
    return fixed


def _env(sid: str) -> dict:
    s = get_scenario(sid)
    wd = WORK_DIR / sid
    wd.mkdir(parents=True, exist_ok=True)
    return {"LAB_SCENARIO": sid, "LAB_WORKDIR": str(wd), "LAB_NAMESPACE": str((s or {}).get("namespace", ""))}


def _job_error(phase: str, job: Job) -> str | None:
    if job.status == "succeeded":
        return None
    return f"{phase} job failed (exit {job.returncode}); see the Log tab."


def _job_for(sid: str, phase: str) -> Job | None:
    for j in running_jobs():
        if j.kind == "scenario" and j.meta.get("scenario") == sid and j.meta.get("phase") == phase:
            return j
    return None


def load(sid: str) -> Job:
    s = get_scenario(sid)
    if not s:
        raise KeyError(sid)
    if j := _job_for(sid, "setup"):
        return j
    _update(sid, status="loading", loaded_at=None, passed_at=None, error=None)

    async def done(job: Job):
        _update(sid, status="loaded" if job.status == "succeeded" else "error", loaded_at=time.time(), error=_job_error("Setup", job))

    return start_job("scenario", f"Load {s['title']}", ["bash", str(Path(s["dir"]) / "setup.sh")],
                     env_extra=_env(sid), cwd=str(WORK_DIR / sid), timeout=600,
                     meta={"scenario": sid, "phase": "setup"}, on_done=done)


def cleanup(sid: str) -> Job:
    s = get_scenario(sid)
    if not s:
        raise KeyError(sid)
    if j := _job_for(sid, "cleanup"):
        return j
    _update(sid, status="cleaning", error=None)

    async def done(job: Job):
        _update(sid, status="idle" if job.status == "succeeded" else "error", hints_revealed=0, error=_job_error("Cleanup", job))

    return start_job("scenario", f"Clean up {s['title']}", ["bash", str(Path(s["dir"]) / "cleanup.sh")],
                     env_extra=_env(sid), cwd=str(WORK_DIR / sid), timeout=600,
                     meta={"scenario": sid, "phase": "cleanup"}, on_done=done)


def reset(sid: str) -> Job:
    """cleanup then setup, as one job (bash -c)."""
    s = get_scenario(sid)
    if not s:
        raise KeyError(sid)
    if j := _job_for(sid, "reset"):
        return j
    _update(sid, status="loading", passed_at=None, error=None)
    d = Path(s["dir"])

    async def done(job: Job):
        _update(sid, status="loaded" if job.status == "succeeded" else "error", loaded_at=time.time(), hints_revealed=0, error=_job_error("Reset", job))

    script = f'bash "{d / "cleanup.sh"}" || true; sleep 2; bash "{d / "setup.sh"}"'
    return start_job("scenario", f"Reset {s['title']}", ["bash", "-c", script],
                     env_extra=_env(sid), cwd=str(WORK_DIR / sid), timeout=900,
                     meta={"scenario": sid, "phase": "reset"}, on_done=done)


async def run_checks(sid: str, user_id: str) -> dict:
    s = get_scenario(sid)
    if not s:
        raise KeyError(sid)
    env = script_env(_env(sid))
    results = []
    all_ok = True
    for c in s.get("checks") or []:
        t0 = time.time()
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", "-o", "pipefail", "-c", c["cmd"],
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, cwd=str(WORK_DIR / sid),
            )
            out, _ = await asyncio.wait_for(proc.communicate(), 45)
            rc = proc.returncode or 0
            text = out.decode(errors="replace").strip()
        except asyncio.TimeoutError:
            rc, text = 124, "check timed out after 45s"
        ok = rc == 0
        all_ok = all_ok and ok
        results.append({"name": c["name"], "passed": ok, "output": text[-1500:], "seconds": round(time.time() - t0, 1)})
    cur = state_of(sid)
    attempts = cur.get("attempts", 0) + 1
    upd = {"attempts": attempts, "last_check_at": time.time()}
    if all_ok:
        upd["passed_at"] = time.time()
        db.set_progress(user_id, "scenario", sid, "passed", {"attempts": attempts, "hints_used": cur.get("hints_revealed", 0)})
    else:
        db.set_progress(user_id, "scenario", sid, "attempted", {"attempts": attempts})
    _update(sid, **upd)
    return {"passed": all_ok, "results": results, "attempts": attempts, "concepts": s.get("concepts") if all_ok else None}


def reveal_hint(sid: str, index: int) -> dict:
    s = get_scenario(sid)
    if not s:
        raise KeyError(sid)
    hints = s.get("hints") or []
    index = max(0, min(index, len(hints) - 1))
    cur = state_of(sid)
    revealed = max(cur.get("hints_revealed", 0), index + 1)
    _update(sid, hints_revealed=revealed)
    return {"index": index, "hint": hints[index], "hints_revealed": revealed, "total": len(hints)}

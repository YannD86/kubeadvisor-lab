"""Background jobs that run shell scripts and keep their output in memory."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from app.config import script_env


@dataclass
class Job:
    id: str
    kind: str
    label: str
    status: str = "running"  # running | succeeded | failed
    returncode: int | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    output: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def to_dict(self, tail: int | None = None) -> dict:
        lines = self.output if tail is None else self.output[-tail:]
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "returncode": self.returncode,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration": round((self.finished_at or time.time()) - self.started_at, 1),
            "output": lines,
            "line_count": len(self.output),
            "meta": self.meta,
        }


JOBS: dict[str, Job] = {}
_locks: dict[str, asyncio.Lock] = {}
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Remember the server's event loop so sync code (threadpool routes) can schedule jobs."""
    global _loop
    _loop = loop


def _schedule(coro) -> None:
    try:
        asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        if _loop is None:
            raise
        asyncio.run_coroutine_threadsafe(coro, _loop)


def lock_for(key: str) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


async def _pump(job: Job, cmd: list[str], env: dict, cwd: str | None, timeout: int, on_done=None) -> None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, cwd=cwd
        )
    except Exception as e:  # noqa: BLE001
        job.output.append(f"failed to start: {e}")
        job.status, job.returncode, job.finished_at = "failed", -1, time.time()
        if on_done:
            await on_done(job)
        return

    async def read():
        assert proc.stdout
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            job.output.append(line.decode(errors="replace").rstrip("\n"))

    try:
        await asyncio.wait_for(read(), timeout)
        rc = await proc.wait()
    except asyncio.TimeoutError:
        proc.kill()
        job.output.append(f"[lab] job timed out after {timeout}s and was killed")
        rc = 124
    job.returncode = rc
    job.status = "succeeded" if rc == 0 else "failed"
    job.finished_at = time.time()
    if on_done:
        try:
            await on_done(job)
        except Exception as e:  # noqa: BLE001
            job.output.append(f"[lab] post-hook error: {e}")


def start_job(kind: str, label: str, cmd: list[str], env_extra: dict | None = None, cwd: str | None = None,
              timeout: int = 900, meta: dict | None = None, on_done=None) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, label=label, meta=meta or {})
    JOBS[job.id] = job
    _schedule(_pump(job, cmd, script_env(env_extra), cwd, timeout, on_done))
    # keep memory bounded
    if len(JOBS) > 200:
        for k in list(JOBS)[:-150]:
            del JOBS[k]
    return job


def get_job(jid: str) -> Job | None:
    return JOBS.get(jid)


def running_jobs() -> list[Job]:
    return [j for j in JOBS.values() if j.status == "running"]

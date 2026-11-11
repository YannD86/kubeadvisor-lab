"""Cluster status and lifecycle (kind + addons)."""
from __future__ import annotations

import asyncio
import json
import shutil

from app.config import ADDON_IDS, CLUSTER_DIR, CLUSTER_NAME, KUBECONFIG, script_env
from app.services.jobs import Job, lock_for, running_jobs, start_job

ADDON_PROBE = {
    "metrics-server": ("kube-system", "metrics-server"),
    "gitea": ("lab-gitea", "gitea"),
    "flux": ("flux-system", "source-controller"),
    "ingress-nginx": ("ingress-nginx", "ingress-nginx-controller"),
    "cert-manager": ("cert-manager", "cert-manager"),
}


async def _run(cmd: list[str], timeout: float = 15) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=script_env()
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode or 0, out.decode(errors="replace")
    except FileNotFoundError:
        return 127, "not found"
    except asyncio.TimeoutError:
        return 124, "timeout"


async def tool_versions() -> dict:
    async def v(name: str, args: list[str]):
        if not shutil.which(name):
            return name, None
        rc, out = await _run([name, *args], 8)
        first = out.strip().splitlines()[0] if out.strip() else ""
        return name, first[:80] if rc == 0 else None

    pairs = await asyncio.gather(
        v("docker", ["--version"]), v("kind", ["--version"]), v("kubectl", ["version", "--client", "-o", "json"]),
        v("helm", ["version", "--short"]), v("flux", ["--version"]), v("k9s", ["version", "--short"]),
        v("kubeconform", ["-v"]), v("git", ["--version"]),
    )
    out = dict(pairs)
    if out.get("kubectl") and out["kubectl"].startswith("{"):
        try:
            rc, raw = await _run(["kubectl", "version", "--client", "-o", "json"], 8)
            out["kubectl"] = json.loads(raw).get("clientVersion", {}).get("gitVersion")
        except Exception:  # noqa: BLE001
            pass
    return out


async def status() -> dict:
    docker_rc, _ = await _run(["docker", "info"], 10)
    kind_rc, kind_out = await _run(["kind", "get", "clusters"], 10)
    exists = kind_rc == 0 and CLUSTER_NAME in kind_out.split()
    if exists and not KUBECONFIG.exists():
        # LAB_HOME moved (~/.sre-labs -> ~/.kubeadvisor) or the file was deleted: regenerate it from the running cluster
        await _run(["bash", str(CLUSTER_DIR / "ensure-kubeconfig.sh")], 30)
    nodes: list[dict] = []
    api_ok = False
    addons = {a: False for a in ADDON_IDS}
    if exists and KUBECONFIG.exists():
        rc, out = await _run(["kubectl", "get", "nodes", "-o", "json"], 12)
        if rc == 0:
            api_ok = True
            try:
                for n in json.loads(out).get("items", []):
                    conds = {c["type"]: c["status"] for c in n["status"].get("conditions", [])}
                    labels = n["metadata"].get("labels", {})
                    nodes.append(
                        {
                            "name": n["metadata"]["name"],
                            "ready": conds.get("Ready") == "True",
                            "role": "control-plane" if "node-role.kubernetes.io/control-plane" in labels else "worker",
                            "version": n["status"]["nodeInfo"]["kubeletVersion"],
                            "unschedulable": bool(n["spec"].get("unschedulable")),
                            "taints": [f"{t['key']}={t.get('value','')}:{t['effect']}" for t in n["spec"].get("taints", [])],
                        }
                    )
            except Exception:  # noqa: BLE001
                pass
        if api_ok:
            async def probe(aid: str):
                ns, name = ADDON_PROBE[aid]
                rc2, _ = await _run(["kubectl", "get", "deploy", "-n", ns, name], 10)
                return aid, rc2 == 0

            for aid, ok in await asyncio.gather(*(probe(a) for a in ADDON_IDS)):
                addons[aid] = ok
    jobs = [j.to_dict(tail=3) for j in running_jobs() if j.kind in ("cluster", "addon")]
    return {
        "docker": docker_rc == 0,
        "kind_installed": shutil.which("kind") is not None,
        "cluster_name": CLUSTER_NAME,
        "exists": exists,
        "api_reachable": api_ok,
        "nodes": nodes,
        "addons": addons,
        "kubeconfig": str(KUBECONFIG),
        "running_jobs": jobs,
    }


def _busy(kind: str) -> Job | None:
    return next((j for j in running_jobs() if j.kind == kind), None)


def up() -> Job:
    j = _busy("cluster")
    if j:
        return j
    return start_job("cluster", "Create cluster", ["bash", str(CLUSTER_DIR / "up.sh")], timeout=1500)


def down() -> Job:
    j = _busy("cluster")
    if j:
        return j
    return start_job("cluster", "Delete cluster", ["bash", str(CLUSTER_DIR / "down.sh")], timeout=600)


def reset_labs() -> Job:
    return start_job("cluster", "Delete lab namespaces", ["bash", str(CLUSTER_DIR / "reset-labs.sh")], timeout=300)


def install_addon(aid: str) -> Job:
    if aid not in ADDON_IDS:
        raise ValueError(f"unknown addon {aid}")
    for j in running_jobs():
        if j.kind == "addon" and j.meta.get("addon") == aid:
            return j
    return start_job("addon", f"Install {aid}", ["bash", str(CLUSTER_DIR / "addons" / f"{aid}.sh")], timeout=1200, meta={"addon": aid})


async def missing_addons(required: list[str]) -> list[str]:
    if not required:
        return []
    st = await status()
    if not st["api_reachable"]:
        return list(required)
    return [a for a in required if not st["addons"].get(a)]

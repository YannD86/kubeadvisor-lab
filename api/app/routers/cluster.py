from fastapi import APIRouter, Depends, HTTPException

from app import auth, config
from app.services import access
from app.services import cluster as svc
from app.services.jobs import get_job, running_jobs

router = APIRouter(prefix="/api", tags=["cluster"])


@router.get("/cluster/status")
async def status():
    if config.LAB_MODE == "hosted":
        return {"lab_mode": "hosted", "docker": False, "kind_installed": False, "cluster_name": config.CLUSTER_NAME, "exists": False,
                "api_reachable": False, "nodes": [], "addons": {}, "kubeconfig": "", "running_jobs": []}
    return (await svc.status()) | {"lab_mode": config.LAB_MODE}


@router.get("/cluster/tools")
async def tools():
    return await svc.tool_versions()


@router.post("/cluster/up")
async def up(_: auth.Identity = Depends(auth.require_admin)):
    access.hosted_guard()
    return svc.up().to_dict()


@router.post("/cluster/down")
async def down(_: auth.Identity = Depends(auth.require_admin)):
    access.hosted_guard()
    return svc.down().to_dict()


@router.post("/cluster/reset-labs")
async def reset_labs(_: auth.Identity = Depends(auth.require_admin)):
    access.hosted_guard()
    return svc.reset_labs().to_dict()


@router.post("/cluster/addons/{aid}")
async def addon(aid: str, _: auth.Identity = Depends(auth.require_admin)):
    access.hosted_guard()
    try:
        return svc.install_addon(aid).to_dict()
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/jobs/{jid}")
def job(jid: str, tail: int | None = None):
    j = get_job(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j.to_dict(tail=tail)


@router.get("/jobs")
def jobs():
    return {"running": [j.to_dict(tail=1) for j in running_jobs()]}

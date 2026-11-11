from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import auth, content, db

router = APIRouter(prefix="/api/progress", tags=["progress"])

KINDS = {"builder", "scenario", "lesson", "course_lesson", "exercise", "assessment"}


class ProgressIn(BaseModel):
    kind: str = Field(pattern=r"^[a-z_]{1,40}$")
    item_id: str = Field(min_length=1, max_length=200)
    status: str = Field(min_length=1, max_length=40)
    data: dict = Field(default_factory=dict)


def _course_summary(rows: list[dict]) -> dict:
    done = {r["item_id"] for r in rows if r["kind"] == "course_lesson" and r["status"] == "completed"}
    out = {}
    for p in content.list_products():
        lessons = content.list_course_lessons(p["id"])
        n = sum(1 for l in lessons if f"{p['id']}/{l['slug']}" in done)
        out[p["id"]] = {"title": p["title"], "completed": n, "total": len(lessons), "percent": round(100 * n / len(lessons)) if lessons else 0}
    return out


@router.get("")
def get_progress(ident: auth.Identity = Depends(auth.require_user)):
    rows = db.get_all(ident.id)
    course_total = sum(len(content.list_course_lessons(p["id"])) for p in content.list_products())
    totals = {
        "builders": len(content.list_builders()),
        "scenarios": len(content.list_scenarios()),
        "lessons": sum(len(content.list_lessons(r["id"])) for r in content.list_realms() if r["kind"] == "lessons"),
        "course_lessons": course_total,
    }
    done = {
        "builders": sum(1 for r in rows if r["kind"] == "builder" and r["status"] in ("completed", "applied")),
        "scenarios": sum(1 for r in rows if r["kind"] == "scenario" and r["status"] == "passed"),
        "lessons": sum(1 for r in rows if r["kind"] == "lesson" and r["status"] == "completed"),
        "course_lessons": sum(1 for r in rows if r["kind"] == "course_lesson" and r["status"] == "completed"),
    }
    return {"items": rows, "totals": totals, "done": done, "courses": _course_summary(rows)}


@router.post("")
def set_progress(body: ProgressIn, ident: auth.Identity = Depends(auth.require_user)):
    if body.kind not in KINDS:
        raise auth.err(422, "bad_kind", f"kind must be one of {sorted(KINDS)}")
    return db.set_progress(ident.id, body.kind, body.item_id, body.status, body.data)


@router.delete("")
def reset(ident: auth.Identity = Depends(auth.require_user)):
    db.reset_all(ident.id)
    return {"ok": True}

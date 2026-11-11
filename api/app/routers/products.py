from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select

from app import auth, config, content, db
from app.services import access

router = APIRouter(prefix="/api/products", tags=["products"])


def progress_index(ident: auth.Identity | None) -> dict[tuple[str, str], dict]:
    if ident is None:
        return {}
    return {(i["kind"], i["item_id"]): i for i in db.get_all(ident.id)}


def attempt_stats(ident: auth.Identity | None, pid: str) -> dict[str, tuple[int, float | None]]:
    """assessment_id -> (attempts, best_percent)"""
    if ident is None:
        return {}
    with db.session() as s:
        rows = s.execute(
            select(db.QuizAttempt.assessment_id, func.count(), func.max(db.QuizAttempt.percent))
            .where(db.QuizAttempt.user_id == ident.id, db.QuizAttempt.product_id == pid)
            .group_by(db.QuizAttempt.assessment_id)
        ).all()
    return {aid: (int(n), float(best) if best is not None else None) for aid, n, best in rows}


def summary(p: dict, ent: access.Entitlements, prog: dict) -> dict:
    pid = p["id"]
    out = {k: p.get(k) for k in content.PRODUCT_SUMMARY_FIELDS}
    out["description"] = p.get("description")
    lessons = content.list_course_lessons(pid)
    out["lesson_count"] = len(lessons)
    out["assessment_count"] = len(content.list_assessments(pid))
    out["exercise_count"] = len(content.list_exercises(pid))
    via = access.product_access(ent, pid)
    out["owned"] = via is not None
    out["via"] = via
    done = sum(1 for l in lessons if prog.get(("course_lesson", f"{pid}/{l['slug']}"), {}).get("status") == "completed")
    out["lessons_completed"] = done
    out["progress_percent"] = round(100 * done / len(lessons)) if lessons else 0
    return out


def _visible(p: dict | None, ident: auth.Identity | None) -> bool:
    return bool(p) and (p.get("status", "active") == "active" or bool(ident and ident.is_admin))


@router.get("")
def list_products(ident: auth.Identity | None = Depends(auth.current_user_optional)):
    ent = access.entitlements_for(ident)
    prog = progress_index(ident)
    items = [summary(p, ent, prog) for p in content.list_products(include_draft=bool(ident and ident.is_admin))]
    return {
        "products": items,
        "pro": {"price_cents": config.PRO_PRICE_CENTS, "currency": config.PRO_CURRENCY, "interval": "month",
                "enabled": config.billing_enabled() and bool(config.STRIPE_PRO_PRICE_ID), "active": ent.pro},
    }


@router.get("/{pid}")
def get_product(pid: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    p = content.get_product(pid)
    if not _visible(p, ident):
        raise HTTPException(404, "product not found")
    assert p is not None
    ent = access.entitlements_for(ident)
    prog = progress_index(ident)
    out = summary(p, ent, prog)
    owned = out["owned"]
    out["lessons"] = [
        l | {"locked": not (l.get("preview") or owned),
             "completed": prog.get(("course_lesson", f"{pid}/{l['slug']}"), {}).get("status") == "completed"}
        for l in content.list_course_lessons(pid)
    ]
    stats = attempt_stats(ident, pid)
    out["assessments"] = [
        {"id": a["id"], "title": a.get("title"), "kind": a.get("kind"), "description": a.get("description"), "order": a.get("order"),
         "question_count": len(a.get("questions") or []), "time_limit_minutes": a.get("time_limit_minutes", 0),
         "pass_percent": a.get("pass_percent", 70), "locked": not owned,
         "attempts": stats.get(a["id"], (0, None))[0], "best_percent": stats.get(a["id"], (0, None))[1]}
        for a in content.list_assessments(pid)
    ]
    out["exercises"] = [
        {"id": e["id"], "title": e.get("title"), "order": e.get("order"), "domain": e.get("domain"), "difficulty": e.get("difficulty"),
         "objective": e.get("objective"), "mode": e.get("mode", "legacy"), "scenario": e.get("scenario"), "locked": not owned,
         "status": prog.get(("exercise", f"{pid}/{e['id']}"), {}).get("status", "idle")}
        for e in content.list_exercises(pid)
    ]
    out["included_products"] = [summary(c, ent, prog) for c in (content.get_product(i) for i in p.get("includes") or []) if c]
    return out

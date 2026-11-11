import json
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app import auth, content, db
from app.services import access

router = APIRouter(prefix="/api/courses", tags=["courses"])


def _product(pid: str, ident: auth.Identity | None) -> dict:
    p = content.get_product(pid)
    if not p or (p.get("status", "active") != "active" and not (ident and ident.is_admin)):
        raise HTTPException(404, "product not found")
    return p


def _status(ident: auth.Identity | None, kind: str, item: str) -> str | None:
    if ident is None:
        return None
    with db.session() as s:
        row = s.get(db.Progress, (ident.id, kind, item))
        return row.status if row else None


@router.get("/{pid}/lessons/{slug}")
def lesson(pid: str, slug: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    _product(pid, ident)
    l = content.get_course_lesson(pid, slug)
    if not l:
        raise HTTPException(404, "lesson not found")
    ent = access.entitlements_for(ident)
    via = access.product_access(ent, pid)
    if not l.get("preview"):
        via = access.require_product(ent, pid, anonymous=ident is None)
    out = dict(l)
    src = out.pop("source", None) or {}
    out["source"] = {"system": src.get("system"), "review": src.get("review")}
    out["access_via"] = via
    out["completed"] = _status(ident, "course_lesson", f"{pid}/{slug}") == "completed"
    out["scenario_items"] = [s for s in content.list_scenarios() if s["id"] in (l.get("scenarios") or [])]
    out["builder_items"] = [b for b in content.list_builders() if b["id"] in (l.get("builders") or [])]
    return out


def _attempts(ident: auth.Identity | None, pid: str, aid: str) -> tuple[int, float | None]:
    if ident is None:
        return 0, None
    with db.session() as s:
        n, best = s.execute(
            select(func.count(), func.max(db.QuizAttempt.percent))
            .where(db.QuizAttempt.user_id == ident.id, db.QuizAttempt.product_id == pid, db.QuizAttempt.assessment_id == aid)
        ).one()
    return int(n or 0), (float(best) if best is not None else None)


ASSESSMENT_FIELDS = ["id", "title", "product", "kind", "description", "time_limit_minutes", "pass_percent", "domain", "order"]


@router.get("/{pid}/assessments/{aid}")
def assessment(pid: str, aid: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    _product(pid, ident)
    a = content.get_assessment(pid, aid)
    if not a:
        raise HTTPException(404, "assessment not found")
    ent = access.entitlements_for(ident)
    access.require_product(ent, pid, anonymous=ident is None)
    qs = [{"index": i, "q": q.get("q"), "options": q.get("options") or [], "domain": q.get("domain"), "difficulty": q.get("difficulty")}
          for i, q in enumerate(a.get("questions") or [])]
    n, best = _attempts(ident, pid, aid)
    out = {k: a.get(k) for k in ASSESSMENT_FIELDS}
    out.update({"questions": qs, "question_count": len(qs), "attempts": n, "best_percent": best,
                "time_limit_minutes": a.get("time_limit_minutes") or 0, "pass_percent": a.get("pass_percent") or 70})
    return out


class SubmitIn(BaseModel):
    answers: dict[str, int] = Field(default_factory=dict)   # question index -> option index
    seconds: int | None = None


@router.post("/{pid}/assessments/{aid}/submit")
def submit(pid: str, aid: str, body: SubmitIn, ident: auth.Identity = Depends(auth.require_user)):
    _product(pid, ident)
    a = content.get_assessment(pid, aid)
    if not a:
        raise HTTPException(404, "assessment not found")
    access.require_product(access.entitlements_for(ident), pid, anonymous=False)
    questions = a.get("questions") or []
    results, by_domain = [], {}
    score = 0
    for i, q in enumerate(questions):
        chosen = body.answers.get(str(i))
        correct = chosen is not None and chosen == q.get("answer")
        score += int(correct)
        dom = q.get("domain") or "general"
        d = by_domain.setdefault(dom, {"correct": 0, "total": 0})
        d["total"] += 1
        d["correct"] += int(correct)
        results.append({"index": i, "correct": correct, "answer": q.get("answer"), "chosen": chosen, "explain": q.get("explain") or q.get("explanation")})
    total = len(questions)
    percent = round(100 * score / total, 1) if total else 0.0
    pass_percent = a.get("pass_percent") or 70
    passed = percent >= pass_percent
    with db.session() as s:
        s.add(db.QuizAttempt(user_id=ident.id, product_id=pid, assessment_id=aid, score=score, total=total, percent=percent,
                             passed=passed, answers=json.dumps(body.answers), by_domain=json.dumps(by_domain)))
    n, best = _attempts(ident, pid, aid)
    db.set_progress(ident.id, "assessment", f"{pid}/{aid}", "passed" if (best or 0) >= pass_percent else "attempted",
                    {"best_percent": best, "last_percent": percent, "attempts": n, "last_at": time.time()})
    return {"score": score, "total": total, "percent": percent, "passed": passed, "pass_percent": pass_percent,
            "results": results, "by_domain": by_domain, "attempts": n, "best_percent": best}


@router.get("/{pid}/exercises/{eid}")
def exercise(pid: str, eid: str, ident: auth.Identity | None = Depends(auth.current_user_optional)):
    _product(pid, ident)
    e = content.get_exercise(pid, eid)
    if not e:
        raise HTTPException(404, "exercise not found")
    access.require_product(access.entitlements_for(ident), pid, anonymous=ident is None)
    out = dict(e)
    legacy = out.pop("legacy", None) or {}
    # legacy tasks reference objects their setup commands create; without them the task cannot be done
    out["setup_commands"] = list(legacy.get("setup_commands") or [])
    out["scenario_item"] = next((s for s in content.list_scenarios() if s["id"] == e.get("scenario")), None) if e.get("scenario") else None
    out["status"] = _status(ident, "exercise", f"{pid}/{eid}") or "idle"
    return out

from fastapi import APIRouter, HTTPException

from app import content

router = APIRouter(prefix="/api/lessons", tags=["lessons"])


@router.get("/{realm}")
def list_lessons(realm: str):
    if not content.get_realm(realm):
        raise HTTPException(404, "realm not found")
    return {"realm": content.get_realm(realm), "lessons": content.list_lessons(realm)}


@router.get("/{realm}/{slug}")
def get_lesson(realm: str, slug: str):
    l = content.get_lesson(realm, slug)
    if not l:
        raise HTTPException(404, "lesson not found")
    # enrich linked items with titles so the UI can render cards
    l["builder_items"] = [b for b in content.list_builders() if b["id"] in (l.get("builders") or [])]
    l["scenario_items"] = [s for s in content.list_scenarios() if s["id"] in (l.get("scenarios") or [])]
    return l

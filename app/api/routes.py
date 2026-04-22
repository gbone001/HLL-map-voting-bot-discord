"""FastAPI routes for the map vote service."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.clients.crcon_client import CRCONClient
from app.models.schemas import CastVoteRequest, CloseVoteRequest, ForceWinnerRequest, StartVoteRequest
from app.services.mapvote_service import MapVoteService
from app.storage.postgres_store import store

router = APIRouter()

crcon = CRCONClient()
service = MapVoteService(crcon, store)


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "database": "configured"}


@router.post("/votes/start")
async def start_vote(req: StartVoteRequest):
    try:
        return await service.start_vote(req.maps, req.duration_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/votes/active")
async def active():
    return await service.get_active_vote()


@router.post("/votes/cast")
async def cast(req: CastVoteRequest):
    result = await service.cast_vote(req.voter_id, req.map_name)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/votes/close")
async def close(req: CloseVoteRequest):
    result = await service.close_vote(req.apply)
    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/votes/cancel")
async def cancel():
    result = await service.cancel_vote()
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/votes/results")
async def results():
    result = await service.get_results()
    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/votes/force")
async def force(req: ForceWinnerRequest):
    result = await service.force_winner(req.map_name, req.apply)
    if isinstance(result, dict) and "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/votes/suggested-pool")
async def suggested_pool(player_count: int | None = None):
    return await service.suggest_map_pool(player_count)

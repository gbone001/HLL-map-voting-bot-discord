"""Core map vote domain service."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.schemas import VoteRecord
from app.models.vote_state import select_winner
from app.storage.postgres_store import store


class MapVoteService:
    """Owns vote lifecycle, tallying, and optional CRCON application."""

    def __init__(self, crcon, vote_store=store) -> None:
        self.crcon = crcon
        self.store = vote_store

    async def start_vote(
        self,
        maps: list[str],
        duration_seconds: int,
        actor_type: str = "system",
        actor_id: str = "system",
    ) -> VoteRecord:
        if not maps:
            raise ValueError("maps must contain at least one map")

        if duration_seconds <= 0:
            raise ValueError("duration_seconds must be greater than zero")

        current_vote = await self.store.get_active_vote()
        if current_vote and current_vote.active:
            raise ValueError("an active vote already exists")

        vote_id = str(uuid.uuid4())
        closes_at = datetime.now(timezone.utc) + timedelta(seconds=duration_seconds)
        vote = await self.store.create_vote(
            vote_id=vote_id,
            maps=maps,
            closes_at=closes_at,
        )
        await self._audit(
            actor_type=actor_type,
            actor_id=actor_id,
            action="vote_started",
            vote_id=vote.vote_id,
            payload={"maps": maps, "duration_seconds": duration_seconds},
            result={"active": True},
        )
        return vote

    async def get_active_vote(self) -> VoteRecord | None:
        return await self.store.get_active_vote()

    async def cast_vote(
        self,
        voter_id: str,
        map_name: str,
        actor_type: str = "discord",
        actor_id: str | None = None,
    ) -> dict:
        vote = await self.store.get_active_vote()
        if not vote or not vote.active:
            return {"error": "no active vote"}

        valid_maps = {option.map_name for option in vote.options}
        if map_name not in valid_maps:
            return {"error": "invalid map"}

        await self.store.cast_vote(vote.vote_id, voter_id, map_name)

        await self._audit(
            actor_type=actor_type,
            actor_id=actor_id or voter_id,
            action="vote_cast",
            vote_id=vote.vote_id,
            payload={"voter_id": voter_id, "map_name": map_name},
            result={"status": "vote_cast"},
        )
        return {"status": "vote_cast"}

    async def close_vote(
        self,
        apply_winner: bool = False,
        actor_type: str = "system",
        actor_id: str = "system",
    ) -> VoteRecord | dict:
        vote = await self.store.get_active_vote()
        if not vote:
            return {"error": "no vote"}

        winner = select_winner(vote)
        applied_to_server = False

        if apply_winner and winner:
            await self.crcon.set_next_map(winner)
            applied_to_server = True

        closed_vote = await self.store.close_vote(vote.vote_id, winner, applied_to_server)
        await self._audit(
            actor_type=actor_type,
            actor_id=actor_id,
            action="vote_closed",
            vote_id=vote.vote_id,
            payload={"apply_winner": apply_winner},
            result={
                "winner": closed_vote.winner,
                "applied_to_server": closed_vote.applied_to_server,
            },
        )
        return closed_vote

    async def force_winner(
        self,
        map_name: str,
        apply: bool = False,
        actor_type: str = "admin",
        actor_id: str = "admin",
    ) -> VoteRecord | dict:
        vote = await self.store.get_active_vote()
        if not vote:
            return {"error": "no vote"}

        valid_maps = {option.map_name for option in vote.options}
        if map_name not in valid_maps:
            return {"error": "invalid map"}

        applied_to_server = False

        if apply:
            await self.crcon.set_next_map(map_name)
            applied_to_server = True

        forced_vote = await self.store.force_winner(vote.vote_id, map_name, applied_to_server)
        await self._audit(
            actor_type=actor_type,
            actor_id=actor_id,
            action="vote_forced",
            vote_id=vote.vote_id,
            payload={"map_name": map_name, "apply": apply},
            result={
                "winner": forced_vote.winner,
                "applied_to_server": forced_vote.applied_to_server,
            },
        )
        return forced_vote

    async def cancel_vote(
        self,
        actor_type: str = "admin",
        actor_id: str = "admin",
    ) -> dict:
        vote = await self.store.get_active_vote()
        if not vote:
            return {"error": "no vote"}

        await self.store.cancel_vote(vote.vote_id)
        await self._audit(
            actor_type=actor_type,
            actor_id=actor_id,
            action="vote_cancelled",
            vote_id=vote.vote_id,
            payload={},
            result={"status": "cancelled"},
        )
        return {"status": "cancelled", "vote_id": vote.vote_id}

    async def get_results(self) -> VoteRecord | dict:
        vote = await self.store.get_latest_vote()
        if not vote:
            return {"error": "no vote"}
        return vote

    async def suggest_map_pool(self, player_count: int | None = None) -> dict:
        rotation = await self.crcon.get_rotation()
        maps = rotation.get("maps") if isinstance(rotation, dict) else None
        if not isinstance(maps, list):
            maps = []

        return {
            "player_count": player_count,
            "suggested_maps": maps,
        }

    async def close_expired_votes(self) -> VoteRecord | None:
        vote = await self.store.get_active_vote()
        if not vote or not vote.active:
            return None

        if vote.closes_at >= datetime.now(timezone.utc):
            return None

        result = await self.close_vote(apply_winner=False, actor_type="system", actor_id="expiry_worker")
        if isinstance(result, dict) and "error" in result:
            return None
        return result

    async def _audit(
        self,
        actor_type: str,
        actor_id: str,
        action: str,
        vote_id: str | None,
        payload: dict,
        result: dict,
    ) -> None:
        await self.store.record_action(
            tool=action,
            vote_id=vote_id,
            payload=payload,
            result=result,
            actor_type=actor_type,
            actor_id=actor_id,
        )

"""PostgreSQL-backed vote storage."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import asyncpg

from app.config import settings
from app.models.schemas import AuditRecord, VoteOption, VoteRecord


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS votes (
    id UUID PRIMARY KEY,
    active BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    winner TEXT,
    applied BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS vote_options (
    id SERIAL PRIMARY KEY,
    vote_id UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    map_name TEXT NOT NULL,
    votes INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vote_casts (
    id SERIAL PRIMARY KEY,
    vote_id UUID NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL,
    map_name TEXT NOT NULL,
    UNIQUE(vote_id, voter_id)
);

CREATE TABLE IF NOT EXISTS actions (
    id SERIAL PRIMARY KEY,
    tool TEXT NOT NULL,
    vote_id UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


class PostgresVoteStore:
    """Persistence layer for active votes, vote history, and audit actions."""

    def __init__(self) -> None:
        self.pool: asyncpg.Pool | None = None

    async def init(self) -> None:
        if self.pool is not None:
            return

        self.pool = await asyncpg.create_pool(settings.DATABASE_URL)
        async with self.pool.acquire() as connection:
            await connection.execute(SCHEMA_SQL)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def create_vote(self, vote_id: str, maps: list[str], closes_at: datetime) -> VoteRecord:
        created_at = datetime.now(timezone.utc)
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO votes(id, active, created_at, closes_at, winner, applied)
                    VALUES($1, TRUE, $2, $3, NULL, FALSE)
                    """,
                    UUID(vote_id),
                    created_at,
                    closes_at,
                )
                await connection.executemany(
                    """
                    INSERT INTO vote_options(vote_id, map_name, votes)
                    VALUES($1, $2, 0)
                    """,
                    [(UUID(vote_id), map_name) for map_name in maps],
                )

        vote = await self.get_vote(vote_id)
        if vote is None:
            raise RuntimeError("failed to create vote")
        return vote

    async def get_active_vote(self) -> VoteRecord | None:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT id
                FROM votes
                WHERE active = TRUE
                ORDER BY created_at DESC
                LIMIT 1
                """
            )
        if row is None:
            return None
        return await self.get_vote(str(row["id"]))

    async def get_latest_vote(self) -> VoteRecord | None:
        async with self.pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT id
                FROM votes
                ORDER BY created_at DESC
                LIMIT 1
                """
            )
        if row is None:
            return None
        return await self.get_vote(str(row["id"]))

    async def get_vote(self, vote_id: str) -> VoteRecord | None:
        async with self.pool.acquire() as connection:
            vote_row = await connection.fetchrow(
                """
                SELECT id, active, created_at, closes_at, winner, applied
                FROM votes
                WHERE id = $1
                """,
                UUID(vote_id),
            )
            if vote_row is None:
                return None

            option_rows = await connection.fetch(
                """
                SELECT map_name, votes
                FROM vote_options
                WHERE vote_id = $1
                ORDER BY id ASC
                """,
                UUID(vote_id),
            )
            cast_rows = await connection.fetch(
                """
                SELECT voter_id, map_name
                FROM vote_casts
                WHERE vote_id = $1
                """,
                UUID(vote_id),
            )

        return VoteRecord(
            vote_id=str(vote_row["id"]),
            active=vote_row["active"],
            created_at=vote_row["created_at"],
            closes_at=vote_row["closes_at"],
            options=[
                VoteOption(map_name=row["map_name"], votes=row["votes"])
                for row in option_rows
            ],
            voter_choices={row["voter_id"]: row["map_name"] for row in cast_rows},
            winner=vote_row["winner"],
            applied_to_server=vote_row["applied"],
        )

    async def cast_vote(self, vote_id: str, voter_id: str, map_name: str) -> VoteRecord:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    INSERT INTO vote_casts(vote_id, voter_id, map_name)
                    VALUES($1, $2, $3)
                    ON CONFLICT (vote_id, voter_id)
                    DO UPDATE SET map_name = EXCLUDED.map_name
                    """,
                    UUID(vote_id),
                    voter_id,
                    map_name,
                )
                await connection.execute(
                    """
                    UPDATE vote_options AS option
                    SET votes = tally.vote_count
                    FROM (
                        SELECT option_inner.id, COUNT(cast.id)::INT AS vote_count
                        FROM vote_options AS option_inner
                        LEFT JOIN vote_casts AS cast
                          ON cast.vote_id = option_inner.vote_id
                         AND cast.map_name = option_inner.map_name
                        WHERE option_inner.vote_id = $1
                        GROUP BY option_inner.id
                    ) AS tally
                    WHERE option.id = tally.id
                    """,
                    UUID(vote_id),
                )
        vote = await self.get_vote(vote_id)
        if vote is None:
            raise RuntimeError("failed to load updated vote after cast")
        return vote

    async def close_vote(
        self,
        vote_id: str,
        winner: str | None,
        applied_to_server: bool,
    ) -> VoteRecord:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE votes
                SET active = FALSE,
                    winner = $2,
                    applied = $3
                WHERE id = $1
                """,
                UUID(vote_id),
                winner,
                applied_to_server,
            )
        vote = await self.get_vote(vote_id)
        if vote is None:
            raise RuntimeError("failed to load closed vote")
        return vote

    async def force_winner(
        self,
        vote_id: str,
        winner: str,
        applied_to_server: bool,
    ) -> VoteRecord:
        return await self.close_vote(vote_id, winner, applied_to_server)

    async def cancel_vote(self, vote_id: str) -> VoteRecord:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE votes
                SET active = FALSE,
                    winner = NULL,
                    applied = FALSE
                WHERE id = $1
                """,
                UUID(vote_id),
            )
        vote = await self.get_vote(vote_id)
        if vote is None:
            raise RuntimeError("failed to load cancelled vote")
        return vote

    async def record_action(
        self,
        *,
        tool: str,
        vote_id: str | None,
        payload: dict[str, Any],
        result: dict[str, Any],
        actor_type: str,
        actor_id: str,
    ) -> None:
        async with self.pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO actions(tool, vote_id, payload, result, actor_type, actor_id)
                VALUES($1, $2, $3::jsonb, $4::jsonb, $5, $6)
                """,
                tool,
                UUID(vote_id) if vote_id else None,
                json.dumps(payload),
                json.dumps(result),
                actor_type,
                actor_id,
            )

    async def get_audit_records(self) -> list[AuditRecord]:
        async with self.pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT tool, vote_id, payload, result, actor_type, actor_id, created_at
                FROM actions
                ORDER BY created_at DESC
                """
            )

        return [
            AuditRecord(
                actor_type=row["actor_type"],
                actor_id=row["actor_id"],
                action=row["tool"],
                vote_id=str(row["vote_id"]) if row["vote_id"] else None,
                payload=row["payload"],
                result=row["result"],
                timestamp=row["created_at"],
            )
            for row in rows
        ]


store = PostgresVoteStore()

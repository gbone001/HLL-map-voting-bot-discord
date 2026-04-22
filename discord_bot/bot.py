"""Thin Discord client that calls the map vote HTTP API."""

from __future__ import annotations

import httpx

BASE = "http://localhost:8000"


async def start_vote(ctx) -> None:
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{BASE}/votes/start",
            json={"maps": ["SME", "Utah", "Carentan"], "duration_seconds": 600},
        )
    await ctx.send("Vote started")


async def vote(ctx, map_name: str) -> None:
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{BASE}/votes/cast",
            json={"voter_id": str(ctx.author.id), "map_name": map_name},
        )
    await ctx.send(f"Vote recorded for {map_name}")


async def get_active_vote() -> dict | None:
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{BASE}/votes/active")
        response.raise_for_status()
        return response.json()

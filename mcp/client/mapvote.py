"""MCP adapter for the map vote service."""

from __future__ import annotations

import httpx

BASE = "http://mapvote-service:8000"


async def start_map_vote(maps: list[str]):
    async with httpx.AsyncClient() as client:
        response = await client.post(f"{BASE}/votes/start", json={"maps": maps})
        response.raise_for_status()
        return response.json()


async def get_map_vote_status():
    async with httpx.AsyncClient() as client:
        response = await client.get(f"{BASE}/votes/active")
        response.raise_for_status()
        return response.json()


async def close_vote(apply: bool = False):
    if apply:
        return {
            "status": "requires_approval",
            "message": "Use Discord approval UI",
        }

    async with httpx.AsyncClient() as client:
        response = await client.post(f"{BASE}/votes/close", json={"apply": apply})
        response.raise_for_status()
        return response.json()

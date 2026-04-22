"""CRCON API client."""

from __future__ import annotations

import httpx

from app.config import settings


class CRCONClient:
    """Small CRCON client with a narrow, map-vote-safe interface."""

    def __init__(self) -> None:
        headers = {}
        if settings.CRCON_TOKEN:
            headers["Authorization"] = f"Bearer {settings.CRCON_TOKEN}"

        self.client = httpx.AsyncClient(
            base_url=settings.CRCON_URL,
            headers=headers,
            timeout=10.0,
        )

    async def set_next_map(self, map_name: str) -> dict:
        response = await self.client.post("/api/do_change_map", json={"map": map_name})
        response.raise_for_status()
        return response.json()

    async def get_rotation(self) -> dict:
        response = await self.client.get("/api/get_map_rotation")
        response.raise_for_status()
        return response.json()

    async def aclose(self) -> None:
        await self.client.aclose()

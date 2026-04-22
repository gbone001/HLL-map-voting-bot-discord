"""Vote-expiry background worker."""

from __future__ import annotations

import asyncio

from app.config import settings


async def vote_expiry_loop(service) -> None:
    """Close expired votes on a small polling interval."""
    while True:
        await service.close_expired_votes()
        await asyncio.sleep(settings.VOTE_WORKER_INTERVAL_SECONDS)

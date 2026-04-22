"""FastAPI entrypoint."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import crcon, router, service
from app.storage.postgres_store import store
from app.workers.vote_worker import vote_expiry_loop


@asynccontextmanager
async def lifespan(_: FastAPI):
    await store.init()
    worker_task = asyncio.create_task(vote_expiry_loop(service))
    try:
        yield
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass
        await crcon.aclose()
        await store.close()


app = FastAPI(title="Map Vote Service", lifespan=lifespan)
app.include_router(router)

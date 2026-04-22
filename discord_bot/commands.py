"""Command wrappers for the Discord client."""

from __future__ import annotations

from discord_bot.bot import start_vote, vote


async def start_vote_command(ctx) -> None:
    await start_vote(ctx)


async def cast_vote_command(ctx, map_name: str) -> None:
    await vote(ctx, map_name)

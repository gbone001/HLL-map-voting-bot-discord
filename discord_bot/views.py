"""Discord embed and button views for map voting."""

from __future__ import annotations

import asyncio

import discord
import httpx

BASE = "http://mapvote-service:8000"


def build_vote_embed(vote: dict | None) -> discord.Embed:
    """Render a map-vote embed from API payload data."""
    embed = discord.Embed(title="🗳️ Map Vote")

    if not vote:
        embed.description = "No active vote."
        return embed

    for option in vote.get("options", []):
        embed.add_field(
            name=option["map_name"],
            value=f"Votes: {option['votes']}",
            inline=False,
        )

    embed.set_footer(text=f"Vote ID: {vote.get('vote_id', 'unknown')}")
    return embed


class VoteButton(discord.ui.Button):
    """Vote button that submits the selected map to the service API."""

    def __init__(self, map_name: str) -> None:
        super().__init__(label=map_name, style=discord.ButtonStyle.primary)
        self.map_name = map_name

    async def callback(self, interaction: discord.Interaction) -> None:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{BASE}/votes/cast",
                json={
                    "voter_id": str(interaction.user.id),
                    "map_name": self.map_name,
                },
            )

        if response.is_error:
            await interaction.response.send_message(
                "Unable to record your vote right now.",
                ephemeral=True,
            )
            return

        await interaction.response.send_message(
            f"Vote cast for {self.map_name}",
            ephemeral=True,
        )


class VoteView(discord.ui.View):
    """Persistent view made of one button per map option."""

    def __init__(self, vote: dict) -> None:
        super().__init__(timeout=None)
        for option in vote.get("options", []):
            self.add_item(VoteButton(option["map_name"]))


async def update_vote_message(message: discord.Message) -> None:
    """Refresh a Discord vote message from the API on a fixed interval."""
    while True:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{BASE}/votes/active")
            vote = response.json() if response.status_code == 200 else None

        embed = build_vote_embed(vote)
        view = VoteView(vote) if vote else None
        await message.edit(embed=embed, view=view)
        await asyncio.sleep(10)

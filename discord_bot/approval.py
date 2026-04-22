"""Discord approval UI for map-application actions."""

from __future__ import annotations

import discord
import httpx

BASE = "http://mapvote-service:8000"


class ApplyWinnerView(discord.ui.View):
    """Human approval gate before applying the winning map to CRCON."""

    def __init__(self) -> None:
        super().__init__(timeout=60)

    @discord.ui.button(label="✅ Apply Winner", style=discord.ButtonStyle.success)
    async def apply(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{BASE}/votes/close", json={"apply": True})

        if response.is_error:
            await interaction.response.send_message(
                "Failed to apply the winning map.",
                ephemeral=True,
            )
            return

        await interaction.response.send_message("✅ Map applied", ephemeral=True)

    @discord.ui.button(label="❌ Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.send_message("Cancelled", ephemeral=True)

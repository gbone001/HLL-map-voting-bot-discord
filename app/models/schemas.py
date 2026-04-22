"""API and storage models."""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class VoteOption(BaseModel):
    """Single vote option and its current tally."""

    map_name: str
    votes: int = 0


class VoteRecord(BaseModel):
    """Current vote session state."""

    vote_id: str
    active: bool
    created_at: datetime
    closes_at: datetime
    options: List[VoteOption]
    voter_choices: Dict[str, str]
    winner: Optional[str] = None
    applied_to_server: bool = False


class AuditRecord(BaseModel):
    """Audit event for operational traceability."""

    actor_type: Literal["discord", "mcp", "system", "admin"]
    actor_id: str
    action: str
    vote_id: Optional[str] = None
    payload: dict = Field(default_factory=dict)
    result: dict = Field(default_factory=dict)
    timestamp: datetime


class StartVoteRequest(BaseModel):
    """Request body for starting a vote."""

    maps: List[str]
    duration_seconds: int = 600


class CastVoteRequest(BaseModel):
    """Request body for casting a vote."""

    voter_id: str
    map_name: str


class CloseVoteRequest(BaseModel):
    """Request body for closing a vote."""

    apply: bool = False


class ForceWinnerRequest(BaseModel):
    """Request body for forcing a winner."""

    map_name: str
    apply: bool = False

"""Vote-state helpers."""

from __future__ import annotations

from collections import Counter
from typing import Iterable, Optional

from app.models.schemas import VoteOption, VoteRecord


def tally_vote_options(options: list[VoteOption], voter_choices: dict[str, str]) -> None:
    """Mutate vote options so their counts match the latest voter choices."""
    counts = Counter(voter_choices.values())
    for option in options:
        option.votes = counts.get(option.map_name, 0)


def select_winner(vote: VoteRecord) -> Optional[str]:
    """Return the current winning map name, or None when no options exist."""
    if not vote.options:
        return None

    ordered_options: Iterable[VoteOption] = sorted(
        vote.options,
        key=lambda option: (-option.votes, option.map_name.lower()),
    )
    return next(iter(ordered_options)).map_name

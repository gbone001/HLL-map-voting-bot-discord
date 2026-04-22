"""In-memory vote storage for the initial service skeleton."""

from __future__ import annotations

from typing import List, Optional

from app.models.schemas import AuditRecord, VoteRecord


class VoteStore:
    """Very small in-memory store for the active vote and audit history."""

    def __init__(self) -> None:
        self.active_vote: Optional[VoteRecord] = None
        self.audit_records: List[AuditRecord] = []

    def set(self, vote: VoteRecord) -> None:
        self.active_vote = vote

    def get(self) -> Optional[VoteRecord]:
        return self.active_vote

    def clear(self) -> None:
        self.active_vote = None

    def append_audit(self, record: AuditRecord) -> None:
        self.audit_records.append(record)

    def list_audit(self) -> List[AuditRecord]:
        return list(self.audit_records)


store = VoteStore()

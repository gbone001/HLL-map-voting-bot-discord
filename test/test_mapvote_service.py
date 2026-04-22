import unittest
from datetime import datetime, timedelta, timezone

from app.services.mapvote_service import MapVoteService


class FakeCRCONClient:
    def __init__(self):
        self.applied_maps = []

    async def set_next_map(self, map_name: str):
        self.applied_maps.append(map_name)
        return {"status": "ok", "map_name": map_name}

    async def get_rotation(self):
        return {"maps": ["SME", "Utah", "Carentan"]}


class FakeVoteStore:
    def __init__(self):
        self.active_vote = None
        self.latest_vote = None
        self.actions = []

    async def create_vote(self, vote_id, maps, closes_at):
        vote = type("VoteRecordLike", (), {})()
        vote.vote_id = vote_id
        vote.active = True
        vote.created_at = datetime.now(timezone.utc)
        vote.closes_at = closes_at
        vote.options = [type("VoteOptionLike", (), {"map_name": item, "votes": 0})() for item in maps]
        vote.voter_choices = {}
        vote.winner = None
        vote.applied_to_server = False
        self.active_vote = vote
        self.latest_vote = vote
        return vote

    async def get_active_vote(self):
        return self.active_vote if self.active_vote and self.active_vote.active else None

    async def get_latest_vote(self):
        return self.latest_vote

    async def cast_vote(self, vote_id, voter_id, map_name):
        vote = self.active_vote
        vote.voter_choices[voter_id] = map_name
        for option in vote.options:
            option.votes = list(vote.voter_choices.values()).count(option.map_name)
        self.latest_vote = vote
        return vote

    async def close_vote(self, vote_id, winner, applied_to_server):
        vote = self.active_vote
        vote.active = False
        vote.winner = winner
        vote.applied_to_server = applied_to_server
        self.latest_vote = vote
        return vote

    async def force_winner(self, vote_id, winner, applied_to_server):
        return await self.close_vote(vote_id, winner, applied_to_server)

    async def cancel_vote(self, vote_id):
        vote = self.active_vote
        vote.active = False
        vote.winner = None
        vote.applied_to_server = False
        self.latest_vote = vote
        return vote

    async def record_action(self, **kwargs):
        self.actions.append(kwargs)


class MapVoteServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = FakeVoteStore()
        self.crcon = FakeCRCONClient()
        self.service = MapVoteService(self.crcon, self.store)

    async def test_close_vote_applies_winner_and_persists_latest_results(self):
        vote = await self.service.start_vote(["SME", "Utah"], 300)
        await self.service.cast_vote("user-1", "Utah")
        closed_vote = await self.service.close_vote(apply_winner=True)
        latest_results = await self.service.get_results()

        self.assertEqual(vote.vote_id, closed_vote.vote_id)
        self.assertEqual(closed_vote.winner, "Utah")
        self.assertTrue(closed_vote.applied_to_server)
        self.assertEqual(self.crcon.applied_maps, ["Utah"])
        self.assertEqual(latest_results.winner, "Utah")
        self.assertFalse(latest_results.active)

    async def test_close_expired_votes_closes_without_applying(self):
        await self.service.start_vote(["SME", "Utah"], 300)
        self.store.active_vote.closes_at = datetime.now(timezone.utc) - timedelta(seconds=1)

        closed_vote = await self.service.close_expired_votes()

        self.assertIsNotNone(closed_vote)
        self.assertFalse(closed_vote.active)
        self.assertEqual(self.crcon.applied_maps, [])


if __name__ == "__main__":
    unittest.main()

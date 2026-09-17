"""Unit tests for sole scrape-bot vote detection."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import canny_auth
import update

SCRAPER = "6a5f9e9bd4058d953b392a6f"
OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa"


def _post(*, score, voters):
    return {"score": score, "voters": voters}


class IsSoleScraperVoteTest(unittest.TestCase):
    def test_only_scraper_complete_list(self) -> None:
        post = _post(score=1, voters=[{"_id": SCRAPER, "name": "HackebeinsBot"}])
        self.assertTrue(update.is_sole_scraper_vote(post, SCRAPER))

    def test_voter_id_field(self) -> None:
        post = _post(score=1, voters=[{"id": SCRAPER}])
        self.assertTrue(update.is_sole_scraper_vote(post, SCRAPER))

    def test_extra_voter(self) -> None:
        post = _post(
            score=2,
            voters=[{"_id": SCRAPER}, {"_id": OTHER}],
        )
        self.assertFalse(update.is_sole_scraper_vote(post, SCRAPER))

    def test_incomplete_list(self) -> None:
        post = _post(score=5, voters=[{"_id": SCRAPER}])
        self.assertFalse(update.is_sole_scraper_vote(post, SCRAPER))

    def test_empty_voters(self) -> None:
        post = _post(score=1, voters=[])
        self.assertFalse(update.is_sole_scraper_vote(post, SCRAPER))

    def test_missing_scraper_id(self) -> None:
        post = _post(score=1, voters=[{"_id": SCRAPER}])
        self.assertFalse(update.is_sole_scraper_vote(post, None))
        self.assertFalse(update.is_sole_scraper_vote(post, ""))

    def test_zero_score(self) -> None:
        post = _post(score=0, voters=[])
        self.assertFalse(update.is_sole_scraper_vote(post, SCRAPER))


class UnvoteSoleScraperVotesTest(unittest.TestCase):
    def test_rewrites_post_and_records_voted_id(self) -> None:
        post = {
            "_id": "pid1",
            "urlName": "canary",
            "score": 1,
            "viewerVote": 1,
            "voters": [{"_id": SCRAPER, "name": "HackebeinsBot"}],
            "board": {"urlName": "website"},
        }
        results = {"pid1": (post, [], False, False)}
        state = {"votedPostIds": [], "scraperUserId": SCRAPER}
        session = MagicMock()
        session.scraper_user_id = SCRAPER
        with (
            patch.object(
                update.canny_auth,
                "vote_post",
                return_value=canny_auth.VoteResult(ok=True),
            ) as vote,
            patch.object(update.board_store, "write_post") as write,
            patch.object(update.time, "sleep"),
        ):
            n = update._unvote_sole_scraper_votes(session, results, state)
        self.assertEqual(n, 1)
        vote.assert_called_once_with(session, "pid1", score=0)
        write.assert_called_once_with("website", post)
        self.assertEqual(post["score"], 0)
        self.assertEqual(post["voters"], [])
        self.assertEqual(post["viewerVote"], 0)
        self.assertEqual(state["votedPostIds"], ["pid1"])

    def test_skips_posts_with_other_voters(self) -> None:
        post = {
            "_id": "pid2",
            "urlName": "shared",
            "score": 2,
            "voters": [{"_id": SCRAPER}, {"_id": OTHER}],
            "board": {"urlName": "website"},
        }
        results = {"pid2": (post, [], False, False)}
        state = {"votedPostIds": [], "scraperUserId": SCRAPER}
        session = MagicMock()
        session.scraper_user_id = SCRAPER
        with (
            patch.object(update.canny_auth, "vote_post") as vote,
            patch.object(update.board_store, "write_post") as write,
            patch.object(update.time, "sleep"),
        ):
            n = update._unvote_sole_scraper_votes(session, results, state)
        self.assertEqual(n, 0)
        vote.assert_not_called()
        write.assert_not_called()
        self.assertEqual(state["votedPostIds"], [])


if __name__ == "__main__":
    unittest.main()

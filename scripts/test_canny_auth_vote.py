"""Unit tests for vote error classification."""

from __future__ import annotations

import unittest

import canny_auth


class ClassifyVoteErrorTest(unittest.TestCase):
    def test_not_authorized_is_forbidden(self) -> None:
        rate_limited, forbidden = canny_auth.classify_vote_error(
            400, "not authorized"
        )
        self.assertFalse(rate_limited)
        self.assertTrue(forbidden)

    def test_429_is_rate_limited_not_forbidden(self) -> None:
        rate_limited, forbidden = canny_auth.classify_vote_error(429, "slow down")
        self.assertTrue(rate_limited)
        self.assertFalse(forbidden)

    def test_generic_400_is_neither(self) -> None:
        rate_limited, forbidden = canny_auth.classify_vote_error(400, "bad request")
        self.assertFalse(rate_limited)
        self.assertFalse(forbidden)


if __name__ == "__main__":
    unittest.main()

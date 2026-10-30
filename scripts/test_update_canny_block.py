"""Abort the board update when Canny SSO fails or HTTP 403s pile up."""

from __future__ import annotations

import io
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

import canny_auth
import update


def _completed(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["curl"], returncode=0, stdout=stdout, stderr="")


def _http(code: int, body: str = "x") -> subprocess.CompletedProcess[str]:
    return _completed(f"{body}\n__HTTP_CODE__:{code}")


class ObserveHttpStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        update.reset_http_stats()

    def test_aborts_after_consecutive_403s(self) -> None:
        update.observe_http_status(403)
        update.observe_http_status(403)
        with self.assertRaises(update.CannyBlocked) as ctx:
            update.observe_http_status(403)
        self.assertIn("HTTP 403", str(ctx.exception))
        self.assertIn("aborting", str(ctx.exception))

    def test_non_403_resets_streak(self) -> None:
        update.observe_http_status(403)
        update.observe_http_status(403)
        update.observe_http_status(200)
        update.observe_http_status(403)
        update.observe_http_status(403)
        update.observe_http_status(404)
        update.observe_http_status(403)
        update.observe_http_status(429)
        update.observe_http_status(403)
        update.observe_http_status(500)
        update.observe_http_status(403)
        update.observe_http_status(0)
        update.observe_http_status(403)
        update.observe_http_status(403)


class FetchStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        update.reset_http_stats()

    def tearDown(self) -> None:
        update.reset_http_stats()

    def test_post_page_does_not_retry_403(self) -> None:
        calls: list[int] = []

        def run(cmd, **kwargs):
            calls.append(1)
            return _http(403, "blocked")

        with patch.object(update.subprocess, "run", side_effect=run), patch.object(update.time, "sleep"):
            post, _comments, not_found, transient = update.fetch_post_page(
                "bug-reports", "slug", retries=3,
            )
        self.assertEqual(calls, [1])
        self.assertIsNone(post)
        self.assertFalse(not_found)
        self.assertTrue(transient)
        self.assertEqual(update._http_stats["retries"], 0)

    def test_post_page_retries_500_and_429(self) -> None:
        for code in (500, 429, 0):
            with self.subTest(code=code):
                update.reset_http_stats()
                calls: list[int] = []

                def run(cmd, **kwargs):
                    calls.append(code)
                    if code == 0:
                        raise OSError("network down")
                    return _http(code, "")

                with (
                    patch.object(update.subprocess, "run", side_effect=run),
                    patch.object(update.time, "sleep"),
                ):
                    post, _comments, not_found, transient = update.fetch_post_page(
                        "bug-reports", "slug", retries=3,
                    )
                self.assertEqual(calls, [code, code, code])
                self.assertIsNone(post)
                self.assertFalse(not_found)
                self.assertTrue(transient)
                self.assertEqual(update._http_stats["retries"], 3)

    def test_page_scan_aborts_without_scanning_every_post(self) -> None:
        calls: list[int] = []

        def run(cmd, **kwargs):
            calls.append(1)
            return _http(403, "blocked")

        targets = [("bug-reports", f"p{i}", f"s{i}") for i in range(20)]
        with patch.object(update.subprocess, "run", side_effect=run), patch.object(update.time, "sleep"):
            with self.assertRaises(update.CannyBlocked):
                update.fetch_all_pages(targets)
        self.assertGreaterEqual(len(calls), update.CANNY_403_ABORT_AFTER)
        self.assertLess(len(calls), len(targets))
        self.assertEqual(update._http_stats["retries"], 0)

    def test_page_scan_keeps_unrelated_crashes_transient(self) -> None:
        def boom(board, slug, retries=3):
            raise RuntimeError("parse blew up")

        with patch.object(update, "fetch_post_page", side_effect=boom):
            results = update.fetch_all_pages([("bug-reports", "pid", "slug")])
        self.assertEqual(results["pid"], (None, [], False, True))

    def test_voters_do_not_retry_403(self) -> None:
        calls: list[int] = []

        def post(url, payload, timeout=15):
            calls.append(1)
            return 403, "<HTML>403"

        with patch.object(update, "_curl_post_json", side_effect=post), patch.object(update.time, "sleep"):
            self.assertIsNone(update.fetch_voters("pid", retries=3))
        self.assertEqual(calls, [1])
        self.assertEqual(update._http_stats["retries"], 0)

    def test_voters_retry_transient_statuses(self) -> None:
        for code in (500, 429, 0):
            with self.subTest(code=code):
                update.reset_http_stats()
                calls: list[int] = []

                def post(url, payload, timeout=15):
                    calls.append(code)
                    return code, ""

                with (
                    patch.object(update, "_curl_post_json", side_effect=post),
                    patch.object(update.time, "sleep"),
                ):
                    self.assertIsNone(update.fetch_voters("pid", retries=3))
                self.assertEqual(calls, [code, code, code])
                self.assertEqual(update._http_stats["retries"], 3)

    def test_posts_get_403_is_forbidden_not_empty_board(self) -> None:
        with patch.object(update, "_curl_post_json", return_value=(403, "<HTML>403")):
            posts, ids, has_next, err = update.fetch_board_posts("secret")
        self.assertEqual(posts, [])
        self.assertEqual(ids, set())
        self.assertIsNone(has_next)
        self.assertEqual(err, "HTTP 403")

    def test_newest_sweep_aborts_on_403_streak(self) -> None:
        def post(url, payload, timeout=15):
            update.observe_http_status(403)
            return 403, "blocked"

        with patch.object(update, "_curl_post_json", side_effect=post), patch.object(update.time, "sleep"):
            with self.assertRaises(update.CannyBlocked):
                update.fetch_newest_all(["a", "b", "c", "d", "e", "f"])

    def test_apply_results_does_not_write_when_blocked(self) -> None:
        post = {
            "_id": "pid",
            "urlName": "new-slug",
            "score": 20,
            "voters": [],
            "board": {"urlName": "bug-reports"},
        }
        stored = {
            "pid": {
                "board_slug": "bug-reports",
                "url_slug": "old-slug",
                "post": dict(post),
            }
        }
        results = {"pid": (post, [], False, False)}

        def blocked(post_id, retries=3):
            raise update.CannyBlocked("Canny returned HTTP 403 3 times in a row; aborting")

        with (
            patch.object(update, "fetch_voters", side_effect=blocked),
            patch.object(update.board_store, "write_post") as write,
            patch.object(update.board_store, "delete_post") as delete,
            patch.object(update.time, "sleep"),
        ):
            with self.assertRaises(update.CannyBlocked):
                update.apply_results(
                    stored, results, "2026-10-30T00:00:00Z", None, "", None, scraped_at={},
                )
        write.assert_not_called()
        delete.assert_not_called()


class SsoAbortTest(unittest.TestCase):
    def test_sso_failure_exits_before_any_fetch(self) -> None:
        buf = io.StringIO()
        with (
            patch.object(sys, "argv", ["update.py", "--refresh-oldest", "0", "--refresh-newest", "0"]),
            patch.object(
                update.canny_auth,
                "login_canny_session",
                side_effect=canny_auth.CannyAuthError("Canny SSO redirect failed HTTP 403"),
            ),
            patch.object(update.canny_auth, "fetch_notifications") as notes,
            patch.object(update, "fetch_newest_all") as newest,
            patch.object(update, "fetch_all_pages") as pages,
            patch.object(update, "load_all_stored") as load,
            patch.object(update.scrape_state, "save_state") as save,
            patch.object(update.board_store, "write_post") as write,
            redirect_stderr(buf),
        ):
            with self.assertRaises(SystemExit) as ctx:
                update.main()
        self.assertEqual(ctx.exception.code, 1)
        err = buf.getvalue()
        self.assertIn("Canny SSO failed", err)
        self.assertIn("no further Canny requests", err)
        notes.assert_not_called()
        newest.assert_not_called()
        pages.assert_not_called()
        load.assert_not_called()
        save.assert_not_called()
        write.assert_not_called()

    def test_cli_block_exits_nonzero_without_running_past_main(self) -> None:
        buf = io.StringIO()
        with (
            patch.object(
                update,
                "main",
                side_effect=update.CannyBlocked(
                    "Canny returned HTTP 403 3 times in a row; aborting"
                ),
            ),
            redirect_stderr(buf),
        ):
            with self.assertRaises(SystemExit) as ctx:
                update._exit_on_canny_block()
        self.assertEqual(ctx.exception.code, 1)
        err = buf.getvalue()
        self.assertIn("HTTP 403", err)
        self.assertIn("board data was not written", err)


if __name__ == "__main__":
    unittest.main()

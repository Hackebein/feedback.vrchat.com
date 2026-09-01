"""Cookie-jar merge and VRChat suffix-cookie stripping."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import canny_auth


def _write_jar(path: Path, rows: list[str]) -> None:
    path.write_text(
        "# Netscape HTTP Cookie File\n" + "".join(f"{row}\n" for row in rows),
        encoding="utf-8",
    )


class MergeNetscapeJarsTest(unittest.TestCase):
    def test_incoming_upserts_same_name_keeps_other_domains(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "dest.jar"
            incoming = Path(td) / "in.jar"
            _write_jar(
                dest,
                [
                    "api.vrchat.cloud\tFALSE\t/\tTRUE\t0\tauth\toldauth",
                    "feedback.vrchat.com\tFALSE\t/\tTRUE\t0\t__canny_sid\toldsid",
                ],
            )
            _write_jar(
                incoming,
                ["feedback.vrchat.com\tFALSE\t/\tTRUE\t0\t__canny_sid\tnewsid"],
            )
            canny_auth.merge_netscape_jars(dest, incoming)
            self.assertEqual(canny_auth.read_cookie(dest, "auth"), "oldauth")
            self.assertEqual(
                canny_auth.read_cookie(dest, "__canny_sid", domain_substr="feedback.vrchat"),
                "newsid",
            )


class DropVrchatSuffixCookiesTest(unittest.TestCase):
    def test_drops_dot_vrchat_keeps_host_only(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            jar = Path(td) / "cookies.jar"
            _write_jar(
                jar,
                [
                    ".vrchat.com\tTRUE\t/\tTRUE\t0\tauth\tleaked",
                    "vrchat.com\tFALSE\t/\tTRUE\t0\tauth\thostonly",
                    "api.vrchat.cloud\tFALSE\t/\tTRUE\t0\tauth\tapiauth",
                ],
            )
            canny_auth.drop_vrchat_suffix_cookies(jar)
            self.assertIsNone(
                canny_auth.read_cookie(jar, "auth", domain_substr=".vrchat.com")
            )
            self.assertEqual(
                canny_auth.read_cookie(jar, "auth", domain_substr="vrchat.com"),
                "hostonly",
            )
            self.assertEqual(
                canny_auth.read_cookie(jar, "auth", domain_substr="api.vrchat.cloud"),
                "apiauth",
            )


if __name__ == "__main__":
    unittest.main()

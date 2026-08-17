"""Unit tests for in-client Details template parsing."""

from __future__ import annotations

import unittest

import in_client_report

QUEST_MARKDOWN = (
    "Description\n\n"
    "cant load actual avis\n\n"
    "Reproduction Steps\n\n"
    "idk tbh\n\n"
    "Details\n\n"
    "- Category: Performance\n\n"
    "- Frequency: Once\n\n"
    "---\n\n"
    "platform: Quest (platform: Android - Quest, store: Oculus, headset: Oculus Quest 2)\n\n"
    "rawPlatform: Android\n\n"
    "clientVersion: 2026.3.1-1886-a268441585-Release\n\n"
    "unityVersion: 2022.3.22f2-DWR\n\n"
    "In-Client Report\n\n"
    "---\n\n"
    "**Log file:** [output_log_2026-08-13_20-20-59.txt]"
    "(https://api.vrchat.cloud/api/1/file/file_abc/1/file)"
)

QUEST_PLAIN = (
    "cant load actual avis\n\n"
    "Details\n"
    "* Category: Performance\n"
    "* Frequency: Once\n"
    "---\n"
    "platform: Quest (platform: Android - Quest, store: Oculus, headset: Oculus Quest 2)\n"
    "rawPlatform: Android\n"
    "clientVersion: 2026.3.1-1886-a268441585-Release\n"
    "unityVersion: 2022.3.22f2-DWR\n"
    "In-Client Report"
)

PC_NO_LOG = (
    "nameplate missing\n\n"
    "Details\n\n"
    "- Category: User Interface\n\n"
    "- Frequency: Once\n\n"
    "---\n\n"
    "platform: PC (platform: Windows, store: Steam, headset: None)\n\n"
    "rawPlatform: WindowsPlayer\n\n"
    "clientVersion: 2026.3.1-1885-81193b80fa-Release\n\n"
    "unityVersion: 6000.0.60f1-DWR\n\n"
    "In-Client Report"
)

OLD_BOARD_NO_MARKER = (
    "## Details\n\n"
    "- Category: User Interface\n\n"
    "- Frequency: Always\n\n"
    "---\n\n"
    "platform: Quest (platform: Android - Quest, store: Oculus, headset: None)\n\n"
    "rawPlatform: Android\n\n"
    "clientVersion: 2026.3.1-1878-c608353bf2-Release\n\n"
    "unityVersion: 2022.3.22f2-DWR"
)

UNRELATED = "Avatars fail to load after teleporting between worlds."


class ParseInClientTemplateTest(unittest.TestCase):
    def test_markdown_with_log_file(self) -> None:
        parsed = in_client_report.parse_in_client_template(QUEST_MARKDOWN)
        assert parsed is not None
        self.assertEqual(parsed["category"], "performance")
        self.assertEqual(parsed["frequency"], "once")
        self.assertEqual(parsed["platform"], "quest")
        self.assertEqual(parsed["raw_platform"], "Android")
        self.assertEqual(parsed["store"], "Oculus")
        self.assertEqual(parsed["headset"], "Oculus Quest 2")
        self.assertEqual(parsed["client_version"], "2026.3.1-1886-a268441585-Release")
        self.assertEqual(parsed["unity_version"], "2022.3.22f2-DWR")
        self.assertTrue(parsed["has_in_client_report"])

    def test_plain_asterisk_list(self) -> None:
        parsed = in_client_report.parse_in_client_template(QUEST_PLAIN)
        assert parsed is not None
        self.assertEqual(parsed["category"], "performance")
        self.assertEqual(parsed["platform"], "quest")
        self.assertTrue(parsed["has_in_client_report"])

    def test_log_file_optional(self) -> None:
        self.assertTrue(in_client_report.is_in_client_report(PC_NO_LOG))
        self.assertTrue(in_client_report.is_in_client_report(OLD_BOARD_NO_MARKER))

    def test_in_client_marker_optional(self) -> None:
        parsed = in_client_report.parse_in_client_template(OLD_BOARD_NO_MARKER)
        assert parsed is not None
        self.assertFalse(parsed["has_in_client_report"])

    def test_rejects_unrelated(self) -> None:
        self.assertIsNone(in_client_report.parse_in_client_template(UNRELATED))
        self.assertFalse(in_client_report.is_in_client_report(UNRELATED))

    def test_rejects_marker_without_template(self) -> None:
        details = "something broke\n\nIn-Client Report"
        self.assertIsNone(in_client_report.parse_in_client_template(details))

    def test_unknown_category_still_parses(self) -> None:
        details = PC_NO_LOG.replace("User Interface", "Graphics")
        parsed = in_client_report.parse_in_client_template(details)
        assert parsed is not None
        self.assertEqual(parsed["category"], "")
        self.assertEqual(parsed["category_label"], "Graphics")
        tags = in_client_report.in_client_search_tags(parsed)
        self.assertFalse(any(t.startswith("inclient.category.") for t in tags))
        self.assertIn("inclient.frequency.once", tags)

    def test_unknown_frequency_still_parses(self) -> None:
        details = PC_NO_LOG.replace("Once", "Rarely")
        parsed = in_client_report.parse_in_client_template(details)
        assert parsed is not None
        self.assertEqual(parsed["frequency"], "")
        self.assertEqual(parsed["frequency_label"], "Rarely")
        tags = in_client_report.in_client_search_tags(parsed)
        self.assertFalse(any(t.startswith("inclient.frequency.") for t in tags))
        self.assertIn("inclient.category.user-interface", tags)

    def test_localized_category_still_parses(self) -> None:
        details = PC_NO_LOG.replace("User Interface", "유저 인터페이스")
        parsed = in_client_report.parse_in_client_template(details)
        assert parsed is not None
        self.assertEqual(parsed["category"], "")
        self.assertEqual(parsed["category_label"], "유저 인터페이스")
        self.assertTrue(parsed["has_in_client_report"])

    def test_non_ascii_platform_uses_raw_platform(self) -> None:
        details = PC_NO_LOG.replace(
            "platform: PC (platform: Windows, store: Steam, headset: None)",
            "platform: 피씨 (platform: Windows, store: Steam, headset: None)",
        )
        parsed = in_client_report.parse_in_client_template(details)
        assert parsed is not None
        self.assertEqual(parsed["platform"], "windowsplayer")
        self.assertEqual(
            in_client_report.client_location_tags(parsed),
            ["loc.pc-client", "platforms.pc.steam"],
        )


class ClientLocationTagsTest(unittest.TestCase):
    def test_quest(self) -> None:
        parsed = in_client_report.parse_in_client_template(QUEST_MARKDOWN)
        assert parsed is not None
        self.assertEqual(
            in_client_report.client_location_tags(parsed),
            ["loc.standalone-vr", "platforms.standalone-vr.quest"],
        )
        self.assertEqual(
            in_client_report.client_location_prior(QUEST_MARKDOWN),
            "loc.standalone-vr",
        )

    def test_pc_steam(self) -> None:
        parsed = in_client_report.parse_in_client_template(PC_NO_LOG)
        assert parsed is not None
        self.assertEqual(
            in_client_report.client_location_tags(parsed),
            ["loc.pc-client", "platforms.pc.steam"],
        )


class InClientSearchTagsTest(unittest.TestCase):
    def test_quest_tags(self) -> None:
        parsed = in_client_report.parse_in_client_template(QUEST_MARKDOWN)
        assert parsed is not None
        tags = in_client_report.in_client_search_tags(parsed)
        self.assertIn("inclient.category.performance", tags)
        self.assertIn("inclient.frequency.once", tags)
        self.assertIn("inclient.platform.quest", tags)
        self.assertIn("inclient.store.oculus", tags)
        self.assertIn("inclient.headset.oculus-quest-2", tags)
        self.assertIn("inclient.raw-platform.android", tags)
        self.assertIn(
            "inclient.client-version.2026.3.1-1886-a268441585-Release",
            tags,
        )
        self.assertIn("inclient.unity-version.2022.3.22f2-DWR", tags)
        self.assertIn("inclient.report", tags)

    def test_skips_none_headset(self) -> None:
        parsed = in_client_report.parse_in_client_template(PC_NO_LOG)
        assert parsed is not None
        tags = in_client_report.in_client_search_tags(parsed)
        self.assertFalse(any(t.startswith("inclient.headset.") for t in tags))
        self.assertIn("inclient.store.steam", tags)
        self.assertIn("inclient.category.user-interface", tags)


if __name__ == "__main__":
    unittest.main()

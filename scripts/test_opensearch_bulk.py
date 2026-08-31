"""Unit tests for in-client template board remapping and tag merge at index time."""

from __future__ import annotations

import unittest

import opensearch_bulk

BUG_REPORTS_ID = "58c62f2b3cf8f8367753b2f0"

QUEST_TEMPLATE = (
    "cant load actual avis\n\n"
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

TEMPLATE_NO_LOG = (
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

MARKER_ONLY = "i just bought the electric pulse profile bundle\n\nIn-Client Report"
UNRELATED = "Avatars fail to load after teleporting between worlds."


def _post(
    *,
    details: str,
    board_url: str = "bug-reports",
    board_id: str = BUG_REPORTS_ID,
    board_name: str = "Bug Reports",
    ai_categories: list[str] | None = None,
) -> dict:
    return {
        "_id": "post123",
        "title": "no avi load",
        "details": details,
        "urlName": "no-avi-load",
        "boardID": board_id,
        "board": {
            "_id": board_id,
            "name": board_name,
            "urlName": board_url,
        },
        "aiCategories": list(ai_categories or []),
    }


class TransformVirtualInClientBoardTest(unittest.TestCase):
    def test_template_with_log_remaps_name_and_ids_keeps_url(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=QUEST_TEMPLATE))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["board"]["_id"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")

    def test_template_without_log_file_remaps(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=TEMPLATE_NO_LOG))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)

    def test_marker_without_template_stays(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=MARKER_ONLY))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], "Bug Reports")
        self.assertEqual(doc["board"]["_id"], BUG_REPORTS_ID)
        self.assertEqual(doc["boardID"], BUG_REPORTS_ID)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")

    def test_already_in_client_board_keeps_url(self) -> None:
        src = _post(
            details=QUEST_TEMPLATE,
            board_url="client-bug-reporting",
            board_id=opensearch_bulk.IN_CLIENT_BOARD_ID,
            board_name=opensearch_bulk.IN_CLIENT_BOARD_NAME,
        )
        doc = opensearch_bulk.transform_post(src)
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["board"]["urlName"], "client-bug-reporting")
        self.assertEqual(doc["board"]["_id"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)

    def test_unrelated_bug_report_unchanged(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=UNRELATED))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], "Bug Reports")
        self.assertEqual(doc["board"]["_id"], BUG_REPORTS_ID)
        self.assertEqual(doc["boardID"], BUG_REPORTS_ID)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")
        self.assertEqual(doc["aiCategories"], [])

    def test_unmapped_localized_category_remaps(self) -> None:
        details = TEMPLATE_NO_LOG.replace("User Interface", "유저 인터페이스")
        doc = opensearch_bulk.transform_post(_post(details=details))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        cats = doc["aiCategories"]
        self.assertFalse(any(c.startswith("inclient.category.") for c in cats))
        self.assertIn("inclient.frequency.once", cats)
        self.assertIn("inclient.report", cats)


class TransformInClientTagsTest(unittest.TestCase):
    def test_merges_location_and_inclient_tags(self) -> None:
        doc = opensearch_bulk.transform_post(
            _post(
                details=QUEST_TEMPLATE,
                ai_categories=["avatars.upload-performance"],
            )
        )
        assert doc is not None
        cats = doc["aiCategories"]
        self.assertIn("avatars.upload-performance", cats)
        self.assertIn("loc.standalone-vr", cats)
        self.assertIn("platforms.standalone-vr.quest", cats)
        self.assertIn("inclient.category.performance", cats)
        self.assertIn("inclient.frequency.once", cats)
        self.assertIn("inclient.platform.quest", cats)
        self.assertIn("inclient.headset.oculus-quest-2", cats)
        self.assertIn("inclient.report", cats)

    def test_does_not_duplicate_existing_location(self) -> None:
        doc = opensearch_bulk.transform_post(
            _post(
                details=QUEST_TEMPLATE,
                ai_categories=["loc.standalone-vr", "platforms.standalone-vr.quest"],
            )
        )
        assert doc is not None
        cats = doc["aiCategories"]
        self.assertEqual(cats.count("loc.standalone-vr"), 1)
        self.assertEqual(cats.count("platforms.standalone-vr.quest"), 1)

    def test_pc_template_adds_pc_location(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=TEMPLATE_NO_LOG))
        assert doc is not None
        cats = doc["aiCategories"]
        self.assertIn("loc.pc-client", cats)
        self.assertIn("platforms.pc.steam", cats)
        self.assertIn("inclient.category.user-interface", cats)
        self.assertNotIn("loc.standalone-vr", cats)


if __name__ == "__main__":
    unittest.main()

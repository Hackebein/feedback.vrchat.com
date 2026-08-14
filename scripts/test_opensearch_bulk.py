"""Unit tests for in-client log-file board remapping at index time."""

from __future__ import annotations

import unittest

import opensearch_bulk

BUG_REPORTS_ID = "58c62f2b3cf8f8367753b2f0"
PLAIN_FOOTER = (
    "cant load actual avis\n\n"
    "In-Client Report\n\n"
    "---\n\n"
    "Log file:\n\n"
    "output_log_2026-08-13_20-20-59.txt"
)
MARKDOWN_FOOTER = (
    "audio\n\n"
    "In-Client Report\n\n"
    "---\n\n"
    "**Log file:** [output_log_2026-08-12_17-43-51.txt]"
    "(https://api.vrchat.cloud/api/1/file/file_abc/1/file)"
)
IN_CLIENT_ONLY = (
    "i just bought the electric pulse profile bundle\n\n"
    "In-Client Report"
)
UNRELATED = "Avatars fail to load after teleporting between worlds."


def _post(
    *,
    details: str,
    board_url: str = "bug-reports",
    board_id: str = BUG_REPORTS_ID,
    board_name: str = "Bug Reports",
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
    }


class HasInClientLogFileFooterTest(unittest.TestCase):
    def test_plain_footer(self) -> None:
        self.assertTrue(opensearch_bulk.has_in_client_log_file_footer(PLAIN_FOOTER))

    def test_markdown_footer(self) -> None:
        self.assertTrue(opensearch_bulk.has_in_client_log_file_footer(MARKDOWN_FOOTER))

    def test_in_client_report_without_log_file(self) -> None:
        self.assertFalse(opensearch_bulk.has_in_client_log_file_footer(IN_CLIENT_ONLY))

    def test_unrelated_details(self) -> None:
        self.assertFalse(opensearch_bulk.has_in_client_log_file_footer(UNRELATED))

    def test_log_file_not_at_end(self) -> None:
        details = PLAIN_FOOTER + "\n\nplease fix"
        self.assertFalse(opensearch_bulk.has_in_client_log_file_footer(details))


class TransformVirtualInClientBoardTest(unittest.TestCase):
    def test_plain_footer_remaps_name_and_ids_keeps_url(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=PLAIN_FOOTER))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["board"]["_id"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")

    def test_markdown_footer_remaps(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=MARKDOWN_FOOTER))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], opensearch_bulk.IN_CLIENT_BOARD_NAME)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")
        self.assertEqual(doc["boardID"], opensearch_bulk.IN_CLIENT_BOARD_ID)

    def test_in_client_report_without_log_file_stays(self) -> None:
        doc = opensearch_bulk.transform_post(_post(details=IN_CLIENT_ONLY))
        assert doc is not None
        self.assertEqual(doc["board"]["name"], "Bug Reports")
        self.assertEqual(doc["board"]["_id"], BUG_REPORTS_ID)
        self.assertEqual(doc["boardID"], BUG_REPORTS_ID)
        self.assertEqual(doc["board"]["urlName"], "bug-reports")

    def test_already_in_client_board_unchanged(self) -> None:
        src = _post(
            details=PLAIN_FOOTER,
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


if __name__ == "__main__":
    unittest.main()

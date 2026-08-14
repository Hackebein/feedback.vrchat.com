"""Unit tests for notification_items_from_response and mark_all_notifications_read."""

from __future__ import annotations

import unittest
from unittest import mock

import canny_auth


class NotificationItemsFromResponseTest(unittest.TestCase):
    def test_wrapper_items(self) -> None:
        item = {"_id": "n1", "type": "postStatusChanged.voter", "post": {"_id": "p1"}}
        data = {
            "notifications": {
                "hasNextPage": True,
                "items": [item],
                "pages": 1,
                "unreadCount": 294,
            }
        }
        self.assertEqual(canny_auth.notification_items_from_response(data), [item])

    def test_legacy_list_under_notifications(self) -> None:
        item = {"_id": "n2", "postID": "p2"}
        data = {"notifications": [item]}
        self.assertEqual(canny_auth.notification_items_from_response(data), [item])

    def test_top_level_items(self) -> None:
        item = {"_id": "n3", "post": {"_id": "p3"}}
        data = {"items": [item]}
        self.assertEqual(canny_auth.notification_items_from_response(data), [item])

    def test_wrapper_values_are_not_treated_as_items(self) -> None:
        # Regression: list(dict.values()) used to yield mixed junk; only items count.
        data = {
            "notifications": {
                "hasNextPage": False,
                "items": [{"_id": "keep"}],
                "pages": 1,
                "unreadCount": 1,
            }
        }
        out = canny_auth.notification_items_from_response(data)
        self.assertEqual(out, [{"_id": "keep"}])
        self.assertTrue(all(isinstance(n, dict) and "_id" in n for n in out))

    def test_non_dict_entries_filtered(self) -> None:
        data = {"notifications": {"items": [{"_id": "ok"}, "skip", 3, None]}}
        self.assertEqual(
            canny_auth.notification_items_from_response(data),
            [{"_id": "ok"}],
        )

    def test_empty_and_invalid(self) -> None:
        self.assertEqual(canny_auth.notification_items_from_response(None), [])
        self.assertEqual(canny_auth.notification_items_from_response({}), [])
        self.assertEqual(
            canny_auth.notification_items_from_response({"notifications": {}}),
            [],
        )


class MarkAllNotificationsReadTest(unittest.TestCase):
    def test_success_string_body(self) -> None:
        session = mock.Mock()
        with mock.patch.object(
            canny_auth, "canny_post_json", return_value=(200, "success")
        ) as post:
            self.assertTrue(canny_auth.mark_all_notifications_read(session))
        post.assert_called_once_with(
            session, "/api/notifications/markAllRead", {}
        )

    def test_failure(self) -> None:
        session = mock.Mock()
        with mock.patch.object(
            canny_auth, "canny_post_json", return_value=(500, {"error": "no"})
        ):
            self.assertFalse(canny_auth.mark_all_notifications_read(session))


if __name__ == "__main__":
    unittest.main()

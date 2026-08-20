#!/usr/bin/env python3
"""Unit tests for run_reindex_maybe.py retry logic."""
import unittest
from run_reindex_maybe import _is_transient_git_error


class TestTransientErrorDetection(unittest.TestCase):
    """Test that transient git errors are correctly identified."""

    def test_http_500_error_is_transient(self):
        """HTTP 500 errors from GitHub should be treated as transient."""
        output = "remote: Internal Server Error\nfatal: unable to access 'https://github.com/repo.git/': The requested URL returned error: 500"
        self.assertTrue(_is_transient_git_error(128, output))

    def test_http_502_error_is_transient(self):
        """HTTP 502 errors should be treated as transient."""
        output = "fatal: unable to access 'https://github.com/repo.git/': The requested URL returned error: 502"
        self.assertTrue(_is_transient_git_error(128, output))

    def test_connection_timeout_is_transient(self):
        """Connection timeouts should be treated as transient."""
        output = "fatal: unable to access 'https://github.com/repo.git/': Connection timed out"
        self.assertTrue(_is_transient_git_error(128, output))

    def test_dns_failure_is_transient(self):
        """DNS resolution failures should be treated as transient."""
        output = "fatal: unable to access 'https://github.com/repo.git/': Could not resolve host: github.com"
        self.assertTrue(_is_transient_git_error(128, output))

    def test_authentication_error_is_not_transient(self):
        """Authentication errors should NOT be treated as transient."""
        output = "fatal: Authentication failed for 'https://github.com/repo.git/'"
        self.assertFalse(_is_transient_git_error(128, output))

    def test_repository_not_found_is_not_transient(self):
        """Repository not found errors should NOT be treated as transient."""
        output = "fatal: repository 'https://github.com/repo.git/' not found"
        self.assertFalse(_is_transient_git_error(128, output))

    def test_non_128_exit_code_is_not_transient(self):
        """Non-128 exit codes should NOT be treated as transient."""
        output = "remote: Internal Server Error"
        self.assertFalse(_is_transient_git_error(1, output))
        self.assertFalse(_is_transient_git_error(0, output))


if __name__ == "__main__":
    unittest.main()

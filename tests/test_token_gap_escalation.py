"""Unit tests for token_gap_escalation.py — Token-Gap Escalation Routine.

Tests cover error source classification, distinguishing between Paperclip governance
403 errors and GitHub API credential errors, and escalation decision logic.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

# Add scripts directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from token_gap_escalation import TokenGapEscalationMonitor


class TestErrorSourceClassification:
    """Test error source classification: github_credential vs governance_expected."""

    def setup_method(self):
        self.monitor = TokenGapEscalationMonitor()

    def test_classifies_github_token_error(self):
        """Identify genuine GitHub API token error."""
        comments = [
            {
                "body": "GitHub API call failed: 401 Unauthorized - bad credentials",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "github_credential"

    def test_classifies_github_token_expired(self):
        """Identify GitHub API token expired error."""
        comments = [
            {
                "body": "api.github.com returned 403: token expired",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "github_credential"

    def test_classifies_github_rate_limit(self):
        """Identify GitHub API rate limit error."""
        comments = [
            {
                "body": "GitHub API rate limit exceeded, please check GH_TOKEN",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "github_credential"

    def test_classifies_paperclip_cross_agent_mutation(self):
        """Identify Paperclip cross-agent mutation block (governance)."""
        comments = [
            {
                "body": "Paperclip API returned 403: cross-agent mutation not allowed",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "governance_expected"

    def test_classifies_paperclip_least_privilege_block(self):
        """Identify Paperclip Least Privilege governance block."""
        comments = [
            {
                "body": "API call blocked: Least Privilege policy prevents cross-agent mutation",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "governance_expected"

    def test_classifies_paperclip_403_mutation(self):
        """Identify Paperclip 403 with mutation in error body."""
        comments = [
            {
                "body": "403 Forbidden: cross-agent mutation - insufficient permissions",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "governance_expected"

    def test_returns_none_for_unknown_error(self):
        """Return None when error source cannot be classified."""
        comments = [
            {
                "body": "Some generic error message",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result is None

    def test_returns_none_for_empty_comments(self):
        """Return None for empty comments list."""
        result = self.monitor._classify_error_source([])
        assert result is None

    def test_prioritizes_governance_over_github_patterns(self):
        """When both governance and github patterns present, classify as governance."""
        comments = [
            {
                "body": "Error: cross-agent mutation (403) and github token issue",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        # Governance check comes first, so should return governance_expected
        assert result == "governance_expected"

    def test_github_token_error_legacy_pattern(self):
        """Identify GitHub token error using legacy patterns."""
        comments = [
            {
                "body": "GitHub authentication failed - invalid token",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "github_credential"

    def test_case_insensitive_classification(self):
        """Error classification is case-insensitive."""
        comments = [
            {
                "body": "CROSS-AGENT MUTATION - 403 Error",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        assert result == "governance_expected"

    def test_multiple_comments_first_match_wins(self):
        """When multiple comments present, first match determines classification."""
        comments = [
            {
                "body": "API error occurred",
                "createdAt": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            },
            {
                "body": "GitHub API 401 - bad credentials",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._classify_error_source(comments)
        # The second comment has the error pattern
        assert result == "github_credential"


class TestHasGitHubTokenError:
    """Test _has_github_token_error method with new classification."""

    def setup_method(self):
        self.monitor = TokenGapEscalationMonitor()

    def test_returns_true_for_github_credential_error(self):
        """Returns True only for actual GitHub credential errors."""
        comments = [
            {
                "body": "GitHub API 401: bad credentials",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._has_github_token_error(comments)
        assert result is True

    def test_returns_false_for_governance_error(self):
        """Returns False for Paperclip governance blocks (not GitHub token issue)."""
        comments = [
            {
                "body": "403 Forbidden: cross-agent mutation",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._has_github_token_error(comments)
        assert result is False

    def test_returns_false_for_unknown_error(self):
        """Returns False when error source unknown."""
        comments = [
            {
                "body": "Some unrelated error",
                "createdAt": datetime.now(timezone.utc).isoformat()
            }
        ]
        result = self.monitor._has_github_token_error(comments)
        assert result is False


class TestEscalationWithErrorClassification:
    """Test escalation behavior with new error classification."""

    def setup_method(self):
        self.monitor = TokenGapEscalationMonitor(
            api_url="http://localhost:3100",
            api_key="test-key",
            company_id="test-company"
        )

    @patch.object(TokenGapEscalationMonitor, '_api_request')
    def test_skips_escalation_for_governance_errors(self, mock_api):
        """Routine skips escalation for governance errors, increments governance_skipped."""
        now = datetime.now(timezone.utc)
        past = now - timedelta(hours=5)

        mock_api.side_effect = [
            # First call: list blocked issues
            [
                {
                    "id": "issue-1",
                    "identifier": "BTCAAAAA-30949",
                    "title": "merge: close-time gate",
                    "status": "blocked",
                    "updatedAt": past.isoformat()
                }
            ],
            # Second call: get issue comments
            [
                {
                    "body": "403 Forbidden: cross-agent mutation - insufficient permissions",
                    "createdAt": past.isoformat()
                }
            ]
        ]

        result = self.monitor.find_and_escalate_token_gaps()

        assert result["governance_skipped"] == 1
        assert result["escalated"] == 0
        # Should have scanned the issue but not escalated it
        assert result["scanned"] == 1

    @patch.object(TokenGapEscalationMonitor, '_api_request')
    def test_escalates_genuine_github_errors(self, mock_api):
        """Routine escalates genuine GitHub credential errors."""
        now = datetime.now(timezone.utc)
        past = now - timedelta(hours=5)

        mock_api.side_effect = [
            # First call: list blocked issues
            [
                {
                    "id": "issue-2",
                    "identifier": "BTCAAAAA-30950",
                    "title": "merge: PR 123",
                    "status": "blocked",
                    "updatedAt": past.isoformat()
                }
            ],
            # Second call: get issue comments
            [
                {
                    "body": "GitHub API 401: bad credentials - check GH_TOKEN",
                    "createdAt": past.isoformat()
                }
            ],
            # Third call: get issue (for escalation check)
            {"id": "issue-2", "blocks": []},
            # Fourth call: create escalation task
            {"id": "escalation-1"}
        ]

        result = self.monitor.find_and_escalate_token_gaps()

        assert result["escalated"] == 1
        assert result["governance_skipped"] == 0
        assert len(result["issues"]) == 1
        assert result["issues"][0]["identifier"] == "BTCAAAAA-30950"

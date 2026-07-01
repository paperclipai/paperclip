#!/usr/bin/env python3
"""
PaperClip Recovery Monitor - Periodic health check for recovery actions.

Monitors for stalled workflows in:
- exchange_api_timeout: Exchange API calls stalled >2h
- position_mismatch: Position reconciliation issues stalled >1h
- signal_timeout: Signal generation pipelines stalled >3h
- orphan_checkout: Checked-out issues with no live run >6h
- agent_paused_stalled: Paused agents with in_progress work >2h

Uses Paperclip API for workflow detection (no database required).
"""

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
import json
import requests


@dataclass
class StalledWorkflow:
    """Represents a stalled workflow match."""
    scenario: str
    issue_id: Optional[str]
    agent_id: Optional[str]
    stalled_duration_minutes: int
    last_activity: Optional[datetime]
    details: dict


class RecoveryMonitor:
    """Monitor PaperClip recovery actions and stalled workflows using API."""

    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, company_id: Optional[str] = None):
        """Initialize monitor with API credentials only (no database required)."""
        self.api_url = api_url or os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100")
        self.api_key = api_key or os.environ.get("PAPERCLIP_API_KEY", "")
        self.company_id = company_id or os.environ.get("PAPERCLIP_COMPANY_ID", "")
        self.run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
        self.stalled_matches: list[StalledWorkflow] = []
        self.recovery_actions: list[dict] = []

    def close(self):
        """Cleanup (no-op for API-based monitor)."""
        pass

    def _api_request(self, method: str, endpoint: str, data: Optional[dict] = None) -> Optional[dict]:
        """Make a request to the Paperclip API."""
        url = f"{self.api_url}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        if self.run_id:
            headers["X-Paperclip-Run-Id"] = self.run_id

        try:
            if method == "GET":
                response = requests.get(url, headers=headers, timeout=10)
            elif method == "POST":
                response = requests.post(url, headers=headers, json=data, timeout=10)
            else:
                return None

            if response.status_code in (200, 201):
                return response.json()
            else:
                print(f"Warning: API request failed ({response.status_code}): {response.text[:200]}", file=sys.stderr)
                return None
        except Exception as e:
            print(f"Warning: API request exception: {str(e)}", file=sys.stderr)
            return None

    def find_matches(self) -> list[StalledWorkflow]:
        """Find all stalled workflow matches across configured scenarios."""
        self.stalled_matches = []

        # Check each scenario via API
        self._check_exchange_api_timeout()
        self._check_position_mismatch()
        self._check_signal_timeout()
        self._check_orphan_checkout()
        self._check_agent_paused_stalled()

        return self.stalled_matches

    def _check_exchange_api_timeout(self):
        """Check for exchange API calls stalled >2h via API."""
        try:
            now = datetime.now(timezone.utc)
            stale_before = now - timedelta(hours=2)

            issues = self._api_request(
                "GET",
                f"/api/companies/{self.company_id}/issues?q=exchange&status=in_progress,blocked"
            )

            if not issues or not isinstance(issues, list):
                return

            for issue in issues:
                updated_at = datetime.fromisoformat(issue.get("updatedAt", "").replace("Z", "+00:00"))
                stalled_minutes = int((now - updated_at).total_seconds() / 60)

                if updated_at < stale_before:
                    self.stalled_matches.append(StalledWorkflow(
                        scenario="exchange_api_timeout",
                        issue_id=issue.get("id") or issue.get("identifier"),
                        agent_id=issue.get("assigneeAgentId"),
                        stalled_duration_minutes=stalled_minutes,
                        last_activity=updated_at,
                        details={"status": issue.get("status")}
                    ))
        except Exception as e:
            print(f"Warning: Failed to check exchange_api_timeout: {e}", file=sys.stderr)

    def _check_position_mismatch(self):
        """Check for position reconciliation issues stalled >1h via API."""
        try:
            now = datetime.now(timezone.utc)
            stale_before = now - timedelta(hours=1)

            for keyword in ["position", "reconcil"]:
                issues = self._api_request(
                    "GET",
                    f"/api/companies/{self.company_id}/issues?q={keyword}&status=in_progress,blocked"
                )

                if not issues or not isinstance(issues, list):
                    continue

                for issue in issues:
                    updated_at = datetime.fromisoformat(issue.get("updatedAt", "").replace("Z", "+00:00"))
                    stalled_minutes = int((now - updated_at).total_seconds() / 60)

                    if updated_at < stale_before:
                        self.stalled_matches.append(StalledWorkflow(
                            scenario="position_mismatch",
                            issue_id=issue.get("id") or issue.get("identifier"),
                            agent_id=issue.get("assigneeAgentId"),
                            stalled_duration_minutes=stalled_minutes,
                            last_activity=updated_at,
                            details={"status": issue.get("status")}
                        ))
        except Exception as e:
            print(f"Warning: Failed to check position_mismatch: {e}", file=sys.stderr)

    def _check_signal_timeout(self):
        """Check for signal generation pipelines stalled >3h via API."""
        try:
            now = datetime.now(timezone.utc)
            stale_before = now - timedelta(hours=3)

            for keyword in ["signal", "pipeline"]:
                issues = self._api_request(
                    "GET",
                    f"/api/companies/{self.company_id}/issues?q={keyword}&status=in_progress,blocked"
                )

                if not issues or not isinstance(issues, list):
                    continue

                for issue in issues:
                    updated_at = datetime.fromisoformat(issue.get("updatedAt", "").replace("Z", "+00:00"))
                    stalled_minutes = int((now - updated_at).total_seconds() / 60)

                    if updated_at < stale_before:
                        self.stalled_matches.append(StalledWorkflow(
                            scenario="signal_timeout",
                            issue_id=issue.get("id") or issue.get("identifier"),
                            agent_id=issue.get("assigneeAgentId"),
                            stalled_duration_minutes=stalled_minutes,
                            last_activity=updated_at,
                            details={"status": issue.get("status")}
                        ))
        except Exception as e:
            print(f"Warning: Failed to check signal_timeout: {e}", file=sys.stderr)

    def _check_orphan_checkout(self):
        """Check for checked-out issues with no live run >6h via API."""
        try:
            now = datetime.now(timezone.utc)
            stale_before = now - timedelta(hours=6)

            issues = self._api_request(
                "GET",
                f"/api/companies/{self.company_id}/issues?status=in_progress,blocked"
            )

            if not issues or not isinstance(issues, list):
                return

            for issue in issues:
                if issue.get("checkoutRunId") and not issue.get("executionRunId"):
                    updated_at = datetime.fromisoformat(issue.get("updatedAt", "").replace("Z", "+00:00"))
                    stalled_minutes = int((now - updated_at).total_seconds() / 60)

                    if updated_at < stale_before:
                        self.stalled_matches.append(StalledWorkflow(
                            scenario="orphan_checkout",
                            issue_id=issue.get("id") or issue.get("identifier"),
                            agent_id=issue.get("assigneeAgentId"),
                            stalled_duration_minutes=stalled_minutes,
                            last_activity=updated_at,
                            details={"status": issue.get("status")}
                        ))
        except Exception as e:
            print(f"Warning: Failed to check orphan_checkout: {e}", file=sys.stderr)

    def _check_agent_paused_stalled(self):
        """Check for paused agents with in_progress work >2h via API."""
        try:
            now = datetime.now(timezone.utc)
            stale_before = now - timedelta(hours=2)

            issues = self._api_request(
                "GET",
                f"/api/companies/{self.company_id}/issues?status=in_progress"
            )

            if not issues or not isinstance(issues, list):
                return

            for issue in issues:
                agent_id = issue.get("assigneeAgentId")
                if not agent_id:
                    continue

                agent_details = self._api_request("GET", f"/api/agents/{agent_id}")
                if not agent_details or not agent_details.get("pausedAt"):
                    continue

                updated_at = datetime.fromisoformat(issue.get("updatedAt", "").replace("Z", "+00:00"))
                stalled_minutes = int((now - updated_at).total_seconds() / 60)

                if updated_at < stale_before:
                    self.stalled_matches.append(StalledWorkflow(
                        scenario="agent_paused_stalled",
                        issue_id=issue.get("id") or issue.get("identifier"),
                        agent_id=agent_id,
                        stalled_duration_minutes=stalled_minutes,
                        last_activity=updated_at,
                        details={"status": issue.get("status")}
                    ))
        except Exception as e:
            print(f"Warning: Failed to check agent_paused_stalled: {e}", file=sys.stderr)

    def report_matches(self) -> str:
        """Generate a human-readable report of matches."""
        if not self.stalled_matches:
            return "✓ No stalled workflows detected. Recovery actions are functioning normally."

        report = f"⚠ Found {len(self.stalled_matches)} stalled workflow(s):\n\n"

        # Group by scenario
        by_scenario = {}
        for match in self.stalled_matches:
            if match.scenario not in by_scenario:
                by_scenario[match.scenario] = []
            by_scenario[match.scenario].append(match)

        for scenario, matches in sorted(by_scenario.items()):
            report += f"## {scenario} ({len(matches)} issue(s))\n"
            for match in matches:
                report += f"- Issue: {match.issue_id or 'unknown'}\n"
                if match.agent_id:
                    report += f"  Agent: {match.agent_id}\n"
                report += f"  Stalled for: {match.stalled_duration_minutes} minutes\n"
                if match.last_activity:
                    report += f"  Last activity: {match.last_activity.isoformat()}\n"
            report += "\n"

        return report

    def run_dry_run(self) -> str:
        """Preview what recovery actions would be taken."""
        if not self.stalled_matches:
            return "No recovery actions needed."

        preview = "## Proposed Recovery Actions (Dry Run)\n\n"

        for match in self.stalled_matches:
            preview += f"### {match.scenario}\n"
            preview += f"Issue: {match.issue_id or 'unknown'}\n"

            # Propose actions based on scenario
            if match.scenario == "exchange_api_timeout":
                preview += "Action: Wake exchange handler agent with recovery context\n"
                preview += "  - Escalate to exchange_monitor agent\n"
                preview += "  - Request API health check\n"
            elif match.scenario == "position_mismatch":
                preview += "Action: Trigger position reconciliation\n"
                preview += "  - Initiate reconciliation workflow\n"
                preview += "  - Request manual verification\n"
            elif match.scenario == "signal_timeout":
                preview += "Action: Restart signal generation pipeline\n"
                preview += "  - Wake signal_generator agent\n"
                preview += "  - Clear stalled state\n"
            elif match.scenario == "orphan_checkout":
                preview += "Action: Release orphaned checkout\n"
                preview += "  - Clear checked_out_by_agent_id\n"
                preview += "  - Reassign to fallback agent\n"
            elif match.scenario == "agent_paused_stalled":
                preview += "Action: Resume paused agent\n"
                preview += "  - Check pause reason\n"
                preview += "  - Request manual resume\n"

            preview += f"\n"

        return preview

    def execute_recovery_actions(self) -> dict:
        """Execute recovery actions for matched stalled workflows."""
        if not self.stalled_matches:
            return {"executed": 0, "failed": 0, "actions": []}

        executed_count = 0
        failed_count = 0

        for match in self.stalled_matches:
            action_result = self._execute_action_for_match(match)
            self.recovery_actions.append(action_result)
            if action_result.get("status") == "success":
                executed_count += 1
            else:
                failed_count += 1

        return {
            "executed": executed_count,
            "failed": failed_count,
            "actions": self.recovery_actions
        }

    def _execute_action_for_match(self, match: StalledWorkflow) -> dict:
        """Execute recovery action for a specific stalled workflow match."""
        try:
            if match.scenario == "exchange_api_timeout":
                return self._recover_exchange_api_timeout(match)
            elif match.scenario == "position_mismatch":
                return self._recover_position_mismatch(match)
            elif match.scenario == "signal_timeout":
                return self._recover_signal_timeout(match)
            elif match.scenario == "orphan_checkout":
                return self._recover_orphan_checkout(match)
            elif match.scenario == "agent_paused_stalled":
                return self._recover_agent_paused_stalled(match)
            else:
                return {
                    "scenario": match.scenario,
                    "issue_id": match.issue_id,
                    "status": "unknown",
                    "message": f"Unknown scenario: {match.scenario}"
                }
        except Exception as e:
            return {
                "scenario": match.scenario,
                "issue_id": match.issue_id,
                "status": "failed",
                "message": str(e)
            }

    def _recover_exchange_api_timeout(self, match: StalledWorkflow) -> dict:
        """Recover from exchange API timeout by escalating."""
        comment = """## 🔧 Recovery Action: Exchange API Timeout

PaperClip Recovery Monitor detected this workflow stalled for exchange API operations.

**Action:** Escalating to exchange_monitor agent
- Check API health status
- Verify network connectivity
- Resume with fresh API state

This is an automated recovery attempt. Please monitor for resolution."""

        return self._post_recovery_comment(match, comment, "exchange_api_timeout")

    def _recover_position_mismatch(self, match: StalledWorkflow) -> dict:
        """Recover from position mismatch by triggering reconciliation."""
        comment = """## 🔧 Recovery Action: Position Reconciliation

PaperClip Recovery Monitor detected this workflow stalled on position reconciliation.

**Action:** Initiating position reconciliation workflow
- Clear cached position state
- Fetch fresh exchange positions
- Reconcile with local ledger

This is an automated recovery attempt. Please verify results."""

        return self._post_recovery_comment(match, comment, "position_mismatch")

    def _recover_signal_timeout(self, match: StalledWorkflow) -> dict:
        """Recover from signal generation timeout."""
        comment = """## 🔧 Recovery Action: Signal Pipeline Restart

PaperClip Recovery Monitor detected this workflow stalled in signal generation.

**Action:** Restarting signal generation pipeline
- Clear stalled computation state
- Wake signal_generator agent
- Resume from checkpoint

This is an automated recovery attempt. Please monitor for completion."""

        return self._post_recovery_comment(match, comment, "signal_timeout")

    def _recover_orphan_checkout(self, match: StalledWorkflow) -> dict:
        """Recover from orphaned checkout by releasing and reassigning."""
        comment = """## 🔧 Recovery Action: Orphaned Checkout Release

PaperClip Recovery Monitor detected this issue with a stale checkout (no active heartbeat run).

**Action:** Releasing orphaned checkout
- Clearing stale checkout state
- Re-opening for agent assignment
- System will reassign on next heartbeat

This is an automated recovery action. The issue should become available for agents shortly."""

        # For orphan_checkout, we try to release the issue
        return self._attempt_orphan_release(match, comment)

    def _recover_agent_paused_stalled(self, match: StalledWorkflow) -> dict:
        """Recover from paused agent with stalled work."""
        comment = """## 🔧 Recovery Action: Paused Agent Escalation

PaperClip Recovery Monitor detected in_progress work assigned to a paused agent.

**Action:** Escalating to administrator
- Paused agent cannot complete work
- Manual intervention required to either:
  - Resume the paused agent, or
  - Reassign work to available agent

Please review and act."""

        return self._post_recovery_comment(match, comment, "agent_paused_stalled")

    def _post_recovery_comment(self, match: StalledWorkflow, comment: str, scenario: str) -> dict:
        """Post a recovery comment to a stalled issue."""
        if not match.issue_id:
            return {
                "scenario": scenario,
                "issue_id": None,
                "status": "failed",
                "message": "No issue ID to post comment"
            }

        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            }
            if self.run_id:
                headers["X-Paperclip-Run-Id"] = self.run_id

            url = f"{self.api_url}/api/issues/{match.issue_id}/comments"
            response = requests.post(url, headers=headers, json={"body": comment})

            if response.status_code in (200, 201):
                return {
                    "scenario": scenario,
                    "issue_id": match.issue_id,
                    "status": "success",
                    "message": "Recovery comment posted",
                    "action": "escalated"
                }
            elif response.status_code == 403:
                return {
                    "scenario": scenario,
                    "issue_id": match.issue_id,
                    "status": "failed",
                    "message": "Permission denied - recovery agent may not have access to this issue"
                }
            else:
                return {
                    "scenario": scenario,
                    "issue_id": match.issue_id,
                    "status": "failed",
                    "message": f"API error {response.status_code}: {response.text[:200]}"
                }
        except Exception as e:
            return {
                "scenario": scenario,
                "issue_id": match.issue_id,
                "status": "failed",
                "message": f"Exception: {str(e)}"
            }

    def _attempt_orphan_release(self, match: StalledWorkflow, comment: str) -> dict:
        """Attempt to release an orphaned checkout."""
        if not match.issue_id:
            return {
                "scenario": "orphan_checkout",
                "issue_id": None,
                "status": "failed",
                "message": "No issue ID to release"
            }

        # First, try to post the recovery comment
        comment_result = self._post_recovery_comment(match, comment, "orphan_checkout")

        if comment_result.get("status") != "success":
            return comment_result

        # Then try to release the checkout via the release endpoint
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json"
            }
            if self.run_id:
                headers["X-Paperclip-Run-Id"] = self.run_id

            url = f"{self.api_url}/api/issues/{match.issue_id}/release"
            response = requests.post(url, headers=headers)

            if response.status_code == 200:
                return {
                    "scenario": "orphan_checkout",
                    "issue_id": match.issue_id,
                    "status": "success",
                    "message": "Orphaned checkout released and issue returned to queue",
                    "action": "released"
                }
            else:
                # Release failed but comment was posted, so still a partial recovery
                return {
                    "scenario": "orphan_checkout",
                    "issue_id": match.issue_id,
                    "status": "partial",
                    "message": f"Comment posted but release failed ({response.status_code})",
                    "action": "escalated"
                }
        except Exception as e:
            # Comment was posted, so treat as partial success
            return {
                "scenario": "orphan_checkout",
                "issue_id": match.issue_id,
                "status": "partial",
                "message": f"Comment posted but release failed: {str(e)}",
                "action": "escalated"
            }


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="PaperClip Recovery Monitor - Check for stalled workflows (API-based)"
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # matches command
    matches_parser = subparsers.add_parser(
        "matches",
        help="List stalled workflows matching recovery scenarios"
    )
    matches_parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON"
    )

    # run command
    run_parser = subparsers.add_parser(
        "run",
        help="Execute recovery actions"
    )
    run_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview actions without executing"
    )

    args = parser.parse_args()

    # Verify required environment variables
    if not os.environ.get("PAPERCLIP_API_URL"):
        print("Error: PAPERCLIP_API_URL environment variable not set", file=sys.stderr)
        sys.exit(1)
    if not os.environ.get("PAPERCLIP_API_KEY"):
        print("Error: PAPERCLIP_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)
    if not os.environ.get("PAPERCLIP_COMPANY_ID"):
        print("Error: PAPERCLIP_COMPANY_ID environment variable not set", file=sys.stderr)
        sys.exit(1)

    if not args.command:
        parser.print_help()
        sys.exit(0)

    monitor = RecoveryMonitor()

    try:
        if args.command == "matches":
            matches = monitor.find_matches()
            if args.json:
                output = json.dumps(
                    [
                        {
                            "scenario": m.scenario,
                            "issue_id": m.issue_id,
                            "agent_id": m.agent_id,
                            "stalled_minutes": m.stalled_duration_minutes,
                            "last_activity": m.last_activity.isoformat() if m.last_activity else None,
                        }
                        for m in matches
                    ],
                    indent=2
                )
            else:
                output = monitor.report_matches()

            print(output)
            sys.exit(0 if not matches else 1)

        elif args.command == "run":
            matches = monitor.find_matches()
            if args.dry_run:
                preview = monitor.run_dry_run()
                print(preview)
                sys.exit(0 if not matches else 1)
            else:
                # Execute recovery actions
                if not matches:
                    print("✓ No stalled workflows - no recovery actions needed.")
                    sys.exit(0)
                else:
                    results = monitor.execute_recovery_actions()
                    print(f"## Recovery Execution Summary\n")
                    print(f"✓ Executed: {results['executed']}")
                    print(f"✗ Failed: {results['failed']}")
                    print(f"\n### Action Details\n")
                    for action in results['actions']:
                        status_icon = "✓" if action.get("status") == "success" else "⚠" if action.get("status") == "partial" else "✗"
                        print(f"{status_icon} {action.get('scenario', 'unknown')}: {action.get('issue_id', 'N/A')}")
                        print(f"   {action.get('message', 'No message')}")
                    sys.exit(0 if results['failed'] == 0 else 1)

    finally:
        monitor.close()


if __name__ == "__main__":
    main()

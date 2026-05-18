#!/usr/bin/env python3
"""
Test suite for PaperClip Recovery Monitor.
Validates the recovery monitor logic and reporting without database dependency.
"""

import sys
sys.path.insert(0, 'scripts')

from paperclip_recovery_monitor import RecoveryMonitor, StalledWorkflow
from datetime import datetime, timezone


def test_recovery_monitor_initialization():
    """Test that monitor initializes correctly."""
    monitor = RecoveryMonitor(
        api_url="http://localhost:3100",
        api_key="test-key",
        company_id="test-company"
    )
    assert monitor.api_url == "http://localhost:3100"
    assert monitor.api_key == "test-key"
    assert monitor.company_id == "test-company"
    assert monitor.stalled_matches == []
    print("✓ Monitor initialization test passed")


def test_stalled_workflow_creation():
    """Test that StalledWorkflow dataclass works correctly."""
    now = datetime.now(timezone.utc)
    workflow = StalledWorkflow(
        scenario="exchange_api_timeout",
        issue_id="BTCAAAAA-12345",
        agent_id="agent-exchange-monitor",
        stalled_duration_minutes=150,
        last_activity=now,
        details={"status": "running", "error": "timeout"}
    )

    assert workflow.scenario == "exchange_api_timeout"
    assert workflow.issue_id == "BTCAAAAA-12345"
    assert workflow.stalled_duration_minutes == 150
    assert workflow.last_activity == now
    print("✓ StalledWorkflow creation test passed")


def test_report_generation():
    """Test that recovery monitor generates reports correctly."""
    monitor = RecoveryMonitor()

    # Add test matches
    monitor.stalled_matches = [
        StalledWorkflow(
            scenario="exchange_api_timeout",
            issue_id="BTCAAAAA-001",
            agent_id="agent-123",
            stalled_duration_minutes=140,
            last_activity=None,
            details={"status": "running"}
        ),
        StalledWorkflow(
            scenario="position_mismatch",
            issue_id="BTCAAAAA-002",
            agent_id="agent-456",
            stalled_duration_minutes=75,
            last_activity=None,
            details={"status": "queued"}
        ),
        StalledWorkflow(
            scenario="signal_timeout",
            issue_id="BTCAAAAA-003",
            agent_id="agent-789",
            stalled_duration_minutes=190,
            last_activity=None,
            details={"status": "running"}
        ),
    ]

    report = monitor.report_matches()

    # Verify report contains expected information
    assert "⚠ Found 3 stalled workflow(s)" in report
    assert "exchange_api_timeout" in report
    assert "position_mismatch" in report
    assert "signal_timeout" in report
    assert "BTCAAAAA-001" in report
    assert "BTCAAAAA-002" in report
    assert "BTCAAAAA-003" in report
    assert "140 minutes" in report
    assert "75 minutes" in report
    assert "190 minutes" in report

    print("✓ Report generation test passed")
    print("\nGenerated Report:")
    print(report)


def test_no_matches_report():
    """Test report when no matches found."""
    monitor = RecoveryMonitor()
    monitor.stalled_matches = []

    report = monitor.report_matches()
    assert "✓ No stalled workflows detected" in report
    assert "Recovery actions are functioning normally" in report

    print("✓ No matches report test passed")


def test_dry_run_generation():
    """Test dry-run action preview."""
    monitor = RecoveryMonitor()
    monitor.stalled_matches = [
        StalledWorkflow(
            scenario="exchange_api_timeout",
            issue_id="BTCAAAAA-001",
            agent_id="agent-123",
            stalled_duration_minutes=140,
            last_activity=None,
            details={"status": "running"}
        ),
        StalledWorkflow(
            scenario="orphan_checkout",
            issue_id="BTCAAAAA-002",
            agent_id="agent-456",
            stalled_duration_minutes=400,
            last_activity=None,
            details={"status": "queued"}
        ),
        StalledWorkflow(
            scenario="agent_paused_stalled",
            issue_id="BTCAAAAA-003",
            agent_id="agent-789",
            stalled_duration_minutes=130,
            last_activity=None,
            details={"status": "in_progress"}
        ),
    ]

    dry_run = monitor.run_dry_run()

    # Verify dry-run contains expected recovery actions
    assert "Proposed Recovery Actions" in dry_run
    assert "exchange_api_timeout" in dry_run
    assert "exchange_monitor agent" in dry_run
    assert "orphan_checkout" in dry_run
    assert "Release orphaned checkout" in dry_run
    assert "agent_paused_stalled" in dry_run
    assert "Resume paused agent" in dry_run

    print("✓ Dry-run generation test passed")
    print("\nGenerated Dry-Run Preview:")
    print(dry_run)


def test_recovery_action_execution_structure():
    """Test the recovery action execution result structure."""
    monitor = RecoveryMonitor()
    monitor.stalled_matches = []

    result = monitor.execute_recovery_actions()

    assert "executed" in result
    assert "failed" in result
    assert "actions" in result
    assert result["executed"] == 0
    assert result["failed"] == 0
    assert len(result["actions"]) == 0

    print("✓ Recovery action execution structure test passed")


def test_scenario_coverage():
    """Verify all 5 scenarios are properly implemented."""
    monitor = RecoveryMonitor()

    scenarios = [
        "exchange_api_timeout",
        "position_mismatch",
        "signal_timeout",
        "orphan_checkout",
        "agent_paused_stalled"
    ]

    for scenario in scenarios:
        assert hasattr(monitor, f"_check_{scenario}")
        assert hasattr(monitor, f"_recover_{scenario}")

    print(f"✓ All {len(scenarios)} recovery scenarios are implemented:")
    for s in scenarios:
        print(f"  - {s}")


def main():
    """Run all tests."""
    print("=" * 60)
    print("PaperClip Recovery Monitor - Validation Test Suite")
    print("=" * 60)
    print()

    try:
        test_recovery_monitor_initialization()
        test_stalled_workflow_creation()
        test_report_generation()
        test_no_matches_report()
        test_dry_run_generation()
        test_recovery_action_execution_structure()
        test_scenario_coverage()

        print()
        print("=" * 60)
        print("✓ All validation tests passed!")
        print("=" * 60)
        return 0
    except AssertionError as e:
        print(f"\n✗ Test failed: {e}")
        return 1
    except Exception as e:
        print(f"\n✗ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

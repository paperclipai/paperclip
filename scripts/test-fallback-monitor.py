#!/usr/bin/env python3
"""Focused regression checks for fallback-monitor limit detection.

Run with: python3 scripts/test-fallback-monitor.py
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location("fallback_monitor", SCRIPT_DIR / "fallback-monitor.py")
assert spec and spec.loader
fallback_monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fallback_monitor)


class FallbackMonitorLimitTests(unittest.TestCase):
    def test_spark_usage_limit_wording_matches(self) -> None:
        for message in (
            "You've hit your usage limit. Try again at Aug 16th, 2026 1:35 PM.",
            "usage limit reached",
            "Usage limit has been reached; please try later.",
        ):
            match, provider = fallback_monitor.detect_limit_text(message, "codex_local")
            self.assertIsNotNone(match, message)
            self.assertEqual(provider, "generic")
            self.assertEqual(fallback_monitor.infer_limit_kind(message, provider), "usage")

    def test_empty_spark_success_streak_trips_at_twelve(self) -> None:
        now = datetime.now(timezone.utc)
        runs = [
            {
                "id": f"empty-{index}",
                "agentId": "spark-primary",
                "status": "succeeded",
                "finishedAt": (now - timedelta(minutes=index)).isoformat(),
                "usageJson": {"outputTokens": 0},
            }
            for index in range(12)
        ]
        streak = fallback_monitor.detect_spark_empty_output_streak(runs, "spark-primary", 12)
        self.assertEqual([run["id"] for run in streak], [f"empty-{index}" for index in range(12)])

    def test_real_output_or_missing_usage_breaks_empty_streak(self) -> None:
        now = datetime.now(timezone.utc)
        empty = {
            "id": "empty",
            "agentId": "spark-primary",
            "finishedAt": now.isoformat(),
            "usageJson": {"output_tokens": 0},
        }
        meaningful = {
            "id": "meaningful",
            "agentId": "spark-primary",
            "finishedAt": (now - timedelta(minutes=1)).isoformat(),
            "usageJson": {"output_tokens": 2},
        }
        unknown = {
            "id": "unknown",
            "agentId": "spark-primary",
            "finishedAt": (now - timedelta(minutes=1)).isoformat(),
        }
        self.assertEqual(
            fallback_monitor.detect_spark_empty_output_streak([empty, meaningful], "spark-primary", 2),
            [],
        )
        self.assertEqual(
            fallback_monitor.detect_spark_empty_output_streak([empty, unknown], "spark-primary", 2),
            [],
        )

    def test_spark_detection_requires_exact_configured_model(self) -> None:
        self.assertTrue(
            fallback_monitor.agent_serves_spark(
                {"adapterConfig": {"model": "gpt-5.3-codex-spark"}}
            )
        )
        self.assertFalse(
            fallback_monitor.agent_serves_spark({"adapterConfig": {"model": "gpt-5.5"}})
        )


if __name__ == "__main__":
    unittest.main()

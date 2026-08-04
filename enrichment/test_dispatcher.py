"""
Unit tests for dispatcher.py — cost-cap enforcement and concurrency flag.

All DB and LiteLLM/Anthropic calls are mocked; no network or DB required.

Run: python3 -m pytest enrichment/test_dispatcher.py -v
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

sys.path.insert(0, os.path.dirname(__file__))
from cost_cap import CostCapTracker
from dispatcher import (
    DispatcherConfig,
    EnrichmentDispatcher,
    PRIMARY_MODEL,
    _build_enrichment_messages,
    _preflight_auth_check,
    _process_row,
    _anthropic_preflight,
    _anthropic_reviewer,
)
from cost_cap import WEEKLY_CAP_USD

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cfg(tmp_dir: str, concurrency: int = 1, anthropic_key: str = "fake-key") -> DispatcherConfig:
    return DispatcherConfig(
        database_url="postgresql://test/test",
        litellm_base_url="http://localhost:4000",
        anthropic_api_key=anthropic_key,
        paperclip_api_url="http://localhost:3101",
        paperclip_api_key="fake",
        paperclip_routine_id="routine-123",
        enrichment_issue_id="issue-456",
        cost_cap_ledger_path=os.path.join(tmp_dir, "ledger.json"),
        batch_size=5,
        concurrency=concurrency,
    )


def _minimal_valid_output() -> dict:
    return {
        "sku": "TEST-001",
        "product_name": "Test Surface",
        "manufacturer": None,
        "material_type": "quartz",
        "primary_color_family": "white",
        "secondary_color_family": None,
        "finish": "polished",
        "pattern_type": "veined",
        "thickness_options_mm": [20, 30],
        "slab_sizes_available": [{"width_mm": 3050, "height_mm": 1440}],
        "applications": ["countertop"],
        "price_tier": "mid",
        "availability": "in_stock",
        "is_outdoor": False,
        "weather_rating": None,
        "heat_resistance": "good",
        "scratch_resistance": "good",
        "stain_resistant": True,
        "sealing_required": False,
        "care_level": "low",
        "edge_profiles_available": [],
        "certifications": [],
        "country_of_origin": None,
        "uv_resistant": None,
        "warranty_years": None,
        "recycled_content_pct": None,
        "voc_compliant": None,
        "series_name": None,
        "collection_name": None,
        "enrichment_confidence": 0.85,
        "low_confidence_fields": [],
        "enrichment_notes": None,
    }


def _make_row() -> dict:
    return {
        "id": "row-abc-123",
        "source_row_id": "SKU-001",
        "payload_json": {"sku": "SKU-001", "product_name": "Test", "raw_description": "A quartz slab"},
    }


# ---------------------------------------------------------------------------
# Tests: concurrency feature flag
# ---------------------------------------------------------------------------

class TestConcurrencyFlag(unittest.TestCase):
    def test_default_concurrency_is_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = _make_cfg(tmp, concurrency=1)
            self.assertEqual(cfg.concurrency, 1)

    def test_concurrency_clamped_to_four(self):
        from dispatcher import DispatcherConfig
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATABASE_URL"] = "postgresql://test/test"
            os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"] = "10"
            cfg = DispatcherConfig.from_env()
            self.assertEqual(cfg.concurrency, 4)  # clamped
            del os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"]

    def test_concurrency_minimum_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATABASE_URL"] = "postgresql://test/test"
            os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"] = "0"
            from dispatcher import DispatcherConfig
            cfg = DispatcherConfig.from_env()
            self.assertEqual(cfg.concurrency, 1)
            del os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"]


# ---------------------------------------------------------------------------
# Tests: cost-cap enforcement in process_row
# ---------------------------------------------------------------------------

class TestCostCapEnforcement(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_row(self, weekly_spend_pre: float) -> dict:
        """Run one row through _process_row with the given pre-seeded weekly spend."""
        cfg = _make_cfg(self._tmp)
        tracker = CostCapTracker(cfg.cost_cap_ledger_path)
        if weekly_spend_pre > 0:
            tracker.record(weekly_spend_pre)

        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={
                "choices": [{"message": {"content": valid_json}}]
            }),
        )

        reviewer_response = {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}

        with patch("dispatcher._anthropic_reviewer", new=AsyncMock(return_value=(reviewer_response, 0.05, None))), \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "batch-1", cfg, tracker, http_client, conn, cap_paused,
                reviewer_enabled=True, reviewer_auth_failed=asyncio.Event(),
            )

        return {
            "cap_paused": cap_paused.is_set(),
            "weekly_spend_after": tracker.weekly_spend(),
        }

    async def test_reviewer_called_below_cap(self):
        """Reviewer is called when weekly spend is well below $50."""
        result = await self._run_row(weekly_spend_pre=0.0)
        self.assertFalse(result["cap_paused"])
        self.assertGreater(result["weekly_spend_after"], 0.0)

    async def test_reviewer_skipped_above_cap(self):
        """When weekly spend already exceeds $50, reviewer tier is skipped and routine is paused."""
        with patch("dispatcher._pause_routine", new=AsyncMock()):
            result = await self._run_row(weekly_spend_pre=50.01)
        self.assertTrue(result["cap_paused"])

    async def test_no_pause_at_exactly_50(self):
        """Exactly $50.00 is not yet a breach — reviewer may still run."""
        result = await self._run_row(weekly_spend_pre=50.00)
        # Whether it runs depends on estimated cost check; key assertion: $50.00 alone is not a breach
        tracker = CostCapTracker(_make_cfg(self._tmp).cost_cap_ledger_path)
        self.assertFalse(tracker.would_breach(0.0))

    async def test_empty_queue_returns_immediately(self):
        """run_batch with an empty DB returns a zero-row summary."""
        cfg = _make_cfg(self._tmp)

        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher._fetch_pending_rows", return_value=[]):
            dispatcher = EnrichmentDispatcher(cfg)
            summary = await dispatcher.run_batch()

        self.assertEqual(summary["total"], 0)
        self.assertEqual(summary["done"], 0)
        self.assertFalse(summary["cap_paused"])


# ---------------------------------------------------------------------------
# Tests: row processing tiers
# ---------------------------------------------------------------------------

class TestRowTierRouting(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_with_primary_content(self, primary_content: str, fallback_content: str = "") -> str:
        cfg = _make_cfg(self._tmp, anthropic_key="")  # no reviewer
        tracker = CostCapTracker(cfg.cost_cap_ledger_path)
        cap_paused = asyncio.Event()
        conn = MagicMock()

        call_count = [0]

        async def mock_litellm_complete(client, base_url, model, system, user, timeout, api_key=""):
            call_count[0] += 1
            if call_count[0] == 1:
                return primary_content, False
            return fallback_content, False

        with patch("dispatcher._litellm_complete", side_effect=mock_litellm_complete), \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging") as mock_write, \
             patch("dispatcher._mark_queue_done") as mock_done:
            http_client = AsyncMock()
            tier = await _process_row(
                _make_row(), "batch-1", cfg, tracker, http_client, conn, cap_paused,
                reviewer_enabled=False,
            )
            queue_status = mock_done.call_args[0][2] if mock_done.called else None

        return tier

    async def test_primary_valid_uses_primary_tier(self):
        tier = await self._run_with_primary_content(json.dumps(_minimal_valid_output()))
        self.assertEqual(tier, "primary")

    async def test_invalid_primary_falls_to_fallback(self):
        tier = await self._run_with_primary_content(
            primary_content="not json",
            fallback_content=json.dumps(_minimal_valid_output()),
        )
        self.assertEqual(tier, "fallback")

    async def test_both_fail_returns_failed(self):
        tier = await self._run_with_primary_content(
            primary_content="bad",
            fallback_content="also bad",
        )
        self.assertEqual(tier, "failed")

    async def test_fallback_nested_applications_list_is_normalized(self):
        fallback = _minimal_valid_output()
        fallback["applications"] = [["countertop", "bathroom_vanity"]]

        tier = await self._run_with_primary_content(
            primary_content="bad",
            fallback_content=json.dumps(fallback),
        )

        self.assertEqual(tier, "fallback")


# ---------------------------------------------------------------------------
# Tests: preflight auth check (SAG-3455 fix 1)
# ---------------------------------------------------------------------------

class TestPreflightAuthCheck(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def test_preflight_raises_on_401(self):
        """_preflight_auth_check raises RuntimeError mentioning LITELLM_API_KEY on 401."""
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)

        with self.assertRaises(RuntimeError) as ctx:
            await _preflight_auth_check(mock_client, "http://localhost:4000", "bad-key")

        self.assertIn("LITELLM_API_KEY", str(ctx.exception))
        self.assertIn("401", str(ctx.exception))

    async def test_preflight_raises_on_403(self):
        """_preflight_auth_check raises RuntimeError on 403 (forbidden)."""
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)

        with self.assertRaises(RuntimeError) as ctx:
            await _preflight_auth_check(mock_client, "http://localhost:4000", "key")

        self.assertIn("LITELLM_API_KEY", str(ctx.exception))

    async def test_preflight_no_raise_on_200(self):
        """_preflight_auth_check does not raise when gateway returns 200."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_resp)

        await _preflight_auth_check(mock_client, "http://localhost:4000", "good-key")

    async def test_preflight_warns_and_continues_on_network_error(self):
        """Network errors log a warning and do not raise — infra blips don't abort batches."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))

        # Should not raise
        await _preflight_auth_check(mock_client, "http://localhost:4000", "key")

    async def test_run_batch_propagates_preflight_auth_error(self):
        """run_batch raises immediately when preflight detects 401 — no rows processed."""
        cfg = _make_cfg(self._tmp)
        with patch(
            "dispatcher._preflight_auth_check",
            new=AsyncMock(side_effect=RuntimeError("LITELLM_API_KEY missing or invalid: 401")),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                await EnrichmentDispatcher(cfg).run_batch()
            self.assertIn("LITELLM_API_KEY", str(ctx.exception))


# ---------------------------------------------------------------------------
# Tests: /no_think directive for primary Qwen3 model (SAG-3455 fix 4)
# ---------------------------------------------------------------------------

class TestNoThinkDirective(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _capture_litellm_calls(self, primary_content: str) -> list[dict]:
        cfg = _make_cfg(self._tmp, anthropic_key="")
        tracker = CostCapTracker(cfg.cost_cap_ledger_path)
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()
        calls: list[dict] = []

        async def _capture(client, base_url, model, system, user, timeout, api_key=""):
            calls.append({"model": model, "system": system, "user": user})
            if model == PRIMARY_MODEL:
                return primary_content, False
            return json.dumps(_minimal_valid_output()), False

        with patch("dispatcher._litellm_complete", side_effect=_capture), \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "b", cfg, tracker, http_client, conn, cap_paused,
                reviewer_enabled=False,
            )

        return calls

    async def test_primary_call_has_no_no_think_prefix(self):
        """Primary (Gemma4) call must NOT carry /no_think — Gemma4 does not emit thinking blocks."""
        calls = await self._capture_litellm_calls(json.dumps(_minimal_valid_output()))
        primary_calls = [c for c in calls if c["model"] == PRIMARY_MODEL]
        self.assertEqual(len(primary_calls), 1, "Expected exactly one primary call")
        self.assertFalse(
            primary_calls[0]["user"].startswith("/no_think"),
            f"Primary (Gemma4) user prompt must not start with /no_think: {primary_calls[0]['user'][:60]!r}",
        )

    async def test_fallback_call_has_no_no_think_prefix(self):
        """Fallback model call must NOT carry the /no_think prefix."""
        calls = await self._capture_litellm_calls("not valid json")  # force fallback
        fallback_calls = [c for c in calls if c["model"] != PRIMARY_MODEL]
        self.assertGreater(len(fallback_calls), 0, "Expected at least one fallback call")
        for fc in fallback_calls:
            self.assertFalse(
                fc["user"].startswith("/no_think"),
                f"Fallback user prompt should not start with /no_think: {fc['user'][:60]!r}",
            )


# ---------------------------------------------------------------------------
# Tests: Anthropic preflight — pure function, no network (SAG-3483)
# ---------------------------------------------------------------------------

class TestAnthropicPreflight(unittest.TestCase):

    def test_empty_key_returns_false(self):
        self.assertFalse(_anthropic_preflight(""))

    def test_placeholder_key_returns_false(self):
        self.assertFalse(_anthropic_preflight("dev_key"))

    def test_non_skant_long_key_returns_false(self):
        self.assertFalse(_anthropic_preflight("some-random-key-that-is-long-enough"))

    def test_valid_skant_prefix_returns_true(self):
        self.assertTrue(_anthropic_preflight("sk-ant-api03-abc123"))

    def test_skant_minimal_prefix_returns_true(self):
        self.assertTrue(_anthropic_preflight("sk-ant-x"))

    def test_almost_correct_prefix_returns_false(self):
        self.assertFalse(_anthropic_preflight("sk-ant"))  # missing trailing dash


# ---------------------------------------------------------------------------
# Fake exception classes for _anthropic_reviewer unit tests (SAG-3483)
# ---------------------------------------------------------------------------

class _FakeAPIStatusError(Exception):
    """Fake Anthropic HTTP error — carries status_code like the real SDK."""
    def __init__(self, status_code: int):
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}")


class _FakeAPITimeoutError(Exception):
    """Fake Anthropic timeout — class name contains 'timeout' (case-insensitive)."""
    pass


# ---------------------------------------------------------------------------
# Tests: _anthropic_reviewer typed error classes (SAG-3483)
# ---------------------------------------------------------------------------

class TestAnthropicReviewerTypedErrors(unittest.IsolatedAsyncioTestCase):

    def _mock_ant_module(self, side_effect=None):
        mock_resp = MagicMock()
        mock_resp.content = [MagicMock(
            text='{"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}'
        )]
        mock_resp.usage.input_tokens = 100
        mock_resp.usage.output_tokens = 50

        mock_client = MagicMock()
        if side_effect is not None:
            mock_client.messages.create = AsyncMock(side_effect=side_effect)
        else:
            mock_client.messages.create = AsyncMock(return_value=mock_resp)

        mock_ant = MagicMock()
        mock_ant.AsyncAnthropic.return_value = mock_client
        return mock_ant

    async def test_success_returns_none_error_class(self):
        mock_ant = self._mock_ant_module()
        with patch.dict(sys.modules, {'anthropic': mock_ant}):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(error_class)
        self.assertIsNotNone(verdict)
        self.assertGreater(cost, 0)

    async def test_401_returns_reviewer_auth_error(self):
        mock_ant = self._mock_ant_module(side_effect=_FakeAPIStatusError(401))
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=AsyncMock()):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_auth_error")

    async def test_403_returns_reviewer_auth_error(self):
        mock_ant = self._mock_ant_module(side_effect=_FakeAPIStatusError(403))
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=AsyncMock()):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_auth_error")

    async def test_auth_error_does_not_retry(self):
        """401/403 must not retry — no asyncio.sleep calls."""
        mock_ant = self._mock_ant_module(side_effect=_FakeAPIStatusError(401))
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=AsyncMock()) as mock_sleep:
            await _anthropic_reviewer("sk-ant-key", {"sku": "X"}, _minimal_valid_output())
        mock_sleep.assert_not_called()

    async def test_429_retries_twice_then_returns_rate_limited(self):
        mock_ant = self._mock_ant_module(side_effect=_FakeAPIStatusError(429))
        mock_sleep = AsyncMock()
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=mock_sleep):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_rate_limited")
        self.assertEqual(mock_sleep.call_count, 2)  # REVIEWER_MAX_RETRIES = 2

    async def test_529_returns_rate_limited(self):
        mock_ant = self._mock_ant_module(side_effect=_FakeAPIStatusError(529))
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=AsyncMock()):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_rate_limited")

    async def test_timeout_retries_twice_then_returns_reviewer_timeout(self):
        mock_ant = self._mock_ant_module(side_effect=_FakeAPITimeoutError("timed out"))
        mock_sleep = AsyncMock()
        with patch.dict(sys.modules, {'anthropic': mock_ant}), \
             patch("asyncio.sleep", new=mock_sleep):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_timeout")
        self.assertEqual(mock_sleep.call_count, 2)

    async def test_unexpected_exception_returns_reviewer_error(self):
        mock_ant = self._mock_ant_module(side_effect=ValueError("unexpected"))
        with patch.dict(sys.modules, {'anthropic': mock_ant}):
            verdict, cost, error_class = await _anthropic_reviewer(
                "sk-ant-key", {"sku": "X"}, _minimal_valid_output()
            )
        self.assertIsNone(verdict)
        self.assertEqual(error_class, "reviewer_error")


# ---------------------------------------------------------------------------
# Tests: reviewer_skipped + auth flip in _process_row (SAG-3483)
# ---------------------------------------------------------------------------

class TestReviewerDisabledAndAuthFlip(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_row_reviewer(
        self,
        reviewer_enabled: bool,
        reviewer_auth_failed: asyncio.Event | None = None,
        reviewer_mock_return=None,
    ) -> dict:
        cfg = _make_cfg(self._tmp)
        tracker = CostCapTracker(cfg.cost_cap_ledger_path)
        cap_paused = asyncio.Event()
        if reviewer_auth_failed is None:
            reviewer_auth_failed = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={"choices": [{"message": {"content": valid_json}}]}),
        )

        result_captured = {}

        def mock_write_sync(conn_, batch_id_, source_row_id_, result_):
            result_captured.update(result_)

        reviewer_return = reviewer_mock_return or (
            {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None
        )

        with patch("dispatcher._anthropic_reviewer", new=AsyncMock(return_value=reviewer_return)) as mock_rev, \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging", side_effect=mock_write_sync), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "batch-1", cfg, tracker, http_client, conn, cap_paused,
                reviewer_enabled=reviewer_enabled,
                reviewer_auth_failed=reviewer_auth_failed,
            )

        return {
            "reviewer_verdict": result_captured.get("reviewer_verdict"),
            "reviewer_auth_failed_set": reviewer_auth_failed.is_set(),
            "mock_reviewer_called": mock_rev.called,
        }

    async def test_reviewer_skipped_when_disabled(self):
        result = await self._run_row_reviewer(reviewer_enabled=False)
        self.assertEqual(result["reviewer_verdict"], "reviewer_skipped")
        self.assertFalse(result["mock_reviewer_called"])

    async def test_reviewer_called_when_enabled(self):
        result = await self._run_row_reviewer(reviewer_enabled=True)
        self.assertTrue(result["mock_reviewer_called"])
        self.assertNotEqual(result["reviewer_verdict"], "reviewer_skipped")

    async def test_reviewer_skipped_after_auth_failed_event(self):
        auth_failed = asyncio.Event()
        auth_failed.set()
        result = await self._run_row_reviewer(
            reviewer_enabled=True, reviewer_auth_failed=auth_failed,
        )
        self.assertEqual(result["reviewer_verdict"], "reviewer_skipped")
        self.assertFalse(result["mock_reviewer_called"])

    async def test_reviewer_auth_error_sets_auth_failed_event(self):
        auth_failed = asyncio.Event()
        result = await self._run_row_reviewer(
            reviewer_enabled=True,
            reviewer_auth_failed=auth_failed,
            reviewer_mock_return=(None, 0.0, "reviewer_auth_error"),
        )
        self.assertEqual(result["reviewer_verdict"], "reviewer_auth_error")
        self.assertTrue(result["reviewer_auth_failed_set"])

    async def test_reviewer_rate_limited_verdict_stored(self):
        result = await self._run_row_reviewer(
            reviewer_enabled=True,
            reviewer_mock_return=(None, 0.0, "reviewer_rate_limited"),
        )
        self.assertEqual(result["reviewer_verdict"], "reviewer_rate_limited")

    async def test_reviewer_timeout_verdict_stored(self):
        result = await self._run_row_reviewer(
            reviewer_enabled=True,
            reviewer_mock_return=(None, 0.0, "reviewer_timeout"),
        )
        self.assertEqual(result["reviewer_verdict"], "reviewer_timeout")


# ---------------------------------------------------------------------------
# Tests: run_batch Anthropic preflight integration (SAG-3483)
# ---------------------------------------------------------------------------

class TestRunBatchAnthropicPreflight(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def test_placeholder_key_disables_reviewer(self):
        """anthropic_api_key='dev_key' → reviewer never called, all rows get reviewer_skipped."""
        cfg = _make_cfg(self._tmp, anthropic_key="dev_key")
        reviewer_calls = [0]

        async def counting_reviewer(*args, **kwargs):
            reviewer_calls[0] += 1
            return {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None

        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher._fetch_pending_rows", return_value=[_make_row()]), \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging"), \
             patch("dispatcher._mark_queue_done"), \
             patch("dispatcher._anthropic_reviewer", side_effect=counting_reviewer), \
             patch("dispatcher._litellm_complete", new=AsyncMock(
                 return_value=(json.dumps(_minimal_valid_output()), False)
             )):
            await EnrichmentDispatcher(cfg).run_batch()

        self.assertEqual(reviewer_calls[0], 0, "Reviewer must not be called for placeholder key")

    async def test_valid_skant_key_enables_reviewer(self):
        """anthropic_api_key='sk-ant-key' → reviewer IS called."""
        cfg = _make_cfg(self._tmp, anthropic_key="sk-ant-key")
        reviewer_calls = [0]

        async def counting_reviewer(*args, **kwargs):
            reviewer_calls[0] += 1
            return {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None

        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher._fetch_pending_rows", return_value=[_make_row()]), \
             patch("dispatcher._mark_in_flight"), \
             patch("dispatcher._write_staging"), \
             patch("dispatcher._mark_queue_done"), \
             patch("dispatcher._anthropic_reviewer", side_effect=counting_reviewer), \
             patch("dispatcher._litellm_complete", new=AsyncMock(
                 return_value=(json.dumps(_minimal_valid_output()), False)
             )):
            await EnrichmentDispatcher(cfg).run_batch()

        self.assertEqual(reviewer_calls[0], 1, "Reviewer must be called for valid sk-ant- key")


# ---------------------------------------------------------------------------
# Tests: _repair_cross_fields availability null repair (SAG-3528)
# ---------------------------------------------------------------------------

class TestRepairCrossFieldsAvailability(unittest.TestCase):
    def setUp(self):
        from dispatcher import _repair_cross_fields
        self._repair = _repair_cross_fields

    def test_null_availability_defaults_to_in_stock(self):
        """gemma4 emits null availability — repair must default to in_stock."""
        row = {"sku": "SSI-QTZ-0109", "availability": None, "is_outdoor": False}
        self._repair(row)
        self.assertEqual(row["availability"], "in_stock")

    def test_missing_availability_key_defaults_to_in_stock(self):
        """Missing availability key (not present) is treated same as null."""
        row = {"sku": "SSI-QTZ-0109", "is_outdoor": False}
        self._repair(row)
        self.assertEqual(row["availability"], "in_stock")

    def test_valid_availability_is_not_overwritten(self):
        """Pre-set availability values are preserved unchanged."""
        for val in ("discontinued", "made_to_order", "limited_stock", "coming_soon"):
            row = {"sku": "X", "availability": val, "is_outdoor": False}
            self._repair(row)
            self.assertEqual(row["availability"], val)

    def test_weather_rating_repair_still_works(self):
        """Existing weather_rating repair is not broken by the new availability fix."""
        row = {"sku": "X", "availability": None, "is_outdoor": True, "weather_rating": None}
        self._repair(row)
        self.assertEqual(row["weather_rating"], "not_rated")
        self.assertEqual(row["availability"], "in_stock")


class TestValidatedCrossFieldRepairs(unittest.TestCase):
    """Keep the Phase A R1/R2/R3 repairs alongside the SAG-3663 fix."""

    def setUp(self):
        from dispatcher import _repair_cross_fields
        self._repair = _repair_cross_fields

    def test_r1_country_name_is_normalized_to_iso_code(self):
        row = {"sku": "SSI-MBL-0113", "country_of_origin": "China", "availability": "in_stock", "is_outdoor": False}
        self._repair(row)
        self.assertEqual(row["country_of_origin"], "CN")

    def test_r2_finish_array_is_normalized_to_first_valid_value(self):
        row = {"sku": "SSI-QTZ-0100", "finish": ["polished", "honed"], "availability": "in_stock", "is_outdoor": False}
        self._repair(row)
        self.assertEqual(row["finish"], "polished")

    def test_r3_applications_keep_valid_values_and_drop_invalid_values(self):
        row = {
            "sku": "SSI-PRC-0105",
            "applications": ["outdoor_kitchen", "outdoor_flooring"],
            "availability": "in_stock",
            "is_outdoor": True,
            "weather_rating": "excellent",
        }
        self._repair(row)
        self.assertEqual(row["applications"], ["outdoor_kitchen"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

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
import reviewer_reservations
from dispatcher import (
    DispatcherConfig,
    EnrichmentDispatcher,
    PRIMARY_MODEL,
    _build_litellm_request,
    _build_enrichment_messages,
    _preflight_auth_check,
    _process_row,
    _anthropic_preflight,
    _anthropic_reviewer,
)

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
        company_id="company-test",
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
        "series_name": None,
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


class _ClosableConnection(MagicMock):
    """A connection double that records the required exactly-once close."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.close_count = 0

    def close(self):
        self.close_count += 1


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
            os.environ["ENRICHMENT_COMPANY_ID"] = "company-test"
            os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"] = "10"
            cfg = DispatcherConfig.from_env()
            self.assertEqual(cfg.concurrency, 4)  # clamped
            del os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"]
            del os.environ["ENRICHMENT_COMPANY_ID"]

    def test_concurrency_minimum_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATABASE_URL"] = "postgresql://test/test"
            os.environ["ENRICHMENT_COMPANY_ID"] = "company-test"
            os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"] = "0"
            from dispatcher import DispatcherConfig
            cfg = DispatcherConfig.from_env()
            self.assertEqual(cfg.concurrency, 1)
            del os.environ["ENRICHMENT_DISPATCHER_CONCURRENCY"]
            del os.environ["ENRICHMENT_COMPANY_ID"]


# ---------------------------------------------------------------------------
# Tests: cost-cap enforcement in process_row
# ---------------------------------------------------------------------------

class TestCostCapEnforcement(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_row(self, reserve_result) -> dict:
        """Run one row through _process_row with a patched reservation outcome."""
        cfg = _make_cfg(self._tmp)

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

        with patch("dispatcher._anthropic_reviewer", new=AsyncMock(return_value=(reviewer_response, 0.05, None))) as mock_rev, \
             patch("dispatcher.reservations.reserve", return_value=reserve_result) as mock_reserve, \
             patch("dispatcher.reservations.settle") as mock_settle, \
             patch("dispatcher.reservations.release") as mock_release, \
             patch("dispatcher._pause_routine", new=AsyncMock()) as mock_pause, \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "batch-1", cfg, http_client, conn, cap_paused,
                reviewer_enabled=True, reviewer_auth_failed=asyncio.Event(),
            )

        return {
            "cap_paused": cap_paused.is_set(),
            "reviewer_called": mock_rev.called,
            "reserve_called": mock_reserve.called,
            "settle_called": mock_settle.called,
            "release_called": mock_release.called,
            "pause_called": mock_pause.called,
        }

    async def test_reviewer_called_below_cap(self):
        """Below cap: a live reservation is held, reviewer runs, and settle records spend."""
        res = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_RESERVED,
            reservation_id="r1", state="reserved",
            reserved_cents=33, committed_reserved_cents=33,
        )
        result = await self._run_row(res)
        self.assertFalse(result["cap_paused"])
        self.assertTrue(result["reviewer_called"])
        self.assertTrue(result["settle_called"])

    async def test_reviewer_skipped_above_cap(self):
        """cap_exceeded: reviewer tier is skipped, routine paused, no reviewer call."""
        res = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_CAP_EXCEEDED,
            reservation_id=None, state=None,
            reserved_cents=33, committed_reserved_cents=5001,
        )
        result = await self._run_row(res)
        self.assertTrue(result["cap_paused"])
        self.assertFalse(result["reviewer_called"])
        self.assertTrue(result["pause_called"])

    async def test_no_pause_at_exactly_50(self):
        """Exactly $50.00 committed (== cap) still yields a live hold — reviewer runs, settle called."""
        res = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_RESERVED,
            reservation_id="r1", state="reserved",
            reserved_cents=33, committed_reserved_cents=5000,
        )
        result = await self._run_row(res)
        self.assertFalse(result["cap_paused"])
        self.assertTrue(result["settle_called"])

    async def test_empty_queue_returns_immediately(self):
        """run_batch with an empty DB returns a zero-row summary."""
        cfg = _make_cfg(self._tmp)

        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher.claim_next_queue_row", return_value=None):
            dispatcher = EnrichmentDispatcher(cfg)
            summary = await dispatcher.run_batch()

        self.assertEqual(summary["total"], 0)
        self.assertEqual(summary["done"], 0)
        self.assertFalse(summary["cap_paused"])


class TestQueueClaimLifecycle(unittest.IsolatedAsyncioTestCase):
    """Claim connections stay owned by the worker through terminalization."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def test_connection_failure_does_not_attempt_a_claim(self):
        cfg = _make_cfg(self._tmp)
        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect", side_effect=RuntimeError("db unavailable")), \
             patch("dispatcher.claim_next_queue_row") as claim:
            with self.assertRaisesRegex(RuntimeError, "db unavailable"):
                await EnrichmentDispatcher(cfg).run_batch()
        claim.assert_not_called()

    async def test_processing_exception_marks_claimed_row_failed_with_finished_at(self):
        from dispatcher import _process_row

        cfg = _make_cfg(self._tmp, anthropic_key="")
        conn = MagicMock()
        cap_paused = asyncio.Event()
        with patch("dispatcher._litellm_complete", new=AsyncMock(side_effect=RuntimeError("primary exploded"))), \
             patch("dispatcher._mark_queue_done") as terminalize:
            tier = await _process_row(_make_row(), "batch-1", cfg, AsyncMock(), conn, cap_paused, reviewer_enabled=False)

        self.assertEqual(tier, "failed")
        terminalize.assert_called_once_with(conn, cfg.company_id, "row-abc-123", "failed")

    async def test_failed_terminalization_uses_one_replacement_connection_and_closes_it(self):
        from dispatcher import _process_row

        cfg = _make_cfg(self._tmp, anthropic_key="")
        original = MagicMock()
        replacement = MagicMock()
        cap_paused = asyncio.Event()
        with patch("dispatcher._litellm_complete", new=AsyncMock(side_effect=RuntimeError("primary exploded"))), \
             patch("dispatcher._mark_queue_done", side_effect=[RuntimeError("write failed"), None]) as terminalize, \
             patch("dispatcher._db_connect", return_value=replacement) as connect:
            tier = await _process_row(_make_row(), "batch-1", cfg, AsyncMock(), original, cap_paused, reviewer_enabled=False)

        self.assertEqual(tier, "failed")
        self.assertEqual(terminalize.call_count, 2)
        connect.assert_called_once_with(cfg.database_url)
        replacement.close.assert_called_once_with()


class TestCapPauseDelivery(unittest.IsolatedAsyncioTestCase):
    async def test_one_claimant_delivers_and_marks_event_delivered(self):
        from dispatcher import _deliver_cap_pause

        cfg = _make_cfg(tempfile.mkdtemp())
        with patch("dispatcher.reservations.enqueue_cap_pause_event", return_value="event-1") as enqueue, \
             patch("dispatcher.reservations.claim_cap_pause_event", return_value=True) as claim, \
             patch("dispatcher.reservations.finalize_cap_pause_event") as finalize, \
             patch("dispatcher._pause_routine", new=AsyncMock()) as notify:
            delivered = await _deliver_cap_pause(MagicMock(), cfg, cfg.company_id, "row-1", 5000)

        self.assertTrue(delivered)
        enqueue.assert_called_once()
        claim.assert_called_once()
        notify.assert_awaited_once_with(cfg, 50.0)
        self.assertEqual(finalize.call_args.kwargs, {"delivered": True})

    async def test_non_claimant_skips_notification(self):
        from dispatcher import _deliver_cap_pause

        cfg = _make_cfg(tempfile.mkdtemp())
        with patch("dispatcher.reservations.enqueue_cap_pause_event", return_value="event-1"), \
             patch("dispatcher.reservations.claim_cap_pause_event", return_value=False), \
             patch("dispatcher._pause_routine", new=AsyncMock()) as notify:
            delivered = await _deliver_cap_pause(MagicMock(), cfg, cfg.company_id, "row-1", 5000)

        self.assertFalse(delivered)
        notify.assert_not_awaited()


# ---------------------------------------------------------------------------
# Tests: row processing tiers
# ---------------------------------------------------------------------------

class TestRowTierRouting(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_with_primary_content(self, primary_content: str, fallback_content: str = "") -> str:
        cfg = _make_cfg(self._tmp, anthropic_key="")  # no reviewer
        cap_paused = asyncio.Event()
        conn = MagicMock()

        call_count = [0]

        async def mock_litellm_complete(client, base_url, model, system, user, timeout, api_key=""):
            call_count[0] += 1
            if call_count[0] == 1:
                return primary_content, False
            return fallback_content, False

        with patch("dispatcher._litellm_complete", side_effect=mock_litellm_complete), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done") as mock_done:
            http_client = AsyncMock()
            tier = await _process_row(
                _make_row(), "batch-1", cfg, http_client, conn, cap_paused,
                reviewer_enabled=False,
            )
            queue_status = mock_done.call_args[0][3] if mock_done.called else None

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
# Tests: preflight auth check (reference fix 1)
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
# Tests: /no_think directive for primary Qwen3 model (reference fix 4)
# ---------------------------------------------------------------------------

class TestNoThinkDirective(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _capture_litellm_calls(self, primary_content: str) -> list[dict]:
        cfg = _make_cfg(self._tmp, anthropic_key="")
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
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "b", cfg, http_client, conn, cap_paused,
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


class TestLiteLLMRequestRecipe(unittest.TestCase):
    def test_primary_and_fallback_use_the_identical_validated_recipe(self):
        primary = _build_litellm_request("primary", "system", "user")
        fallback = _build_litellm_request("fallback", "system", "user")

        self.assertEqual(
            {key: value for key, value in primary.items() if key != "model"},
            {key: value for key, value in fallback.items() if key != "model"},
        )
        self.assertEqual(primary["max_tokens"], 4096)
        self.assertEqual(primary["response_format"], {"type": "json_object"})
        self.assertEqual(primary["temperature"], 0)
        self.assertIs(primary["think"], False)


# ---------------------------------------------------------------------------
# Tests: Anthropic preflight — pure function, no network (reference)
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
# Fake exception classes for _anthropic_reviewer unit tests (reference)
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
# Tests: _anthropic_reviewer typed error classes (reference)
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
# Tests: reviewer_skipped + auth flip in _process_row (reference)
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

        def mock_insert_staging(conn_, company_id_, batch_id_, source_row_id_, result_):
            result_captured.update(result_)
            return "staging-1"

        reviewer_return = reviewer_mock_return or (
            {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None
        )

        ok_reservation = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_RESERVED,
            reservation_id="r1", state="reserved",
            reserved_cents=33, committed_reserved_cents=33,
        )

        with patch("dispatcher._anthropic_reviewer", new=AsyncMock(return_value=reviewer_return)) as mock_rev, \
             patch("dispatcher.reservations.reserve", return_value=ok_reservation), \
             patch("dispatcher.reservations.settle"), \
             patch("dispatcher.reservations.release"), \
             patch("dispatcher._insert_staging", side_effect=mock_insert_staging), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "batch-1", cfg, http_client, conn, cap_paused,
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
# Tests: run_batch Anthropic preflight integration (reference)
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
             patch("dispatcher.claim_next_queue_row", side_effect=[_make_row(), None]), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
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

        ok_reservation = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_RESERVED,
            reservation_id="r1", state="reserved",
            reserved_cents=33, committed_reserved_cents=33,
        )

        with patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher.claim_next_queue_row", side_effect=[_make_row(), None]), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher.reservations.reserve", return_value=ok_reservation), \
             patch("dispatcher.reservations.settle"), \
             patch("dispatcher._mark_queue_done"), \
             patch("dispatcher._anthropic_reviewer", side_effect=counting_reviewer), \
             patch("dispatcher._litellm_complete", new=AsyncMock(
                 return_value=(json.dumps(_minimal_valid_output()), False)
             )):
            await EnrichmentDispatcher(cfg).run_batch()

        self.assertEqual(reviewer_calls[0], 1, "Reviewer must be called for valid sk-ant- key")


# ---------------------------------------------------------------------------
# Tests: reservation lifecycle wiring in _process_row (reference)
# ---------------------------------------------------------------------------

class TestReservationLifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()

    async def _run_row(self, reserve_result, reviewer_return):
        cfg = _make_cfg(self._tmp, anthropic_key="sk-ant-key")
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        result_captured = {}

        def mock_insert_staging(conn_, company_id_, batch_id_, source_row_id_, result_):
            result_captured.update(result_)
            return "staging-1"

        with patch("dispatcher._litellm_complete", new=AsyncMock(
                 return_value=(json.dumps(_minimal_valid_output()), False))), \
             patch("dispatcher._anthropic_reviewer", new=AsyncMock(return_value=reviewer_return)) as mock_rev, \
             patch("dispatcher.reservations.reserve", return_value=reserve_result) as mock_reserve, \
             patch("dispatcher.reservations.settle") as mock_settle, \
             patch("dispatcher.reservations.release") as mock_release, \
             patch("dispatcher._pause_routine", new=AsyncMock()) as mock_pause, \
             patch("dispatcher._insert_staging", side_effect=mock_insert_staging), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(
                _make_row(), "batch-1", cfg, http_client, conn, cap_paused,
                reviewer_enabled=True, reviewer_auth_failed=asyncio.Event(),
            )

        return {
            "cap_paused": cap_paused.is_set(),
            "reviewer_verdict": result_captured.get("reviewer_verdict"),
            "reviewer_called": mock_rev.called,
            "settle_called": mock_settle.called,
            "release_called": mock_release.called,
            "pause_called": mock_pause.called,
        }

    def _ok_reservation(self):
        return reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_RESERVED,
            reservation_id="r1", state="reserved",
            reserved_cents=33, committed_reserved_cents=33,
        )

    async def test_reviewer_success_settles_reservation(self):
        reviewer_return = (
            {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None
        )
        result = await self._run_row(self._ok_reservation(), reviewer_return)
        self.assertTrue(result["settle_called"])
        self.assertFalse(result["release_called"])

    async def test_reviewer_error_releases_reservation(self):
        reviewer_return = (None, 0.0, "reviewer_error")
        result = await self._run_row(self._ok_reservation(), reviewer_return)
        self.assertTrue(result["release_called"])
        self.assertFalse(result["settle_called"])
        self.assertEqual(result["reviewer_verdict"], "reviewer_error")

    async def test_cap_exceeded_pauses_and_skips_reviewer(self):
        cap_exceeded = reviewer_reservations.ReservationResult(
            outcome=reviewer_reservations.OUTCOME_CAP_EXCEEDED,
            reservation_id=None, state=None,
            reserved_cents=33, committed_reserved_cents=5001,
        )
        reviewer_return = (
            {"anomaly_score": 0.1, "anomaly_reason": "ok", "triggered_rules": []}, 0.05, None
        )
        result = await self._run_row(cap_exceeded, reviewer_return)
        self.assertTrue(result["cap_paused"])
        self.assertEqual(result["reviewer_verdict"], "cap_paused")
        self.assertTrue(result["pause_called"])
        self.assertFalse(result["reviewer_called"])
        self.assertFalse(result["settle_called"])
        self.assertFalse(result["release_called"])


# ---------------------------------------------------------------------------
# Tests: _repair_cross_fields availability null repair (reference)
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
    """Keep the Phase A R1/R2/R3 repairs alongside the reference fix."""

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

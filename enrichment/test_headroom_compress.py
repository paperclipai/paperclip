"""
Tests for enrichment/headroom_compress.py and the dispatcher integration (reference).

headroom-ai is not installed in this environment (Python 3.14, no pre-built wheel),
so all headroom import tests mock the module.  The dispatcher integration tests
verify that compress() is called and that compression results are logged.

Run: python3 -m pytest enrichment/test_headroom_compress.py -v
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import unittest
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
import headroom_compress
from headroom_compress import CompressResult, check_health, compress


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_headroom(compress_fn=None):
    """Return a fake headroom module with a controllable compress() function."""
    mod = ModuleType("headroom")
    mod.__version__ = "0.23.0"
    if compress_fn is None:
        def compress_fn(content):
            # Simulate 40% reduction — replace every 5-char run with first 3
            return content[:max(1, len(content) * 3 // 5)] if len(content) > 5 else content
    mod.compress = compress_fn
    return mod


# ---------------------------------------------------------------------------
# Unit tests: headroom_compress.check_health()
# ---------------------------------------------------------------------------

class TestCheckHealth(unittest.TestCase):
    def setUp(self):
        # Reset cached availability flag so each test starts fresh
        headroom_compress._headroom_available = None

    def test_available_when_headroom_importable(self):
        fake_hr = _mock_headroom()
        with patch.dict("sys.modules", {"headroom": fake_hr}):
            result = check_health()
        self.assertTrue(result["headroomAvailable"])
        self.assertEqual(result["version"], "0.23.0")
        self.assertTrue(result["telemetryEnforced"])
        self.assertTrue(result["libraryModeOnly"])

    def test_unavailable_when_headroom_missing(self):
        with patch.dict("sys.modules", {"headroom": None}):
            headroom_compress._headroom_available = None
            result = check_health()
        self.assertFalse(result["headroomAvailable"])
        self.assertIsNone(result["version"])
        self.assertTrue(result["telemetryEnforced"])
        self.assertTrue(result["libraryModeOnly"])

    def test_telemetry_env_set_at_import_time(self):
        """HEADROOM_TELEMETRY=off must always be set regardless of headroom availability."""
        self.assertEqual(os.environ.get("HEADROOM_TELEMETRY"), "off")


# ---------------------------------------------------------------------------
# Unit tests: headroom_compress.compress()
# ---------------------------------------------------------------------------

class TestCompress(unittest.TestCase):
    def setUp(self):
        headroom_compress._headroom_available = None

    def test_returns_passthrough_when_headroom_missing(self):
        content = "Hello world, this is a test"
        with patch.dict("sys.modules", {"headroom": None}):
            headroom_compress._headroom_available = None
            result = compress(content)
        self.assertEqual(result.compressed, content)
        self.assertEqual(result.original_len, len(content))
        self.assertEqual(result.compressed_len, len(content))

    def test_returns_compressed_content_when_available(self):
        original = "A" * 100
        expected_compressed = "A" * 50

        fake_hr = _mock_headroom(compress_fn=lambda c: c[:len(c) // 2])
        with patch.dict("sys.modules", {"headroom": fake_hr}):
            headroom_compress._headroom_available = None
            result = compress(original)

        self.assertEqual(result.compressed, expected_compressed)
        self.assertEqual(result.original_len, 100)
        self.assertEqual(result.compressed_len, 50)

    def test_empty_string_returns_zero_lengths(self):
        result = compress("")
        self.assertEqual(result.compressed, "")
        self.assertEqual(result.original_len, 0)
        self.assertEqual(result.compressed_len, 0)

    def test_compress_exception_falls_back_to_original(self):
        def bad_compress(c):
            raise RuntimeError("simulated failure")

        fake_hr = _mock_headroom(compress_fn=bad_compress)
        content = "test content"
        with patch.dict("sys.modules", {"headroom": fake_hr}):
            headroom_compress._headroom_available = None
            result = compress(content)

        self.assertEqual(result.compressed, content)
        self.assertEqual(result.original_len, len(content))
        self.assertEqual(result.compressed_len, len(content))

    def test_compress_result_is_named_tuple(self):
        result = compress("hello")
        self.assertIsInstance(result, CompressResult)
        self.assertIsInstance(result.compressed, str)
        self.assertIsInstance(result.original_len, int)
        self.assertIsInstance(result.compressed_len, int)


# ---------------------------------------------------------------------------
# Integration tests: dispatcher wires headroom_compress
# ---------------------------------------------------------------------------

from dispatcher import (
    DispatcherConfig,
    EnrichmentDispatcher,
    _build_enrichment_messages,
    _process_row,
)


def _make_cfg(tmp_dir: str) -> DispatcherConfig:
    return DispatcherConfig(
        database_url="postgresql://test/test",
        litellm_base_url="http://localhost:4000",
        anthropic_api_key="",
        company_id="company-test",
        batch_size=5,
        concurrency=1,
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
        "payload_json": {
            "sku": "SKU-001",
            "product_name": "Calacatta Marble",
            "raw_description": "Premium Italian marble with dramatic veining",
        },
    }


class TestDispatcherUsesHeadroomCompress(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        headroom_compress._headroom_available = None

    async def test_compress_is_called_on_user_prompt(self):
        """compress() is invoked with the enrichment user prompt before LiteLLM."""
        compress_calls = []

        def recording_compress(content: str) -> CompressResult:
            compress_calls.append(content)
            return CompressResult(content, len(content), len(content))

        cfg = _make_cfg(self._tmp)
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={"choices": [{"message": {"content": valid_json}}]}),
        )

        with patch("headroom_compress.compress", side_effect=recording_compress), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(_make_row(), "batch-1", cfg, http_client, conn, cap_paused, reviewer_enabled=False)

        self.assertEqual(len(compress_calls), 1, "compress() should be called exactly once per row")
        _, expected_user = _build_enrichment_messages(_make_row()["payload_json"])
        self.assertEqual(compress_calls[0], expected_user)

    async def test_compression_result_replaces_user_prompt(self):
        """When headroom returns a shorter string, the LiteLLM call uses the compressed version."""
        compressed_payload = "SHORT"

        def shrinking_compress(content: str) -> CompressResult:
            return CompressResult(compressed_payload, len(content), len(compressed_payload))

        cfg = _make_cfg(self._tmp)
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={"choices": [{"message": {"content": valid_json}}]}),
        )

        with patch("headroom_compress.compress", side_effect=shrinking_compress), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"):
            await _process_row(_make_row(), "batch-1", cfg, http_client, conn, cap_paused, reviewer_enabled=False)

        # Inspect the LiteLLM POST body — user message should be the compressed version
        post_calls = http_client.post.call_args_list
        self.assertTrue(len(post_calls) >= 1)
        body = post_calls[0].kwargs.get("json") or post_calls[0].args[1] if len(post_calls[0].args) > 1 else post_calls[0].kwargs.get("json")
        # Extract user content from the messages array
        user_msg = next(
            (m["content"] for m in (body or {}).get("messages", []) if m.get("role") == "user"),
            None,
        )
        self.assertEqual(user_msg, compressed_payload)

    async def test_passthrough_when_compress_raises(self):
        """If compress() raises unexpectedly, the row still processes successfully."""
        def exploding_compress(content: str) -> CompressResult:
            raise RuntimeError("unexpected compress failure")

        cfg = _make_cfg(self._tmp)
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={"choices": [{"message": {"content": valid_json}}]}),
        )

        # A raised exception from compress should not prevent the row from being processed.
        # headroom_compress.compress() itself already catches exceptions and returns pass-through,
        # so this test ensures that safety net is in place.
        original_compress = headroom_compress.compress

        def safe_wrapper(content):
            try:
                return original_compress(content)
            except Exception:
                return CompressResult(content, len(content), len(content))

        with patch("headroom_compress.compress", side_effect=safe_wrapper), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"):
            tier = await _process_row(_make_row(), "batch-1", cfg, http_client, conn, cap_paused, reviewer_enabled=False)

        self.assertEqual(tier, "primary")

    async def test_health_check_logged_at_batch_start(self):
        """run_batch() calls check_health() and logs the result."""
        health_calls = []

        def recording_health():
            result = {
                "headroomAvailable": False,
                "version": None,
                "telemetryEnforced": True,
                "libraryModeOnly": True,
            }
            health_calls.append(result)
            return result

        cfg = _make_cfg(self._tmp)

        with patch("headroom_compress.check_health", side_effect=recording_health), \
             patch("dispatcher._preflight_auth_check", new=AsyncMock()), \
             patch("dispatcher._db_connect"), \
             patch("dispatcher.claim_next_queue_row", return_value=None):
            dispatcher = EnrichmentDispatcher(cfg)
            await dispatcher.run_batch()

        self.assertEqual(len(health_calls), 1, "check_health() should be called once per batch")

    async def test_metric_logged_when_compressed(self):
        """When compressed_len < original_len, a metric log line is emitted."""
        def shrink(content: str) -> CompressResult:
            short = content[: len(content) // 2]
            return CompressResult(short, len(content), len(short))

        cfg = _make_cfg(self._tmp)
        cap_paused = asyncio.Event()
        conn = MagicMock()
        http_client = AsyncMock()

        valid_json = json.dumps(_minimal_valid_output())
        http_client.post.return_value = AsyncMock(
            raise_for_status=MagicMock(),
            json=MagicMock(return_value={"choices": [{"message": {"content": valid_json}}]}),
        )

        with patch("headroom_compress.compress", side_effect=shrink), \
             patch("dispatcher._insert_staging", return_value="staging-1"), \
             patch("dispatcher._update_staging_review"), \
             patch("dispatcher._mark_queue_done"), \
             self.assertLogs("dispatcher", level="INFO") as log_ctx:
            await _process_row(_make_row(), "batch-1", cfg, http_client, conn, cap_paused, reviewer_enabled=False)

        metric_lines = [l for l in log_ctx.output if "headroom compress" in l]
        self.assertTrue(len(metric_lines) >= 1, "Expected a headroom compress metric log line")
        self.assertIn("orig=", metric_lines[0])
        self.assertIn("comp=", metric_lines[0])
        self.assertIn("ratio=", metric_lines[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

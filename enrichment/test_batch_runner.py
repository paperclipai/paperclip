"""
Unit tests for batch_runner.py — reference / reference.

Verifies: summary comment format, Paperclip API calls, exit codes,
terminal states, typed error classes, SKIPPED_LOCKED record emission,
and secret sanitizer (GOVERNANCE §5).
No DB, LiteLLM, or Anthropic calls.

Run: python3 -m pytest enrichment/test_batch_runner.py -v
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
import batch_runner
from batch_runner import _build_comment, _load_dotenv, run
from dispatcher import DispatcherConfig


# ---------------------------------------------------------------------------
# _build_comment
# ---------------------------------------------------------------------------

class TestBuildComment(unittest.TestCase):
    _started = datetime(2026, 5, 24, 2, 0, 0, tzinfo=timezone.utc)
    _finished = datetime(2026, 5, 24, 2, 0, 30, tzinfo=timezone.utc)

    def _comment(self, **summary_overrides):
        base = {"total": 10, "done": 10, "failed": 0, "cap_paused": False}
        base.update(summary_overrides)
        return _build_comment(base, self._started, self._finished)

    def test_success_message_present(self):
        c = self._comment()
        self.assertIn("10/10 rows enriched successfully", c)

    def test_empty_queue_message(self):
        c = self._comment(total=0, done=0, failed=0)
        self.assertIn("queue empty", c)

    def test_partial_failure_message(self):
        c = self._comment(total=10, done=8, failed=2)
        self.assertIn("8/10 enriched", c)
        self.assertIn("2 failed", c)

    def test_total_failure_message(self):
        c = self._comment(total=5, done=0, failed=5)
        self.assertIn("FAILED", c)

    def test_cap_paused_warning_present(self):
        c = self._comment(cap_paused=True)
        self.assertIn("cost cap hit", c.lower())
        self.assertIn("control-plane task", c)

    def test_cap_not_paused_no_warning(self):
        c = self._comment(cap_paused=False)
        self.assertNotIn("auto-paused", c)

    def test_duration_in_comment(self):
        c = self._comment()
        self.assertIn("30.0s", c)

    def test_terminal_state_in_comment(self):
        c = self._comment(terminal_state="ALL_ENRICHED")
        self.assertIn("ALL_ENRICHED", c)

    def test_terminal_state_defaults_to_unknown_when_absent(self):
        c = self._comment()  # no terminal_state key
        self.assertIn("unknown", c)


# ---------------------------------------------------------------------------
# run() — happy path and error path
# ---------------------------------------------------------------------------

class TestRunFunction(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._lock_path = pathlib.Path(tempfile.mkdtemp()) / "test_batch_runner.lock"
        self._lock_patch = patch.object(batch_runner, "_LOCK_PATH", self._lock_path)
        self._lock_patch.start()
        self.addCleanup(self._lock_patch.stop)

    def _env(self, **overrides) -> dict:
        base = {
            "DATABASE_URL": "postgresql://test/test",
            "ENRICHMENT_COMPANY_ID": "company-test",
            "ENRICHMENT_ESCALATION_ASSIGNEE_ID": "operator-agent",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
        }
        base.update(overrides)
        return base

    async def _run_with_summary(self, summary: dict) -> int:
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)) as mock_mark, \
             patch("batch_runner._emit_terminal_record"):
            instance = MockDisp.return_value
            instance.run_batch = AsyncMock(return_value=summary)
            code = await run()
        return code

    async def test_success_returns_zero(self):
        code = await self._run_with_summary(
            {"total": 5, "done": 5, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(code, 0)

    async def test_empty_queue_returns_zero(self):
        code = await self._run_with_summary(
            {"total": 0, "done": 0, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(code, 0)

    async def test_enabled_mode_fails_closed_when_shim_is_unavailable(self):
        with patch.dict(
            os.environ,
            self._env(OPENSH_SANDBOX_ENABLED="1", OPENSH_SANDBOX_IMAGE="registry/image:1"),
            clear=False,
        ), patch.object(batch_runner, "_OPENSH_AVAILABLE", False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=True)), \
             patch("batch_runner._emit_terminal_record"):
            code = await run()

        self.assertEqual(code, 1)
        MockDisp.assert_not_called()

    async def test_dispatcher_exception_returns_one(self):
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=True)), \
             patch("batch_runner._emit_terminal_record"):
            instance = MockDisp.return_value
            instance.run_batch = AsyncMock(side_effect=RuntimeError("db gone"))
            code = await run()
        self.assertEqual(code, 1)

    async def test_mark_issue_done_called_on_success(self):
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)) as mock_mark, \
             patch("batch_runner._emit_terminal_record"):
            instance = MockDisp.return_value
            instance.run_batch = AsyncMock(
                return_value={"total": 3, "done": 3, "failed": 0, "cap_paused": False}
            )
            await run()

        mock_mark.assert_awaited_once()
        _, _, _, issue_id, comment = mock_mark.call_args.args
        self.assertEqual(issue_id, "issue-abc")
        self.assertIn("3/3 rows enriched", comment)

    async def test_skips_api_when_task_id_missing(self):
        env = self._env()
        env.pop("PAPERCLIP_TASK_ID", None)
        with patch.dict(os.environ, env, clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)) as mock_mark, \
             patch("batch_runner._emit_terminal_record"):
            os.environ.pop("PAPERCLIP_TASK_ID", None)
            instance = MockDisp.return_value
            instance.run_batch = AsyncMock(
                return_value={"total": 0, "done": 0, "failed": 0, "cap_paused": False}
            )
            await run()
        mock_mark.assert_not_awaited()


# ---------------------------------------------------------------------------
# reference — single-runner flock guard
# ---------------------------------------------------------------------------

class TestSingleRunnerGuard(unittest.IsolatedAsyncioTestCase):
    """Verify the flock guard prevents concurrent drainers (reference)."""

    def _make_lock_path(self) -> pathlib.Path:
        fd, name = tempfile.mkstemp(suffix=".lock")
        os.close(fd)
        return pathlib.Path(name)

    def test_try_acquire_lock_returns_fd_when_free(self):
        lock_path = self._make_lock_path()
        lock_path.unlink(missing_ok=True)
        try:
            with patch.object(batch_runner, "_LOCK_PATH", lock_path):
                fd = batch_runner._try_acquire_lock()
            self.assertIsNotNone(fd, "_try_acquire_lock must return an fd when uncontested")
            batch_runner._release_lock(fd)
        finally:
            lock_path.unlink(missing_ok=True)

    def test_try_acquire_lock_returns_none_when_held(self):
        lock_path = self._make_lock_path()
        holder = open(lock_path, "w")
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with patch.object(batch_runner, "_LOCK_PATH", lock_path):
                fd = batch_runner._try_acquire_lock()
            self.assertIsNone(fd, "_try_acquire_lock must return None when another process holds it")
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            holder.close()
            lock_path.unlink(missing_ok=True)

    async def test_run_exits_zero_without_dispatcher_when_lock_held(self):
        """When lock is already held, run() returns 0 and never touches the dispatcher."""
        lock_path = self._make_lock_path()
        holder = open(lock_path, "w")
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            env = {
                "DATABASE_URL": "postgresql://test/test",
                "ENRICHMENT_COMPANY_ID": "company-test",
                "PAPERCLIP_API_URL": "http://localhost:3100",
                "PAPERCLIP_API_KEY": "fake-key",
                "PAPERCLIP_RUN_ID": "run-xyz",
                "PAPERCLIP_TASK_ID": "issue-abc",
            }
            with patch.object(batch_runner, "_LOCK_PATH", lock_path), \
                 patch.dict(os.environ, env, clear=False), \
                 patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
                 patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
                 patch("batch_runner._emit_terminal_record"):
                code = await run()

            MockDisp.assert_not_called()
            self.assertEqual(code, 0)
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            holder.close()
            lock_path.unlink(missing_ok=True)

    async def test_run_releases_lock_after_success(self):
        """Lock must be released after a normal run so the next invocation can acquire it."""
        lock_path = self._make_lock_path()
        lock_path.unlink(missing_ok=True)
        env = {
            "DATABASE_URL": "postgresql://test/test",
            "ENRICHMENT_COMPANY_ID": "company-test",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
        }
        try:
            with patch.object(batch_runner, "_LOCK_PATH", lock_path), \
                 patch.dict(os.environ, env, clear=False), \
                 patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
                 patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
                 patch("batch_runner._emit_terminal_record"):
                instance = MockDisp.return_value
                instance.run_batch = AsyncMock(
                    return_value={"total": 1, "done": 1, "failed": 0, "cap_paused": False}
                )
                await run()

            # After run() completes, the lock must be releasable
            fd = open(lock_path, "w")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                acquired = False
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                fd.close()

            self.assertTrue(acquired, "Lock must be released after run() completes")
        finally:
            lock_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# reference — terminal states (LES §1 part 4)
# ---------------------------------------------------------------------------

class TestTerminalStates(unittest.IsolatedAsyncioTestCase):
    """Each TerminalState must be reachable; terminal record must carry the state name."""

    def setUp(self):
        self._lock_path = pathlib.Path(tempfile.mkdtemp()) / "test_batch_runner.lock"
        self._lock_patch = patch.object(batch_runner, "_LOCK_PATH", self._lock_path)
        self._lock_patch.start()
        self.addCleanup(self._lock_patch.stop)

    def _env(self):
        return {
            "DATABASE_URL": "postgresql://test/test",
            "ENRICHMENT_COMPANY_ID": "company-test",
            "ENRICHMENT_ESCALATION_ASSIGNEE_ID": "operator-agent",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
        }

    async def _run_and_capture(
        self,
        summary: dict | None = None,
        exc: Exception | None = None,
    ) -> "tuple[int, dict]":
        """Run with a mocked dispatcher; return (exit_code, emitted_terminal_record)."""
        captured: list[dict] = []

        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=True)), \
             patch("batch_runner._emit_terminal_record", side_effect=captured.append):
            instance = MockDisp.return_value
            if exc is not None:
                instance.run_batch = AsyncMock(side_effect=exc)
            else:
                instance.run_batch = AsyncMock(return_value=summary)
            code = await run()

        self.assertEqual(len(captured), 1, "exactly one terminal record must be emitted per run")
        return code, captured[0]

    async def test_empty_queue(self):
        code, rec = await self._run_and_capture(
            {"total": 0, "done": 0, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(code, 0)
        self.assertEqual(rec["terminal_state"], "EMPTY_QUEUE")

    async def test_all_enriched(self):
        code, rec = await self._run_and_capture(
            {"total": 5, "done": 5, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(code, 0)
        self.assertEqual(rec["terminal_state"], "ALL_ENRICHED")

    async def test_partial(self):
        code, rec = await self._run_and_capture(
            {"total": 5, "done": 3, "failed": 2, "cap_paused": False}
        )
        self.assertEqual(code, 0)
        self.assertEqual(rec["terminal_state"], "PARTIAL")

    async def test_all_failed(self):
        code, rec = await self._run_and_capture(
            {"total": 5, "done": 0, "failed": 5, "cap_paused": False}
        )
        self.assertEqual(code, 0)
        self.assertEqual(rec["terminal_state"], "ALL_FAILED")

    async def test_dispatcher_error(self):
        code, rec = await self._run_and_capture(exc=RuntimeError("something went wrong"))
        self.assertEqual(code, 1)
        self.assertEqual(rec["terminal_state"], "DISPATCHER_ERROR")

    async def test_skipped_locked_emits_record(self):
        """SKIPPED_LOCKED must emit a terminal record, not exit silently (reference)."""
        _, lock_name = tempfile.mkstemp(suffix=".lock")
        lock_path = pathlib.Path(lock_name)
        holder = open(lock_path, "w")
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        captured: list[dict] = []
        try:
            with patch.object(batch_runner, "_LOCK_PATH", lock_path), \
                 patch.dict(os.environ, self._env(), clear=False), \
                 patch("batch_runner._emit_terminal_record", side_effect=captured.append):
                code = await run()

            self.assertEqual(code, 0)
            self.assertEqual(len(captured), 1, "SKIPPED_LOCKED must emit exactly one terminal record")
            self.assertEqual(captured[0]["terminal_state"], "SKIPPED_LOCKED")
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            holder.close()
            lock_path.unlink(missing_ok=True)

    async def test_terminal_record_fields_present(self):
        """Terminal record must carry all required §5 fields."""
        _, rec = await self._run_and_capture(
            {"total": 2, "done": 2, "failed": 0, "cap_paused": False}
        )
        required_fields = {
            "batch_id", "started_at", "finished_at", "terminal_state",
            "total", "done", "failed", "cap_paused", "error_class",
            "comment_posted", "runner_pid", "run_id",
        }
        self.assertEqual(required_fields, required_fields & rec.keys())

    async def test_terminal_record_is_json_serializable(self):
        """Terminal record must be JSON-serializable (no MagicMock or non-serializable types)."""
        _, rec = await self._run_and_capture(
            {"total": 1, "done": 1, "failed": 0, "cap_paused": False}
        )
        # Should not raise
        json.dumps(rec)


# ---------------------------------------------------------------------------
# reference — typed error classes
# ---------------------------------------------------------------------------

class TestClassifyDispatcherError(unittest.TestCase):
    """Unit tests for _classify_dispatcher_error()."""

    def _http_status_error(self, status_code: int) -> "httpx.HTTPStatusError":
        import httpx
        response = MagicMock()
        response.status_code = status_code
        return httpx.HTTPStatusError(
            f"HTTP {status_code}", request=MagicMock(), response=response
        )

    def test_http_401_is_auth(self):
        import httpx
        self.assertEqual(
            batch_runner._classify_dispatcher_error(self._http_status_error(401)), "auth"
        )

    def test_http_403_is_auth(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(self._http_status_error(403)), "auth"
        )

    def test_unauthorized_keyword_is_auth(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(RuntimeError("unauthorized request")), "auth"
        )

    def test_connect_error_is_network(self):
        import httpx
        self.assertEqual(
            batch_runner._classify_dispatcher_error(httpx.ConnectError("refused")), "network"
        )

    def test_connection_refused_is_network(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(ConnectionRefusedError("refused")), "network"
        )

    def test_timeout_keyword_is_network(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(RuntimeError("connection timeout after 30s")), "network"
        )

    def test_database_keyword_is_db(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(RuntimeError("database connection refused")), "db"
        )

    def test_psycopg_keyword_is_db(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(RuntimeError("psycopg error: ssl connection")), "db"
        )

    def test_runtime_error_is_unknown(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(RuntimeError("something weird happened")), "unknown"
        )

    def test_value_error_is_unknown(self):
        self.assertEqual(
            batch_runner._classify_dispatcher_error(ValueError("bad value")), "unknown"
        )


class TestErrorClassInRecord(unittest.IsolatedAsyncioTestCase):
    """error_class must be set in the terminal record for DISPATCHER_ERROR paths."""

    def setUp(self):
        self._lock_path = pathlib.Path(tempfile.mkdtemp()) / "test_batch_runner.lock"
        self._lock_patch = patch.object(batch_runner, "_LOCK_PATH", self._lock_path)
        self._lock_patch.start()
        self.addCleanup(self._lock_patch.stop)

    def _env(self):
        return {
            "DATABASE_URL": "postgresql://test/test",
            "ENRICHMENT_COMPANY_ID": "company-test",
            "ENRICHMENT_ESCALATION_ASSIGNEE_ID": "operator-agent",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
        }

    async def _run_exc(self, exc: Exception) -> dict:
        captured: list[dict] = []
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=False)), \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=False)), \
             patch("batch_runner._emit_terminal_record", side_effect=captured.append):
            MockDisp.return_value.run_batch = AsyncMock(side_effect=exc)
            await run()
        return captured[0]

    async def test_auth_error_class_http_401(self):
        import httpx
        response = MagicMock()
        response.status_code = 401
        exc = httpx.HTTPStatusError("Unauthorized", request=MagicMock(), response=response)
        rec = await self._run_exc(exc)
        self.assertEqual(rec["error_class"], "auth")

    async def test_network_error_class_connect_refused(self):
        rec = await self._run_exc(ConnectionRefusedError("ECONNREFUSED"))
        self.assertEqual(rec["error_class"], "network")

    async def test_db_error_class_keyword(self):
        rec = await self._run_exc(RuntimeError("database connection failed: psycopg error"))
        self.assertEqual(rec["error_class"], "db")

    async def test_unknown_error_class(self):
        rec = await self._run_exc(RuntimeError("something completely unexpected"))
        self.assertEqual(rec["error_class"], "unknown")

    async def test_runtime_config_error_still_terminalizes_once(self):
        captured: list[dict] = []
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.DispatcherConfig.from_env", side_effect=ValueError("missing sandbox image")), \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=False)), \
             patch("batch_runner._emit_terminal_record", side_effect=captured.append):
            code = await run()
        self.assertEqual(code, 1)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["terminal_state"], "DISPATCHER_ERROR")
        self.assertEqual(captured[0]["error_class"], "unknown")

    async def test_comment_posted_false_when_mark_fails(self):
        rec = await self._run_exc(RuntimeError("whoops"))
        self.assertFalse(rec["comment_posted"])

    async def test_comment_posted_true_when_mark_succeeds(self):
        captured: list[dict] = []
        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
             patch("batch_runner._emit_terminal_record", side_effect=captured.append):
            MockDisp.return_value.run_batch = AsyncMock(
                return_value={"total": 1, "done": 1, "failed": 0, "cap_paused": False}
            )
            await run()
        self.assertTrue(captured[0]["comment_posted"])


# ---------------------------------------------------------------------------
# reference — secret sanitizer (GOVERNANCE §5)
# ---------------------------------------------------------------------------

class TestSecretSanitizer(unittest.TestCase):
    """_sanitize_message must strip secrets; terminal record must never contain them."""

    def test_litellm_api_key_redacted(self):
        key = "sk-super-secret-litellm-12345"
        with patch.dict(os.environ, {"LITELLM_API_KEY": key}):
            sanitized = batch_runner._sanitize_message(f"request failed: key={key}")
        self.assertNotIn(key, sanitized)
        self.assertIn("[REDACTED]", sanitized)

    def test_anthropic_api_key_redacted(self):
        key = "ant-super-secret-67890"
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": key}):
            sanitized = batch_runner._sanitize_message(f"auth error: {key} rejected")
        self.assertNotIn(key, sanitized)
        self.assertIn("[REDACTED]", sanitized)

    def test_database_url_password_redacted(self):
        db_url = "postgresql://paperclip:my-secret-pass@localhost:54329/paperclip"
        sanitized = batch_runner._sanitize_message(db_url)
        self.assertNotIn("my-secret-pass", sanitized)
        self.assertIn("[REDACTED]", sanitized)

    def test_postgres_variant_password_redacted(self):
        db_url = "postgres://user:another-pass@host:5432/db"
        sanitized = batch_runner._sanitize_message(db_url)
        self.assertNotIn("another-pass", sanitized)

    def test_clean_message_unchanged(self):
        msg = "connection timeout after 30s"
        self.assertEqual(batch_runner._sanitize_message(msg), msg)

    def test_empty_env_vars_no_change(self):
        with patch.dict(os.environ, {"LITELLM_API_KEY": "", "ANTHROPIC_API_KEY": ""}):
            msg = "some harmless message"
            self.assertEqual(batch_runner._sanitize_message(msg), msg)

    def test_multiple_secrets_all_redacted(self):
        key = "sk-multi-12345"
        with patch.dict(os.environ, {"LITELLM_API_KEY": key}):
            msg = f"first {key} second {key}"
            sanitized = batch_runner._sanitize_message(msg)
        self.assertNotIn(key, sanitized)


class TestSecretNotInTerminalRecord(unittest.IsolatedAsyncioTestCase):
    """Terminal record must never contain secret values even when they appear in the exception."""

    async def test_secret_not_in_record_on_dispatcher_error(self):
        api_key_val = "sk-test-secret-litellm-abc"
        anthropic_val = "ant-test-secret-xyz-789"
        db_url = "postgresql://user:db-password-secret@localhost:5432/db"

        env = {
            "LITELLM_API_KEY": api_key_val,
            "ANTHROPIC_API_KEY": anthropic_val,
            "DATABASE_URL": db_url,
            "ENRICHMENT_COMPANY_ID": "company-test",
            "ENRICHMENT_ESCALATION_ASSIGNEE_ID": "operator-agent",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
        }
        captured: list[dict] = []

        with patch.dict(os.environ, env, clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=False)), \
             patch("batch_runner._mark_issue_blocked", new=AsyncMock(return_value=False)), \
             patch("batch_runner._emit_terminal_record", side_effect=captured.append):
            MockDisp.return_value.run_batch = AsyncMock(
                side_effect=RuntimeError(
                    f"request failed api_key={api_key_val} url={db_url}"
                )
            )
            await run()

        self.assertEqual(len(captured), 1)
        record_str = json.dumps(captured[0])
        self.assertNotIn(api_key_val, record_str,
                         "LITELLM_API_KEY must not appear in terminal record")
        self.assertNotIn(anthropic_val, record_str,
                         "ANTHROPIC_API_KEY must not appear in terminal record")
        self.assertNotIn("db-password-secret", record_str,
                         "DATABASE_URL password must not appear in terminal record")


# ---------------------------------------------------------------------------
# _load_dotenv — reference
# ---------------------------------------------------------------------------

class TestLoadDotenv(unittest.TestCase):
    def test_populates_missing_database_url_and_config_succeeds(self):
        """Loader sets DATABASE_URL from .env when absent; DispatcherConfig.from_env does not raise."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False) as f:
            f.write("DATABASE_URL=postgresql://user:pass@localhost/testdb\n")
            tmp_path = f.name
        try:
            with patch.dict(os.environ, {"ENRICHMENT_COMPANY_ID": "company-test"}, clear=False):
                os.environ.pop("DATABASE_URL", None)
                _load_dotenv(tmp_path)
                self.assertEqual(os.environ["DATABASE_URL"], "postgresql://user:pass@localhost/testdb")
                cfg = DispatcherConfig.from_env()
                self.assertEqual(cfg.database_url, "postgresql://user:pass@localhost/testdb")
        finally:
            os.unlink(tmp_path)

    def test_does_not_overwrite_existing_database_url(self):
        """Existing DATABASE_URL in os.environ wins; .env value is silently ignored."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".env", delete=False) as f:
            f.write("DATABASE_URL=postgresql://from-file/db\n")
            tmp_path = f.name
        try:
            original = "postgresql://from-env/existing"
            with patch.dict(os.environ, {"DATABASE_URL": original}, clear=False):
                _load_dotenv(tmp_path)
                self.assertEqual(os.environ["DATABASE_URL"], original)
        finally:
            os.unlink(tmp_path)

    def test_missing_env_file_is_noop(self):
        """Missing .env file is a no-op — no exception raised."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            _load_dotenv("/nonexistent/__does_not_exist__.env")  # must not raise
            self.assertNotIn("DATABASE_URL", os.environ)


# ---------------------------------------------------------------------------
# reference — loud-fail guardrail: auth-failed/ALL_FAILED must block→CTO, never done
# ---------------------------------------------------------------------------

class TestLoudFailGuardrail(unittest.IsolatedAsyncioTestCase):
    """Failed runs must route to the configured assignee, never mark done."""

    ESCALATION_ASSIGNEE_ID = "operator-agent"

    def setUp(self):
        self._lock_path = pathlib.Path(tempfile.mkdtemp()) / "test_batch_runner.lock"
        self._lock_patch = patch.object(batch_runner, "_LOCK_PATH", self._lock_path)
        self._lock_patch.start()
        self.addCleanup(self._lock_patch.stop)

    def _env(self, **overrides) -> dict:
        base = {
            "DATABASE_URL": "postgresql://test/test",
            "ENRICHMENT_COMPANY_ID": "company-test",
            "PAPERCLIP_API_URL": "http://localhost:3100",
            "PAPERCLIP_API_KEY": "fake-key",
            "PAPERCLIP_RUN_ID": "run-xyz",
            "PAPERCLIP_TASK_ID": "issue-abc",
            "ENRICHMENT_ESCALATION_ASSIGNEE_ID": self.ESCALATION_ASSIGNEE_ID,
        }
        base.update(overrides)
        return base

    async def _run_with_exc(self, exc: Exception) -> "tuple[list, list]":
        blocked_calls: list[dict] = []
        done_calls: list = []

        async def mock_blocked(api_url, api_key, run_id, issue_id, comment, assignee_id):
            blocked_calls.append({"issue_id": issue_id, "assignee_id": assignee_id, "comment": comment})
            return True

        async def mock_done(*args, **kwargs):
            done_calls.append(args)
            return True

        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_blocked", new=mock_blocked), \
             patch("batch_runner._mark_issue_done", new=mock_done), \
             patch("batch_runner._emit_terminal_record"):
            MockDisp.return_value.run_batch = AsyncMock(side_effect=exc)
            await run()
        return blocked_calls, done_calls

    async def _run_with_summary(self, summary: dict) -> "tuple[list[dict], list]":
        blocked_calls: list[dict] = []
        done_calls: list = []

        async def mock_blocked(api_url, api_key, run_id, issue_id, comment, assignee_id):
            blocked_calls.append({"issue_id": issue_id, "assignee_id": assignee_id, "comment": comment})
            return True

        async def mock_done(*args, **kwargs):
            done_calls.append(args)
            return True

        with patch.dict(os.environ, self._env(), clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_blocked", new=mock_blocked), \
             patch("batch_runner._mark_issue_done", new=mock_done), \
             patch("batch_runner._emit_terminal_record"):
            MockDisp.return_value.run_batch = AsyncMock(return_value=summary)
            await run()
        return blocked_calls, done_calls

    async def test_dispatcher_error_auth_http401_blocks_not_done(self):
        import httpx
        response = MagicMock()
        response.status_code = 401
        exc = httpx.HTTPStatusError("Unauthorized", request=MagicMock(), response=response)
        blocked, done = await self._run_with_exc(exc)
        self.assertEqual(len(blocked), 1, "_mark_issue_blocked must be called once")
        self.assertEqual(len(done), 0, "_mark_issue_done must NOT be called")
        self.assertEqual(blocked[0]["issue_id"], "issue-abc")
        self.assertEqual(blocked[0]["assignee_id"], self.ESCALATION_ASSIGNEE_ID)
        self.assertIn("LITELLM_API_KEY", blocked[0]["comment"])

    async def test_dispatcher_error_auth_keyword_mentions_local_board(self):
        exc = RuntimeError("unauthorized request failed")
        blocked, done = await self._run_with_exc(exc)
        self.assertEqual(len(blocked), 1)
        self.assertEqual(len(done), 0)
        self.assertIn("LITELLM_API_KEY", blocked[0]["comment"])
        self.assertIn("local-board", blocked[0]["comment"])

    async def test_dispatcher_error_non_auth_blocks_to_cto(self):
        exc = RuntimeError("database connection failed")
        blocked, done = await self._run_with_exc(exc)
        self.assertEqual(len(blocked), 1)
        self.assertEqual(len(done), 0)
        self.assertEqual(blocked[0]["assignee_id"], self.ESCALATION_ASSIGNEE_ID)

    async def test_dispatcher_error_comment_names_terminal_state_and_error_class(self):
        import httpx
        response = MagicMock()
        response.status_code = 401
        exc = httpx.HTTPStatusError("Unauthorized", request=MagicMock(), response=response)
        blocked, _ = await self._run_with_exc(exc)
        self.assertEqual(len(blocked), 1)
        comment = blocked[0]["comment"]
        self.assertIn("DISPATCHER_ERROR", comment)
        self.assertIn("auth", comment)

    async def test_all_failed_blocks_to_cto_never_done(self):
        blocked, done = await self._run_with_summary(
            {"total": 5, "done": 0, "failed": 5, "cap_paused": False}
        )
        self.assertEqual(len(blocked), 1, "ALL_FAILED must call _mark_issue_blocked")
        self.assertEqual(len(done), 0, "_mark_issue_done must NOT be called for ALL_FAILED")
        self.assertEqual(blocked[0]["assignee_id"], self.ESCALATION_ASSIGNEE_ID)

    async def test_all_enriched_calls_done_not_blocked(self):
        blocked, done = await self._run_with_summary(
            {"total": 5, "done": 5, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(len(blocked), 0, "ALL_ENRICHED must NOT call _mark_issue_blocked")
        self.assertEqual(len(done), 1, "ALL_ENRICHED must call _mark_issue_done")

    async def test_empty_queue_calls_done_not_blocked(self):
        blocked, done = await self._run_with_summary(
            {"total": 0, "done": 0, "failed": 0, "cap_paused": False}
        )
        self.assertEqual(len(blocked), 0, "EMPTY_QUEUE must NOT call _mark_issue_blocked")
        self.assertEqual(len(done), 1)

    async def test_partial_calls_done_not_blocked(self):
        blocked, done = await self._run_with_summary(
            {"total": 5, "done": 3, "failed": 2, "cap_paused": False}
        )
        self.assertEqual(len(blocked), 0, "PARTIAL must NOT call _mark_issue_blocked")
        self.assertEqual(len(done), 1)

    async def test_secret_not_in_blocked_comment(self):
        api_key_val = "sk-super-secret-litellm-54321"
        env = self._env()
        env["LITELLM_API_KEY"] = api_key_val
        blocked_calls: list[dict] = []

        async def mock_blocked(api_url, api_key, run_id, issue_id, comment, assignee_id):
            blocked_calls.append({"comment": comment})
            return True

        with patch.dict(os.environ, env, clear=False), \
             patch("batch_runner.EnrichmentDispatcher") as MockDisp, \
             patch("batch_runner._mark_issue_blocked", new=mock_blocked), \
             patch("batch_runner._mark_issue_done", new=AsyncMock(return_value=True)), \
             patch("batch_runner._emit_terminal_record"):
            MockDisp.return_value.run_batch = AsyncMock(
                side_effect=RuntimeError(f"401 Unauthorized key={api_key_val}")
            )
            await run()

        self.assertEqual(len(blocked_calls), 1)
        self.assertNotIn(api_key_val, blocked_calls[0]["comment"])


class TestSandboxedDispatcherCommand(unittest.IsolatedAsyncioTestCase):
    def test_summary_parser_uses_final_valid_json_line(self):
        summary = batch_runner._parse_dispatcher_summary(
            "untrusted log line\n{\"total\": 2, \"done\": 2, \"failed\": 0, \"cap_paused\": false}\n"
        )
        self.assertEqual(summary, {"total": 2, "done": 2, "failed": 0, "cap_paused": False})

    def test_summary_parser_rejects_inconsistent_output(self):
        with self.assertRaisesRegex(RuntimeError, "valid summary"):
            batch_runner._parse_dispatcher_summary(
                '{"total": 2, "done": 1, "failed": 0, "cap_paused": false}'
            )

    async def test_sandboxed_path_uses_the_canonical_dispatcher_command(self):
        shim = MagicMock()
        shim.run.return_value = subprocess.CompletedProcess(
            [], 0, stdout='{"total": 1, "done": 1, "failed": 0, "cap_paused": false}\n', stderr=""
        )

        summary = await batch_runner._run_sandboxed_dispatcher(shim)

        self.assertEqual(summary["done"], 1)
        self.assertEqual(shim.run.call_args.args[0][1:], ["-m", "enrichment.dispatcher"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Tests for docker/claude/rh-memory-hook (TECH-8410, TECH-8416).

Run: python3 -m unittest discover -s docker/claude -p 'test_*.py'
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None  # type: ignore[assignment]

_PATH = Path(__file__).with_name("rh-memory-hook")
_loader = importlib.machinery.SourceFileLoader("rh_memory_hook", str(_PATH))
_spec = importlib.util.spec_from_loader("rh_memory_hook", _loader)
assert _spec is not None
hook = importlib.util.module_from_spec(_spec)
_loader.exec_module(hook)

ENV = {"RH_MEMORY_TOKEN": "tok", "RH_MEMORY_URL": "https://mem.example.com/"}


def _transcript(entries: list[dict]) -> str:
    handle = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    with handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
    return handle.name


class RecallTest(unittest.TestCase):
    def test_noop_without_token(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "what did we decide?"}))
        post.assert_not_called()

    def test_requires_https_url(self) -> None:
        env = {"RH_MEMORY_TOKEN": "tok", "RH_MEMORY_URL": "http://mem.example"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "what did we decide?"}))
        post.assert_not_called()

    def test_returns_additional_context(self) -> None:
        results = {"results": [{"memory": "Dan prefers  short\nanswers", "score": 0.9}, {"memory": ""}]}
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_PROXY": "http://127.0.0.1:1055"}, clear=True), \
                mock.patch.object(hook, "_post", return_value=results) as post:
            out = json.loads(hook.recall({"prompt": "  how should I answer?  "}) or "{}")
        url, path, token, proxy, body, _timeout = post.call_args.args
        self.assertEqual((url, path, token, proxy), ("https://mem.example.com", "/search", "tok", "http://127.0.0.1:1055"))
        self.assertEqual(body, {"query": "how should I answer?", "top_k": 5})
        spec = out["hookSpecificOutput"]
        self.assertEqual(spec["hookEventName"], "UserPromptSubmit")
        self.assertIn("- Dan prefers short answers", spec["additionalContext"])

    def test_no_output_when_nothing_found(self) -> None:
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook, "_post", return_value={"results": []}):
            self.assertIsNone(hook.recall({"prompt": "anything new?"}))

    def test_trivial_prompt_skipped(self) -> None:
        with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(hook, "_post") as post:
            self.assertIsNone(hook.recall({"prompt": "ok"}))
        post.assert_not_called()

    def test_recall_unaffected_when_capture_is_off(self) -> None:
        results = {"results": [{"memory": "Dan prefers short answers", "score": 0.9}]}
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_CAPTURE": "off"}, clear=True), \
                mock.patch.object(hook, "_post", return_value=results) as post:
            out = json.loads(hook.recall({"prompt": "how should I answer?"}) or "{}")
        self.assertIn("- Dan prefers short answers", out["hookSpecificOutput"]["additionalContext"])
        post.assert_called_once()

    def test_main_fails_open(self) -> None:
        stdin = io.StringIO(json.dumps({"prompt": "what did we decide?"}))
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook, "_post", side_effect=OSError("unreachable")), \
                mock.patch("sys.stdin", stdin), mock.patch("sys.stdout", stdout):
            self.assertEqual(hook.main(["rh-memory-hook", "recall"]), 0)
        self.assertEqual(stdout.getvalue(), "")


class LastExchangeTest(unittest.TestCase):
    def test_picks_last_prompt_and_following_text(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "old question"}},
            {"message": {"role": "assistant", "content": [{"type": "text", "text": "old answer"}]}},
            {"isMeta": True, "message": {"role": "user", "content": "<system note>"}},
            {"message": {"role": "user", "content": "Use Postgres for the cache"}},
            {"message": {"role": "assistant", "content": [
                {"type": "text", "text": "Switching to Postgres."},
                {"type": "tool_use", "name": "Edit", "input": {}},
            ]}},
            {"message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
            {"message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}},
            "not a dict",
        ])
        self.assertEqual(hook.last_exchange(path), [
            {"role": "user", "content": "Use Postgres for the cache"},
            {"role": "assistant", "content": "Switching to Postgres.\nDone."},
        ])

    def test_empty_without_assistant_reply(self) -> None:
        path = _transcript([{"message": {"role": "user", "content": "hello there"}}])
        self.assertEqual(hook.last_exchange(path), [])


class CaptureTest(unittest.TestCase):
    def test_noop_without_token(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(hook.os, "fork") as fork:
            hook.capture({"transcript_path": "/nonexistent"})
        fork.assert_not_called()

    def test_disabled_by_rh_memory_capture_env(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "remember this"}},
            {"message": {"role": "assistant", "content": "ok"}},
        ])
        for val in ("off", "false", "0", "no", "OFF", " off "):
            with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_CAPTURE": val}, clear=True), \
                    mock.patch.object(hook.os, "fork") as fork, \
                    mock.patch.object(hook, "_post") as post:
                hook.capture({"transcript_path": path})
                fork.assert_not_called()
                post.assert_not_called()

    def test_disabled_by_rh_memory_capture_env_codex_format(self) -> None:
        event = {"transcript_path": _codex_rollout(), "turn_id": "t1"}
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_CAPTURE": "off"}, clear=True), \
                mock.patch.object(hook.os, "fork") as fork, \
                mock.patch.object(hook, "_post") as post:
            hook.capture(event, "codex")
            fork.assert_not_called()
            post.assert_not_called()

    def test_capture_enabled_when_unset_or_other_values(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "remember this"}},
            {"message": {"role": "assistant", "content": "ok"}},
        ])
        for val in (None, "on", "1", "true", "garbage", "ON", " yes "):
            env = dict(ENV)
            if val is not None:
                env["RH_MEMORY_CAPTURE"] = val
            with mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(hook.os, "fork", return_value=1234) as fork, \
                    mock.patch.object(hook, "_post") as post:
                hook.capture({"transcript_path": path})
                fork.assert_called_once()
                post.assert_not_called()  # Parent returns immediately after fork

    def test_parent_returns_after_fork(self) -> None:
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", return_value=1234), \
                mock.patch.object(hook, "last_exchange") as parse, \
                mock.patch.object(hook, "_post") as post:
            hook.capture({"transcript_path": "/some/transcript.jsonl"})
        parse.assert_not_called()  # transcript work happens only in the child
        post.assert_not_called()

    def test_child_posts_exchange(self) -> None:
        path = _transcript([
            {"message": {"role": "user", "content": "remember the deploy window is Tuesday"}},
            {"message": {"role": "assistant", "content": "Noted."}},
        ])
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", return_value=0), \
                mock.patch.object(hook.os, "setsid"), \
                mock.patch.object(hook, "_detach_stdio") as detach, \
                mock.patch.object(hook.os, "_exit", side_effect=SystemExit) as exit_, \
                mock.patch.object(hook, "_post") as post:
            with self.assertRaises(SystemExit):
                hook.capture({"transcript_path": path})
        exit_.assert_called_once_with(0)
        detach.assert_called_once_with()  # child releases Claude's stdio pipes
        _url, path_arg, _token, _proxy, body, _timeout = post.call_args.args
        self.assertEqual(path_arg, "/memories")
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant"])


def _codex_rollout(turn: str = "t1") -> str:
    def item(kind: str, text: str, turn_id: str = turn) -> dict:
        return {"type": "event_msg", "payload": {
            "type": "item_completed", "turn_id": turn_id,
            "item": {"type": kind, "id": "x", "content": [{"type": "text" if kind == "UserMessage" else "Text", "text": text}]},
        }}
    return _transcript([
        {"type": "session_meta", "payload": {}},
        {"type": "response_item", "payload": {"type": "message", "role": "developer",
                                              "content": [{"type": "input_text", "text": "Notes recalled: secret"}]}},
        item("UserMessage", "old question", "t0"),
        item("AgentMessage", "old answer", "t0"),
        item("UserMessage", "Use Postgres for the cache"),
        item("AgentMessage", "Switching to Postgres."),
        item("AgentMessage", "Done."),
        "not a dict",
        {"type": "event_msg", "payload": "bad"},
    ])


class CodexLastExchangeTest(unittest.TestCase):
    def test_reads_only_the_named_turn_and_skips_injected_context(self) -> None:
        self.assertEqual(hook.codex_last_exchange(_codex_rollout(), "t1"), [
            {"role": "user", "content": "Use Postgres for the cache"},
            {"role": "assistant", "content": "Switching to Postgres.\nDone."},
        ])

    def test_without_turn_id_uses_last_prompt(self) -> None:
        out = hook.codex_last_exchange(_codex_rollout())
        self.assertEqual(out[0]["content"], "Use Postgres for the cache")

    def test_falls_back_to_last_assistant_message(self) -> None:
        path = _transcript([{"type": "event_msg", "payload": {
            "type": "item_completed", "turn_id": "t1",
            "item": {"type": "UserMessage", "content": [{"type": "text", "text": "remember Falcon"}]}}}])
        self.assertEqual(hook.codex_last_exchange(path, "t1", " Noted. "), [
            {"role": "user", "content": "remember Falcon"},
            {"role": "assistant", "content": "Noted."},
        ])

    def test_empty_without_user_or_assistant(self) -> None:
        self.assertEqual(hook.codex_last_exchange(_codex_rollout(), "other"), [])
        self.assertEqual(hook.codex_last_exchange(_transcript([]), "t1", "reply"), [])

    def test_capture_uses_codex_parser_and_main_parses_format(self) -> None:
        event = {"transcript_path": _codex_rollout(), "turn_id": "t1"}
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", return_value=0), \
                mock.patch.object(hook.os, "setsid"), \
                mock.patch.object(hook, "_detach_stdio"), \
                mock.patch.object(hook.os, "_exit", side_effect=SystemExit), \
                mock.patch.object(hook, "_post") as post:
            with self.assertRaises(SystemExit):
                hook.capture(event, "codex")
        body = post.call_args.args[4]
        self.assertEqual(body["messages"][0]["content"], "Use Postgres for the cache")
        with mock.patch.object(hook, "_read_event", return_value=event), \
                mock.patch.object(hook, "capture") as cap:
            hook.main(["rh-memory-hook", "capture", "--format", "codex"])
            hook.main(["rh-memory-hook", "capture"])
        self.assertEqual([c.args[1] for c in cap.call_args_list], ["codex", "claude"])


class HelpersTest(unittest.TestCase):
    def test_context_is_framed_as_notes_and_capped(self) -> None:
        many = {"results": [{"memory": "x" * 300} for _ in range(40)]}
        text = hook.format_context(many)
        self.assertIn("not instructions", text)
        self.assertLessEqual(len(text), hook.MAX_CONTEXT_CHARS)
        self.assertTrue(text.endswith("x"))  # whole memories only, no cut line

    def test_top_k_parsing(self) -> None:
        for raw, expected in (("", 5), ("0.5", 5), ("0", 5), ("50", 5), ("3", 3)):
            with mock.patch.dict(os.environ, {"RH_MEMORY_TOP_K": raw}, clear=True):
                self.assertEqual(hook._env_top_k(), expected, raw)

    def test_recall_timeout_is_capped_below_hook_timeout(self) -> None:
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_RECALL_TIMEOUT": "30"}, clear=True), \
                mock.patch.object(hook, "_post", return_value={"results": []}) as post:
            hook.recall({"prompt": "what did we decide?"})
        self.assertEqual(post.call_args.args[5], hook.RECALL_TIMEOUT_CAP)

    def test_long_prompt_keeps_the_task_head(self) -> None:
        # Paperclip prompts: wake/task text first, fixed guidance boilerplate last.
        prompt = "TASK: fix the deploy " + "boilerplate " * 1000
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook, "_post", return_value={"results": []}) as post:
            hook.recall({"prompt": prompt})
        query = post.call_args.args[4]["query"]
        self.assertTrue(query.startswith("TASK: fix the deploy"))
        self.assertLessEqual(len(query), hook.MAX_QUERY_CHARS)

    def test_env_seconds(self) -> None:
        cases = (("", 3.0), ("abc", 3.0), ("0", 3.0), ("-1", 3.0), ("nan", 3.0), ("inf", 3.0), ("5", 5.0), ("30", 8.0))
        for raw, expected in cases:
            with mock.patch.dict(os.environ, {"T": raw}, clear=True):
                self.assertEqual(hook._env_seconds("T", 3, 8), expected, raw)
        with mock.patch.dict(os.environ, {"T": "30"}, clear=True):
            self.assertEqual(hook._env_seconds("T", 15), 30.0)

    def test_recall_overall_deadline(self) -> None:
        import time

        def slow(*_args: object) -> None:
            time.sleep(5)

        stdin = io.StringIO(json.dumps({"prompt": "what did we decide?"}))
        with mock.patch.dict(os.environ, {**ENV, "RH_MEMORY_RECALL_TIMEOUT": "0.2"}, clear=True), \
                mock.patch.object(hook, "_post", side_effect=slow), \
                mock.patch("sys.stdin", stdin), mock.patch("sys.stdout", io.StringIO()) as out, \
                mock.patch("sys.stderr", io.StringIO()):
            start = time.monotonic()
            self.assertEqual(hook.main(["rh-memory-hook", "recall"]), 0)
            self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(out.getvalue(), "")

    def test_detach_stdio_points_fds_at_devnull(self) -> None:
        import subprocess
        import sys

        code = (
            "import importlib.machinery as m, importlib.util as u, os, sys;"
            f"l=m.SourceFileLoader('h', {str(_PATH)!r}); s=u.spec_from_loader('h', l); h=u.module_from_spec(s); l.exec_module(h);"
            "h._detach_stdio(); print('leak'); sys.stderr.write('leak')"
        )
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
        self.assertEqual((done.stdout, done.stderr), ("", ""))

    def test_main_capture_fails_open(self) -> None:
        stdin = io.StringIO(json.dumps({"transcript_path": "/x"}))
        with mock.patch.dict(os.environ, ENV, clear=True), \
                mock.patch.object(hook.os, "fork", side_effect=OSError("no fork")), \
                mock.patch("sys.stdin", stdin), mock.patch("sys.stderr", io.StringIO()) as err:
            self.assertEqual(hook.main(["rh-memory-hook", "capture"]), 0)
        self.assertEqual(err.getvalue(), "rh-memory-hook capture: OSError\n")

    def test_post_round_trip(self) -> None:
        import http.server
        import threading

        seen: dict = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                seen["path"] = self.path
                seen["key"] = self.headers.get("X-API-Key")
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                data = b'{"results": [{"memory": "m"}]}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.handle_request, daemon=True).start()
        try:
            with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:9"}, clear=True):
                out = hook._post(f"http://127.0.0.1:{server.server_port}", "/search", "tok", None, {"query": "q"}, 5)
        finally:
            server.server_close()
        self.assertEqual(out, {"results": [{"memory": "m"}]})
        self.assertEqual(seen, {"path": "/search", "key": "tok", "body": {"query": "q"}})


class ManagedSettingsTest(unittest.TestCase):
    def test_auto_memory_is_disabled(self) -> None:
        # TECH-8749: the rh-memory-mcp hook is the memory path; Claude Code's own
        # auto memory (notes under $CLAUDE_CONFIG_DIR/projects/*/memory) stays off.
        settings = json.loads(_PATH.with_name("managed-settings.json").read_text())
        self.assertIs(settings["autoMemoryEnabled"], False)
        self.assertEqual(settings["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")

    def test_registers_both_hooks(self) -> None:
        settings = json.loads(_PATH.with_name("managed-settings.json").read_text())
        commands = {
            event: [h["command"] for group in groups for h in group["hooks"]]
            for event, groups in settings["hooks"].items()
        }
        self.assertEqual(commands, {
            "UserPromptSubmit": ["/usr/local/bin/rh-memory-hook recall"],
            "Stop": ["/usr/local/bin/rh-memory-hook capture"],
        })


@unittest.skipUnless(tomllib, "tomllib needs Python 3.11+")
class CodexManagedConfigTest(unittest.TestCase):
    def test_registers_both_hooks(self) -> None:
        config = tomllib.loads(_PATH.parent.parent.joinpath("codex", "managed_config.toml").read_text())
        commands = {
            event: [h["command"] for group in groups for h in group["hooks"]]
            for event, groups in config["hooks"].items()
        }
        self.assertEqual(commands, {
            "UserPromptSubmit": ["/usr/local/bin/rh-memory-hook recall"],
            "Stop": ["/usr/local/bin/rh-memory-hook capture --format codex"],
        })


if __name__ == "__main__":
    unittest.main()

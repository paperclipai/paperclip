import asyncio
import json
import threading
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from acp.schema import ClientCapabilities
from bridge import ManagedHermesACPAgent, ManagedSessionManager, SessionPermissions, permission_scope, assigned_skill_identity, ChannelClient, native_answers, question_set, install_no_auth_transport, disable_background_title_inference, turn_usage, USAGE_COUNTERS
from policy import authorize_tool
from billing import TurnBilling, TokenBilling


class Accounting(unittest.TestCase):
    def test_managed_title_keeps_derived_title_without_background_inference(self):
        from agent import title_generator, memory_provider
        store = Mock()
        store.get_session_title.return_value = None
        store.set_auto_title.return_value = True
        with patch.object(title_generator, "_model_title_upgrade_enabled"), \
                patch.object(title_generator, "_auto_title_enabled", return_value=True), \
                patch.object(memory_provider, "spawn_context_thread") as spawn:
            disable_background_title_inference()
            result = title_generator.maybe_auto_title(store, "session", "Investigate the runner retry accounting")
        self.assertIsNone(result)
        store.set_auto_title.assert_called_once_with("session", unittest.mock.ANY, source="derived")
        self.assertTrue(store.set_auto_title.call_args.args[1])
        spawn.assert_not_called()

    def test_usage_is_per_turn_and_cache_and_thought_are_not_double_counted(self):
        before = dict.fromkeys(USAGE_COUNTERS, 100)
        after = {key: value + 5 for key, value in before.items()}
        result = turn_usage(before, after, [True, True])
        self.assertEqual(result.input_tokens, 5)
        self.assertEqual(result.cached_read_tokens, 5)
        self.assertEqual(result.cached_write_tokens, 5)
        self.assertEqual(result.thought_tokens, 0)
        self.assertIsNone(turn_usage(before, after, [True, False]))
        self.assertIsNone(turn_usage(before, after, []))
        with self.assertRaises(ValueError):
            turn_usage(after, before, [True])


class ToolPolicy(unittest.TestCase):
    def test_planning_workflow_mutations_reach_semantic_authority_but_are_not_reads(self):
        assigned = ["mcp__paperclip__write_document", "mcp__paperclip__request_human_input", "mcp__paperclip__set_task_title", "mcp__paperclip__call_api"]
        policy = {"permissionMode": "approve-all", "readOnly": True, "paperclipReadOnlyTools": assigned}
        for name in assigned:
            self.assertFalse(authorize_tool(name, {}, policy=policy, cwd="/workspace"))
        for name in ["terminal", "write_file", "mcp__other__write_document", "mcp__paperclip__manage_routine"]:
            with self.assertRaises(PermissionError):
                authorize_tool(name, {}, policy=policy, cwd="/workspace")
        with self.assertRaises(PermissionError):
            authorize_tool(assigned[0], {}, policy={**policy, "permissionMode": "deny-all"}, cwd="/workspace")

    def test_planning_can_report_and_use_only_authoritative_assigned_reads(self):
        policy = {"permissionMode": "approve-reads", "readOnly": True,
                  "paperclipReadTools": ["mcp__paperclip__read_document"]}
        for name in ["mcp__paperclip__paperclip_finish", "mcp__paperclip__read_document", "todo_list"]:
            self.assertTrue(authorize_tool(name, {}, policy=policy, cwd="/workspace"))
        for name in ["mcp__other__read_document", "mcp__paperclip__manage_routine", "mcp__paperclip__unknown_read"]:
            with self.assertRaises(PermissionError):
                authorize_tool(name, {}, policy=policy, cwd="/workspace")

    def test_planning_disallows_commands_writes_and_unassigned_read_roots(self):
        policy = {"permissionMode": "approve-all", "readOnly": True, "protectedPaths": ["/private/runtime"], "readRoots": []}
        for name, args in [("terminal", {"command": "touch x"}), ("write_file", {"path": "x"}), ("read_file", {"path": "/private/runtime/auth.json"}), ("read_file", {"path": "/other/secret"})]:
            with self.assertRaises(PermissionError):
                authorize_tool(name, args, policy=policy, cwd="/workspace")
        self.assertTrue(authorize_tool("read_file", {"path": "a.txt"}, policy=policy, cwd="/workspace"))

    def test_scheduler_and_protected_ancestors_are_denied_in_full_auto(self):
        policy = {"permissionMode": "approve-all", "readOnly": False, "protectedPaths": ["/workspace/runtime"]}
        for name, args in [("cronjob", {}), ("send_message", {}), ("write_file", {"path": "/workspace"}), ("write_file", {"path": "/skills/a"})]:
            with self.assertRaises(PermissionError):
                authorize_tool(name, args, policy=policy, cwd="/workspace", assigned_skills=["/skills"])


class Questions(unittest.TestCase):
    def test_published_answer_limit_matches_native_text_and_custom_answers(self):
        for options, multi_select in [(None, False), (["A"], False), (["A"], True)]:
            form = question_set("Which?", options, multi_select)
            self.assertEqual(form["questions"][0]["textValidation"], {"maxLength": 65536})
            field = "customText" if options else "text"
            for value, accepted in [("x" * 65536, True), ("x" * 65537, False), ("x" * 70000, False),
                                    ("\U0001f600" * 32768, True), ("\U0001f600" * 32769, False)]:
                with self.subTest(options=options, multi_select=multi_select, length=len(value)):
                    response = {"outcome": "answered", "answers": {"q0": {field: value}}}
                    if accepted:
                        self.assertEqual(native_answers(form, response, False), [value] if multi_select else value)
                    else:
                        with self.assertRaisesRegex(ValueError, "Invalid Hermes text answer"):
                            native_answers(form, response, False)

    def test_batches_preserve_native_question_ids_and_multiple_answers(self):
        form = question_set(None, questions=[
            {"qid": "q0", "question": "Which?", "choices": ["A", "B"], "multi_select": True},
            {"qid": "q1", "question": "Why?"},
        ])
        result = native_answers(form, {"outcome": "answered", "answers": {
            "q0": {"selectedOptionIds": ["o1", "o0"], "customText": "C"}, "q1": {"text": "Because"},
        }}, True)
        self.assertEqual(result, {"answers": {"q0": ["B", "A", "C"], "q1": "Because"}})

    def test_rejects_incomplete_or_unknown_answers(self):
        form = question_set("Which?", ["A"])
        for answers in ({}, {"q0": {"selectedOptionIds": ["missing"]}}, {"q0": {}}):
            with self.assertRaises(ValueError):
                native_answers(form, {"outcome": "answered", "answers": answers}, False)
        self.assertIsNone(native_answers(form, {"outcome": "cancelled"}, False))


class PermissionGrants(unittest.TestCase):
    def test_concurrent_same_tool_uses_one_confirmed_session_grant(self):
        permissions = SessionPermissions()
        permissions.bind("a" * 64)
        started, release = threading.Event(), threading.Event()
        calls = []
        def ask():
            calls.append("permission")
            started.set()
            self.assertTrue(release.wait(5))
            return "session"
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(permissions.allow, "write_file", ask, lambda: None)
            self.assertTrue(started.wait(5))
            second = executor.submit(permissions.allow, "write_file", ask, lambda: None)
            release.set()
            first.result(timeout=5)
            second.result(timeout=5)
        self.assertEqual(calls, ["permission"])
        self.assertEqual(permissions.record()["tools"], ["write_file"])

    def test_other_tools_do_not_wait_on_an_unanswered_tool_and_once_or_deny_is_not_saved(self):
        permissions = SessionPermissions()
        permissions.bind("a" * 64)
        waiting, other, release = threading.Event(), threading.Event(), threading.Event()
        def blocked():
            waiting.set()
            self.assertTrue(release.wait(5))
            return "once"
        def independent():
            other.set()
            return "deny"
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(permissions.allow, "write_file", blocked, lambda: None)
            self.assertTrue(waiting.wait(5))
            second = executor.submit(permissions.allow, "terminal", independent, lambda: None)
            self.assertTrue(other.wait(5))
            release.set()
            first.result(timeout=5)
            with self.assertRaises(PermissionError):
                second.result(timeout=5)
        self.assertEqual(permissions.record()["tools"], [])

    def test_private_record_is_closed_versioned_and_bounded(self):
        valid = {"schema": SessionPermissions.SCHEMA, "scope": "a" * 64, "tools": ["write_file"]}
        self.assertEqual(SessionPermissions(valid).record(), valid)
        for record in [[], {**valid, "schema": "future"}, {**valid, "scope": "unknown"},
                       {**valid, "tools": ["write_file", "write_file"]}, {**valid, "tools": [None]},
                       {**valid, "tools": ["tool\ncommand"]}, {**valid, "tools": ["tool" + str(i) for i in range(257)]},
                       {**valid, "arguments": {"apiKey": "MUST_NOT_BE_STORED"}}]:
            with self.subTest(record=record), self.assertRaises(ValueError):
                SessionPermissions(record)
        full = SessionPermissions({**valid, "tools": ["tool" + str(i) for i in range(256)]})
        with self.assertRaises(PermissionError):
            full.allow("new_tool", lambda: "session", lambda: None)
        self.assertEqual(len(full.record()["tools"]), 256)

    def test_restore_keeps_compatible_grants_and_invalidates_changed_scope_without_token_material(self):
        state = SimpleNamespace(cwd="/workspace", model="model-A", agent=SimpleNamespace(
            provider="custom:paperclip", base_url="https://model.test/v1", api_mode="chat_completions", api_key="FIRST_SECRET"))
        policy = {"permissionMode": "approve-reads", "readOnly": False, "protectedPaths": ["/runtime"]}
        scope = permission_scope(state, "session-A", policy, [])
        permissions = SessionPermissions()
        permissions.bind(scope)
        permissions.allow("write_file", lambda: "session", lambda: None)
        restored = SessionPermissions(permissions.record())
        state.agent.api_key = "REFRESHED_SECRET"
        state.agent.base_url = "https://model.test/v1/"
        restored.bind(permission_scope(state, "session-A", policy, []))
        ask = Mock()
        restored.allow("write_file", ask, lambda: None)
        ask.assert_not_called()
        self.assertNotIn("SECRET", json.dumps(restored.record()))
        changed = [permission_scope(state, "session-B", policy, []),
                   permission_scope(state, "session-A", {**policy, "permissionMode": "approve-paperclip"}, []),
                   permission_scope(state, "session-A", {**policy, "readOnly": True}, []),
                   permission_scope(state, "session-A", policy, ["/assigned/skill"])]
        state.cwd = "/other-workspace"
        changed.append(permission_scope(state, "session-A", policy, []))
        state.cwd, state.model = "/workspace", "model-B"
        changed.append(permission_scope(state, "session-A", policy, []))
        state.model, state.agent.base_url = "model-A", "https://other-model.test/v1"
        changed.append(permission_scope(state, "session-A", policy, []))
        for changed_scope in changed:
            restored = SessionPermissions(permissions.record())
            restored.bind(changed_scope)
            self.assertEqual(restored.record()["tools"], [])


class Restore(unittest.TestCase):
    def test_assigned_skill_identity_survives_new_lease_paths_and_detects_changes(self):
        with tempfile.TemporaryDirectory() as root:
            first, second = Path(root) / "lease-A", Path(root) / "lease-B"
            for path in (first, second):
                (path / "assigned" / "empty").mkdir(parents=True)
                (path / "assigned" / "SKILL.md").write_text("Original assigned instructions")
            identity = assigned_skill_identity([str(first)])
            self.assertEqual(assigned_skill_identity([str(second)]), identity)
            (second / "assigned" / "SKILL.md").write_text("Changed assigned instructions")
            self.assertNotEqual(assigned_skill_identity([str(second)]), identity)
            (second / "assigned" / "SKILL.md").write_text("Original assigned instructions")
            (second / "assigned" / "empty").rename(second / "assigned" / "renamed")
            self.assertNotEqual(assigned_skill_identity([str(second)]), identity)

    def test_assigned_skill_identity_rejects_links_and_unsupported_roots(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            original = root / "original"; original.write_text("Assigned content")
            assigned = root / "assigned"; assigned.mkdir()
            (assigned / "link").symlink_to(original)
            with self.assertRaises(ValueError):
                assigned_skill_identity([str(assigned)])
            (assigned / "link").unlink()
            (assigned / "link").hardlink_to(original)
            with self.assertRaises(ValueError):
                assigned_skill_identity([str(assigned)])
            for roots in [None, ["relative"], [None], [str(assigned)] * 129]:
                with self.subTest(roots=roots), self.assertRaises(ValueError):
                    assigned_skill_identity(roots)

    def test_versioned_permission_metadata_follows_native_compaction_and_legacy_history(self):
        db = Mock()
        manager = ManagedSessionManager(db=db)
        manager._get_db = lambda: db
        agent = SimpleNamespace(model="test", _session_db=db, session_id="head",
                                _flush_messages_to_session_db=Mock(return_value=True))
        permissions = SessionPermissions()
        permissions.bind("a" * 64)
        permissions.allow("write_file", lambda: "session", lambda: None)
        state = SimpleNamespace(session_id="parent", model="test", cwd="/workspace", agent=agent,
            history=[{"role": "user", "content": "Saved history"}], _paperclip_permissions=permissions)
        db.get_session.return_value = {"source": "acp"}
        db.get_messages_as_conversation.return_value = state.history
        manager._persist(state)
        saved = [json.loads(c.args[1]) for c in db.update_session_meta.call_args_list]
        self.assertEqual(len(saved), 2)
        self.assertEqual(saved[0], saved[1])
        self.assertEqual(saved[0]["paperclip_permissions"], permissions.record())
        self.assertEqual(saved[0]["paperclip_head"], "head")
        db.get_compression_tip.return_value = "head"
        db.get_compression_chain.return_value = ["parent", "head"]
        db.get_session.side_effect = lambda identity: {"source": "acp", "model": "test", "model_config": json.dumps(saved[0])}
        manager._make_agent = Mock(return_value=SimpleNamespace(model="test"))
        restored = manager._restore("parent")
        self.assertEqual(restored._paperclip_permissions.record(), permissions.record())
        legacy = {k: v for k, v in saved[0].items() if k != "paperclip_permissions"}
        db.get_session.side_effect = lambda identity: {"source": "acp", "model": "test", "model_config": json.dumps(legacy)}
        self.assertIsNone(manager._restore("parent")._paperclip_permissions.record())
        for broken in [{"schema": "future"}, {**permissions.record(), "tools": ["write_file", "write_file"]}]:
            db.get_session.side_effect = lambda identity: {"source": "acp", "model": "test", "model_config": json.dumps({**saved[0], "paperclip_permissions": broken})}
            manager._make_agent.reset_mock()
            with self.assertRaisesRegex(ValueError, "saved permission state"):
                manager._restore("parent")
            manager._make_agent.assert_not_called()

    def test_missing_or_failed_history_never_becomes_an_empty_success(self):
        manager = ManagedSessionManager(agent_factory=lambda: SimpleNamespace())
        db = Mock()
        db.get_compression_tip.return_value = "session"
        manager._get_db = lambda: db
        for row, history in [(None, []), ({"source": "cli"}, []), ({"source": "acp"}, [])]:
            db.get_session.return_value = row
            db.get_messages_as_conversation.return_value = history
            with self.assertRaises(ValueError):
                manager._restore("session")
        db.get_session.return_value = {"source": "acp"}
        db.get_messages_as_conversation.side_effect = OSError("damaged database")
        with self.assertRaises(OSError):
            manager._restore("session")

    def test_compaction_restores_the_native_head_under_the_stable_acp_handle(self):
        manager = ManagedSessionManager(agent_factory=lambda: SimpleNamespace())
        db = Mock()
        manager._get_db = lambda: db
        db.get_compression_tip.return_value = "child"
        db.get_compression_chain.return_value = ["parent", "child"]
        db.get_session.side_effect = lambda identity: {"source": "acp", "model": "test",
            "end_reason": "compression" if identity == "parent" else None,
            "model_config": json.dumps({"cwd": "/workspace", "paperclip_head": "child"})}
        db.get_messages_as_conversation.return_value = [{"role": "user", "content": "compacted summary"}]
        manager._make_agent = Mock(return_value=SimpleNamespace(model="test"))
        state = manager._restore("parent")
        self.assertEqual(state.session_id, "parent")
        self.assertEqual(manager._make_agent.call_args.kwargs["session_id"], "child")
        db.get_messages_as_conversation.assert_called_once_with("child", repair_alternation=True)
        db.get_compression_tip.return_value = "parent"
        with self.assertRaisesRegex(ValueError, "compacted session history is missing"):
            manager._restore("parent")

    def test_restore_accepts_sdk_base_url_normalization_but_rejects_routing_changes(self):
        manager = ManagedSessionManager()
        config = {"model": {"provider": "custom:paperclip", "default": "exact-model"}}
        route = {"provider": "custom", "base_url": "https://example.test/v1?route=a", "api_mode": "chat_completions"}
        agent = SimpleNamespace(**route, model="exact-model")
        with patch("hermes_cli.config.load_config", return_value=config), patch("hermes_cli.runtime_provider.resolve_runtime_provider", return_value=route), patch("acp_adapter.session.SessionManager._make_agent", return_value=agent) as native:
            manager._make_agent(model="exact-model", requested_provider="custom", base_url="https://example.test/v1/?route=a", api_mode="chat_completions")
            native.assert_called_once()
            self.assertEqual(native.call_args.kwargs["requested_provider"], "custom:paperclip")
            for change in [{"model": "other"}, {"base_url": "https://example.test/v2?route=a"}, {"base_url": "https://example.test/v1?route=b"}, {"requested_provider": "other"}, {"api_mode": "responses"}]:
                native.reset_mock()
                with self.assertRaises(ValueError):
                    manager._make_agent(**{"model": "exact-model", "base_url": route["base_url"], "api_mode": "chat_completions", **change})
                native.assert_not_called()

    def test_native_route_fallback_is_rejected_before_a_turn(self):
        manager = ManagedSessionManager()
        config = {"model": {"provider": "custom:paperclip", "default": "exact-model"}}
        route = {"provider": "custom", "base_url": "https://example.test/v1", "api_mode": "chat_completions"}
        for change in [{"provider": ""}, {"provider": "openrouter"}, {"base_url": "https://other.test/v1"},
                       {"base_url": "https://example.test/v2"}, {"api_mode": "responses"}, {"model": "other-model"}]:
            agent = SimpleNamespace(**{**route, "model": "exact-model", **change})
            with self.subTest(change=change), patch("hermes_cli.config.load_config", return_value=config), \
                    patch("hermes_cli.runtime_provider.resolve_runtime_provider", return_value=route), \
                    patch("acp_adapter.session.SessionManager._make_agent", return_value=agent):
                with self.assertRaisesRegex(ValueError, "Hermes native (route|model) differs"):
                    manager._make_agent(model="exact-model", requested_provider="custom", base_url=route["base_url"], api_mode=route["api_mode"])

    def test_new_native_route_accepts_sdk_url_normalization_without_recorded_arguments(self):
        manager = ManagedSessionManager()
        config = {"model": {"provider": "custom:paperclip", "default": "exact-model"}}
        route = {"provider": "custom", "base_url": "https://example.test/v1", "api_mode": "chat_completions"}
        agent = SimpleNamespace(**{**route, "base_url": "https://example.test/v1/", "model": "exact-model"})
        with patch("hermes_cli.config.load_config", return_value=config), \
                patch("hermes_cli.runtime_provider.resolve_runtime_provider", return_value=route), \
                patch("acp_adapter.session.SessionManager._make_agent", return_value=agent) as native:
            manager._make_agent()
        self.assertEqual(native.call_args.kwargs["requested_provider"], "custom:paperclip")

    def test_failed_native_flush_cannot_be_reported_as_durable(self):
        db = Mock()
        manager = ManagedSessionManager(db=db)
        manager._get_db = lambda: db
        agent = SimpleNamespace(_session_db=db, session_id="head", _flush_messages_to_session_db=Mock(return_value=False))
        with self.assertRaisesRegex(ValueError, "could not be saved"):
            manager._persist(SimpleNamespace(history=[{"role": "user", "content": "x"}], agent=agent, session_id="head"))
        db.update_session_meta.assert_not_called()


class Controls(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.state = SimpleNamespace(runtime_lock=threading.Lock(), is_running=True,
                                     cancel_event=threading.Event(), agent=Mock(), cwd="/workspace", model="test")
        self.manager = Mock()
        self.manager.get_session.return_value = self.state
        self.bridge = ManagedHermesACPAgent(self.manager)
        self.bridge._negotiated = True
        self.bridge._active = ("session", "turn")

    async def test_reported_wire_usage_includes_calls_missing_from_native_accepted_response_counters(self):
        self.state.agent = SimpleNamespace(**{"session_" + key: 0 for key in USAGE_COUNTERS},
            _paperclip_usage_receipts=[True], _paperclip_cost_receipts=[True])
        # Native session counters can reset during compaction. Complete wire
        # receipts remain scoped to this turn instead of subtracting sessions.
        self.bridge._usage_before = dict.fromkeys(USAGE_COUNTERS, 100)
        self.bridge._billing = TurnBilling()
        for _ in range(2):
            self.bridge._billing.begin().json(b'{"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.0042}}')
        conn = SimpleNamespace(ext_notification=AsyncMock())
        with patch("bridge.HermesACPAgent._finish_turn", new=AsyncMock(return_value=SimpleNamespace(usage=None))):
            response = await self.bridge._finish_turn(self.state, "session", conn, {}, None, True)
        self.assertEqual(response.usage.input_tokens, 40)
        self.assertEqual(response.usage.output_tokens, 10)
        params = conn.ext_notification.call_args.args[1]
        self.assertEqual(params["turnToken"], "turn")
        self.assertEqual(params["billing"]["amountUsdExact"], "0.008400000")
        self.assertEqual(params["billing"]["reportedRequestCount"], 2)
        self.assertEqual(params["cost"], "unavailable")  # no smaller model-price estimate

    async def test_direct_api_wire_usage_has_token_authority_without_a_dollar_claim(self):
        self.state.agent = SimpleNamespace(**{"session_" + key: 0 for key in USAGE_COUNTERS},
            _paperclip_usage_receipts=[True], _paperclip_cost_receipts=[True])
        self.bridge._usage_before = dict.fromkeys(USAGE_COUNTERS, 100)
        self.bridge._billing = TokenBilling("anthropic", "fixture-model", "messages")
        for _ in range(2):
            self.bridge._billing.begin().json(b'{"type":"message","usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":3}}')
        conn = SimpleNamespace(ext_notification=AsyncMock())
        with patch("bridge.HermesACPAgent._finish_turn", new=AsyncMock(return_value=SimpleNamespace(usage=None))):
            response = await self.bridge._finish_turn(self.state, "session", conn, {}, None, True)
        self.assertEqual((response.usage.input_tokens, response.usage.output_tokens, response.usage.cached_read_tokens), (40, 10, 6))
        params = conn.ext_notification.call_args.args[1]
        self.assertEqual(params["turnToken"], "turn")
        self.assertTrue(params["tokenAccounting"]["complete"])
        self.assertEqual(params["tokenAccounting"]["requestCount"], 2)
        self.assertNotIn("billing", params)
        self.assertNotIn("estimatedUsd", params)
        self.assertEqual(params["cost"], "unavailable")

    async def test_missing_wire_usage_cannot_fall_back_to_the_smaller_native_receipt(self):
        self.state.agent = SimpleNamespace(**{"session_" + key: 0 for key in USAGE_COUNTERS},
            _paperclip_usage_receipts=[True], _paperclip_cost_receipts=[True])
        self.bridge._usage_before = dict.fromkeys(USAGE_COUNTERS, 0)
        self.bridge._billing = TurnBilling()
        self.bridge._billing.begin().json(b'{"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.0042}}')
        self.bridge._billing.begin()  # interrupted request never returned usage
        conn = SimpleNamespace(ext_notification=AsyncMock())
        with patch("bridge.HermesACPAgent._finish_turn", new=AsyncMock(return_value=SimpleNamespace(usage=None))):
            response = await self.bridge._finish_turn(self.state, "session", conn, {}, None, True)
        self.assertIsNone(response.usage)
        self.assertFalse(conn.ext_notification.call_args.args[1]["billing"]["complete"])

    async def test_steering_is_bound_to_live_session_and_turn(self):
        for session, token in [("other", "turn"), ("session", "old")]:
            response = await self.bridge.ext_method("hermes/steer", {
                "version": 1, "sessionId": session, "turnToken": token, "message": "Change direction",
            })
            self.assertFalse(response["accepted"])
        self.state.agent.redirect.assert_not_called()
        self.state.agent.redirect.return_value = True
        response = await self.bridge.ext_method("hermes/steer", {
            "version": 1, "sessionId": "session", "turnToken": "turn", "message": "Change direction",
        })
        self.assertTrue(response["accepted"])
        self.state.agent.redirect.assert_called_once_with("Change direction")
        self.state.cancel_event.set()
        response = await self.bridge.ext_method("hermes/steer", {
            "version": 1, "sessionId": "session", "turnToken": "turn", "message": "Too late",
        })
        self.assertFalse(response["accepted"])

    async def test_concurrent_prompt_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "queue work in Paperclip"):
            await self.bridge.prompt([], "session")

    async def test_overlapping_same_name_tools_complete_by_native_identity(self):
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
        updates = []
        with patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update", side_effect=lambda c, s, l, event: updates.append(event)):
            self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
            self.state.agent.tool_start_callback("call-a", "read_file", {"path": "a.txt"})
            self.state.agent.tool_start_callback("call-b", "read_file", {"path": "b.txt"})
            self.state.agent.tool_complete_callback("call-b", "read_file", {"path": "b.txt"}, "B")
            self.state.agent.tool_complete_callback("call-a", "read_file", {"path": "a.txt"}, "A")
        self.assertEqual([u.tool_call_id for u in updates], ["call-a", "call-b", "call-b", "call-a"])
        self.assertEqual(callbacks.tool_call_ids, {})
        self.assertEqual(callbacks.tool_call_meta, {})

    async def test_structured_tool_results_retain_native_content_and_raw_output(self):
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
        updates = []
        with patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update", side_effect=lambda c, s, l, event: updates.append(event)):
            self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
            for call_id, result in [("success", {"marker": "native-result"}), ("failure", {"error": "denied"})]:
                self.state.agent.tool_start_callback(call_id, "mcp__paperclip__write_document", {})
                self.state.agent.tool_complete_callback(call_id, "mcp__paperclip__write_document", {}, result)
        self.assertEqual(json.loads(updates[1].raw_output), {"marker": "native-result"})
        self.assertTrue(updates[1].content)
        self.assertEqual(updates[3].status, "failed")
        self.assertEqual(json.loads(updates[3].raw_output), {"error": "denied"})

    async def test_committed_question_stops_before_its_native_completion_is_published(self):
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
        result = {"disposition": "applied", "interaction": {"id": "question", "companyId": "company",
            "issueId": "issue", "sourceRunId": "run", "kind": "ask_user_questions",
            "status": "pending", "continuationPolicy": "wake_assignee"}}
        name = "mcp__paperclip__request_human_input"
        updates = []
        carriers = []
        for kind in ("ask_user_questions", "request_confirmation", "request_checkbox_confirmation"):
            committed = {**result, "interaction": {**result["interaction"], "kind": kind}}
            carriers.extend([committed, {"result": committed}, {"result": json.dumps(committed)},
                             {"result": "Human input saved", "structuredContent": committed}])
        for carrier in carriers:
            with self.subTest(carrier=carrier):
                self.state.cancel_event.clear()
                self.bridge._committed_wait_updates.clear()
                callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
                with patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), \
                        patch("bridge._send_update", side_effect=lambda c, s, l, event: updates.append(event)), \
                        patch("bridge.request_hard_interrupt", return_value=True) as stop:
                    self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
                    self.state.agent.tool_start_callback("wait", name, {})
                    self.state.agent.tool_complete_callback("wait", name, {}, json.dumps(carrier))
                self.assertTrue(self.state.cancel_event.is_set())
                stop.assert_called_once_with(self.state.agent, tool_reason="user_interrupt")
                self.assertNotEqual(updates[-1].status, "completed")
                self.assertEqual(len(self.bridge._committed_wait_updates), 1)
                self.assertEqual(json.loads(self.bridge._committed_wait_updates[0].raw_output), carrier)

    async def test_committed_question_completion_follows_final_native_usage(self):
        self.state.agent = SimpleNamespace(**{"session_" + key: 0 for key in USAGE_COUNTERS},
            _paperclip_usage_receipts=[True], _paperclip_cost_receipts=[True])
        self.bridge._usage_before = dict.fromkeys(USAGE_COUNTERS, 0)
        self.bridge._billing = TurnBilling()
        self.bridge._billing.begin().json(b'{"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.0042}}')
        update = object()
        self.bridge._committed_wait_updates.append(update)
        order = []
        conn = SimpleNamespace(ext_notification=AsyncMock(side_effect=lambda *args: order.append("usage")),
                               session_update=AsyncMock(side_effect=lambda *args: order.append("question")))
        with patch("bridge.HermesACPAgent._finish_turn", new=AsyncMock(return_value=SimpleNamespace(usage=None))):
            response = await self.bridge._finish_turn(self.state, "session", conn, {}, None, True)
        self.assertEqual(order, ["usage", "question"])
        self.assertEqual(response.usage.total_tokens, 25)
        conn.session_update.assert_awaited_once_with("session", update)
        self.assertEqual(self.bridge._committed_wait_updates, [])

    async def test_other_or_uncommitted_tool_results_cannot_stop_the_native_turn(self):
        original = {"disposition": "applied", "interaction": {"id": "question", "companyId": "company",
            "issueId": "issue", "sourceRunId": "run", "kind": "ask_user_questions",
            "status": "pending", "continuationPolicy": "wake_assignee"}}
        cases = [("mcp__paperclip__read_file", original), ("terminal", original),
                 ("mcp__paperclip__request_human_input", {"error": "denied"}),
                 ("mcp__paperclip__request_human_input", {"result": "Saved a pending question"}),
                 ("mcp__paperclip__request_human_input", {"result": original, "error": "denied"}),
                 ("mcp__paperclip__request_human_input", {**original, "disposition": "rejected"})]
        for key, value in [("status", "resolved"), ("kind", "future_interaction"), ("kind", []),
                           ("continuationPolicy", "none"), ("sourceRunId", None), ("id", "")]:
            cases.append(("mcp__paperclip__request_human_input",
                          {**original, "interaction": {**original["interaction"], key: value}}))
        with patch("bridge.request_hard_interrupt", return_value=True) as stop:
            for index, (name, result) in enumerate(cases):
                with self.subTest(name=name, result=result):
                    callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
                    with patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update"):
                        self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
                        self.state.agent.tool_start_callback(str(index), name, {})
                        self.state.agent.tool_complete_callback(str(index), name, {}, result)
                    self.assertFalse(self.state.cancel_event.is_set())
            stop.assert_not_called()

    async def test_pre_dispatch_denials_keep_native_ids_and_complete_exactly_once(self):
        from hermes_cli import middleware
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={})
        updates = []
        execute = Mock()
        with patch.dict("os.environ", {"PAPERCLIP_HERMES_POLICY": json.dumps({"permissionMode": "approve-all", "readOnly": True})}), patch("hermes_cli.middleware.run_tool_execution_middleware", side_effect=lambda name, args, run, **kwargs: run(args)), patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update", side_effect=lambda c, s, l, event: updates.append(event)):
            self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
            for call_id in ["denial-a", "denial-b"]:
                result = middleware.run_tool_execution_middleware("terminal", {"command": "touch proof"}, execute, tool_call_id=call_id)
                self.state.agent.tool_complete_callback(call_id, "terminal", {}, result)
        execute.assert_not_called()
        self.assertEqual([update.tool_call_id for update in updates], ["denial-a", "denial-a", "denial-b", "denial-b"])
        for update in updates[1::2]:
            self.assertEqual(update.status, "failed")
            self.assertIn("planning mode permits", update.raw_output)
        self.assertEqual(callbacks.tool_call_meta, {})

    async def test_one_native_write_approval_covers_its_prepared_edit_and_session_reuse(self):
        from hermes_cli import middleware
        from acp_adapter.edit_approval import maybe_require_edit_approval, set_edit_approval_requester, reset_edit_approval_requester
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={}, approval_cb=Mock(side_effect=["once", "session"]),
                                    edit_approval_requester=Mock(return_value=False))
        with tempfile.TemporaryDirectory() as root:
            self.state.cwd = root
            written = []
            def native_edit(args):
                binding = set_edit_approval_requester(callbacks.edit_approval_requester)
                try:
                    refusal = maybe_require_edit_approval("write_file", args)
                    self.assertIsNone(refusal)
                    Path(args["path"]).write_text(args["content"])
                    written.append(args["path"])
                    return "written"
                finally:
                    reset_edit_approval_requester(binding)
            policy = {"permissionMode": "approve-reads", "readOnly": False, "protectedPaths": [root + "/protected"]}
            with patch.dict("os.environ", {"PAPERCLIP_HERMES_POLICY": json.dumps(policy)}), patch("hermes_cli.middleware.run_tool_execution_middleware", side_effect=lambda name, args, run, **kwargs: run(args)), patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update"):
                self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
                for index in range(3):
                    path = str(Path(root, f"proof-{index}.txt"))
                    args = {"path": path, "content": "native-edit-proof"}
                    self.assertEqual(middleware.run_tool_execution_middleware("write_file", args, native_edit), "written")
                    self.assertEqual(Path(path).read_text(), args["content"])
                self.assertEqual(callbacks.approval_cb.call_count, 2)
                self.assertEqual(self.state._paperclip_permissions.record()["tools"], ["write_file"])
                denied = middleware.run_tool_execution_middleware("write_file", {"path": root + "/protected/secret", "content": "x"}, native_edit)
                self.assertIn("protects", json.loads(denied)["error"])
                self.assertEqual(callbacks.approval_cb.call_count, 2)
                self.assertEqual(len(written), 3)

    async def test_native_edit_approval_does_not_inherit_an_unrelated_tool_invocation(self):
        from hermes_cli import middleware
        from acp_adapter.edit_approval import EditProposal
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={}, approval_cb=Mock(side_effect=["once", "deny"]))
        with patch.dict("os.environ", {"PAPERCLIP_HERMES_POLICY": json.dumps({"permissionMode": "approve-reads", "readOnly": False})}), patch("hermes_cli.middleware.run_tool_execution_middleware", side_effect=lambda name, args, run, **kwargs: run(args)), patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update"):
            self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
            result = middleware.run_tool_execution_middleware("execute_code", {"code": "native nested edit"}, lambda args: callbacks.edit_approval_requester(EditProposal("write_file", "/workspace/a.txt", None, "x", {"path": "a.txt", "content": "x"})))
            self.assertFalse(result)
            self.assertEqual(callbacks.approval_cb.call_count, 2)
            self.assertEqual(self.state._paperclip_permissions.record()["tools"], [])

    async def test_stop_racing_a_session_approval_cannot_grant_or_execute(self):
        from hermes_cli import middleware
        def stop_then_allow(*args, **kwargs):
            self.state.cancel_event.set()
            return "session"
        callbacks = SimpleNamespace(tool_call_ids={}, tool_call_meta={}, approval_cb=Mock(side_effect=stop_then_allow))
        execute = Mock()
        with patch.dict("os.environ", {"PAPERCLIP_HERMES_POLICY": json.dumps({"permissionMode": "approve-reads", "readOnly": False})}), patch("hermes_cli.middleware.run_tool_execution_middleware", side_effect=lambda name, args, run, **kwargs: run(args)), patch("bridge.HermesACPAgent._wire_turn_callbacks", return_value=callbacks), patch("bridge._send_update"):
            self.bridge._wire_turn_callbacks(self.state, "session", Mock(), asyncio.get_running_loop())
            result = middleware.run_tool_execution_middleware("write_file", {"path": "a.txt", "content": "x"}, execute, tool_call_id="cancelled-write")
        execute.assert_not_called()
        self.assertIn("turn has stopped", json.loads(result)["error"])
        self.assertEqual(self.state._paperclip_permissions.record()["tools"], [])

    async def test_managed_restore_retains_history_without_replaying_it_as_live_output(self):
        self.bridge._conn = SimpleNamespace(session_update=AsyncMock())
        history = [{"role": "assistant", "content": "Previous reply"}]
        state = SimpleNamespace(session_id="session", history=history)
        await self.bridge._replay_session_history(state)
        self.bridge._conn.session_update.assert_not_called()
        self.assertEqual(state.history, history)
        self.bridge._negotiated = False
        await self.bridge._replay_session_history(state)
        self.bridge._conn.session_update.assert_awaited_once()

    async def test_capabilities_use_native_sdk_metadata(self):
        response = await self.bridge.initialize(client_capabilities=ClientCapabilities(
            field_meta={"paperclipHermes": {"version": 1}}))
        self.assertTrue(self.bridge._negotiated)
        self.assertEqual(response.agent_capabilities.field_meta["paperclipHermes"]["version"], 1)

    async def test_reasoning_and_text_have_distinct_native_message_ids(self):
        import acp
        client = SimpleNamespace(session_update=AsyncMock())
        wrapper = ChannelClient(client)
        thought = acp.update_agent_thought_text("Fixture reasoning")
        text = acp.update_agent_message_text("Fixture text")
        thought.message_id = text.message_id = "0496571a-3b77-42a6-ab45-71bd6b7593ab"
        await wrapper.session_update("session", thought)
        await wrapper.session_update("session", text)
        first, second = [c.args[1] for c in client.session_update.call_args_list]
        self.assertNotEqual(first.message_id, second.message_id)
        self.assertEqual(second.message_id, text.message_id)


class ToolProcess(unittest.TestCase):
    def test_linux_devices_keep_protected_and_assigned_overlays(self):
        import tool_process
        with patch.object(tool_process.sys, "platform", "linux"), patch.object(tool_process.shutil, "which", return_value="/usr/bin/bwrap"):
            command = tool_process.sandbox_command(["/bin/sh", "-c", "true"], cwd="/workspace",
                policy={"protectedPaths": ["/runtime"]}, assigned=["/assigned"])
        self.assertEqual(command[:11], ["/usr/bin/bwrap", "--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs"])
        self.assertEqual(command[11:], ["/runtime", "--ro-bind", "/assigned", "/assigned", "--chdir", "/workspace", "--", "/bin/sh", "-c", "true"])

    def test_linux_device_redirection_supports_concurrent_atomic_writes(self):
        import subprocess
        import sys
        import tempfile
        from concurrent.futures import ThreadPoolExecutor
        from pathlib import Path
        from tool_process import sandbox_command
        if sys.platform != "linux":
            self.skipTest("Requires the real Linux bubblewrap device mount")
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            workspace, protected, assigned = [root / name for name in ("workspace", "protected", "assigned")]
            for directory in (workspace, protected, assigned):
                directory.mkdir()
            (protected / "secret").write_text("MUST_NOT_READ")
            (assigned / "SKILL.md").write_text("Assigned instructions")
            script = ('set -eu; test -c /dev/null; : < /dev/null; : > /dev/null; '
                'test ! -e "$3/secret"; test -r "$4/SKILL.md"; '
                'if printf forbidden > "$4/changed" 2>/dev/null; then exit 23; fi; '
                'tmp="$(mktemp "$1/.device-write.XXXXXX" 2>/dev/null)"; '
                'printf "%s" "$2" > "$tmp"; mv "$tmp" "$1/$2"')
            def write(index):
                name = f"write-{index}"
                command = sandbox_command(["/bin/sh", "-c", script, "fixture", str(workspace), name, str(protected), str(assigned)],
                    cwd=str(workspace), policy={"protectedPaths": [str(protected)]}, assigned=[str(assigned)])
                subprocess.run(command, check=True, capture_output=True, timeout=10)
                self.assertEqual((workspace / name).read_text(), name)
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(write, range(16)))
            self.assertEqual(len(list(workspace.iterdir())), 16)
            self.assertFalse((assigned / "changed").exists())
            self.assertEqual((protected / "secret").read_text(), "MUST_NOT_READ")


class NoAuth(unittest.TestCase):
    def test_no_auth_omits_sdk_headers_and_metadata_probe_credentials(self):
        import openai
        import anthropic
        import httpx
        from agent import model_metadata
        classes = [openai.OpenAI, openai.AsyncOpenAI, anthropic.Anthropic, anthropic.AsyncAnthropic]
        original = [c.__init__ for c in classes]
        metadata = model_metadata._auth_headers
        requests = []
        try:
            install_no_auth_transport("http://127.0.0.1:9876/v1")
            with openai.OpenAI(base_url="http://127.0.0.1:9876/v1", api_key="no-key-required", http_client=httpx.Client(transport=httpx.MockTransport(
                lambda req: requests.append(req) or httpx.Response(200, json={"data": []})
            ))) as client:
                client.models.list()
            self.assertNotIn("Authorization", requests[0].headers)
            self.assertEqual(model_metadata._auth_headers("no-key-required"), {})
        finally:
            for cls, constructor in zip(classes, original):
                cls.__init__ = constructor
            model_metadata._auth_headers = metadata


if __name__ == "__main__":
    unittest.main()

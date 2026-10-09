"""Paperclip's version-pinned boundary around Hermes's native ACP agent.

No agent loop lives here. Control messages, restore failures, and input forms
are adapted to the runner; inference, tools and conversation history are Hermes.
"""
from __future__ import annotations

import asyncio
from urllib.parse import urlsplit, urlunsplit
import concurrent.futures
import json
import math
import os
import uuid
from collections import deque
from pathlib import Path

import acp
from acp_adapter.server import HermesACPAgent, _history_replay_updates, _mcp_server_config
from acp_adapter.session import SessionManager, _parse_model_config, _expand_acp_enabled_toolsets
from acp_adapter.events import _send_update, make_step_cb
from acp_adapter.tools import build_tool_start, build_tool_complete
from policy import authorize_tool, REPORTING_TOOLS
from tool_process import tool_policy, install_tool_process_policy

EXTENSION_VERSION = 1
ANSWER_MAX_LENGTH = 65536
USAGE_COUNTERS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "estimated_cost_usd")


def usage_snapshot(agent):
    return {key: getattr(agent, "session_" + key, 0) for key in USAGE_COUNTERS}


def turn_usage(before, after, receipts):
    # Hermes session counters include earlier prompts. ACPX prompt receipts must
    # contain only this prompt, with cache buckets disjoint from uncached input.
    if not receipts or not all(receipts):
        return None
    delta = {key: after[key] - before[key] for key in USAGE_COUNTERS}
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in delta.values()):
        raise ValueError("Hermes usage counters changed incompatibly during the turn")
    return acp.schema.Usage(input_tokens=delta["input_tokens"], output_tokens=delta["output_tokens"],
                            cached_read_tokens=delta["cache_read_tokens"], cached_write_tokens=delta["cache_write_tokens"],
                            thought_tokens=0, total_tokens=delta["total_tokens"])


class ChannelClient:
    def __init__(self, client):
        self.client = client

    def __getattr__(self, name):
        return getattr(self.client, name)

    async def session_update(self, session_id, update, **kwargs):
        if getattr(update, "session_update", None) == "agent_thought_chunk" and getattr(update, "message_id", None):
            update = update.model_copy(update={"message_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "paperclip:hermes:thought:" + update.message_id))})
        return await self.client.session_update(session_id, update, **kwargs)


def question_set(question, choices=None, multi_select=False, questions=None):
    source = questions if questions is not None else [
        {"question": question, "choices": choices, "multi_select": multi_select}
    ]
    if not isinstance(source, list) or not 1 <= len(source) <= 5:
        raise ValueError("Hermes questions must contain one to five questions")
    result = []
    for i, item in enumerate(source):
        text = item.get("question")
        options = item.get("choices") or []
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ValueError("Invalid Hermes question")
        if not isinstance(options, list) or len(options) > 4 or any(
            not isinstance(option, str) or not option or len(option) > 1000 for option in options
        ):
            raise ValueError("Invalid Hermes question choices")
        entry = {"id": item.get("qid", f"q{i}"), "prompt": text, "required": True,
                 "textValidation": {"maxLength": ANSWER_MAX_LENGTH},
                 "answerMode": ("multi_select" if item.get("multi_select") else "single_select") if options else "text"}
        if options:
            entry["options"] = [{"id": f"o{j}", "label": label} for j, label in enumerate(options)]
            entry["customAnswer"] = {"enabled": True}
        result.append(entry)
    return {"schema": "paperclip.question_set.v1", "questions": result}


def native_answers(form, response, batch):
    if response.get("outcome") != "answered":
        return {"answers": {}, "timed_out": True, "notice": "Question cancelled"} if batch else None
    answers = response.get("answers")
    if not isinstance(answers, dict) or set(answers) != {q["id"] for q in form["questions"]}:
        raise ValueError("Incomplete Hermes answer")
    values = {}
    for question in form["questions"]:
        answer = answers[question["id"]]
        if not isinstance(answer, dict):
            raise ValueError("Invalid Hermes answer")
        options = {o["id"]: o["label"] for o in question.get("options", [])}
        selected = answer.get("selectedOptionIds", [])
        if not isinstance(selected, list) or len(set(selected)) != len(selected) or any(i not in options for i in selected):
            raise ValueError("Unknown Hermes answer choice")
        if question["answerMode"] == "single_select" and len(selected) > 1:
            raise ValueError("Hermes question allows one answer")
        parts = [options[i] for i in selected]
        for name in ("text", "customText"):
            value = answer.get(name)
            if value is not None:
                # Match the canonical form's JavaScript string length, including
                # astral characters and unpaired surrogates, for custom text too.
                if not isinstance(value, str) or len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > ANSWER_MAX_LENGTH:
                    raise ValueError("Invalid Hermes text answer")
                if value.strip():
                    parts.append(value)
        if not parts:
            raise ValueError("Missing Hermes answer")
        values[question["id"]] = parts if question["answerMode"] == "multi_select" else ", ".join(parts)
    return {"answers": values} if batch else next(iter(values.values()))


class ManagedSessionManager(SessionManager):
    def _persist(self, state):
        db = self._get_db()
        if db is None:
            raise ValueError("Hermes session database is unavailable")
        if not state.history:
            return  # Native session/new probes have no conversation yet.
        agent = state.agent
        head = getattr(agent, "session_id", state.session_id)
        if getattr(agent, "_session_db", None) is db:
            # The native writer preserves archived compaction generations. Retry
            # its bounded flush and require its explicit durability receipt.
            if agent._flush_messages_to_session_db(state.history) is not True:
                raise ValueError("Hermes conversation could not be saved")
            db.flush_token_counts()
        else:
            if db.get_session(head) is None:
                db.create_session(session_id=head, source="acp", model=state.model, cwd=state.cwd)
            db.replace_messages(head, state.history, active_only=True)
        meta = {"cwd": state.cwd, "paperclip_head": head}
        for key in ("provider", "base_url", "api_mode"):
            value = getattr(agent, key, None)
            if isinstance(value, str) and value.strip():
                meta[key] = value.strip()
        for identity in {state.session_id, head}:
            row = db.get_session(identity)
            if row is None or row.get("source") != "acp":
                raise ValueError("Hermes saved session identity is missing")
            db.update_session_meta(identity, json.dumps(meta), str(state.model))
        if not db.get_messages_as_conversation(head):
            raise ValueError("Hermes saved conversation is empty")

    def _restore(self, session_id):
        # Native _restore catches history errors and substitutes []; that is not
        # a successful runner recovery. Read once and install exactly that data.
        db = self._get_db()
        if db is None:
            raise ValueError("Hermes session database is unavailable")
        row = db.get_session(session_id)
        if row is None or row.get("source") != "acp":
            raise ValueError("Hermes session history is missing")
        # A native compaction rotates the database identity, while ACP keeps a
        # stable conversation handle. Follow only the native compression chain;
        # an ended parent with a missing child must never replay stale history.
        head = db.get_compression_tip(session_id)
        head_row = db.get_session(head) if isinstance(head, str) else None
        if head_row is None or head_row.get("source") != "acp" or head_row.get("end_reason") == "compression":
            raise ValueError("Hermes compacted session history is missing")
        recorded = _parse_model_config(row.get("model_config")).get("paperclip_head")
        if recorded and recorded not in db.get_compression_chain(session_id):
            raise ValueError("Hermes recorded session head is missing")
        history = db.get_messages_as_conversation(head, repair_alternation=True)
        if not isinstance(history, list) or not history:
            raise ValueError("Hermes session history is empty or unreadable")
        meta = _parse_model_config(row.get("model_config"))
        if not meta.get("cwd"):
            raise ValueError("Hermes session workspace identity is missing")
        agent = self._make_agent(session_id=head, cwd=meta["cwd"], model=row.get("model"),
                                 api_mode=meta.get("api_mode"), requested_provider=meta.get("provider"),
                                 base_url=meta.get("base_url"))
        return self._install_state(session_id, agent, meta["cwd"], row.get("model") or agent.model,
                                   history, persist=False)

    def _make_agent(self, **kwargs):
        # Validate the configured route before native construction can try its
        # permissive default-provider fallback.
        if self._agent_factory is None:
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            config = load_config()
            model = config["model"]
            runtime = resolve_runtime_provider(requested=model["provider"], target_model=model["default"])
            if kwargs.get("model") not in (None, model["default"]):
                raise ValueError("Hermes restored model differs from the selected connection")
            for argument, field in (("requested_provider", "provider"), ("base_url", "base_url"), ("api_mode", "api_mode")):
                actual, expected = kwargs.get(argument), runtime.get(field)
                if argument == "base_url" and isinstance(actual, str) and isinstance(expected, str):
                    # SDK clients normalize a base URL by appending a slash.
                    # Compare only that normalization; query, host and protocol
                    # remain exact and Paperclip pins the connection fingerprint.
                    def normalize(url):
                        parts = urlsplit(url)
                        return urlunsplit(parts._replace(path=parts.path.rstrip("/")))
                    actual, expected = normalize(actual), normalize(expected)
                if actual is not None and actual != expected:
                    raise ValueError("Hermes restored route differs from the selected connection")
        agent = super()._make_agent(**kwargs)
        agent.ephemeral_system_prompt = os.environ.get("PAPERCLIP_HERMES_SYSTEM_INSTRUCTIONS", "")
        # Authorized attachments belong to the selected model. Never route an
        # unknown vision model through Hermes's auxiliary image-description API.
        agent._model_supports_vision = lambda: True
        return agent


class ManagedHermesACPAgent(HermesACPAgent):
    def __init__(self, session_manager=None):
        super().__init__(session_manager or ManagedSessionManager())
        self._active = None
        self._pending_questions = set()
        self._negotiated = False
        self._dispatch_original = None
        self._usage_before = None

    def _build_model_state(self, state):
        from acp.schema import ModelInfo, SessionModelState
        # Paperclip has already resolved the account, endpoint and exact model.
        # Native picker IDs add a provider prefix, which is not the model ID.
        model = str(state.model)
        return SessionModelState(current_model_id=model,
                                 available_models=[ModelInfo(model_id=model, name=model)])

    async def set_session_model(self, model_id, session_id, **kwargs):
        from acp.schema import SetSessionModelResponse
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        if state is None or model_id != state.model:
            raise ValueError("Change the model through Paperclip Connections")
        return SetSessionModelResponse()

    async def set_config_option(self, *args, **kwargs):
        raise ValueError("Change runtime configuration through Paperclip")

    async def initialize(self, *args, **kwargs):
        capabilities = kwargs.get("client_capabilities")
        meta = getattr(capabilities, "field_meta", None) or {}
        self._negotiated = meta.get("paperclipHermes", {}).get("version") == EXTENSION_VERSION
        response = await super().initialize(*args, **kwargs)
        response.agent_capabilities.field_meta = {"paperclipHermes": {
            "version": EXTENSION_VERSION, "steering": True, "questions": True,
            "queuedFollowUp": False, "strictRestore": True,
        }}
        return response

    async def _replay_session_history(self, state):
        if not self._conn:
            raise ValueError("Hermes history replay has no client")
        if self._negotiated:
            # Paperclip restores its durable transcript independently. Native
            # history has already been strictly loaded into the agent; replay
            # notifications must not be mistaken for this turn's live output.
            return
        for update in _history_replay_updates(state.history):
            await self._conn.session_update(session_id=state.session_id, update=update)

    async def _session_response_fields(self, state, replay_verb=None):
        # Avoid the native best-effort replay wrapper swallowing a broken stream.
        if replay_verb:
            await self._replay_session_history(state)
        return await super()._session_response_fields(state)

    async def _register_session_mcp_servers(self, state, mcp_servers):
        # Native registration is best-effort. Assigned Paperclip authority must
        # be present before a turn starts, including after process restoration.
        if not mcp_servers:
            return
        from tools.mcp_tool_discovery import register_mcp_servers
        from tools.registry import registry
        from model_tools import get_tool_definitions
        from agent.memory_manager import inject_memory_provider_tools
        await asyncio.to_thread(register_mcp_servers, {server.name: _mcp_server_config(server) for server in mcp_servers})
        agent = state.agent
        agent.enabled_toolsets = _expand_acp_enabled_toolsets(agent.enabled_toolsets, [server.name for server in mcp_servers])
        agent.tools = get_tool_definitions(enabled_toolsets=agent.enabled_toolsets,
            disabled_toolsets=agent.disabled_toolsets, quiet_mode=True)
        agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools or []}
        inject_memory_provider_tools(agent)
        agent._invalidate_system_prompt()
        for server in mcp_servers or []:
            names = set(registry.get_tool_names_for_toolset("mcp-" + server.name))
            if not names or not names.issubset(state.agent.valid_tool_names):
                raise ValueError(f"Hermes could not load an assigned Paperclip tool bridge ({len(names)} registered, {len(names & state.agent.valid_tool_names)} exposed)")

    async def resume_session(self, cwd, session_id, mcp_servers=None, **kwargs):
        if await asyncio.to_thread(self.session_manager.get_session, session_id) is None:
            raise ValueError("Hermes session history is missing")
        return await super().resume_session(cwd, session_id, mcp_servers, **kwargs)

    async def prompt(self, prompt, session_id, **kwargs):
        if not self._negotiated:
            raise ValueError("Paperclip Hermes extension v1 was not negotiated")
        if self._active is not None:
            raise ValueError("Hermes already has an active turn; queue work in Paperclip")
        token = str(uuid.uuid4())
        self._active = (session_id, token)
        try:
            state = await asyncio.to_thread(self.session_manager.get_session, session_id)
            if state is None:
                raise ValueError("Hermes session is unavailable")
            self._usage_before = usage_snapshot(state.agent)
            state.agent._paperclip_usage_receipts = []
            state.agent._paperclip_cost_receipts = []
            await self._conn.ext_notification("hermes/turn_started", {
                "version": EXTENSION_VERSION, "sessionId": session_id, "turnToken": token,
            })
            return await super().prompt(prompt, session_id, **kwargs)
        finally:
            self._active = None
            self._usage_before = None
            for future in tuple(self._pending_questions):
                future.cancel()

    def _build_usage_update(self, state):
        update = super()._build_usage_update(state)
        if update is not None:
            # Native cost is a cumulative model-price estimate, not billed USD.
            update.cost = None
        return update

    async def _finish_turn(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
        response = await super()._finish_turn(state, session_id, conn, result, pre_turn_hermes_id, streamed_message)
        before = self._usage_before
        if before is None:
            raise ValueError("Hermes turn accounting is unavailable")
        after = usage_snapshot(state.agent)
        receipts = state.agent._paperclip_usage_receipts
        response.usage = turn_usage(before, after, receipts)
        costs = state.agent._paperclip_cost_receipts
        estimated = bool(costs) and all(costs) and response.usage is not None
        await conn.ext_notification("hermes/usage", {
            "version": EXTENSION_VERSION, "sessionId": session_id, "turnToken": self._active[1],
            "tokens": "reported" if response.usage is not None else "unavailable",
            "cost": "estimated" if estimated else "unavailable",
            **({"estimatedUsd": after["estimated_cost_usd"] - before["estimated_cost_usd"]} if estimated else {}),
        })
        return response

    def _handle_slash_command(self, *args, **kwargs):
        # Model, scheduling, queue and permission changes belong to the controller.
        # A literal slash-leading user message remains ordinary model input.
        return None

    async def ext_method(self, method, params):
        if method != "hermes/steer" or not self._negotiated or params.get("version") != EXTENSION_VERSION:
            raise ValueError("Unsupported Hermes extension")
        if self._active != (params.get("sessionId"), params.get("turnToken")):
            return {"accepted": False, "reason": "stale_turn"}
        message = params.get("message")
        if not isinstance(message, str) or not message.strip() or len(message.encode()) > 65536:
            raise ValueError("Invalid Hermes steering message")
        state = await asyncio.to_thread(self.session_manager.get_session, params["sessionId"])
        # Recheck after the await: another prompt may have taken the session.
        if state is None or self._active != (params["sessionId"], params.get("turnToken")):
            return {"accepted": False, "reason": "stale_turn"}
        with state.runtime_lock:
            if not state.is_running or state.cancel_event.is_set():
                return {"accepted": False, "reason": "unavailable"}
            accepted = state.agent.redirect(message)
        return {"accepted": bool(accepted), "turnToken": params["turnToken"]}

    def _wire_turn_callbacks(self, state, session_id, conn, loop):
        conn = ChannelClient(conn)
        callbacks = super()._wire_turn_callbacks(state, session_id, conn, loop)
        token = self._active[1]
        # The generic ACP progress callback pairs completions FIFO by tool name.
        # Native start/complete callbacks carry the actual call ID, including
        # overlapping invocations and out-of-order completion of the same tool.
        calls, metadata = callbacks.tool_call_ids, callbacks.tool_call_meta
        completed_denials = set()
        turn_state = {"saw_completion": True}

        def tool_start(call_id, name, args):
            snapshot = None
            if name in {"write_file", "patch", "skill_manage"}:
                from agent.display import capture_local_edit_snapshot
                snapshot = capture_local_edit_snapshot(name, args)
            calls.setdefault(name, deque()).append(call_id)
            metadata[call_id] = {"args": args, "snapshot": snapshot}
            _send_update(conn, session_id, loop, build_tool_start(call_id, name, args))

        def tool_complete(call_id, name, args, result):
            if call_id in completed_denials:
                return
            if call_id not in metadata:
                raise ValueError("Hermes completed an unknown tool call")
            meta = metadata.pop(call_id)
            calls[name].remove(call_id)
            if not calls[name]:
                calls.pop(name)
            result_text = result if isinstance(result, str) else json.dumps(result)
            try:
                envelope = json.loads(result_text)
            except (ValueError, TypeError):
                envelope = None
            # Native policy and MCP transport failures use this exact envelope;
            # an arbitrary successful payload mentioning errors is not a failure.
            is_error = (isinstance(envelope, dict) and set(envelope) == {"error"}
                        and isinstance(envelope["error"], str) and bool(envelope["error"]))
            update = build_tool_complete(
                call_id, name, result=result_text,
                function_args=args, snapshot=meta["snapshot"], is_error=is_error,
            )
            # Hermes deliberately omits raw output for its polished/structured
            # cards. ACPX consumes rawOutput for the runner transcript; keep
            # native content (including diffs) and the original result together.
            _send_update(conn, session_id, loop, update.model_copy(update={"raw_output": result_text}))

        def progress(event, name=None, preview=None, args=None, **details):
            child = details.get("child_session_id") or details.get("subagent_id")
            if event not in {"subagent.start", "subagent.progress", "subagent.tool", "subagent.complete"} or not isinstance(child, str):
                return
            future = asyncio.run_coroutine_threadsafe(conn.ext_notification("hermes/delegation", {
                "version": EXTENSION_VERSION, "sessionId": session_id, "turnToken": token,
                "event": event, "childId": child[:160],
                "delegationId": str(details.get("delegation_id") or child)[:160],
                "model": str(details.get("model") or "")[:200],
                "summary": str(preview or details.get("goal") or "")[:4000],
                "status": str(details.get("status") or "")[:100],
            }), loop)
            future.result(timeout=10)

        state.agent.tool_progress_callback = progress
        state.agent.tool_start_callback = tool_start
        state.agent.tool_complete_callback = tool_complete
        state.agent.step_callback = make_step_cb(conn, session_id, loop, calls, metadata, turn_state)
        if os.environ.get("PAPERCLIP_HERMES_POLICY"):
            from hermes_cli import middleware
            if self._dispatch_original is None:
                self._dispatch_original = middleware.run_tool_execution_middleware
            policy = json.loads(os.environ["PAPERCLIP_HERMES_POLICY"])
            assigned = json.loads(os.environ.get("PAPERCLIP_HERMES_ASSIGNED_SKILLS", "[]"))

            def dispatch(name, args, execute, **kwargs):
                # Both sequential inline tools and concurrent registry tools
                # cross this native execution boundary, including child agents.
                def checked(final_args):
                    return authorized(name, final_args, execute, kwargs.get("tool_call_id"))
                return self._dispatch_original(name, args, checked, **kwargs)

            def authorized(name, args, execute, call_id):
                try:
                    read = authorize_tool(name, args, policy=policy, cwd=state.cwd, assigned_skills=assigned)
                    if self._active != (session_id, token) or state.cancel_event.is_set():
                        raise PermissionError("Paperclip turn has stopped")
                    automatic = (name in REPORTING_TOOLS or name in {"clarify", "todo_list"}
                                 or name in policy.get("paperclipAutomaticTools", []))
                    if policy["permissionMode"] != "approve-all" and not automatic and not (read and policy["permissionMode"] == "approve-reads"):
                        allowed = callbacks.approval_cb(name, json.dumps(args), allow_permanent=False, allow_session=True)
                        if allowed not in {"once", "session"}:
                            raise PermissionError("Paperclip denied this operation")
                    scope = tool_policy.set((policy, assigned))
                    try:
                        return execute(args)
                    finally:
                        tool_policy.reset(scope)
                except PermissionError as error:
                    result = json.dumps({"error": str(error)})
                    # Policy is evaluated before Hermes's dispatch/start hook.
                    # Its executor can therefore return a denied result without
                    # emitting a start, and its later complete hook is too late
                    # to pair it. Project the denial using the native hook ID.
                    if isinstance(call_id, str) and call_id:
                        if call_id not in metadata:
                            tool_start(call_id, name, args)
                        tool_complete(call_id, name, args, result)
                        completed_denials.add(call_id)
                    return result
            middleware.run_tool_execution_middleware = dispatch

        def clarify(question=None, choices=None, multi_select=False, questions=None):
            form = question_set(question, choices, multi_select, questions)
            future = asyncio.run_coroutine_threadsafe(conn.ext_method("hermes/ask_questions", {
                "version": EXTENSION_VERSION, "sessionId": session_id, "turnToken": token, "input": form,
            }), loop)
            self._pending_questions.add(future)
            try:
                while True:
                    if state.cancel_event.is_set() or self._active != (session_id, token):
                        future.cancel()
                        return native_answers(form, {"outcome": "cancelled"}, questions is not None)
                    try:
                        return native_answers(form, future.result(timeout=0.25), questions is not None)
                    except concurrent.futures.TimeoutError:
                        continue
                    except concurrent.futures.CancelledError:
                        return native_answers(form, {"outcome": "cancelled"}, questions is not None)
            finally:
                self._pending_questions.discard(future)

        state.agent.clarify_callback = clarify
        return callbacks

    async def cancel(self, session_id, **kwargs):
        for future in tuple(self._pending_questions):
            future.cancel()
        await super().cancel(session_id, **kwargs)


def main():
    import logging
    # Upstream prompt logging includes user text; only protocol events are durable.
    logging.disable(logging.CRITICAL)
    configure_managed_runtime()
    asyncio.run(acp.run_agent(ManagedHermesACPAgent(), use_unstable_protocol=True))


def configure_managed_runtime():
    install_tool_process_policy()
    from agent import turn_response_check
    original_usage = turn_response_check.record_response_usage

    def record_usage(agent, response, **kwargs):
        result = original_usage(agent, response, **kwargs)
        if hasattr(agent, "_paperclip_usage_receipts"):
            present = bool(getattr(response, "usage", None))
            agent._paperclip_usage_receipts.append(present)
            agent._paperclip_cost_receipts.append(present and getattr(agent, "session_cost_status", None) == "estimated")
        return result

    turn_response_check.record_response_usage = record_usage
    from agent import skill_utils
    assigned = [Path(p) for p in json.loads(os.environ.get("PAPERCLIP_HERMES_ASSIGNED_SKILLS", "[]"))]
    skill_utils.get_external_skills_dirs = lambda: assigned
    skill_utils.get_project_skills_dirs = lambda: []
    # Assigned versions take precedence over a same-named learned skill. The
    # native skill manager recognizes external roots as read-only; only the
    # private home/skills tree participates in managed state collection.
    skill_utils.get_all_skills_dirs = lambda: [*assigned, skill_utils.get_skills_dir()]
    from tools import skills_tool
    skills_tool._skill_search_dirs = lambda: ([], [*assigned, skills_tool._skills_dir()], skills_tool._skills_dir())
    # Never borrow a personal Claude login or write the macOS Keychain.
    from agent import anthropic_credentials
    anthropic_credentials.read_claude_code_credentials = lambda: None
    anthropic_credentials._root_hermes_oauth_file = lambda: None
    from tools.environments import local, local_env_policy
    blocked = {"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "PAPERCLIP_HERMES_AUTH_JSON_SECRET"}
    local._ALWAYS_STRIP_KEYS = frozenset(local._ALWAYS_STRIP_KEYS) | blocked
    local_env_policy._ALWAYS_STRIP_KEYS = local._ALWAYS_STRIP_KEYS
    # Preserve the authoritative Messages header style instead of guessing it
    # from a proxy hostname. This contains no credential values.
    from hermes_cli.config import load_config
    config = load_config()
    route = config.get("paperclip_auth", {})
    if route.get("style") == "none":
        install_no_auth_transport(config["providers"]["paperclip"]["base_url"])
    if route.get("protocol") == "messages":
        from agent import anthropic_adapter
        style = route["style"]
        if style in {"bearer", "api_key"}:
            anthropic_adapter._auth_style = lambda *_: style


def install_no_auth_transport(endpoint):
    """SDK-supported omitted headers, restricted to the selected endpoint."""
    import functools
    import openai
    import anthropic
    from agent import model_metadata
    # Metadata probes use httpx directly, before constructing the SDK client.
    model_metadata._auth_headers = lambda *_args, **_kwargs: {}
    endpoint = endpoint.rstrip("/")
    for sdk, classes, headers in ((openai, (openai.OpenAI, openai.AsyncOpenAI), ("Authorization",)),
                                  (anthropic, (anthropic.Anthropic, anthropic.AsyncAnthropic), ("Authorization", "X-Api-Key"))):
        for cls in classes:
            original = cls.__init__

            @functools.wraps(original)
            def initialize(self, *args, _original=original, _sdk=sdk, _headers=headers, **kwargs):
                actual = str(kwargs.get("base_url", "")).rstrip("/")
                # Hermes's Messages adapter normalizes a trailing /v1 away.
                expected = endpoint.removesuffix("/v1") if _sdk is anthropic else endpoint
                if actual == expected:
                    kwargs["default_headers"] = {**(kwargs.get("default_headers") or {}),
                                                 **{key: _sdk.Omit() for key in _headers}}
                _original(self, *args, **kwargs)

            cls.__init__ = initialize


if __name__ == "__main__":
    main()

"""Credential-free turn-failure regressions executed in the real pinned hermetic SDK."""


def _paperclip_turn_failure_regressions():
  import asyncio
  import contextlib
  import socket
  import subprocess
  import sys
  from types import SimpleNamespace
  from unittest import mock
  from google.antigravity import types as sdk_types
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.server import AgyAdapter, SessionInfo
  from google3.learning.genai.api.localharness import localharness_pb2 as pb
  # This regression runs while server.py imports this module, before server.py
  # calls install; install is idempotent, so the later call is a no-op.
  install(AgyAdapter)

  # Provider strings as the live 1.5.2 helper rendered them (API keys removed).
  zero_quota = ("agent executor error: Error 429, Message: You exceeded your current quota, please check your plan and billing details.\n"
                "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.8-flash\n"
                "Please retry in 4h33m54.066207256s., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.QuotaFailure violations:[map[quotaValue:0]]]]")
  per_minute = ("Error 429, Message: You exceeded your current quota.\n* Quota exceeded for metric: generate_content_requests, limit: 15, model: gemini-3.8-flash\n"
                "Please retry in 23.5s., Status: RESOURCE_EXHAUSTED, Details: []")
  overloaded = ("Encountered retryable error from model provider: Agent execution terminated due to error. (\"Error 503, Message: This model is currently"
                " experiencing high demand. Spikes in demand are usually temporary. Please try again later., Status: UNAVAILABLE, Details: []\")")
  subscription = "Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo reason:QUOTA_EXHAUSTED metadata:map[quotaResetDelay:2h0m0s]]]"
  bad_key = "Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo reason:API_KEY_INVALID]]"
  missing = "Error 404, Message: models/gemini-4-neon is not found for API version v1beta, Status: NOT_FOUND, Details: []"
  assert classify_turn_failure(zero_quota) == {"kind": "model_unavailable", "httpStatus": 429, "status": "RESOURCE_EXHAUSTED"}
  assert classify_turn_failure(per_minute) == {"kind": "rate_limit", "httpStatus": 429, "status": "RESOURCE_EXHAUSTED", "retryAfterSeconds": 23}
  assert classify_turn_failure(overloaded) == {"kind": "overloaded", "httpStatus": 503, "status": "UNAVAILABLE"}
  assert classify_turn_failure(subscription)["kind"] == "quota_exhausted"
  assert classify_turn_failure(bad_key)["kind"] == "authentication"
  assert classify_turn_failure(missing)["kind"] == "model_unavailable"
  # A typed connection error for 401 carries only the step's HTTP code.
  assert classify_turn_failure("System error occurred.", 401) == {"kind": "authentication", "httpStatus": 401}
  assert classify_turn_failure("anything", 0, True) == {"kind": "connection"}
  assert classify_turn_failure("opaque failure") == {"kind": "unknown"}

  # Managed native configs retry briefly and keep exactly the workspace rule files.
  config = pb.HarnessConfig()
  config.rules_config.filenames.extend(MANAGED_RULE_FILENAMES)
  assert not config.retry_config.HasField("api_retry")
  for key, value in MANAGED_API_RETRY.items():
    setattr(config.retry_config.api_retry, key, value)
  assert config.retry_config.api_retry.max_retries == 3
  total = sum(MANAGED_API_RETRY["initial_sleep_duration_ms"] * MANAGED_API_RETRY["exponential_multiplier"] ** attempt for attempt in range(MANAGED_API_RETRY["max_retries"]))
  assert total <= 30_000, "bounded native retries must end well inside the five-minute silence watchdog"

  sid = "offline-turn-failure"
  model = "gemini-3.8-flash-low"
  admission = {"schema": SCHEMA, "nonce": "turn-failure", "model": model, "digest": "sha256:" + "0" * 64, "byteLength": 0, "content": ""}

  class Client:
    def __init__(self):
      self.updates = []

    async def session_update(self, session_id, update):
      self.updates.append(update)

  class Agent:
    def __init__(self, scenario):
      self.scenario = scenario
      self.model_id = model
      self._strategy = SimpleNamespace(_paperclip_native_admission={k: admission[k] for k in ("schema", "nonce", "model", "digest", "byteLength")} | {"sessionId": sid, "connectionId": "c"})
      self.conversation = SimpleNamespace(receive_steps=self.receive_steps)

    async def chat(self, prompt):
      if self.scenario == "connection":
        raise sdk_types.AntigravityConnectionError("System error occurred.")
      return SimpleNamespace(stop_reason=None)

    async def receive_steps(self):
      if self.scenario in ("overloaded", "zero_quota"):
        yield sdk_types.Step(id="retry", trajectory_id=sid, type=sdk_types.StepType.UNKNOWN, source=sdk_types.StepSource.SYSTEM,
                             status=sdk_types.StepStatus.ERROR, error="retrying")
        raise sdk_types.AntigravityExecutionError(overloaded if self.scenario == "overloaded" else zero_quota)
      if self.scenario == "success-after-retry":
        step = sdk_types.Step(id="retry", trajectory_id=sid, type=sdk_types.StepType.UNKNOWN, source=sdk_types.StepSource.SYSTEM,
                              status=sdk_types.StepStatus.ERROR, error="retrying")
        yield step

  class Adapter(AgyAdapter):
    async def _observe_usage(self, session_id):
      pass

    async def _maybe_refresh_admin_controls_for_turn(self, session_id):
      pass

    async def _maybe_apply_model_switch(self, session_id):
      pass

    async def _send_citation_notice(self, session_id):
      pass

    def _ensure_auth_state(self):
      return SimpleNamespace(method_id="gemini-api-key")

  def forbidden(*args, **kwargs):
    raise AssertionError("offline turn-failure regression reached network or process launch")

  async def turn(scenario):
    adapter = Adapter()
    adapter._client = Client()
    info = SessionInfo(agent=Agent(scenario), stack=contextlib.AsyncExitStack(), cwd="/", current_model_id=model)
    info.agent_model_id = model
    info.mode_id = "default"
    info.system_prompt = ""
    adapter._sessions[sid] = info
    adapter._paperclip_managed_sessions = {sid: admission}
    result = await adapter.prompt([{"type": "text", "text": "work"}], sid)
    return result, adapter._client.updates

  async def run():
    result, updates = await turn("overloaded")
    assert result.stop_reason == "end_turn", "1.5.2 itself still reports end_turn"
    failure = result.field_meta["paperclipAntigravityFailure"]
    assert failure == {"schema": TURN_FAILURE_SCHEMA, "kind": "overloaded", "httpStatus": 503, "status": "UNAVAILABLE", "model": model, "route": "api_key"}
    air = result.field_meta["jetbrains"]["air"]["sessionFailure"]
    assert air["severity"] == "error" and air["category"] == "service" and "high demand" in air["title"]
    assert any(getattr(update, "session_update", "") == "agent_message_chunk" for update in updates)

    result, _ = await turn("zero_quota")
    failure = result.field_meta["paperclipAntigravityFailure"]
    assert failure["kind"] == "model_unavailable" and failure["route"] == "api_key" and failure["model"] == model
    title = result.field_meta["jetbrains"]["air"]["sessionFailure"]["title"]
    assert "quota" not in title.lower(), "a model refusal never forwards provider wording"

    result, _ = await turn("connection")
    assert result.field_meta["paperclipAntigravityFailure"]["kind"] == "unknown", "no model HTTP code was observed"

    result, _ = await turn("success-after-retry")
    assert not (result.field_meta or {}).get("paperclipAntigravityFailure"), "a retried turn that recovered is not a failure"
    assert _TURN.get() is None

  with contextlib.ExitStack() as stack:
    for owner, name in ((socket, "create_connection"), (subprocess, "Popen"), (asyncio, "create_subprocess_exec")):
      stack.enter_context(mock.patch.object(owner, name, side_effect=forbidden))
    asyncio.run(run())
  sys.stderr.write("paperclip-turn-failure-regressions: passed\n")


_paperclip_turn_failure_regressions()

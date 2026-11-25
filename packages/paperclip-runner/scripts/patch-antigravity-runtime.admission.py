"""Paperclip-owned admission for the pinned Antigravity 1.5.2 native runtime.

Loaded inside Google's hermetic distribution on every patched platform. No
credentials or prompt content are persisted in receipts. Native creation must
acknowledge the exact config before the ACP client receives authority to send
a managed prompt.
"""
import asyncio
import contextvars
import ctypes
import dataclasses
import functools
import hashlib
import os
import stat
import re
import sys
import uuid

from acp import exceptions
from google.antigravity import types as sdk_types
from google3.cloud.developer_experience.antigravity_extensions.acp_server import api_errors
from google3.cloud.developer_experience.antigravity_extensions.acp_server import browser_subagent
from google3.cloud.developer_experience.antigravity_extensions.acp_server import model_selection
from google3.cloud.developer_experience.antigravity_extensions.acp_server.ccpa_connection import quota_errors
from google3.cloud.developer_experience.antigravity_extensions.acp_server import paperclip_native_identity
from google3.cloud.developer_experience.antigravity_extensions.acp_server import request_meta
from google3.cloud.developer_experience.antigravity_extensions.acp_server import system_prompt
from google3.cloud.developer_experience.antigravity_extensions.acp_server import hooks as acp_hooks
from google3.cloud.developer_experience.antigravity_extensions.acp_server import tool_filter
from google3.cloud.developer_experience.antigravity_extensions.acp_server.oauth.credential_manager import OAuthCredentialManager

SCHEMA = "paperclip.antigravity.admission.v1"
MODELS_SCHEMA = "paperclip.antigravity.models.v1"
TURN_FAILURE_SCHEMA = "paperclip.antigravity.turn_failure.v1"
_CONTEXT = contextvars.ContextVar("paperclip_antigravity_admission", default=None)
# One managed prompt's provider failure evidence; never shared across turns.
_TURN = contextvars.ContextVar("paperclip_antigravity_turn", default=None)
# 1.5.2 retries model API errors for minutes without any ACP event. A managed
# turn retries briefly (about 14 seconds of backoff) and then fails with a
# classified provider failure that Paperclip's own capacity retry owns.
MANAGED_API_RETRY = {"max_retries": 3, "initial_sleep_duration_ms": 2000, "exponential_multiplier": 2.0}
# Rule files 1.5.2 discovers in the workspace and in the private GEMINI_HOME.
# Workspace rules are repository guidance, as Codex reads AGENTS.md; the
# Paperclip instructions stay the exact, receipted system prompt section.
MANAGED_RULE_FILENAMES = ("GEMINI.md", "AGENTS.md")


def _fail(message):
  # Structured data names an admission refusal without matching its text.
  raise exceptions.RequestError(code=-32602, message="Paperclip admission: " + message, data={"paperclipAdmission": "refused"})


_GO_API_ERROR = re.compile(r"Error (?P<code>\d{3}), Message: (?P<message>.+?), Status: (?P<status>[A-Z_]+)", re.DOTALL)
_ERROR_REASON = re.compile(r"\breason:(?P<reason>[A-Z_]+)")
_QUOTA_LIMIT = re.compile(r"\blimit: (?P<limit>\d+)")
_RETRY_DELAY = re.compile(r"(?:retry in |retryDelay:)(?P<value>(?:\d+(?:\.\d+)?(?:ms|h|m|s))+)")
_GO_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")
_AIR_CATEGORY = {
    "model_unavailable": "request", "invalid_request": "request", "quota_exhausted": "limit", "rate_limit": "limit",
    "authentication": "access", "permission": "access", "overloaded": "service", "timeout": "service",
    "connection": "connection", "unknown": "unknown",
}


def _go_seconds(value):
  units = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}
  return sum(float(amount) * units[unit] for amount, unit in _GO_DURATION_PART.findall(value))


def classify_turn_failure(raw, http_code=0, connection_lost=False):
  """Classify one terminal native failure from its structured fields.

  The model step carries the HTTP code; the terminal SDK error carries Go's
  `Error <code>, Message: ..., Status: <STATUS>` rendering with ErrorInfo and
  QuotaFailure details. The message text itself is never interpreted.
  """
  if connection_lost:
    return {"kind": "connection"}
  raw = raw if isinstance(raw, str) else ""
  match = _GO_API_ERROR.search(raw)
  code = int(match.group("code")) if match else (http_code if isinstance(http_code, int) and 400 <= http_code <= 599 else 0)
  status = match.group("status") if match else ""
  reasons = {item.group("reason") for item in _ERROR_REASON.finditer(raw)}
  delay = _RETRY_DELAY.search(raw)
  retry_after = _go_seconds(delay.group("value")) if delay else None
  if "QUOTA_EXHAUSTED" in reasons:
    kind = "quota_exhausted"
  elif code == 429 or status == "RESOURCE_EXHAUSTED":
    limits = [int(item.group("limit")) for item in _QUOTA_LIMIT.finditer(raw)]
    # A zero quota means this key's plan cannot use the model at all.
    kind = "model_unavailable" if limits and all(limit == 0 for limit in limits) else "rate_limit"
  elif code == 404 or status == "NOT_FOUND":
    kind = "model_unavailable"
  elif "API_KEY_INVALID" in reasons or code == 401 or status == "UNAUTHENTICATED":
    kind = "authentication"
  elif code == 403 or status == "PERMISSION_DENIED":
    kind = "permission"
  elif code in (500, 502, 503, 529) or status in ("UNAVAILABLE", "INTERNAL"):
    kind = "overloaded"
  elif code == 504 or status == "DEADLINE_EXCEEDED":
    kind = "timeout"
  elif code == 400 or status in ("INVALID_ARGUMENT", "FAILED_PRECONDITION"):
    kind = "invalid_request"
  else:
    kind = "unknown"
  result = {"kind": kind}
  if code:
    result["httpStatus"] = code
  if status:
    result["status"] = status
  if kind == "rate_limit":
    # A per-minute limit carries no delay; one minute is its natural window.
    result["retryAfterSeconds"] = int(retry_after) if retry_after else 60
  elif retry_after and kind == "quota_exhausted":
    result["retryAfterSeconds"] = int(retry_after)
  return result


def _failure_title(kind, raw):
  if kind == "model_unavailable":
    # Never forward provider wording here; Paperclip names the model itself.
    return "The selected model is not available for this connection."
  if kind == "connection":
    return "Google Antigravity lost its connection to the model service."
  return quota_errors.quota_exhausted_message(raw) or api_errors.format_execution_error(raw)


def observe_step(step):
  """Record a native SYSTEM step error's HTTP code for the active managed turn."""
  turn = _TURN.get()
  if turn is None or step.status != sdk_types.StepStatus.ERROR or step.source != sdk_types.StepSource.SYSTEM:
    return
  http_code = getattr(step, "http_code", 0)
  turn["httpCode"] = http_code if isinstance(http_code, int) else 0


def turn_failure_meta(turn, admission, route):
  """The prompt response `_meta` for a managed turn the native server ended with an error."""
  if not turn or ("raw" not in turn and not turn.get("connectionLost")):
    return None
  failure = classify_turn_failure(turn.get("raw"), turn.get("httpCode", 0), turn.get("connectionLost", False))
  air = {"severity": "error", "category": _AIR_CATEGORY[failure["kind"]], "title": _failure_title(failure["kind"], turn.get("raw") or "")}
  return {
      "jetbrains": {"air": {"version": 1, "sessionFailure": air}},
      "paperclipAntigravityFailure": {"schema": TURN_FAILURE_SCHEMA, **failure, "model": admission["model"], **({"route": route} if route else {})},
  }


def _read_request(kwargs):
  meta = request_meta.antigravity_meta_from_request_kwargs(kwargs)
  value = meta.get("paperclipAdmission")
  if value is None:
    return None
  if not isinstance(value, dict) or set(value) != {
      "schema", "nonce", "model", "digest", "byteLength"
  }:
    _fail("invalid request fields")
  if value["schema"] != SCHEMA:
    _fail("unsupported schema")
  for key in ("nonce", "model"):
    if not isinstance(value[key], str) or not 1 <= len(value[key]) <= 512:
      _fail("invalid " + key)
  if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(value["digest"])):
    _fail("invalid instruction digest")
  prompt = meta.get("systemPrompt")
  if not isinstance(prompt, dict) or set(prompt) != {"append"} or not isinstance(prompt["append"], str):
    _fail("exact systemPrompt.append is required, including empty content")
  content = prompt["append"].encode("utf-8")
  if type(value["byteLength"]) is not int or value["byteLength"] != len(content):
    _fail("instruction byte length mismatch")
  if value["digest"] != "sha256:" + hashlib.sha256(content).hexdigest():
    _fail("instruction digest mismatch")
  return {**value, "content": prompt["append"]}


def _owned_executable_path():
  """The kernel's record of this process image, never argv or the environment."""
  if sys.platform == "darwin":
    executable_path = ctypes.create_string_buffer(4096)
    path_size = ctypes.c_uint32(len(executable_path))
    get_executable_path = ctypes.CDLL("/usr/lib/libSystem.B.dylib")._NSGetExecutablePath
    get_executable_path.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    get_executable_path.restype = ctypes.c_int
    if get_executable_path(executable_path, ctypes.byref(path_size)) != 0:
      _fail("cannot resolve the owned native executable path")
    return os.path.realpath(os.fsdecode(executable_path.value))
  if sys.platform.startswith("linux"):
    try:
      path = os.readlink("/proc/self/exe")
    except OSError:
      _fail("cannot resolve the owned native executable path")
    if not os.path.isabs(path) or path.endswith(" (deleted)"):
      _fail("cannot resolve the owned native executable path")
    return os.path.realpath(path)
  _fail("unsupported native host")


def _native_model_matches(target, requested):
  """Whether one native text target is exactly the requested `<family>-<level>` id.

  Personal sign-in sends the id literally. API-key, Agent Platform and gateway
  sessions send the catalog's base model with the thinking level as an
  endpoint option. Both forms must resolve to the same catalog entry: the
  base model and the thinking level are checked together, never the family.
  """
  levels = [
      endpoint.options.thinking_level
      for field, endpoint in (
          ("gemini_api_endpoint", target.gemini_api_endpoint),
          ("vertex_endpoint", target.vertex_endpoint),
      )
      if target.HasField(field)
  ]
  if len(levels) > 1:
    return False
  level = levels[0] if levels else ""
  if target.name == requested and not level:
    return True
  metadata = model_selection.DEFAULT_MODEL_METADATA_MAP.get(requested)
  if metadata is None:
    return False
  expected_level = metadata.thinking_level.value if metadata.thinking_level is not None else ""
  return target.name == metadata.base_model_id and level == expected_level


def prepare_native_config(config, strategy):
  """Inspect the protobuf that will actually be sent to this owned harness."""
  admission = _CONTEXT.get()
  if admission is None:
    return None
  helper = os.path.join(os.path.dirname(_owned_executable_path()), "localharness_external")
  helper_stat = os.lstat(helper)
  if not stat.S_ISREG(helper_stat.st_mode) or helper_stat.st_nlink != 1:
    _fail("native helper must be the immutable sibling executable")
  with open(helper, "rb") as helper_file:
    helper_digest = hashlib.file_digest(helper_file, "sha256").hexdigest()
  if helper_digest != paperclip_native_identity.HELPER_SHA256:
    _fail("native sibling helper digest differs")
  # The SDK resolves this attribute in its constructor. Updating the global
  # environment alone cannot replace that already-cached executable path.
  strategy._binary_path = helper
  if strategy._env is not None:
    strategy._env = {**strategy._env, "ANTIGRAVITY_HARNESS_PATH": helper}
  os.environ["ANTIGRAVITY_HARNESS_PATH"] = helper
  targets = [model for model in config.models if 1 in model.types]
  if len(targets) != 1 or not _native_model_matches(targets[0], admission["model"]):
    _fail("native text model differs from the exact requested model")
  instructions = config.system_instructions
  expected = admission["content"]
  if expected:
    if instructions.WhichOneof("type") != "appended":
      _fail("native instruction layering differs")
    sections = instructions.appended.appended_sections
    if len(sections) != 1 or sections[0].content != expected:
      _fail("native instruction content differs")
  elif config.HasField("system_instructions"):
    # Empty content means no appended section, with the normal native defaults.
    if instructions.WhichOneof("type") != "appended" or any(section.content for section in instructions.appended.appended_sections):
      _fail("native empty instruction content differs")
  if not config.cascade_id:
    _fail("native session identity is missing")
  if config.harness_side_tools.subagents.enabled or config.harness_side_tools.run_workflow.enabled or config.custom_subagents:
    _fail("managed subagents, workflows, and browser agents are unavailable")
  if config.harness_side_tools.schedule.enabled:
    _fail("managed timers and recurring schedules belong to Paperclip")
  if tuple(config.rules_config.filenames) != MANAGED_RULE_FILENAMES:
    _fail("native workspace rule discovery differs")
  if not config.retry_config.HasField("api_retry"):
    for key, value in MANAGED_API_RETRY.items():
      setattr(config.retry_config.api_retry, key, value)
  return {
      **admission,
      "sessionId": config.cascade_id,
      "connectionId": uuid.uuid4().hex,
      "configBytes": config.SerializeToString(deterministic=True),
  }


def acknowledge_native_config(prepared, event, config):
  """A receipt exists only after the same native connection acknowledges init."""
  if prepared is None:
    return None
  if not event.HasField("initialize_conversation_response"):
    _fail("native initialization acknowledgment is missing")
  if event.initialize_conversation_response.cascade_id != prepared["sessionId"]:
    _fail("native initialization session differs")
  if config.SerializeToString(deterministic=True) != prepared["configBytes"]:
    _fail("native initialization config changed")
  return {key: prepared[key] for key in (
      "schema", "nonce", "sessionId", "connectionId", "model", "digest", "byteLength"
  )}


def _receipt(adapter, session_id, admission):
  session = adapter._sessions.get(session_id)
  if session is None:
    _fail("native session is missing")
  strategy = getattr(session.agent, "_strategy", None)
  receipt = getattr(strategy, "_paperclip_native_admission", None)
  if not isinstance(receipt, dict) or receipt.get("sessionId") != session_id:
    _fail("native content acknowledgment is missing")
  for key in ("schema", "nonce", "model", "digest", "byteLength"):
    if receipt.get(key) != admission[key]:
      _fail("native content acknowledgment differs: " + key)
  if session.mode_id != "default" or session.system_prompt != admission["content"]:
    _fail("managed mode or instruction state changed")
  if session.current_model_id != admission["model"] or session.agent_model_id != admission["model"]:
    _fail("selected model differs from initialized model")
  return dict(receipt)


def _add_receipt(result, receipt):
  result.field_meta = {**(result.field_meta or {}), "paperclipAntigravityAdmission": receipt}
  return result


def _auth_route(adapter):
  """Which Google connection served the turn, for Paperclip's own model wording."""
  try:
    state = adapter._ensure_auth_state()
  except Exception:  # pylint: disable=broad-except
    return None
  method = getattr(state, "method_id", None)
  return {"gemini-api-key": "api_key", "oauth-personal": "subscription", "oauth-business": "subscription"}.get(method)


def configure_owned_helper_path():
  """Point the SDK at the helper beside this process image.

  The server's own discovery searches beside sys.argv[0] and sys.executable,
  which does not find the helper in the Linux build; the SDK then refuses to
  create any session. Managed sessions still verify the helper's digest in
  prepare_native_config before it is launched.
  """
  if os.environ.get("ANTIGRAVITY_HARNESS_PATH"):
    return
  try:
    helper = os.path.join(os.path.dirname(_owned_executable_path()), "localharness_external")
  except exceptions.RequestError:
    return
  if os.path.isfile(helper):
    os.environ["ANTIGRAVITY_HARNESS_PATH"] = helper


def install(adapter_type):
  configure_owned_helper_path()
  if adapter_type.__dict__.get("_paperclip_admission_installed", False):
    return
  original_initialize = adapter_type.initialize
  original_extract = system_prompt.extract_system_prompt
  original_list_models = adapter_type._list_available_models
  original_create_config = adapter_type._create_agent_config
  original_rebuild = adapter_type._rebuild_session_agent
  original_replace = adapter_type._maybe_replace_unavailable_model
  original_prompt = adapter_type.prompt
  original_connection_lost = getattr(adapter_type, "_send_connection_lost_message", None)
  original_execution_error_message = browser_subagent.execution_error_message
  original_cleanup = adapter_type.cleanup
  original_ext = getattr(adapter_type, "ext_method", None)
  original_oauth_mgr = getattr(adapter_type, "_ensure_oauth_mgr", None)
  original_hooks_config = acp_hooks.load_hooks_config
  original_hooks_config_async = acp_hooks.load_hooks_config_async
  original_has_workspace_hooks = acp_hooks.has_workspace_hooks

  # Bind this to the manager, because later token use occurs in background
  # threads without the request ContextVar. Explicit standalone authenticate
  # uses a separate, unflagged manager and retains its interactive login.
  if not getattr(OAuthCredentialManager._interactive_login_and_store, "_paperclip_managed_guard", False):
    original_interactive_login = OAuthCredentialManager._interactive_login_and_store

    @functools.wraps(original_interactive_login)
    def interactive_login(manager):
      if getattr(manager, "_paperclip_noninteractive", False):
        raise ValueError("Google sign-in must be renewed through Paperclip before this managed task can continue")
      return original_interactive_login(manager)

    interactive_login._paperclip_managed_guard = True
    OAuthCredentialManager._interactive_login_and_store = interactive_login

  def ensure_oauth_mgr(self):
    manager = original_oauth_mgr(self)
    if _CONTEXT.get() is not None or getattr(self, "_paperclip_managed_sessions", {}):
      manager._paperclip_noninteractive = True
    return manager

  def hooks_config(*args, **kwargs):
    return {} if _CONTEXT.get() is not None else original_hooks_config(*args, **kwargs)

  async def hooks_config_async(*args, **kwargs):
    return {} if _CONTEXT.get() is not None else await original_hooks_config_async(*args, **kwargs)

  def has_workspace_hooks(*args, **kwargs):
    return False if _CONTEXT.get() is not None else original_has_workspace_hooks(*args, **kwargs)

  @functools.wraps(original_initialize)
  async def initialize(self, *args, **kwargs):
    if getattr(self, "_paperclip_managed_sessions", {}):
      _fail("cannot renegotiate an initialized managed connection")
    result = await original_initialize(self, *args, **kwargs)
    meta = result.agent_capabilities.field_meta or {}
    meta.setdefault("antigravity", {})["paperclipAdmission"] = 1
    meta["antigravity"]["paperclipModels"] = 1
    result.agent_capabilities.field_meta = meta
    self._paperclip_managed_sessions = {}
    return result

  def extract(kwargs):
    admission = _CONTEXT.get()
    return admission["content"] if admission is not None else original_extract(kwargs)

  def list_models(self, current_model_id):
    admission = _CONTEXT.get()
    selected = admission["model"] if admission is not None else current_model_id
    result = original_list_models(self, selected)
    if admission is not None and result.current_model_id != selected:
      _fail("provider rejected the exact requested model")
    return result

  @functools.wraps(original_create_config)
  async def create_config(self, *args, **kwargs):
    admission = _CONTEXT.get()
    if admission is not None and (
        kwargs.get("model_id") != admission["model"]
        or kwargs.get("system_instructions") != admission["content"]
    ):
      _fail("native model or instruction input differs")
    if admission is not None and kwargs.get("additional_directories"):
      # 1.5.2 lets a client widen the native workspace and file-tool roots.
      # A managed session keeps the single workspace Paperclip prepared.
      _fail("managed sessions cannot add workspace directories")
    if admission is not None:
      requested_filter = kwargs.get("tool_filter", tool_filter.ToolFilterConfig())
      if not isinstance(requested_filter, tool_filter.ToolFilterConfig):
        _fail("invalid managed native tool filter")
      kwargs["tool_filter"] = dataclasses.replace(requested_filter, disabled_tools=tuple(dict.fromkeys((*(requested_filter.disabled_tools or ()), "invoke_subagent", "run_workflow", "schedule"))))
    result = await original_create_config(self, *args, **kwargs)
    if admission is not None:
      config = result[0] if isinstance(result, tuple) else result
      external_hooks = (acp_hooks.ExternalPreInvocationHook, acp_hooks.ExternalPostInvocationHook, acp_hooks.ExternalPreToolCallDecideHook, acp_hooks.ExternalPostToolCallHook, acp_hooks.ExternalOnSessionEndHook)
      if any(isinstance(hook, external_hooks) for hook in config.hooks):
        _fail("managed workspace command hooks are unavailable")
    return result

  def wrap_open(original, is_new):
    @functools.wraps(original)
    async def open_session(self, *args, **kwargs):
      admission = _read_request(kwargs)
      session_id = None if is_new else kwargs.get("session_id", args[0] if args else None)
      managed = getattr(self, "_paperclip_managed_sessions", {})
      if admission is None:
        if session_id in managed:
          _fail("managed reload requires a fresh exact content acknowledgment")
        return await original(self, *args, **kwargs)
      if any(item["nonce"] == admission["nonce"] for item in managed.values()):
        _fail("request nonce was already used")
      token = _CONTEXT.set(admission)
      try:
        result = await original(self, *args, **kwargs)
        session_id = result.session_id if is_new else session_id
        receipt = _receipt(self, session_id, admission)
        managed[session_id] = admission
        self._paperclip_managed_sessions = managed
        return _add_receipt(result, receipt)
      finally:
        _CONTEXT.reset(token)
    return open_session

  @functools.wraps(original_rebuild)
  async def rebuild(self, session_id):
    admission = getattr(self, "_paperclip_managed_sessions", {}).get(session_id) or _CONTEXT.get()
    if admission is None:
      return await original_rebuild(self, session_id)
    token = _CONTEXT.set(admission)
    try:
      result = await original_rebuild(self, session_id)
      _receipt(self, session_id, admission)
      return result
    finally:
      _CONTEXT.reset(token)

  @functools.wraps(original_replace)
  async def replace(self, session_id):
    if session_id in getattr(self, "_paperclip_managed_sessions", {}):
      # Never let the native enterprise poller substitute a model on this path.
      return
    return await original_replace(self, session_id)

  @functools.wraps(original_prompt)
  async def prompt(self, *args, **kwargs):
    session_id = kwargs.get("session_id", args[1] if len(args) > 1 else None)
    admission = getattr(self, "_paperclip_managed_sessions", {}).get(session_id)
    if admission is None:
      return await original_prompt(self, *args, **kwargs)
    _receipt(self, session_id, admission)
    turn = {}
    token = _TURN.set(turn)
    try:
      result = await original_prompt(self, *args, **kwargs)
    finally:
      _TURN.reset(token)
    # 1.5.2 reports a failed turn as agent text plus end_turn. Attach the
    # typed failure so the client never accepts it as a completed result.
    if result.stop_reason != "cancelled":
      meta = turn_failure_meta(turn, admission, _auth_route(self))
      if meta is not None:
        result.field_meta = {**(result.field_meta or {}), **meta}
    return result

  async def connection_lost(self, session_id, error):
    turn = _TURN.get()
    if turn is not None:
      turn["connectionLost"] = True
    return await original_connection_lost(self, session_id, error)

  @functools.wraps(original_execution_error_message)
  def execution_error_message(raw):
    # Called with str(error) by every SDK execution/connection/validation
    # failure branch of the native prompt handler, before it reports the text.
    turn = _TURN.get()
    if turn is not None and isinstance(raw, str):
      turn["raw"] = raw
    return original_execution_error_message(raw)

  def wrap_setting(original):
    @functools.wraps(original)
    async def setting(self, *args, **kwargs):
      session_id = kwargs.get("session_id", args[1] if len(args) > 1 else None)
      managed = getattr(self, "_paperclip_managed_sessions", {})
      if session_id not in managed:
        return await original(self, *args, **kwargs)
      admission = _read_request(kwargs)
      if admission is None or admission["nonce"] == managed[session_id]["nonce"]:
        _fail("managed configuration change requires a fresh admission request")
      session = self._sessions[session_id]
      if not session.agent.conversation.is_idle:
        _fail("cannot change managed configuration during an active turn")
      token = _CONTEXT.set(admission)
      try:
        result = await original(self, *args, **kwargs)
        session = self._sessions[session_id]
        if session.current_model_id != admission["model"]:
          _fail("configuration selected a different model")
        session.system_prompt = admission["content"]
        managed[session_id] = admission
        await rebuild(self, session_id)
        return _add_receipt(result, _receipt(self, session_id, admission))
      finally:
        _CONTEXT.reset(token)
    return setting

  @functools.wraps(original_cleanup)
  async def cleanup(self, session_id=None):
    try:
      return await original_cleanup(self, session_id)
    finally:
      managed = getattr(self, "_paperclip_managed_sessions", {})
      if session_id is None:
        managed.clear()
      else:
        managed.pop(session_id, None)

  async def models(self, params):
    if (
        not isinstance(params, dict)
        or set(params) != {"schema", "nonce", "authMethod"}
        or params["schema"] != MODELS_SCHEMA
        or params["authMethod"] != "oauth-personal"
        or not isinstance(params["nonce"], str)
        or not 1 <= len(params["nonce"]) <= 512
    ):
      _fail("invalid model catalog request")

    def session_free():
      if (
          getattr(self, "_sessions", {})
          or getattr(self, "_paperclip_managed_sessions", {})
          or _CONTEXT.get() is not None
      ):
        _fail("model catalog requires a session-free connection")

    def require_personal():
      state = self._ensure_auth_state()
      if state is None or state.method_id != "oauth-personal":
        raise exceptions.RequestError(
            code=-32000,
            message="Google personal sign-in is required before model discovery",
        )

    session_free()
    try:
      require_personal()
      # Set the persistent instance policy BEFORE the native auth assertion:
      # both assertion and catalog token reads may otherwise open a browser.
      manager = self._ensure_oauth_mgr()
      manager._paperclip_noninteractive = True
      await self._assert_authenticated()
      require_personal()
    except Exception:
      raise exceptions.RequestError(
          code=-32000,
          message="Google personal sign-in must be renewed through Paperclip before model discovery",
      ) from None
    session_free()
    try:
      state = await asyncio.to_thread(self._list_available_models, "")
      require_personal()
      values = [
          {"id": model.model_id, "label": model.name}
          for model in state.available_models
      ]
      ids = [model["id"] for model in values]
      if (
          not values
          or any(not isinstance(model["id"], str) or not model["id"]
                 or not isinstance(model["label"], str) or not model["label"]
                 for model in values)
          or len(set(ids)) != len(ids)
          or state.current_model_id not in ids
      ):
        raise ValueError("invalid native model catalog")
    except Exception:
      raise exceptions.RequestError(
          code=-32000,
          message="Google Antigravity could not list models for this connection",
      ) from None
    session_free()
    return {
        "schema": MODELS_SCHEMA,
        "nonce": params["nonce"],
        "authMethod": "oauth-personal",
        "models": values,
        "defaultModelId": state.current_model_id,
    }

  async def ext_method(self, method, params):
    if method.lstrip("_") == "paperclip/models":
      return await models(self, params)
    if method.lstrip("_") != "paperclip/admission":
      if original_ext is None:
        _fail("unknown extension method")
      return await original_ext(self, method, params)
    if not isinstance(params, dict) or set(params) != {"sessionId", "nonce"}:
      _fail("invalid admission status request")
    admission = getattr(self, "_paperclip_managed_sessions", {}).get(params["sessionId"])
    if admission is None or admission["nonce"] != params["nonce"]:
      _fail("unknown admission session or nonce")
    return {"paperclipAntigravityAdmission": _receipt(self, params["sessionId"], admission)}

  adapter_type.initialize = initialize
  if original_oauth_mgr is not None:
    adapter_type._ensure_oauth_mgr = ensure_oauth_mgr
  acp_hooks.load_hooks_config = hooks_config
  acp_hooks.load_hooks_config_async = hooks_config_async
  acp_hooks.has_workspace_hooks = has_workspace_hooks
  system_prompt.extract_system_prompt = extract
  adapter_type._list_available_models = list_models
  adapter_type._create_agent_config = create_config
  adapter_type.new_session = wrap_open(adapter_type.new_session, True)
  adapter_type.load_session = wrap_open(adapter_type.load_session, False)
  adapter_type.resume_session = wrap_open(adapter_type.resume_session, False)
  adapter_type._rebuild_session_agent = rebuild
  adapter_type._maybe_replace_unavailable_model = replace
  adapter_type.prompt = prompt
  if original_connection_lost is not None:
    adapter_type._send_connection_lost_message = connection_lost
  browser_subagent.execution_error_message = execution_error_message
  adapter_type.cleanup = cleanup
  adapter_type.set_session_model = wrap_setting(adapter_type.set_session_model)
  adapter_type.set_config_option = wrap_setting(adapter_type.set_config_option)
  adapter_type.ext_method = ext_method
  adapter_type._paperclip_admission_installed = True

"""Paperclip-owned admission for the pinned Antigravity 1.4.3 native runtime.

Loaded inside Google's hermetic distribution. No credentials or prompt content
are persisted in receipts. Native creation must acknowledge the exact config
before the ACP client receives authority to send a managed prompt.
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
import uuid

from acp import exceptions
from google3.cloud.developer_experience.antigravity_extensions.acp_server import request_meta
from google3.cloud.developer_experience.antigravity_extensions.acp_server import system_prompt
from google3.cloud.developer_experience.antigravity_extensions.acp_server import hooks as acp_hooks
from google3.cloud.developer_experience.antigravity_extensions.acp_server import tool_filter
from google3.cloud.developer_experience.antigravity_extensions.acp_server.oauth.credential_manager import OAuthCredentialManager

SCHEMA = "paperclip.antigravity.admission.v1"
MODELS_SCHEMA = "paperclip.antigravity.models.v1"
_CONTEXT = contextvars.ContextVar("paperclip_antigravity_admission", default=None)


def _fail(message):
  raise exceptions.RequestError(code=-32602, message="Paperclip admission: " + message)


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


def prepare_native_config(config, strategy):
  """Inspect the protobuf that will actually be sent to this owned harness."""
  admission = _CONTEXT.get()
  if admission is None:
    return None
  executable_path = ctypes.create_string_buffer(4096)
  path_size = ctypes.c_uint32(len(executable_path))
  get_executable_path = ctypes.CDLL("/usr/lib/libSystem.B.dylib")._NSGetExecutablePath
  get_executable_path.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
  get_executable_path.restype = ctypes.c_int
  if get_executable_path(executable_path, ctypes.byref(path_size)) != 0:
    _fail("cannot resolve the owned native executable path")
  helper = os.path.join(os.path.dirname(os.path.realpath(os.fsdecode(executable_path.value))), "localharness_external")
  helper_stat = os.lstat(helper)
  if not stat.S_ISREG(helper_stat.st_mode) or helper_stat.st_nlink != 1:
    _fail("native helper must be the immutable sibling executable")
  with open(helper, "rb") as helper_file:
    helper_digest = hashlib.file_digest(helper_file, "sha256").hexdigest()
  if helper_digest != "9e8fdc6e20a3262ca0a771850ca4a8414ca839a642cc964ec5c547cc2c33c200":
    _fail("native sibling helper digest differs")
  # The SDK resolves this attribute in its constructor. Updating the global
  # environment alone cannot replace that already-cached executable path.
  strategy._binary_path = helper
  if strategy._env is not None:
    strategy._env = {**strategy._env, "ANTIGRAVITY_HARNESS_PATH": helper}
  os.environ["ANTIGRAVITY_HARNESS_PATH"] = helper
  targets = [model for model in config.models if 1 in model.types]
  if len(targets) != 1 or targets[0].name != admission["model"]:
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


def install(adapter_type):
  if adapter_type.__dict__.get("_paperclip_admission_installed", False):
    return
  original_initialize = adapter_type.initialize
  original_extract = system_prompt.extract_system_prompt
  original_list_models = adapter_type._list_available_models
  original_create_config = adapter_type._create_agent_config
  original_rebuild = adapter_type._rebuild_session_agent
  original_replace = adapter_type._maybe_replace_unavailable_model
  original_prompt = adapter_type.prompt
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
    if admission is not None:
      _receipt(self, session_id, admission)
    return await original_prompt(self, *args, **kwargs)

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
  adapter_type.cleanup = cleanup
  adapter_type.set_session_model = wrap_setting(adapter_type.set_session_model)
  adapter_type.set_config_option = wrap_setting(adapter_type.set_config_option)
  adapter_type.ext_method = ext_method
  adapter_type._paperclip_admission_installed = True

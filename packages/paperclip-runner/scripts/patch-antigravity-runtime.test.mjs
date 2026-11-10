import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { antigravityParSection, patchAntigravityServerBytes, replaceAntigravitySource } from "./patch-antigravity-runtime.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const source = process.env.PAPERCLIP_ANTIGRAVITY_NATIVE_TEST_SOURCE;

function runNative(executable, home, requests) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [], {
      cwd: dirname(executable),
      env: { PATH: process.env.PATH, HOME: home, GEMINI_HOME: join(home, ".gemini"), BROWSER: "/usr/bin/true", AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: join(executable, "..", "localharness_external") },
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ events: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), stderr }));
    child.stdin.end(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  });
}

function initialize() {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "paperclip-runner", version: "test" }, clientCapabilities: {} } };
}

function admission(content) {
  return { schema: "paperclip.antigravity.admission.v1", nonce: "credential-free-regression", model: "gemini-3.1-flash-lite", digest: "sha256:" + hash(content), byteLength: Buffer.byteLength(content) };
}

// This fixture runs inside the real vendor hermetic Python interpreter. It
// tests native protobuf boundaries without creating a session or using auth.
const nativeBoundaryTests = `

def _paperclip_native_boundary_regressions():
  import sys
  from types import SimpleNamespace
  from google3.learning.genai.api.localharness import localharness_pb2 as pb
  def rejected(fn):
    try:
      fn()
    except exceptions.RequestError:
      return
    raise AssertionError("mismatched native admission was accepted")
  for content in ("  exact café 🧷\\n", ""):
    raw = content.encode("utf-8")
    request = {"schema": SCHEMA, "nonce": "native-regression", "model": "literal-model", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": len(raw)}
    metadata = {"antigravity": {"paperclipAdmission": request, "systemPrompt": {"append": content}}}
    expected = _read_request(metadata)
    assert expected["content"] == content
    bad = {"antigravity": {"paperclipAdmission": {**request, "byteLength": len(raw) + 1}, "systemPrompt": {"append": content}}}
    rejected(lambda: _read_request(bad))
    config = pb.HarnessConfig(cascade_id="native-session", models=[pb.ModelConfig(name="literal-model", types=[1])])
    if content:
      config.system_instructions.appended.appended_sections.add(content=content)
    token = _CONTEXT.set(expected)
    try:
      strategy = SimpleNamespace(_binary_path="/untrusted/cached/helper", _env={"ANTIGRAVITY_HARNESS_PATH": "/untrusted/env/helper"})
      prepared = prepare_native_config(config, strategy)
      assert strategy._binary_path == os.environ["ANTIGRAVITY_HARNESS_PATH"]
      assert strategy._env["ANTIGRAVITY_HARNESS_PATH"] == strategy._binary_path
      native_ack = pb.OutputEvent(initialize_conversation_response=pb.InitializeConversationResponse(cascade_id="native-session"))
      receipt = acknowledge_native_config(prepared, native_ack, config)
      assert prepare_native_config(config, strategy)["connectionId"] != prepared["connectionId"]
      assert receipt["digest"] == request["digest"] and receipt["byteLength"] == len(raw)
      assert receipt["sessionId"] == "native-session" and receipt["connectionId"]
      rejected(lambda: acknowledge_native_config(prepared, pb.OutputEvent(), config))
      wrong = pb.OutputEvent(initialize_conversation_response=pb.InitializeConversationResponse(cascade_id="another-session"))
      rejected(lambda: acknowledge_native_config(prepared, wrong, config))
      config.models[0].name = "substituted-model"
      rejected(lambda: prepare_native_config(config, strategy))
      rejected(lambda: acknowledge_native_config(prepared, native_ack, config))
      config.models[0].name = "literal-model"
      config.system_instructions.appended.appended_sections.add(content="unexpected instruction")
      rejected(lambda: prepare_native_config(config, strategy))
      del config.system_instructions.appended.appended_sections[:]
      if content:
        config.system_instructions.appended.appended_sections.add(content=content)
      config.harness_side_tools.subagents.enabled = True
      rejected(lambda: prepare_native_config(config, strategy))
      config.harness_side_tools.subagents.enabled = False
      config.harness_side_tools.run_workflow.enabled = True
      rejected(lambda: prepare_native_config(config, strategy))
      config.harness_side_tools.run_workflow.enabled = False
      config.harness_side_tools.schedule.enabled = True
      rejected(lambda: prepare_native_config(config, strategy))
      config.harness_side_tools.schedule.enabled = False
      config.custom_subagents.add(name="unpromised-browser-agent")
      rejected(lambda: prepare_native_config(config, strategy))
    finally:
      _CONTEXT.reset(token)
  sys.stderr.write("paperclip-native-boundary-regressions: passed\\n")

_paperclip_native_boundary_regressions()
`;

// Calls the real SDK subprocess/stdio/WebSocket startup. The native helper has
// not received InitializeConversationEvent, so no auth or inference is used.
const nativeHelperIsolationTests = `

def _paperclip_native_helper_isolation_regression():
  import asyncio
  import subprocess
  import sys
  from google.antigravity import types as sdk_types
  from google.antigravity.tools.tool_runner import ToolRunner
  from google.antigravity.connections.local.local_connection_config import LocalAgentConfig
  async def run():
    home = os.environ["HOME"]
    os.makedirs(home, exist_ok=True)
    sentinel = os.path.join(home, "untrusted-cached-helper")
    marker = os.path.join(home, "untrusted-helper-launched")
    with open(sentinel, "w") as output:
      output.write("#!/bin/sh\\n: > " + marker + "\\nexit 0\\n")
    os.chmod(sentinel, 0o700)
    config = LocalAgentConfig(conversation_id="helper-isolation-session-1234567890123456", system_instructions="exact helper isolation", capabilities=sdk_types.CapabilitiesConfig(enable_subagents=False, disabled_tools=[sdk_types.BuiltinTools.SCHEDULE]), models=[sdk_types.ModelTarget(name="literal-model", types=[sdk_types.ModelType.TEXT], endpoint=sdk_types.GeminiAPIEndpoint())], env={"ANTIGRAVITY_HARNESS_PATH": sentinel})
    strategy = config.create_strategy(tool_runner=None, hook_runner=None)
    assert strategy._binary_path == sentinel, "test must begin with an already-cached override"
    raw = b"exact helper isolation"
    admission = {"schema": SCHEMA, "nonce": "helper-isolation", "model": "literal-model", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": len(raw), "content": raw.decode()}
    token = _CONTEXT.set(admission)
    owned = []
    launched_paths = []
    ws = None
    original_popen = subprocess.Popen
    def tracked_popen(*args, **kwargs):
      process = original_popen(*args, **kwargs)
      owned.append(process)
      launched_paths.append(args[0][0])
      return process
    try:
      native = strategy._build_harness_config()
      prepare_native_config(native, strategy)
      subprocess.Popen = tracked_popen
      process, ws, _url = await asyncio.wait_for(strategy._spawn_harness_and_connect_ws(), timeout=10)
      assert process.poll() is None, "the actual pinned native helper must be running"
      assert len(launched_paths) == 1 and launched_paths[0] == strategy._binary_path
      assert launched_paths[0] != sentinel
      assert strategy._env["ANTIGRAVITY_HARNESS_PATH"] == launched_paths[0]
      assert not os.path.exists(marker), "the cached override must never execute"
    finally:
      subprocess.Popen = original_popen
      _CONTEXT.reset(token)
      if ws is not None:
        await ws.close()
      for process in owned:
        if process.poll() is None:
          process.kill()
        process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
          if stream is not None:
            stream.close()
    assert owned and all(process.poll() is not None for process in owned)
  asyncio.run(run())
  sys.stderr.write("paperclip-native-helper-isolation-regression: passed\\n")

_paperclip_native_helper_isolation_regression()
`;

const nativeManagedSurfaceTests = `

def _paperclip_managed_surface_regressions():
  import asyncio
  import json
  import sys
  from types import SimpleNamespace
  from google.antigravity import types as sdk_types
  from google.antigravity.tools.tool_runner import ToolRunner
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import browser_subagent
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.server import AgyAdapter, AuthState
  install(AgyAdapter)
  patched_create_config = AgyAdapter._create_agent_config
  install(AgyAdapter)
  assert AgyAdapter._create_agent_config is patched_create_config
  class MemoryStore:
    def read(self): return None
    def write(self, value): pass
    def clear(self): pass
  class FixtureCredentials(OAuthCredentialManager):
    def __init__(self):
      super().__init__(client_id="fixture", client_secret="fixture", scopes=[], token_path=os.path.join(os.environ["HOME"], "unused-credentials.json"), keychain_service="fixture", keychain_account="fixture", store=MemoryStore())
      self.interactive_calls = 0
      self.tier_info = SimpleNamespace(is_empty=True)
    def _authenticate_interactively(self):
      self.interactive_calls += 1
      return SimpleNamespace(valid=True, token="controlled-fixture-token", refresh_token=None)
    def _save_credentials(self, credentials): pass
    def _resolve_backend(self, token, interactive_login=False): pass
  async def run():
    workspace = os.path.join(os.environ["HOME"], "managed-surface-workspace")
    os.makedirs(workspace, exist_ok=True)
    hooks_path = acp_hooks.get_global_hooks_path()
    os.makedirs(os.path.dirname(hooks_path), exist_ok=True)
    hooks = {"fixture": {"enabled": True, "PreInvocation": [{"hooks": [{"type": "command", "command": "false"}]}]}}
    with open(hooks_path, "w") as output: json.dump(hooks, output)
    for workspace_hooks_path in acp_hooks.get_workspace_hooks_paths(workspace):
      os.makedirs(os.path.dirname(workspace_hooks_path), exist_ok=True)
      with open(workspace_hooks_path, "w") as output: json.dump(hooks, output)
    assert acp_hooks.has_workspace_hooks(workspace)
    assert acp_hooks.load_hooks_config(workspace), "unmanaged source loader must remain functional"
    content = "  Exact managed source config 🧷\\n"
    raw = content.encode()
    admission = {"schema": SCHEMA, "nonce": "managed-source-policy", "model": "gemini-3.1-flash-lite", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": len(raw), "content": content}
    adapter = AgyAdapter()
    adapter._auth_state = AuthState(method_id="gemini-api-key", api_key="controlled-fixture-key-not-used")
    original_preflight = browser_subagent.preflight_launcher
    def forbidden_preflight(): raise AssertionError("managed browser launcher must never be probed")
    token = _CONTEXT.set(admission)
    try:
      assert not acp_hooks.has_workspace_hooks(workspace)
      assert acp_hooks.load_hooks_config(workspace) == {}
      assert await acp_hooks.load_hooks_config_async(workspace) == {}
      browser_subagent.preflight_launcher = forbidden_preflight
      config, teardown = await adapter._create_agent_config(cwd=workspace, session_id="managed-source-policy-1234567890123456", gemini_home=os.environ["GEMINI_HOME"], model_id=admission["model"], system_instructions=content)
      assert teardown is None
      assert not config.capabilities.enable_subagents and not config.subagents
      assert all(isinstance(hook, acp_hooks.ExternalOnInteractionHook) for hook in config.hooks)
      strategy = config.create_strategy(tool_runner=ToolRunner(tools=config._get_all_custom_tools()), hook_runner=None)
      native = strategy._build_harness_config()
      assert not native.harness_side_tools.subagents.enabled
      assert not native.harness_side_tools.run_workflow.enabled and not native.custom_subagents
      assert not native.harness_side_tools.schedule.enabled
      prepare_native_config(native, strategy)
      managed_manager = FixtureCredentials()
      adapter._oauth_mgr = managed_manager
      assert adapter._ensure_oauth_mgr() is managed_manager
    finally:
      browser_subagent.preflight_launcher = original_preflight
      _CONTEXT.reset(token)
    try:
      managed_manager.get_access_token()
    except ValueError as error:
      assert "renewed through Paperclip" in str(error)
    else:
      raise AssertionError("managed missing/expired credentials launched interactive auth")
    assert managed_manager.interactive_calls == 0, "managed policy must survive outside its request context"
    standalone = AgyAdapter()
    interactive_manager = FixtureCredentials()
    standalone._oauth_mgr = interactive_manager
    await standalone.authenticate("oauth-personal")
    assert interactive_manager.interactive_calls == 1, "explicit standalone authenticate must retain its interactive path"
    assert not getattr(interactive_manager, "_paperclip_noninteractive", False)
    assert acp_hooks.has_workspace_hooks(workspace)
    assert acp_hooks.load_hooks_config(workspace), "unmanaged hooks policy must be unchanged"
  asyncio.run(run())
  sys.stderr.write("paperclip-managed-surface-regressions: passed\\n")

_paperclip_managed_surface_regressions()
`;

// Exercises the shipped authentication assertion and CCPA model parser. Only
// the metadata response and in-memory credentials are controlled. Session,
// native helper, browser, network, and enterprise-poller factories must not run.
const nativeModelCatalogTests = `

def _paperclip_model_catalog_regressions():
  import asyncio
  import contextlib
  import json
  import socket
  import subprocess
  import sys
  import threading
  import urllib.request
  import webbrowser
  from types import SimpleNamespace
  from unittest import mock
  from google.auth import exceptions as auth_exceptions
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import client_info
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import server as native_server
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import settings_writer
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.ccpa_connection import ccpa_client
  AgyAdapter = native_server.AgyAdapter
  AuthState = native_server.AuthState
  install(AgyAdapter)
  calls = []
  main_thread = threading.get_ident()
  response = {
      "models": {
          "gemini-exact-low-effort": {"displayName": "  Exact café Model 🧷  ", "description": "private description must not escape"},
          "gemini-exact-high-effort": {"displayName": "Native Default"},
          "other-provider": {"displayName": "Filtered for this client"},
          "gemini-disabled": {"displayName": "Not entitled", "disabled": True},
          "gemini-unlisted": {"displayName": "Not advertised in sorts"},
      },
      "agentModelSorts": [{"groups": [{"modelIds": ["gemini-exact-low-effort", "other-provider", "gemini-disabled", "gemini-exact-low-effort", "gemini-exact-high-effort"]}]}],
      "defaultAgentModelId": "gemini-exact-high-effort",
  }
  class MemoryStore:
    def read(self): return None
    def write(self, value): pass
    def clear(self): pass
  class Credentials(OAuthCredentialManager):
    def __init__(self):
      super().__init__(client_id="fixture", client_secret="fixture", scopes=[], token_path=os.path.join(os.environ["HOME"], "unused-model-credentials.json"), keychain_service="fixture", keychain_account="fixture", store=MemoryStore())
      self._creds = SimpleNamespace(valid=True, token="controlled-catalog-token", refresh_token=None)
      self.project_id = "controlled-project"
      self.endpoint_url = "https://catalog.invalid"
      self.interactive_calls = 0
      self.resolutions = 0
    def _authenticate_interactively(self):
      self.interactive_calls += 1
      raise AssertionError("catalog must never authenticate interactively")
    def _save_credentials(self, credentials): pass
    def _resolve_backend(self, token, interactive_login=False):
      assert getattr(self, "_paperclip_noninteractive", False), "noninteractive policy must precede native authentication"
      assert not interactive_login
      self.resolutions += 1
  def forbidden(*args, **kwargs):
    raise AssertionError("session-free model discovery reached a forbidden factory")
  async def rejected(adapter, params, message=None):
    try:
      await adapter.ext_method("_paperclip/models", params)
    except exceptions.RequestError as error:
      text = str(error)
      assert "controlled-secret" not in text
      assert "private description" not in text
      if message is not None: assert message in text, text
      return error
    raise AssertionError("invalid model catalog operation succeeded")
  request = {"schema": MODELS_SCHEMA, "nonce": "catalog-nonce 🧷", "authMethod": "oauth-personal"}
  def adapter():
    value = AgyAdapter(sdk_agent_factory=forbidden)
    value._client_info = client_info.parse(SimpleNamespace(name="paperclip-runner", title="Paperclip Runner", version="test"))
    value._oauth_mgr = Credentials()
    return value
  def fetch(token, endpoint, project, user_agent):
    assert threading.get_ident() != main_thread, "catalog must use the bounded caller's worker thread"
    assert token == "controlled-catalog-token" and endpoint == "https://catalog.invalid" and project == "controlled-project"
    calls.append(user_agent)
    return response
  async def run():
    settings_writer.save_auth_type("oauth-personal")
    value = adapter()
    assert value._auth_state is None, "saved settings must select the actual native auth method"
    result = await value.ext_method("_paperclip/models", request)
    assert result == {"schema": MODELS_SCHEMA, "nonce": request["nonce"], "authMethod": "oauth-personal", "models": [{"id": "gemini-exact-low-effort", "label": "  Exact café Model 🧷  "}, {"id": "gemini-exact-high-effort", "label": "Native Default"}], "defaultModelId": "gemini-exact-high-effort"}
    assert value._auth_state.method_id == "oauth-personal"
    assert len(calls) == 1 and value._oauth_mgr.resolutions == 2
    assert value._oauth_mgr._paperclip_noninteractive and value._oauth_mgr.interactive_calls == 0
    assert value._sessions == {} and value._background_tasks == {}
    assert value._proxy_server is None and value._baic_proxy_server is None and value._admin_controls_mgr is None
    assert "private description" not in json.dumps(result)
    for invalid in (None, {}, {**request, "schema": "other"}, {**request, "authMethod": "oauth-business"}, {**request, "authMethod": "gemini-api-key"}, {**request, "nonce": ""}, {**request, "nonce": 3}, {**request, "nonce": "x" * 513}, {**request, "extra": True}):
      await rejected(value, invalid, "invalid model catalog request")
    assert len(calls) == 1
    for method in ("gemini-api-key", "oauth-business", "agent-platform", "gateway"):
      wrong = adapter()
      wrong._auth_state = AuthState(method_id=method)
      await rejected(wrong, request, "sign-in must be renewed")
      assert not getattr(wrong._oauth_mgr, "_paperclip_noninteractive", False)
    logged_out = adapter()
    logged_out._auth_state = AuthState(method_id="oauth-personal")
    logged_out._logged_out = True
    await rejected(logged_out, request, "sign-in must be renewed")
    assert not getattr(logged_out._oauth_mgr, "_paperclip_noninteractive", False)
    settings_writer.clear_auth_type()
    await rejected(adapter(), request, "sign-in must be renewed")
    settings_writer.save_auth_type("oauth-personal")
    active = adapter()
    active._sessions["not-created"] = object()
    await rejected(active, request, "session-free")
    active._sessions.clear()
    active._paperclip_managed_sessions = {"not-created": {}}
    await rejected(active, request, "session-free")
    token = _CONTEXT.set({"model": "must-not-resolve"})
    try: await rejected(adapter(), request, "session-free")
    finally: _CONTEXT.reset(token)
    assert len(calls) == 1
    # The persistent manager policy must still hold after this request returns.
    manager = value._oauth_mgr
    manager._creds = None
    try: manager.get_access_token()
    except ValueError: pass
    else: raise AssertionError("catalog manager lost its noninteractive policy")
    await rejected(value, request, "sign-in must be renewed")
    assert manager.interactive_calls == 0 and len(calls) == 1
    expired = adapter()
    class Expired:
      valid = False
      refresh_token = "controlled-refresh"
      def refresh(self, request): raise auth_exceptions.RefreshError("controlled-secret refresh rejected")
    expired._oauth_mgr._creds = Expired()
    await rejected(expired, request, "sign-in must be renewed")
    assert len(calls) == 1
    # Provider failures and empty/malformed catalogs must not produce custom or
    # hardcoded model fallbacks, or expose backend/credential response text.
    with mock.patch.object(ccpa_client, "fetch_available_models", side_effect=RuntimeError("controlled-secret backend detail")):
      await rejected(adapter(), request, "could not list models")
    for bad in ({}, {"models": {}, "defaultAgentModelId": "unoffered"}, {**response, "models": {**response["models"], "gemini-exact-low-effort": {"displayName": {"controlled-secret": True}}}}):
      with mock.patch.object(ccpa_client, "fetch_available_models", return_value=bad):
        await rejected(adapter(), request, "could not list models")
  with contextlib.ExitStack() as stack:
    for owner, name in ((AgyAdapter, "_create_agent_config"), (AgyAdapter, "_ensure_business_auth_mgr"), (AgyAdapter, "_ensure_admin_controls_mgr"), (AgyAdapter, "_init_admin_controls_for_session"), (native_server.session_store, "trajectory_path"), (native_server.browser_subagent, "preflight_launcher"), (native_server.LocalAgentConfig, "create_strategy"), (subprocess, "Popen"), (asyncio, "create_subprocess_exec"), (socket, "create_connection"), (urllib.request, "urlopen"), (webbrowser, "open"), (webbrowser, "open_new_tab")):
      stack.enter_context(mock.patch.object(owner, name, side_effect=forbidden))
    stack.enter_context(mock.patch.object(ccpa_client, "fetch_available_models", side_effect=fetch))
    stack.enter_context(mock.patch.dict(os.environ, {"AGY_ACP_DEFAULT_MODEL": "unoffered-custom-fallback"}))
    asyncio.run(run())
  sys.stderr.write("paperclip-model-catalog-regressions: passed\\n")

_paperclip_model_catalog_regressions()
`;

// These state tests use the shipped SDK config builder, ACP response classes,
// and SessionInfo. The native acknowledgment is controlled; no agent is entered
// and no authentication or network request occurs.
const nativeStateTests = `

def _paperclip_managed_state_regressions():
  import asyncio
  import contextlib
  import sys
  from types import SimpleNamespace
  from acp import schema
  from google.antigravity import types as sdk_types
  from google.antigravity.connections.local.local_connection_config import LocalAgentConfig
  from google3.learning.genai.api.localharness import localharness_pb2 as pb
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.server import SessionInfo
  sid = "native-managed-session-12345678901234567890"
  def metadata(content, nonce):
    raw = content.encode("utf-8")
    return {"antigravity": {"paperclipAdmission": {"schema": SCHEMA, "nonce": nonce, "model": "literal-model", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": len(raw)}, "systemPrompt": {"append": content}}}
  async def rejected(fn):
    try:
      await fn()
    except exceptions.RequestError:
      return
    raise AssertionError("managed state mismatch was accepted")
  class FixtureAdapter:
    def __init__(self):
      self._sessions = {}
      self.prompts = 0
      self.replacements = 0
    async def initialize(self, **kwargs):
      return schema.InitializeResponse(protocol_version=1, agent_capabilities=schema.AgentCapabilities(), auth_methods=[])
    def _list_available_models(self, model):
      return schema.SessionModelState(current_model_id=model, available_models=[])
    async def _create_agent_config(self, **kwargs):
      disabled = kwargs["tool_filter"].resolve_disabled_builtins()
      assert sdk_types.BuiltinTools.INVOKE_SUBAGENT in disabled and sdk_types.BuiltinTools.RUN_WORKFLOW in disabled
      assert sdk_types.BuiltinTools.SCHEDULE in disabled
      return LocalAgentConfig(conversation_id=kwargs["session_id"], system_instructions=kwargs["system_instructions"], capabilities=sdk_types.CapabilitiesConfig(enable_subagents=False, disabled_tools=list(disabled)), models=[sdk_types.ModelTarget(name=kwargs["model_id"], types=[sdk_types.ModelType.TEXT], endpoint=sdk_types.GeminiAPIEndpoint())])
    async def _initialize_fixture(self, session_id):
      expected = _CONTEXT.get()
      model = self._list_available_models("native-default").current_model_id
      config = await self._create_agent_config(session_id=session_id, model_id=model, system_instructions=expected["content"])
      strategy = config.create_strategy(tool_runner=None, hook_runner=None)
      native = strategy._build_harness_config()
      prepared = prepare_native_config(native, strategy)
      ack = pb.OutputEvent(initialize_conversation_response=pb.InitializeConversationResponse(cascade_id=session_id))
      strategy._paperclip_native_admission = acknowledge_native_config(prepared, ack, native)
      agent = SimpleNamespace(_strategy=strategy, conversation=SimpleNamespace(is_idle=True))
      self._sessions[session_id] = SessionInfo(agent=agent, stack=contextlib.AsyncExitStack(), current_model_id=model, system_prompt=expected["content"])
    async def new_session(self, cwd, **kwargs):
      await self._initialize_fixture(sid)
      return schema.NewSessionResponse(session_id=sid)
    async def load_session(self, session_id, cwd, **kwargs):
      await self._initialize_fixture(session_id)
      return schema.LoadSessionResponse()
    async def resume_session(self, session_id, cwd, **kwargs):
      await self._initialize_fixture(session_id)
      return schema.ResumeSessionResponse()
    async def _rebuild_session_agent(self, session_id):
      await self._initialize_fixture(session_id)
    async def _maybe_replace_unavailable_model(self, session_id):
      self.replacements += 1
    async def prompt(self, prompt, session_id, **kwargs):
      self.prompts += 1
      return schema.PromptResponse(stop_reason="end_turn")
    async def set_session_model(self, model_id, session_id, **kwargs):
      self._sessions[session_id].current_model_id = model_id
      return schema.SetSessionModelResponse()
    async def set_config_option(self, config_id, session_id, value, **kwargs):
      self._sessions[session_id].current_model_id = value
      return schema.SetSessionConfigOptionResponse(config_options=[])
    async def cleanup(self, session_id=None):
      if session_id is None:
        self._sessions.clear()
      else:
        self._sessions.pop(session_id, None)
  async def run():
    adapter = FixtureAdapter()
    await adapter.initialize()
    first = await adapter.new_session("/fixture", **metadata("  exact café 🧷\\n", "open-nonce"))
    receipt = first.field_meta["paperclipAntigravityAdmission"]
    assert receipt["sessionId"] == sid and receipt["nonce"] == "open-nonce"
    status = await adapter.ext_method("paperclip/admission", {"sessionId": sid, "nonce": "open-nonce"})
    assert status["paperclipAntigravityAdmission"] == receipt
    session = adapter._sessions[sid]
    session.mode_id = "yolo"
    await rejected(lambda: adapter.prompt([], sid))
    assert adapter.prompts == 0
    session.mode_id = "default"
    await adapter._maybe_replace_unavailable_model(sid)
    assert adapter.replacements == 0
    changed = await adapter.set_config_option("model", sid, "literal-model", **metadata("", "setter-nonce"))
    changed_receipt = changed.field_meta["paperclipAntigravityAdmission"]
    assert changed_receipt["nonce"] == "setter-nonce" and changed_receipt["byteLength"] == 0
    assert changed_receipt["connectionId"] != receipt["connectionId"]
    await rejected(lambda: adapter.ext_method("paperclip/admission", {"sessionId": sid, "nonce": "open-nonce"}))
    await rejected(lambda: adapter.load_session(sid, "/fixture"))
    loaded = await adapter.load_session(sid, "/fixture", **metadata(" exact reload ", "load-nonce"))
    assert loaded.field_meta["paperclipAntigravityAdmission"]["nonce"] == "load-nonce"
    resumed = await adapter.resume_session(sid, "/fixture", **metadata(" exact resume ", "resume-nonce"))
    assert resumed.field_meta["paperclipAntigravityAdmission"]["nonce"] == "resume-nonce"
    await adapter.cleanup(sid)
    assert not adapter._paperclip_managed_sessions
  original_extract = system_prompt.extract_system_prompt
  try:
    install(FixtureAdapter)
    asyncio.run(run())
  finally:
    system_prompt.extract_system_prompt = original_extract
  sys.stderr.write("paperclip-managed-state-regressions: passed\\n")

_paperclip_managed_state_regressions()
`;

test("native patch rejects an unpinned executable before decoding", () => {
  assert.throws(() => patchAntigravityServerBytes(Buffer.from("ambient executable"), Buffer.from("module")), /SHA-256 mismatch/);
});

test("source changes require a single exact pinned anchor", () => {
  assert.throws(() => replaceAntigravitySource("changed", "original", "patch"), /anchor changed/);
  assert.throws(() => replaceAntigravitySource("original original", "original", "patch"), /anchor changed/);
});

test("Mach-O section decoding rejects invalid architecture and out-of-bounds native archives", () => {
  assert.throws(() => antigravityParSection(Buffer.alloc(64)), /ARM64 Mach-O/);
  const bytes = Buffer.alloc(32 + 72 + 80);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(152, 36);
  bytes.writeUInt32LE(1, 96);
  bytes.write(".par_data", 104);
  bytes.writeBigUInt64LE(1000n, 144);
  bytes.writeUInt32LE(10, 152);
  assert.throws(() => antigravityParSection(bytes), /archive bounds/);
});

test("pinned native closure reproducibly loads exact admission and rejects requests before authentication", {
  skip: !source || process.platform !== "darwin" || process.arch !== "arm64",
  timeout: 180_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-native-patch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalHash = hash(await readFile(join(source, "agy_acp_server.par")));
  const { patchAntigravityRuntime } = await import("./patch-antigravity-runtime.mjs");
  const first = await patchAntigravityRuntime({ source, destination: join(root, "first") });
  const second = await patchAntigravityRuntime({ source, destination: join(root, "second") });
  assert.deepEqual(second, first, "the complete signed patch must be reproducible");
  assert.equal(hash(await readFile(join(source, "agy_acp_server.par"))), originalHash, "vendor source remains immutable");
  const content = "  exact café 🧷\n";
  const valid = admission(content);
  const create = (id, value) => ({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: root, mcpServers: [], _meta: { antigravity: { paperclipAdmission: value, systemPrompt: { append: content } } } } });
  const models = { schema: "paperclip.antigravity.models.v1", nonce: "native-models-nonce", authMethod: "oauth-personal" };
  const result = await runNative(join(root, "first/agy_acp_server.par"), join(root, "home"), [initialize(), create(2, { ...valid, digest: "sha256:" + "0".repeat(64) }), create(3, valid), { jsonrpc: "2.0", id: 4, method: "_paperclip/admission", params: { sessionId: "missing", nonce: valid.nonce } }, { jsonrpc: "2.0", id: 5, method: "_paperclip/models", params: models }, { jsonrpc: "2.0", id: 6, method: "_paperclip/models", params: { ...models, extra: true } }]);
  const byId = new Map(result.events.filter(event => event.id !== undefined).map(event => [event.id, event]));
  assert.equal(byId.get(1).result.agentInfo.name, "antigravity-acp");
  assert.equal(byId.get(1).result.agentCapabilities._meta.antigravity.paperclipAdmission, 1);
  assert.equal(byId.get(1).result.agentCapabilities._meta.antigravity.paperclipModels, 1);
  assert.match(byId.get(2).error.message, /digest mismatch/);
  assert.equal(byId.get(3).error.code, -32000, "valid metadata reaches the native authentication gate");
  assert.match(byId.get(4).error.message, /unknown admission session or nonce/, "native status extension fails closed without a session");
  assert.equal(byId.get(5).error.code, -32000, "session-free model discovery requires saved personal sign-in");
  assert.match(byId.get(5).error.message, /sign-in must be renewed through Paperclip/);
  assert.equal(byId.get(6).error.code, -32602, "the native model request contract rejects extra fields");
  assert(!result.events.some(event => event.result?._meta?.paperclipAntigravityAdmission), "no native init means no fabricated receipt");

  const fixtureScripts = join(root, "fixture-scripts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(fixtureScripts);
  await copyFile(new URL("./patch-antigravity-runtime.mjs", import.meta.url), join(fixtureScripts, "patch-antigravity-runtime.mjs"));
  const module = await readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url), "utf8");
  await writeFile(join(fixtureScripts, "patch-antigravity-runtime.admission.py"), module + nativeBoundaryTests + nativeHelperIsolationTests + nativeManagedSurfaceTests + nativeModelCatalogTests + nativeStateTests);
  const fixture = await import(pathToFileURL(join(fixtureScripts, "patch-antigravity-runtime.mjs")));
  await fixture.patchAntigravityRuntime({ source, destination: join(root, "boundary-fixture") });
  const tested = await runNative(join(root, "boundary-fixture/agy_acp_server.par"), join(root, "fixture-home"), [initialize()]);
  assert.match(tested.stderr, /paperclip-native-boundary-regressions: passed/);
  assert.match(tested.stderr, /paperclip-native-helper-isolation-regression: passed/);
  assert.match(tested.stderr, /paperclip-managed-surface-regressions: passed/);
  assert.match(tested.stderr, /paperclip-model-catalog-regressions: passed/);
  assert.match(tested.stderr, /paperclip-managed-state-regressions: passed/);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipAdmission, 1);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipModels, 1);
});


test("native client file callbacks settle exact tool identity without broadcasting errors", {
  skip: !source || process.platform !== "darwin" || process.arch !== "arm64",
  timeout: 90_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-tool-lifecycle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureScripts = join(root, "scripts");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(fixtureScripts);
  await copyFile(new URL("./patch-antigravity-runtime.mjs", import.meta.url), join(fixtureScripts, "patch-antigravity-runtime.mjs"));
  const module = await readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url), "utf8");
  const regression = await readFile(new URL("./patch-antigravity-runtime.tool-lifecycle.test.py", import.meta.url), "utf8");
  await writeFile(join(fixtureScripts, "patch-antigravity-runtime.admission.py"), module + "\n" + regression);
  const fixture = await import(pathToFileURL(join(fixtureScripts, "patch-antigravity-runtime.mjs")));
  await fixture.patchAntigravityRuntime({ source, destination: join(root, "runtime") });
  const tested = await runNative(join(root, "runtime/agy_acp_server.par"), join(root, "home"), [initialize()]);
  assert.match(tested.stderr, /paperclip-tool-lifecycle-regressions: passed/);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipAdmission, 1);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { antigravityElfArchive, antigravityEmbeddedZip, antigravityParSection, antigravityPatchTarget, patchAntigravityRuntime, patchAntigravityServerBytes, replaceAntigravitySource } from "./patch-antigravity-runtime.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
// Native regressions run the real vendor build for this host. Point the source
// at an extracted, registry-verified vendor archive for the declared target.
const source = process.env.PAPERCLIP_ANTIGRAVITY_NATIVE_TEST_SOURCE;
const nativeTarget = `${process.platform}-${process.arch}`;
const distributions = JSON.parse(await readFile(new URL("../antigravity-distributions.json", import.meta.url), "utf8"));
const nativeVendorEntries = distributions.platforms[nativeTarget]?.vendorEntries;
const skipNative = !source || !nativeVendorEntries;
const patchNative = (patcher, destination) => patcher.patchAntigravityRuntime({ source, destination, target: nativeTarget, vendorEntries: nativeVendorEntries });

// 1.5.2 shuts down on stdin EOF without answering queued requests, so send
// each request after the previous response and close stdin only at the end.
function runNative(executable, home, requests) {
  return new Promise((resolve, reject) => {
    let stdout = "", next = 0;
    const send = () => next < requests.length ? child.stdin.write(`${JSON.stringify(requests[next++])}\n`) : child.stdin.end();
    const child = execFile(executable, distributions.platforms[nativeTarget].args, {
      cwd: dirname(executable),
      env: { PATH: process.env.PATH, HOME: home, GEMINI_HOME: join(home, ".gemini"), BROWSER: "/usr/bin/true", AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: join(executable, "..", "localharness_external") },
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    }, (error, output, stderr) => error ? reject(Object.assign(error, { stdout: output, stderr })) : resolve({ events: output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), stderr }));
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (let end = stdout.indexOf("\n"); end >= 0; end = stdout.indexOf("\n")) {
        const message = JSON.parse(stdout.slice(0, end));
        stdout = stdout.slice(end + 1);
        if (message.id !== undefined && message.method === undefined) send();
      }
    });
    send();
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
    config.rules_config.filenames.extend(MANAGED_RULE_FILENAMES)
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
      config.models[0].gemini_api_endpoint.options.thinking_level = "low"
      rejected(lambda: prepare_native_config(config, strategy))
      config.models[0].ClearField("gemini_api_endpoint")
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
      # Workspace rules are deliberate: exactly GEMINI.md and AGENTS.md.
      del config.rules_config.filenames[:]
      rejected(lambda: prepare_native_config(config, strategy))
      config.rules_config.filenames.extend((*MANAGED_RULE_FILENAMES, "CUSTOM.md"))
      rejected(lambda: prepare_native_config(config, strategy))
      del config.rules_config.filenames[:]
      config.rules_config.filenames.extend(MANAGED_RULE_FILENAMES)
      # A managed native config retries model API errors only briefly.
      assert config.retry_config.api_retry.max_retries == MANAGED_API_RETRY["max_retries"]
      assert config.retry_config.api_retry.initial_sleep_duration_ms == MANAGED_API_RETRY["initial_sleep_duration_ms"]
      config.custom_subagents.add(name="unpromised-browser-agent")
      rejected(lambda: prepare_native_config(config, strategy))
    finally:
      _CONTEXT.reset(token)
  # Mapped API-key targets: base model and thinking level must both match.
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import model_selection
  requested = "gemini-3.8-flash-low"
  base = model_selection.DEFAULT_MODEL_METADATA_MAP[requested].base_model_id
  raw = b""
  mapped = {"schema": SCHEMA, "nonce": "mapped-regression", "model": requested, "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": 0, "content": ""}
  def mapped_config(name, level=None, vertex=False):
    model = pb.ModelConfig(name=name, types=[1])
    endpoint = model.vertex_endpoint if vertex else model.gemini_api_endpoint
    endpoint.SetInParent()
    if level is not None:
      endpoint.options.thinking_level = level
    config = pb.HarnessConfig(cascade_id="mapped-session", models=[model])
    config.rules_config.filenames.extend(MANAGED_RULE_FILENAMES)
    return config
  strategy = SimpleNamespace(_binary_path="/untrusted", _env=None)
  token = _CONTEXT.set(mapped)
  try:
    assert prepare_native_config(mapped_config(base, "low"), strategy)["model"] == requested
    assert prepare_native_config(mapped_config(base, "low", vertex=True), strategy)["model"] == requested
    assert prepare_native_config(mapped_config(requested), strategy)["model"] == requested
    for name, level in ((base, "high"), (base, None), (base, ""), ("gemini-3.7-flash", "low"), (requested, "low")):
      rejected(lambda: prepare_native_config(mapped_config(name, level), strategy))
  finally:
    _CONTEXT.reset(token)
  sys.stderr.write("paperclip-native-boundary-regressions: passed\\n")

_paperclip_native_boundary_regressions()
`;

// The Linux server's own helper discovery misses the sibling helper, and the
// SDK then refuses every session. The owned patch supplies the kernel path.
const nativeOwnedHelperPathTests = `

def _paperclip_owned_helper_path_regression():
  import sys
  from google.antigravity import types as sdk_types
  from google.antigravity.connections.local.local_connection_config import LocalAgentConfig
  saved = os.environ.pop("ANTIGRAVITY_HARNESS_PATH", None)
  try:
    configure_owned_helper_path()
    expected = os.path.join(os.path.dirname(_owned_executable_path()), "localharness_external")
    assert os.environ.get("ANTIGRAVITY_HARNESS_PATH") == expected, os.environ.get("ANTIGRAVITY_HARNESS_PATH")
    config = LocalAgentConfig(conversation_id="owned-helper-path-1234567890123456", system_instructions="owned helper path", capabilities=sdk_types.CapabilitiesConfig(enable_subagents=False), models=[sdk_types.ModelTarget(name="literal-model", types=[sdk_types.ModelType.TEXT], endpoint=sdk_types.GeminiAPIEndpoint())])
    assert config.create_strategy(tool_runner=None, hook_runner=None)._binary_path == expected
    os.environ["ANTIGRAVITY_HARNESS_PATH"] = "/explicit/operator/helper"
    configure_owned_helper_path()
    assert os.environ["ANTIGRAVITY_HARNESS_PATH"] == "/explicit/operator/helper", "an explicit path is never replaced"
  finally:
    os.environ.pop("ANTIGRAVITY_HARNESS_PATH", None)
    if saved is not None:
      os.environ["ANTIGRAVITY_HARNESS_PATH"] = saved
  sys.stderr.write("paperclip-owned-helper-path-regression: passed\\n")

_paperclip_owned_helper_path_regression()
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
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.proxy_agent_config import ProxyAgentConfig as LocalAgentConfig  # the managed server strategy
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
    # API-key sessions map a catalog id to its base model plus a thinking
    # level; the exact requested id must still be admitted and acknowledged.
    admission = {"schema": SCHEMA, "nonce": "managed-source-policy", "model": "gemini-3.8-flash-low", "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "byteLength": len(raw), "content": content}
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
      try:
        await adapter._create_agent_config(cwd=workspace, session_id="managed-source-policy-1234567890123456", gemini_home=os.environ["GEMINI_HOME"], model_id=admission["model"], system_instructions=content, additional_directories=[os.environ["HOME"]])
      except exceptions.RequestError as error:
        assert "cannot add workspace directories" in str(error)
      else:
        raise AssertionError("a managed session widened its workspace roots")
      assert not config.capabilities.enable_subagents and not config.subagents
      assert all(isinstance(hook, acp_hooks.ExternalOnInteractionHook) for hook in config.hooks)
      strategy = config.create_strategy(tool_runner=ToolRunner(tools=config._get_all_custom_tools()), hook_runner=None)
      native = strategy._build_harness_config()
      assert not native.harness_side_tools.subagents.enabled
      assert not native.harness_side_tools.run_workflow.enabled and not native.custom_subagents
      assert not native.harness_side_tools.schedule.enabled
      text_targets = [model for model in native.models if 1 in model.types]
      assert [(model.name, model.gemini_api_endpoint.options.thinking_level) for model in text_targets] == [("gemini-3.8-flash", "low")], text_targets
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
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.proxy_agent_config import ProxyAgentConfig as LocalAgentConfig  # the managed server strategy
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

// A minimal stored ZIP holding the exact pinned anchors, so the ELF path is
// exercised end to end without vendor binaries.
const ACP = "google3/cloud/developer_experience/antigravity_extensions/acp_server/";
const SDK = "google3/third_party/py/google/antigravity/connections/local/";
const fixtureSources = {
  [ACP + "server.py"]: `class AgyAdapter(Agent):
  pass

    # Immediately flush open tool calls on error step (validation/execution
    # failure).
    if step.status == sdk_types_module.StepStatus.ERROR:
      if open_tool_calls:
        logging.warning(
            "Step error encountered; flushing open tool calls: %s. Error: %s",
            open_tool_calls,
            step.error,
        )
        for tc_id in list(open_tool_calls):
          open_tool_calls.pop(tc_id, None)
          await self._client.session_update(
              session_id=session_id,
              update=schema.ToolCallProgress(
                  session_update="tool_call_update",
                  tool_call_id=tc_id,
                  raw_output=step.error or "Tool execution failed",
                  status="failed",
              ),
          )

`,
  [SDK + "local_connection.py"]: "    harness_config = self._build_harness_config()\n    process, ws, ws_url = await self._spawn_harness_and_connect_ws()\n        init_resp = init_resp_event.initialize_conversation_response\n        parsed = event_processor.parse_initialize_response(init_resp)\n",
  [SDK + "event_processor.py"]: "      result = await self._execute_client_tool(tc)\n      if result is not None:\n        await self._send_tool_results([result])\n",
  [ACP + "__pycache__/server.cpython-314.pyc"]: "x".repeat(65536),
  [SDK + "__pycache__/local_connection.cpython-314.pyc"]: "y".repeat(65536),
  [SDK + "__pycache__/event_processor.cpython-314.pyc"]: "z".repeat(65536),
  [ACP + "unrelated.py"]: "VALUE = 1\n",
};

function storedZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), value = Buffer.from(text);
    const checksum = crc32(value);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(value.length, 18); local.writeUInt32LE(value.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(value.length, 20); central.writeUInt32LE(value.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, value); centrals.push(central, filename);
    offset += 30 + filename.length + value.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

/** ELF64 launcher: header, one PT_LOAD over the code, section names, then the
 * archive section as the final file bytes, as in the vendor Linux builds. */
function elfLauncher(archive, { machine = 62, archiveAtEnd = true, sectionName = ".par_data" } = {}) {
  const code = Buffer.alloc(256, 0xcc);
  const names = Buffer.from(`\0.shstrtab\0${sectionName}\0`);
  const sectionHeaders = 64 + code.length + names.length;
  const archiveStart = Math.ceil((sectionHeaders + 3 * 64) / 4096) * 4096;
  const tail = archiveAtEnd ? Buffer.alloc(0) : Buffer.alloc(16, 1);
  const bytes = Buffer.alloc(archiveStart + archive.length + tail.length);
  bytes.writeUInt32BE(0x7f454c46); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(BigInt(archiveStart - 56), 32); // program header in padding
  bytes.writeBigUInt64LE(BigInt(sectionHeaders), 40);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56); bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(3, 60); bytes.writeUInt16LE(1, 62);
  code.copy(bytes, 64); names.copy(bytes, 64 + code.length);
  const program = archiveStart - 56;
  bytes.writeUInt32LE(1, program); bytes.writeBigUInt64LE(64n, program + 8); bytes.writeBigUInt64LE(BigInt(code.length), program + 32);
  const section = (index, name, type, offset, size) => {
    const header = sectionHeaders + index * 64;
    bytes.writeUInt32LE(name, header); bytes.writeUInt32LE(type, header + 4);
    bytes.writeBigUInt64LE(BigInt(offset), header + 24); bytes.writeBigUInt64LE(BigInt(size), header + 32);
  };
  section(1, 1, 3, 64 + code.length, names.length);
  section(2, 11, 1, archiveStart, archive.length);
  archive.copy(bytes, archiveStart);
  tail.copy(bytes, archiveStart + archive.length);
  return { bytes, archiveStart };
}

const fixtureTarget = server => ({ ...antigravityPatchTarget("linux-x64", [
  { path: "agy_acp_server.par", sha256: hash(server) }, { path: "localharness_external", sha256: "c".repeat(64) },
]) });

function archiveFiles(bytes, start) {
  return new Map(antigravityEmbeddedZip(bytes.subarray(start)).map(entry => [entry.name, entry.method === 8 ? inflateRawSync(entry.payload) : entry.payload]));
}

test("native patch rejects an unpinned or tampered executable before decoding", () => {
  const { bytes } = elfLauncher(storedZip(fixtureSources));
  assert.throws(() => patchAntigravityServerBytes(Buffer.from("ambient executable"), Buffer.from("module"), fixtureTarget(bytes)), /SHA-256 mismatch/);
  const target = fixtureTarget(bytes);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 100] ^= 1;
  assert.throws(() => patchAntigravityServerBytes(tampered, Buffer.from("module"), target), /SHA-256 mismatch/);
  assert.throws(() => patchAntigravityServerBytes(Buffer.from(bytes), Buffer.from("module")), /explicit verified native target/);
  assert.throws(() => antigravityPatchTarget("darwin-x64", []), /unsupported native target/);
  assert.throws(() => antigravityPatchTarget("linux-x64", [{ path: "localharness_external", sha256: "a".repeat(64) }]), /vendor entries/);
});

test("ELF patch replaces only the appended Python archive, deterministically", () => {
  const { bytes, archiveStart } = elfLauncher(storedZip(fixtureSources));
  const target = fixtureTarget(bytes);
  const admission = Buffer.from("# owned admission\n");
  const first = patchAntigravityServerBytes(Buffer.from(bytes), admission, target);
  const second = patchAntigravityServerBytes(Buffer.from(bytes), admission, target);
  assert.deepEqual(first, second);
  assert.equal(first.length, bytes.length);
  assert.deepEqual(first.subarray(0, archiveStart), bytes.subarray(0, archiveStart), "the ELF launcher is unchanged");
  assert.deepEqual(antigravityElfArchive(first, 62), { start: archiveStart, length: bytes.length - archiveStart });
  const files = archiveFiles(first, archiveStart);
  assert.equal(files.get(ACP + "paperclip_admission.py").toString(), admission.toString());
  assert.match(files.get(ACP + "paperclip_native_identity.py").toString(), new RegExp(`HELPER_SHA256 = "${"c".repeat(64)}"`));
  assert.match(files.get(ACP + "server.py").toString(), /paperclip_admission\.install\(AgyAdapter\)/);
  assert.match(files.get(SDK + "local_connection.py").toString(), /prepare_native_config/);
  assert.match(files.get(SDK + "event_processor.py").toString(), /Client file result identity differs/);
  assert.equal(files.get(ACP + "unrelated.py").toString(), "VALUE = 1\n");
  assert(![...files.keys()].some(name => name.endsWith(".pyc")), "stale bytecode for patched sources is removed");
});

test("ELF archive decoding rejects the wrong architecture and misplaced archives", () => {
  const archive = storedZip(fixtureSources);
  assert.throws(() => antigravityElfArchive(Buffer.alloc(64), 62), /64-bit ELF/);
  assert.throws(() => antigravityElfArchive(elfLauncher(archive).bytes, 183), /64-bit ELF/);
  assert.equal(antigravityElfArchive(elfLauncher(archive, { machine: 183 }).bytes, 183).length, archive.length);
  assert.throws(() => antigravityElfArchive(elfLauncher(archive, { archiveAtEnd: false }).bytes, 62), /archive bounds/);
  assert.throws(() => antigravityElfArchive(elfLauncher(archive, { sectionName: ".rodata" }).bytes, 62), /exactly one embedded Python archive/);
  const sourceMissing = storedZip(Object.fromEntries(Object.entries(fixtureSources).filter(([name]) => !name.endsWith("event_processor.py"))));
  const missing = elfLauncher(sourceMissing).bytes;
  assert.throws(() => patchAntigravityServerBytes(missing, Buffer.from("module"), fixtureTarget(missing)), /runtime layout changed/);
});

test("Linux closure patching runs on any host, verifies each vendor file, and never signs", async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-elf-patch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendor = join(root, "vendor");
  await mkdir(vendor, { mode: 0o700 });
  const { bytes } = elfLauncher(storedZip(fixtureSources));
  const helper = Buffer.from("fixture helper");
  await writeFile(join(vendor, "agy_acp_server.par"), bytes, { mode: 0o500 });
  const vendorEntries = [{ path: "agy_acp_server.par", sha256: hash(bytes) }, { path: "localharness_external", sha256: hash(helper) }];
  await assert.rejects(patchAntigravityRuntime({ source: vendor, destination: join(root, "missing"), target: "linux-x64", vendorEntries }), { code: "ENOENT" });
  await writeFile(join(vendor, "localharness_external"), Buffer.from("tampered helper"), { mode: 0o500 });
  await assert.rejects(patchAntigravityRuntime({ source: vendor, destination: join(root, "tampered"), target: "linux-x64", vendorEntries }), /helper SHA-256 mismatch/);
  await rm(join(vendor, "localharness_external"));
  await writeFile(join(vendor, "localharness_external"), helper, { mode: 0o500 });
  const first = await patchAntigravityRuntime({ source: vendor, destination: join(root, "first"), target: "linux-x64", vendorEntries });
  const second = await patchAntigravityRuntime({ source: vendor, destination: join(root, "second"), target: "linux-x64", vendorEntries });
  assert.deepEqual(second, first);
  assert.equal(first.serverSha256, first.unsignedServerSha256, "Linux output is never re-signed");
  assert.equal(first.harnessSha256, hash(helper));
  assert.equal(hash(await readFile(join(root, "first/agy_acp_server.par"))), first.serverSha256);
  assert.match(archiveFiles(await readFile(join(root, "first/agy_acp_server.par")), antigravityElfArchive(await readFile(join(root, "first/agy_acp_server.par")), 62).start).get(ACP + "paperclip_native_identity.py").toString(), new RegExp(hash(helper)));
  await assert.rejects(patchAntigravityRuntime({ source: vendor, destination: join(root, "first"), target: "linux-x64", vendorEntries }), /destination exists/);
  await assert.rejects(patchAntigravityRuntime({ source: vendor, destination: join(root, "arm"), target: "linux-arm64", vendorEntries }), /64-bit ELF/);
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
  skip: skipNative,
  timeout: 180_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-native-patch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalHash = hash(await readFile(join(source, "agy_acp_server.par")));
  const patcher = await import("./patch-antigravity-runtime.mjs");
  const first = await patchNative(patcher, join(root, "first"));
  const second = await patchNative(patcher, join(root, "second"));
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
  await mkdir(fixtureScripts);
  await copyFile(new URL("./patch-antigravity-runtime.mjs", import.meta.url), join(fixtureScripts, "patch-antigravity-runtime.mjs"));
  const module = await readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url), "utf8");
  await writeFile(join(fixtureScripts, "patch-antigravity-runtime.admission.py"), module + nativeBoundaryTests + nativeOwnedHelperPathTests + nativeHelperIsolationTests + nativeManagedSurfaceTests + nativeModelCatalogTests + nativeStateTests);
  const fixture = await import(pathToFileURL(join(fixtureScripts, "patch-antigravity-runtime.mjs")));
  await patchNative(fixture, join(root, "boundary-fixture"));
  const tested = await runNative(join(root, "boundary-fixture/agy_acp_server.par"), join(root, "fixture-home"), [initialize()]);
  assert.match(tested.stderr, /paperclip-native-boundary-regressions: passed/);
  assert.match(tested.stderr, /paperclip-owned-helper-path-regression: passed/);
  assert.match(tested.stderr, /paperclip-native-helper-isolation-regression: passed/);
  assert.match(tested.stderr, /paperclip-managed-surface-regressions: passed/);
  assert.match(tested.stderr, /paperclip-model-catalog-regressions: passed/);
  assert.match(tested.stderr, /paperclip-managed-state-regressions: passed/);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipAdmission, 1);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipModels, 1);
});


test("native client file callbacks settle exact tool identity without broadcasting errors", {
  skip: skipNative,
  timeout: 90_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-tool-lifecycle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureScripts = join(root, "scripts");
  await mkdir(fixtureScripts);
  await copyFile(new URL("./patch-antigravity-runtime.mjs", import.meta.url), join(fixtureScripts, "patch-antigravity-runtime.mjs"));
  const module = await readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url), "utf8");
  const regression = await readFile(new URL("./patch-antigravity-runtime.tool-lifecycle.test.py", import.meta.url), "utf8");
  await writeFile(join(fixtureScripts, "patch-antigravity-runtime.admission.py"), module + "\n" + regression);
  const fixture = await import(pathToFileURL(join(fixtureScripts, "patch-antigravity-runtime.mjs")));
  await patchNative(fixture, join(root, "runtime"));
  const tested = await runNative(join(root, "runtime/agy_acp_server.par"), join(root, "home"), [initialize()]);
  assert.match(tested.stderr, /paperclip-tool-lifecycle-regressions: passed/);
  assert.equal(tested.events[0].result.agentCapabilities._meta.antigravity.paperclipAdmission, 1);
});

test("native managed turns report classified provider failures instead of a completed turn", {
  skip: skipNative,
  timeout: 90_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-turn-failure-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureScripts = join(root, "scripts");
  await mkdir(fixtureScripts);
  await copyFile(new URL("./patch-antigravity-runtime.mjs", import.meta.url), join(fixtureScripts, "patch-antigravity-runtime.mjs"));
  const module = await readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url), "utf8");
  const regression = await readFile(new URL("./patch-antigravity-runtime.turn-failure.test.py", import.meta.url), "utf8");
  await writeFile(join(fixtureScripts, "patch-antigravity-runtime.admission.py"), module + "\n" + regression);
  const fixture = await import(pathToFileURL(join(fixtureScripts, "patch-antigravity-runtime.mjs")));
  await patchNative(fixture, join(root, "runtime"));
  const tested = await runNative(join(root, "runtime/agy_acp_server.par"), join(root, "home"), [initialize()]);
  assert.match(tested.stderr, /paperclip-turn-failure-regressions: passed/);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stat, rm } from "node:fs/promises";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), binary: vi.fn(), sourceHome: vi.fn(), readCredential: vi.fn(), copyBack: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local", () => ({ CODEX_CHATGPT_MODEL_REJECTION_RE: /never-match/, codexChatGptRetirementHint: () => null }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ copyBackCodexAuth: mocks.copyBack }));
vi.mock("../../vendor/paperclip-runner/index.js", async () => ({ probeNativeRunnerEnvironment: mocks.probe, resolveSourceCodexHome: mocks.sourceHome,
  configuredEnvironmentProjection: (await import(new URL("../../../../packages/paperclip-runner/src/configured-environment.ts", import.meta.url).href)).configuredEnvironmentProjection }));
vi.mock("./native-codex-runner.js", () => ({ resolvePaperclipRunnerBinary: mocks.binary, resolveRemotePaperclipRunnerBinary: vi.fn() }));
vi.mock("../local-ai-credential-file.js", () => ({ readLocalAiCredentialFile: mocks.readCredential }));
vi.mock("./native-ssh-command-runner.js", () => ({ createNativeSshCommandRunner: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/runner-connectivity", () => ({ resolvePaperclipRunnerTransport: vi.fn() }));
vi.mock("./native-runner-execution-driver.js", () => ({ createNativeRunnerExecutionDriver: vi.fn() }));
vi.mock("./native-session-executor.js", () => ({ buildNativeProviderEnvironment: (environment: Record<string, string>) => environment }));
import { testNativeRunnerAuthentication } from "./setup-readiness.js";
const { createCapabilityRunnerdProviderEnvironment } = await import(new URL("../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts", import.meta.url).href);
function providerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return createCapabilityRunnerdProviderEnvironment({ provider: "opencode", options: { environment },
    identity: { runnerInstanceId: "probe", environmentLeaseId: "lease", runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item" },
    codexHome: "/synthetic/codex", runtimeContextPath: "/synthetic/context", hasRuntimeContext: false });
}
const model = "openrouter/deepseek/deepseek-v4.1-flash-1017";
const context = (extra: Partial<AdapterEnvironmentTestContext> = {}): AdapterEnvironmentTestContext => ({ companyId: "company-1", adapterType: "paperclip_runner", config: { env: { OPENROUTER_API_KEY: "synthetic-selected-account" } }, ...extra });
const receipt = () => ({ provider: "opencode", providerDriver: "opencode_server", effectiveModel: model, helloProbePassed: true });
beforeEach(() => {
  vi.clearAllMocks(); mocks.binary.mockReturnValue("/synthetic/runnerd"); mocks.sourceHome.mockReturnValue("");
  mocks.probe.mockImplementation(async options => { await options.onCleanupConfirmed(); return receipt(); });
});
afterEach(async () => {
  for (const [input] of mocks.probe.mock.calls) await rm(input.runtimeDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it.each([null, { kind: "local" as const }])("uses native OpenCode with selected local target %j and only its configured account", async executionTarget => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-foreign-openai"); vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-foreign-anthropic"); vi.stubEnv("OPENROUTER_API_KEY", "synthetic-foreign-openrouter");
  const result = await testNativeRunnerAuthentication(context({ executionTarget }), "opencode", model);
  expect(result.status).toBe("pass"); expect(result.checks[0].code).toBe("opencode_hello_probe_passed"); expect(mocks.probe).toHaveBeenCalledOnce();
  const input = mocks.probe.mock.calls[0][0];
  expect(input).toMatchObject({ provider: "opencode", model, timeoutMs: 45_000, environment: { OPENROUTER_API_KEY: "synthetic-selected-account" }, transportOptions: { runnerBinary: "/synthetic/runnerd", sourceCodexHome: "", externallySandboxed: false } });
  expect(input.environment.OPENAI_API_KEY).toBeUndefined(); expect(input.environment.ANTHROPIC_API_KEY).toBeUndefined(); expect(input.reasoningEffort).toBeUndefined();
  expect(mocks.sourceHome).not.toHaveBeenCalled(); expect(mocks.readCredential).not.toHaveBeenCalled(); expect(mocks.copyBack).not.toHaveBeenCalled();
  await expect(stat(input.runtimeDirectory)).rejects.toThrow();
});
it.each(["sandbox", "ssh"] as const)("fails selected remote OpenCode %s before a host or CLI probe", async transport => {
  const remote = { kind: "remote", transport, remoteCwd: "/selected-remote", providerKey: "selected", runner: { execute: vi.fn() } };
  const result = await testNativeRunnerAuthentication(context({ executionTarget: remote as never }), "opencode", model);
  expect(result.status).toBe("fail"); expect(result.checks[0].code).toBe("opencode_native_remote_probe_unsupported");
  expect(mocks.probe).not.toHaveBeenCalled(); expect(mocks.binary).not.toHaveBeenCalled(); expect(mocks.sourceHome).not.toHaveBeenCalled();
});
it.each([
  { provider: "codex" }, { providerDriver: "codex_app_server" }, { providerDriver: "opencode_cli" },
  { effectiveModel: "another-model" }, { effectiveModel: "unknown" }, { effectiveModel: "" }, { effectiveModel: undefined }, { helloProbePassed: false },
])("rejects an incompatible native receipt %j", async delta => {
  mocks.probe.mockImplementation(async options => { await options.onCleanupConfirmed(); return { ...receipt(), ...delta }; });
  const result = await testNativeRunnerAuthentication(context(), "opencode", model);
  expect(result.status).toBe("fail"); expect(result.checks[0].code).toBe("opencode_hello_probe_failed");
});
it("redacts selected credentials and retains private state when native teardown is unconfirmed", async () => {
  mocks.probe.mockRejectedValue(new Error("Native setup timed out: synthetic-selected-account; cleanup unconfirmed"));
  const result = await testNativeRunnerAuthentication(context(), "opencode", model);
  expect(result.status).toBe("fail"); expect(result.checks[0].code).toBe("opencode_hello_probe_timeout");
  expect(JSON.stringify(result)).not.toContain("synthetic-selected-account"); expect(result.checks[0].message).toContain("[REDACTED]");
  expect((await stat(mocks.probe.mock.calls[0][0].runtimeDirectory)).isDirectory()).toBe(true);
});
it("fails before probe handoff when the native daemon is missing", async () => {
  mocks.binary.mockImplementation(() => { throw new Error("Native daemon unavailable"); });
  const result = await testNativeRunnerAuthentication(context(), "opencode", model);
  expect(result.status).toBe("fail"); expect(mocks.probe).not.toHaveBeenCalled();
});
it("keeps the existing local Codex provider, model and effort contract", async () => {
  mocks.probe.mockImplementation(async options => { await options.onCleanupConfirmed(); return { provider: "codex", providerDriver: "codex_app_server", effectiveModel: "gpt-6.1-sol", helloProbePassed: true }; });
  const result = await testNativeRunnerAuthentication(context({ config: { env: { OPENAI_API_KEY: "synthetic-selected-codex" }, modelReasoningEffort: "low" } }), "codex", "gpt-6.1-sol");
  expect(result.status).toBe("pass"); expect(mocks.probe.mock.calls[0][0]).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "low", timeoutMs: 45_000 });
});

it.each([undefined, "", "invalid-selected-key"])("never substitutes the ambient account for selected key %j at the actual provider boundary", async selected => {
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-valid-host-account");
  let downstream: NodeJS.ProcessEnv | undefined;
  mocks.probe.mockImplementation(async options => {
    downstream = providerEnvironment(options.environment);
    await options.onCleanupConfirmed(); throw new Error("authentication failed");
  });
  expect((await testNativeRunnerAuthentication(context({ config: { env: selected === undefined ? {} : { OPENROUTER_API_KEY: selected } } }), "opencode", model)).status).toBe("fail");
  expect(downstream).toBeDefined(); expect(downstream!.OPENROUTER_API_KEY).toBe(selected ?? "");
  expect(downstream!.OPENROUTER_API_KEY).not.toBe("synthetic-valid-host-account");
});
it("carries only explicitly configured custom provider settings through the actual sanitizer", async () => {
  vi.stubEnv("UNSELECTED_GATEWAY_KEY", "synthetic-ambient-gateway");
  const configured = { OPENROUTER_API_KEY: "synthetic-selected-account", CUSTOM_GATEWAY_TOKEN: "synthetic-selected-gateway", OPENCODE_CONFIG_CONTENT: "synthetic-provider-settings", PAPERCLIP_CONFIGURED_ENV_KEYS: '["UNSELECTED_GATEWAY_KEY"]' };
  mocks.probe.mockImplementation(async options => {
    const downstream = providerEnvironment(options.environment);
    expect(downstream.CUSTOM_GATEWAY_TOKEN).toBe(configured.CUSTOM_GATEWAY_TOKEN);
    expect(downstream.OPENCODE_CONFIG_CONTENT).toBe(configured.OPENCODE_CONFIG_CONTENT);
    expect(downstream.UNSELECTED_GATEWAY_KEY).toBeUndefined();
    await options.onCleanupConfirmed(); return receipt();
  });
  expect((await testNativeRunnerAuthentication(context({ config: { env: configured } }), "opencode", model)).status).toBe("pass");
});

it("does not inherit host provider routes or native bridge authority at the actual boundary", async () => {
  for (const key of ["PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN"]) vi.stubEnv(key, "synthetic-host-value");
  let downstream: NodeJS.ProcessEnv | undefined;
  mocks.probe.mockImplementation(async options => { downstream = providerEnvironment(options.environment); await options.onCleanupConfirmed(); return receipt(); });
  expect((await testNativeRunnerAuthentication(context(), "opencode", model)).status).toBe("pass");
  for (const key of ["PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN"]) expect(downstream![key]).toBe("");
});

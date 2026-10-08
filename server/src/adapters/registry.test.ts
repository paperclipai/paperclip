import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidAdapterLoginCapability } from "@paperclipai/adapter-utils";
import { listServerAdapters, requireServerAdapter } from "./registry.js";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";

const { probeInstallation, probeGrokInstallation, probeRunner, probeRemoteProvider, probeAuthentication, nativeAuthentication, prepareRemoteSetup } = vi.hoisted(() => ({
  probeInstallation: vi.fn(),
  probeGrokInstallation: vi.fn(),
  probeRunner: vi.fn(),
  probeRemoteProvider: vi.fn(),
  probeAuthentication: vi.fn(),
  nativeAuthentication: vi.fn(),
  prepareRemoteSetup: vi.fn(),
}));
vi.mock("../services/native-runtime/setup-readiness.js", () => ({
  withRemoteNativeSetupArtifacts: prepareRemoteSetup,
  assertNativeRunnerSetupReady: probeRunner,
  assertRemoteAcpxSetupReady: probeRemoteProvider,
  testNativeAcpxAuthentication: probeAuthentication,
  testNativeRunnerAuthentication: nativeAuthentication,
}));
vi.mock("@paperclipai/paperclip-runner/live", () => ({
  probeAcpxClaudeInstallation: probeInstallation,
  probeAcpxGrokInstallation: probeGrokInstallation,
  probeAcpxCursorInstallation: vi.fn(async () => undefined),
}));

// The registry registers a login capability for the two built-in interactive
// adapters. The test checks the scalar values and the presence of the required
// callbacks. It also runs the shared validator, so the built-in capabilities
// obey the same fail-closed contract as an external adapter.

describe("built-in adapter login capabilities", () => {
  it("registers the Codex device-login capability", () => {
    const capability = requireServerAdapter("codex_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "codex_local")).not.toThrow();
  });

  it("registers the Grok device-login capability", () => {
    const capability = requireServerAdapter("grok_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "grok_local")).not.toThrow();
  });

  it("registers the Claude setup-token capability", () => {
    const capability = requireServerAdapter("claude_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("submitted_browser_code");
    expect(capability.timeoutPolicy).toBe("fixed");
    expect(capability.completionClaim).toBe("storedSessionId");
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(typeof capability.captureCredential).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "claude_local")).not.toThrow();
  });
});

describe("built-in runtime connection tool delivery", () => {
  const expectedStrategies = new Map([
    ["acpx_local", "environment"],
    ["claude_local", "native_mcp"],
    ["codex_local", "native_mcp"],
    ["cursor_cloud", "invocation_context"],
    ["cursor", "environment"],
    ["gemini_local", "environment"],
    ["grok_local", "environment"],
    ["hermes_gateway", "invocation_context"],
    ["hermes_local", "environment"],
    ["kimi_local", "environment"],
    ["openclaw_gateway", "invocation_context"],
    ["opencode_local", "environment"],
    ["paperclip_runner", "environment"],
    ["pi_local", "environment"],
    ["process", "environment"],
    ["http", "invocation_context"],
  ] as const);

  it("requires every built-in adapter to declare its expected delivery strategy", () => {
    const builtIns = listServerAdapters().filter((adapter) => BUILTIN_ADAPTER_TYPES.has(adapter.type));
    expect(new Set(builtIns.map((adapter) => adapter.type))).toEqual(BUILTIN_ADAPTER_TYPES);
    expect(new Map(builtIns.map((adapter) => [adapter.type, adapter.runtimeToolDelivery]))).toEqual(
      expectedStrategies,
    );
  });

  it.each([...expectedStrategies])("delivers %s runtime tools through %s", (type, strategy) => {
    expect(requireServerAdapter(type).runtimeToolDelivery).toBe(strategy);
  });
});


describe("native ACPX environment checks", () => {
  beforeEach(() => {
    prepareRemoteSetup.mockReset().mockImplementation(async (_context, _provider, _model, probe) => probe());
    probeInstallation.mockReset().mockResolvedValue(undefined);
    probeGrokInstallation.mockReset().mockResolvedValue(undefined);
    probeRunner.mockReset().mockResolvedValue(undefined);
    nativeAuthentication.mockReset().mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: new Date(0).toISOString(),
      checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Native hello verified" }] });
    probeRemoteProvider.mockReset().mockResolvedValue(undefined);
    probeAuthentication.mockReset().mockImplementation(async (_context: unknown, agent: string) => ({
      adapterType: "paperclip_runner", status: "pass", testedAt: new Date(0).toISOString(),
      checks: [{ code: `${agent}_hello_probe_passed`, level: "info", message: "Selected native account verified" }],
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  const context = {
    companyId: "company-test",
    adapterType: "paperclip_runner",
    config: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" },
  };

  it("reports unsupported local platforms before a successful CLI login can mask them", async () => {
    probeInstallation.mockRejectedValue(new Error("ACPX Claude requires a supported runtime platform"));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({
      code: "acpx_runtime_unavailable",
      level: "error",
    })]);
  });

  it("requires installed runtime and selected native authentication probes", async () => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("pass");
    expect(probeInstallation).toHaveBeenCalledWith(context.config.model);
    expect(probeAuthentication).toHaveBeenCalledWith(context, "claude", context.config.model, undefined);
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed" }));
  });

  it("does not report installation success as authentication success", async () => {
    probeAuthentication.mockResolvedValueOnce({
      adapterType: "paperclip_runner", status: "fail", testedAt: new Date(0).toISOString(),
      checks: [{ code: "claude_hello_probe_auth_required", level: "error", message: "Select a valid Claude account" }],
    });
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_auth_required", level: "error" }));
  });

  it.each([true, false])("checks Grok's own installation readiness (%s)", async (ready) => {
    if (!ready) probeGrokInstallation.mockRejectedValueOnce(new Error("Grok executable digest mismatch"));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({
      ...context,
      config: { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" },
    });
    expect(result.status).toBe(ready ? "pass" : "fail");
    expect(probeGrokInstallation).toHaveBeenCalledWith("grok-4.7");
    expect(probeInstallation).not.toHaveBeenCalled();
  });

  it("does not use the host platform to reject a remote environment", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({
      ...context,
      executionTarget: {
        kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "test",
        runner: { execute: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "Linux\nx86_64\n" }) },
      },
    });
    expect(result.status).toBe("pass");
    expect(result.checks[0].code).toBe("acpx_runtime_ready");
    expect(probeRemoteProvider).toHaveBeenCalled();
    expect(probeInstallation).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", { provider: "codex", model: "gpt-6.1-sol" }],
    ["opencode", { provider: "opencode", model: "openrouter/example/model" }],
    ["acpx", { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }],
  ] as const)("uses prepared sandbox artifacts throughout %s setup", async (provider, config) => {
    const artifacts = { runnerBinary: "/workspace/.paperclip-runtime/owned/bin/paperclip-runnerd", providerPackRoot: "/workspace/.paperclip-runtime/owned/provider-pack" };
    prepareRemoteSetup.mockImplementationOnce(async (_context, _provider, _model, probe) => probe(artifacts));
    const selected = { ...context, config, executionTarget: {
      kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/workspace", providerKey: "test",
      runner: { execute: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "Linux\nx86_64\n" }) },
    } };
    expect((await requireServerAdapter("paperclip_runner").testEnvironment!(selected)).status).toBe("pass");
    expect(prepareRemoteSetup).toHaveBeenCalledWith(selected, provider, config.model, expect.any(Function));
    expect(probeRunner).toHaveBeenCalledWith(selected, artifacts);
    if (provider === "acpx") {
      expect(probeRemoteProvider).toHaveBeenCalledWith(selected, "claude", config.model, artifacts);
      expect(probeAuthentication).toHaveBeenCalledWith(selected, "claude", config.model, artifacts);
    } else expect(nativeAuthentication).toHaveBeenCalledWith(selected, provider, config.model, artifacts);
  });
  it("does not authenticate or report readiness when sandbox artifact preparation fails", async () => {
    prepareRemoteSetup.mockResolvedValueOnce({ adapterType: "paperclip_runner", status: "fail", testedAt: new Date(0).toISOString(), checks: [{ code: "paperclip_runner_runtime_unavailable", level: "error", message: "Upload unavailable" }] });
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(probeRunner).not.toHaveBeenCalled();
    expect(probeAuthentication).not.toHaveBeenCalled();
    expect(nativeAuthentication).not.toHaveBeenCalled();
  });

  const sshTarget = {
    kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/workspace",
    spec: {
      host: "example.test", port: 22, username: "tester", remoteCwd: "/workspace",
      remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  };

  it.each(["pass", "fail"] as const)("requires staged native Codex readiness on SSH without preinstalled-only rejection (%s)", async status => {
    probeRunner.mockRejectedValue(new Error("SSH has no preinstalled runner"));
    nativeAuthentication.mockResolvedValueOnce({ adapterType: "paperclip_runner", status, testedAt: new Date(0).toISOString(),
      checks: [{ code: status === "pass" ? "codex_hello_probe_passed" : "codex_hello_probe_failed", level: status === "pass" ? "info" : "error", message: "Staged native runtime evidence" }] });
    const selected = { ...context, executionTarget: sshTarget, config: { provider: "codex", model: "gpt-6.1-sol" } };
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(selected);
    expect(result.status).toBe(status);
    expect(nativeAuthentication).toHaveBeenCalledWith(selected, "codex", "gpt-6.1-sol", undefined);
    expect(probeRunner).not.toHaveBeenCalled();
    expect(probeInstallation).not.toHaveBeenCalled();
  });
  it("fails when the selected SSH runtime cannot be verified", async () => {
    probeRunner.mockRejectedValue(new Error("SSH has no preinstalled runner"));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context, executionTarget: sshTarget, config: { provider: "opencode", model: "openrouter/example/model" } });
    expect(result.status).toBe("fail"); expect(probeRunner).toHaveBeenCalledOnce(); expect(nativeAuthentication).not.toHaveBeenCalled();
  });
  it.each(["opencode", "acpx"] as const)("uses prepared private paths for qualified SSH %s", async provider => {
    const artifacts = { runnerBinary: "/workspace/owned/bin/paperclip-runnerd", providerPackRoot: "/workspace/owned/provider-pack" };
    prepareRemoteSetup.mockImplementationOnce(async (_context, _provider, _model, probe) => probe(artifacts));
    const selected = { ...context, executionTarget: sshTarget, config: provider === "opencode" ? { provider, model: "openrouter/example/model" } : { provider, acpxAgent: "claude", model: "claude-sonnet-5" } };
    vi.spyOn(executionTarget, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "Linux\nx86_64\n", stderr: "", signal: null, pid: null, startedAt: new Date(0).toISOString() });
    expect((await requireServerAdapter("paperclip_runner").testEnvironment!(selected)).status).toBe("pass");
    expect(probeRunner).toHaveBeenCalledWith(selected, artifacts);
    if (provider === "acpx") expect(probeRemoteProvider).toHaveBeenCalledWith(selected, "claude", selected.config.model, artifacts);
    else expect(nativeAuthentication).toHaveBeenCalledWith(selected, "opencode", selected.config.model, artifacts);
  });
  it.each([
    ["Linux\nx86_64\n", "pass"],
    ["Darwin\nx86_64\n", "pass"],
    ["Darwin\narm64\n", "pass"],
    ["Linux\naarch64\n", "fail"],
    ["", "fail"],
  ])("qualifies the SSH platform from its own uname output %j", async (stdout, status) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    const probe = vi.spyOn(executionTarget, "runAdapterExecutionTargetShellCommand").mockResolvedValue({
      exitCode: 0, timedOut: false, stdout, stderr: "", signal: null, pid: null, startedAt: new Date(0).toISOString(),
    });
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context, executionTarget: sshTarget });
    expect(result.status).toBe(status);
    expect(probe).toHaveBeenCalledWith(expect.any(String), sshTarget, "uname -s && uname -m", {
      cwd: "/workspace", env: {}, timeoutSec: 15,
    });
  });

  it.each(["timeout", "exit", "exception"])("does not qualify an SSH target after a probe %s", async (failure) => {
    const probe = vi.spyOn(executionTarget, "runAdapterExecutionTargetShellCommand");
    if (failure === "exception") probe.mockRejectedValue(new Error("connection unavailable"));
    else probe.mockResolvedValue({
      exitCode: failure === "exit" ? 1 : 0, timedOut: failure === "timeout",
      stdout: "Linux\nx86_64\n", stderr: "", signal: null, pid: null, startedAt: new Date(0).toISOString(),
    });
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context, executionTarget: sshTarget });
    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("acpx_runtime_unavailable");
  });
});

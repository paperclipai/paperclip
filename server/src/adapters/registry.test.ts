import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidAdapterLoginCapability } from "@paperclipai/adapter-utils";
import { listServerAdapters, requireServerAdapter } from "./registry.js";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { QUALIFIED_ACPX_PROFILES, KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../vendor/paperclip-runner/index.js";

const { probeInstallation, probeGrokInstallation, probePiInstallation, probeKimiInstallation, probeKimiModels, probeKimiRemote, verifyApiKey } = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  probeInstallation: vi.fn(),
  probeGrokInstallation: vi.fn(),
  probePiInstallation: vi.fn(),
  probeKimiInstallation: vi.fn(),
  probeKimiModels: vi.fn(),
  probeKimiRemote: vi.fn(),
}));
vi.mock("../services/ai-api-key-test.js", () => ({ validateAiApiKey: verifyApiKey }));
vi.mock("../services/kimi-connection-probe.js", () => ({ probeKimiExecutionTarget: probeKimiRemote }));
vi.mock("../vendor/paperclip-runner/live/index.js", () => ({
  probeAcpxClaudeInstallation: probeInstallation,
  probeAcpxGrokInstallation: probeGrokInstallation,
  probeAcpxPiInstallation: probePiInstallation,
  probeAcpxKimiInstallation: probeKimiInstallation,
  probeKimiModels,
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
    verifyApiKey.mockReset().mockResolvedValue(undefined);
    probeInstallation.mockReset().mockResolvedValue(undefined);
    probeGrokInstallation.mockReset().mockResolvedValue(undefined);
    probePiInstallation.mockReset().mockResolvedValue(undefined);
    probeKimiInstallation.mockReset().mockResolvedValue(undefined);
    probeKimiModels.mockReset().mockResolvedValue(undefined);
    probeKimiRemote.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  const context = {
    companyId: "company-test",
    adapterType: "paperclip_runner",
    config: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" },
  };

  it("requires an explicit Kimi credential and probes its own installed runtime during qualification", async () => {
    const model = "explicit-kimi-model";
    authorizeKimi(model);
    const config = { provider: "acpx", acpxAgent: "kimi", model };
    const missing = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context, config });
    expect(missing.status).toBe("fail");
    expect(missing.checks[0].code).toBe("KIMI_AUTH_REQUIRED");
    expect(probeKimiInstallation).not.toHaveBeenCalled();

    const ready = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context, config: { ...config, env: { KIMI_API_KEY: "fixture-key" } } });
    expect(ready.status).toBe("pass");
    expect(probeKimiRemote).toHaveBeenCalledExactlyOnceWith("fixture-key", undefined, model, { companyId: context.companyId });
    expect(probeKimiInstallation).not.toHaveBeenCalled();
    expect(probeKimiModels).not.toHaveBeenCalled();
    expect(probeInstallation).not.toHaveBeenCalled();
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(ready.checks[0]).toMatchObject({ code: "kimi_metadata_verified", message: expect.stringContaining("No model prompt was sent") });
  });

  it("keeps a rejected Kimi catalog credential out of the ready lifecycle", async () => {
    const model = "explicit-kimi-model";
    authorizeKimi(model);
    probeKimiRemote.mockRejectedValue(Object.assign(new Error("The Kimi Code credential was rejected by the model catalog."), { code: "KIMI_AUTH_REQUIRED" }));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { provider: "acpx", acpxAgent: "kimi", model, env: { KIMI_API_KEY: "fixture-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toContain("credential was rejected");
  });

  it("requires the selected remote Kimi runtime and authenticated catalog instead of a host installation", async () => {
    const model = "explicit-kimi-model";
    authorizeKimi(model);
    const runner = { execute: vi.fn() };
    const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/workspace", providerKey: "test", runner };
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { provider: "acpx", acpxAgent: "kimi", model, env: { KIMI_API_KEY: "fixture-key" } },
      executionTarget: target,
    });
    expect(result.status).toBe("pass");
    expect(result.checks[0]).toMatchObject({ code: "kimi_metadata_verified" });
    expect(probeKimiRemote).toHaveBeenCalledExactlyOnceWith("fixture-key", target, model, { companyId: context.companyId });
    expect(runner.execute).not.toHaveBeenCalled();
    expect(probeKimiInstallation).not.toHaveBeenCalled();
    expect(probeKimiModels).not.toHaveBeenCalled();
  });

  it("verifies a native Claude key without the global CLI or a model prompt", async () => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { ...context.config, env: { ANTHROPIC_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("pass");
    expect(verifyApiKey).toHaveBeenCalledExactlyOnceWith("anthropic", "test-key");
    expect(result.checks.map(check => check.code)).toEqual(["acpx_runtime_ready", "ai_connection_api_key_reverified"]);
  });

  it.each(["ai_connection_api_key_rejected", "ai_connection_verification_failed"])("fails setup on %s", async code => {
    verifyApiKey.mockRejectedValue({ details: { code } });
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { ...context.config, env: { ANTHROPIC_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)).toMatchObject({ code, level: "error" });
  });

  it.each(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"])("preserves the supplementary probe for custom routing via %s", async name => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { ...context.config, env: { ANTHROPIC_API_KEY: "test-key", [name]: "configured" } },
    });
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(result.checks.some(check => check.code === "ai_connection_api_key_reverified")).toBe(false);
  });

  it("reports unsupported local platforms before a successful CLI login can mask them", async () => {
    probeInstallation.mockRejectedValue(new Error("ACPX Claude requires a supported runtime platform"));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({
      code: "acpx_runtime_unavailable",
      level: "error",
    })]);
  });

  it.each([
    ["claude", "claude-opus-5-5", "aarch64", "warn"],
    ["claude", "claude-opus-5-5", "arm64", "warn"],
    ["claude", "claude-opus-5-5", "armv7l", "fail"],
    ["grok", "grok-4.7", "aarch64", "fail"],
    ["pi", "openrouter/deepseek/deepseek-v4-flash-0731", "aarch64", "fail"],
  ])("checks the selected remote %s architecture %s without widening other providers", async (agent, model, architecture, status) => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({ ...context,
      config: { provider: "acpx", acpxAgent: agent, model },
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "test",
        runner: { execute: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: `Linux\n${architecture}\n` }) } },
    });
    expect(result.status).toBe(status);
    expect(result.checks[0].code).toBe(status === "warn" ? "acpx_remote_runtime_unverified" : "acpx_runtime_unavailable");
    expect(probeInstallation).not.toHaveBeenCalled();
  });

  it("identifies an incomplete installation and gives the operator a repair", async () => {
    probeInstallation.mockRejectedValue(Object.assign(new Error("The Claude ACP runtime package is missing. Reinstall or rebuild Paperclip."), { code: "ACPX_RUNTIME_PACKAGE_MISSING" }));
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({ code: "acpx_runtime_package_missing", message: expect.stringContaining("Reinstall or rebuild") });
  });

  it("requires a successful installed runtime probe", async () => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!(context);
    expect(result.status).toBe("pass");
    expect(probeInstallation).toHaveBeenCalledWith(context.config.model);
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

  it.each([true, false])("checks qualified Pi's own installation readiness (%s)", async (ready) => {
    if (!ready) probePiInstallation.mockRejectedValueOnce(new Error("Pi installation integrity mismatch"));
    const model = "openrouter/deepseek/deepseek-v4-flash-0731";
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({
      ...context,
      config: { provider: "acpx", acpxAgent: "pi", model },
    });
    expect(result.status).toBe(ready ? "pass" : "fail");
    expect(probePiInstallation).toHaveBeenCalledWith(model);
    expect(probeInstallation).not.toHaveBeenCalled();
    expect(probeGrokInstallation).not.toHaveBeenCalled();
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
    expect(result.status).toBe("warn");
    expect(result.checks[0].code).toBe("acpx_remote_runtime_unverified");
    expect(probeInstallation).not.toHaveBeenCalled();
  });

  const sshTarget = {
    kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/workspace",
    spec: {
      host: "example.test", port: 22, username: "tester", remoteCwd: "/workspace",
      remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  };

  it.each([
    ["Linux\nx86_64\n", "warn"],
    ["Darwin\nx86_64\n", "warn"],
    ["Darwin\narm64\n", "warn"],
    ["Linux\naarch64\n", "warn"],
    ["Linux\narm64\n", "warn"],
    ["Linux\narmv7l\n", "fail"],
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

function authorizeKimi(model: string) {
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1",
    companyId: "company-test", agent: "kimi", model, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
    platform: "linux", architecture: "x64", nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256["linux-x64"]}`,
    expiresAt: Date.now() + 60_000 }));
}

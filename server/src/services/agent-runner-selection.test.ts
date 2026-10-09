import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentHarnessType, agentRunner, paperclipRunnerProfileForHarness, paperclipRunnerSupportsPlatform, createAgentSchema, updateAgentSchema, testAdapterEnvironmentSchema } from "@paperclipai/shared";
const state = vi.hoisted(() => ({ disabled: [] as string[], overridden: new Set<string>(), settings: {} as Record<string, unknown>, getEnvironment: vi.fn(), bindings: vi.fn(), managedEnvironment: vi.fn(), ssh: vi.fn(), resolveEnvironment: vi.fn() }));
vi.mock("../adapters/registry.js", () => ({ findActiveServerAdapter: (type: string) => ({ type }), hasActiveAdapterOverride: (type: string) => state.overridden.has(type), waitForExternalAdapters: async () => {} }));
vi.mock("./adapter-plugin-store.js", () => ({ getDisabledAdapterTypes: () => state.disabled }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ get: async () => state.settings }) }));
vi.mock("./environments.js", () => ({ environmentService: () => ({ getById: state.getEnvironment, listBoundCompanyIds: state.bindings, findManagedSandboxEnvironment: state.managedEnvironment, findKubernetesEnvironment: state.managedEnvironment }) }));
vi.mock("./environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: state.resolveEnvironment }));
vi.mock("@paperclipai/adapter-utils/ssh", () => ({ runSshCommand: state.ssh }));
import { agentRunnerAvailability, resolveAgentRunnerTargetForCompany, resolveNewAgentRunner, resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";
const target = { driver: "local", platform: "linux", architecture: "x64" };

describe("server-owned Codex runner selection", () => {
  beforeEach(() => { state.disabled = []; state.overridden.clear(); state.settings = {}; state.getEnvironment.mockReset(); state.bindings.mockReset().mockResolvedValue([]); state.managedEnvironment.mockReset(); state.ssh.mockReset().mockResolvedValue({ stdout: "Linux\nx86_64\n" }); state.resolveEnvironment.mockReset().mockResolvedValue({ driver: "ssh", config: {} }); });
  it("uses native Codex automatically with compatible configuration and is idempotent", () => {
    const input = { adapterType: "codex_local", target, adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high", env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret" } }, cwd: "/workspace", instructionsFilePath: "/workspace/AGENTS.md", workspaceStrategy: { type: "git_worktree" }, timeoutSec: 60, search: false, fastMode: false, dangerouslyBypassApprovalsAndSandbox: true } };
    const resolved = resolveNewAgentRunner(input);
    expect(resolved).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", codexPermissionMode: "never", modelReasoningEffort: "high", env: input.adapterConfig.env, workspaceStrategy: input.adapterConfig.workspaceStrategy, timeoutSec: 60 } });
    expect(resolved.adapterConfig).not.toHaveProperty("search");
    expect(resolveNewAgentRunner(resolved)).toEqual(resolved);
    expect(input.adapterConfig).toHaveProperty("search", false);
  });
  it.each(["claude_local", "opencode_local", "grok_local", "cursor", "pi_local", "process", "external"])("keeps %s default unchanged", adapterType => {
    expect(resolveNewAgentRunner({ adapterType, target, adapterConfig: { custom: "preserved" } })).toEqual({ adapterType, adapterConfig: { custom: "preserved" } });
  });
  it("allows an explicit legacy runner and native to legacy round trip", () => {
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target, runner: "legacy", adapterConfig: { extraArgs: ["--search"] } }).adapterType).toBe("codex_local");
    expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", runner: "legacy", adapterConfig: { provider: "codex", model: "gpt-5.6-sol", lifecycleMode: "per_turn", codexPermissionMode: "never", modelReasoningEffort: "high" } })).toEqual({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high", dangerouslyBypassApprovalsAndSandbox: true } });
  });
  it("preserves explicit legacy permission policy alongside compatible native lifecycle defaults", () => {
    expect(resolveNewAgentRunner({ adapterType: "codex_local", runner: "legacy", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false, lifecycleMode: "per_turn" } }))
      .toEqual({ adapterType: "codex_local", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } });
    expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", runner: "legacy", adapterConfig: { provider: "codex", codexPermissionMode: "never", lifecycleMode: "per_turn", dangerouslyBypassApprovalsAndSandbox: false } }))
      .toEqual({ adapterType: "codex_local", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } });
  });
  it.each(["darwin", "win32"])("keeps unqualified %s targets legacy while preserving explicit native profiles", platform => {
    const input = { adapterType: "codex_local", target: { driver: "local", platform, architecture: "x64" } };
    expect(resolveNewAgentRunner(input).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
    const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, target: input.target };
    expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
    expect(resolveNewAgentRunner({ ...saved, runner: "paperclip" })).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
  });
  it("automatically keeps unsupported targets and active external overrides legacy", () => {
    const input = { adapterType: "codex_local", target: { driver: "local", platform: "win32", architecture: "x64" } };
    expect(resolveNewAgentRunner(input).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
    state.overridden.add("codex_local");
    expect(agentRunnerAvailability("codex_local", target).defaultRunner).toBe("legacy");
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target }).adapterType).toBe("codex_local");
  });
  it("does not select a disabled runner", () => {
    state.disabled = ["paperclip_runner"];
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target }).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", target, runner: "paperclip" })).toThrow("unavailable");
    state.disabled = ["codex_local"];
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", target })).toThrow("Codex is disabled");
  });
  it.each(["extraArgs", "agentCommand", "networkScope", "filesystemScope", "search"])("rejects incompatible %s without changing runner", field => {
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", target, adapterConfig: { [field]: true } })).toThrow("Legacy runner");
    try { resolveNewAgentRunner({ adapterType: "codex_local", target, adapterConfig: { [field]: true } }); }
    catch (error) { expect(error).toMatchObject({ status: 422, details: { fields: [field] } }); }
  });
  it("preserves explicit historical native profiles, including managed configurations", () => {
    for (const config of [{ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }, { provider: "claude_managed", managedProfileId: "profile", managedAgentsRetentionAcknowledged: true }, { provider: "aws_agentcore", agentCoreProfileId: "profile" }]) expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", adapterConfig: config })).toEqual({ adapterType: "paperclip_runner", adapterConfig: config });
  });
  it("rejects a foreign environment before resolving credentials or probing its platform", async () => {
    state.getEnvironment.mockResolvedValue({ id: "foreign", driver: "ssh", status: "active", config: {} });
    state.bindings.mockResolvedValue(["another-company"]);
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "foreign" })).rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });
    expect(state.resolveEnvironment).not.toHaveBeenCalled(); expect(state.ssh).not.toHaveBeenCalled();
  });
  it("uses dispatch's instance default for a null agent override and checks the selected SSH platform", async () => {
    state.settings = { defaultEnvironmentId: "default" };
    state.getEnvironment.mockResolvedValue({ id: "default", driver: "ssh", status: "active", config: {} });
    state.ssh.mockResolvedValue({ stdout: "Linux\naarch64\n" });
    const result = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: null });
    expect(state.getEnvironment).toHaveBeenCalledWith("default"); expect(state.bindings).toHaveBeenCalledWith("default");
    expect(result.adapterType).toBe("codex_local");
  });
  it.each([
    ["Linux\nx86_64\n", "paperclip", "paperclip_runner"],
    ["Darwin\narm64\n", "legacy", "codex_local"],
  ])("uses the same selected SSH target for discovery and saving (%s)", async (stdout, expectedRunner, expectedAdapter) => {
    state.getEnvironment.mockResolvedValue({ id: "selected", driver: "ssh", status: "active", config: {} });
    state.ssh.mockResolvedValue({ stdout });
    const discoveredTarget = await resolveAgentRunnerTargetForCompany({} as never, "company", "selected");
    expect(agentRunnerAvailability("codex_local", discoveredTarget).defaultRunner).toBe(expectedRunner);
    const saved = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "selected" });
    expect(saved.adapterType).toBe(expectedAdapter);
  });
  it("preserves recorded explicit native execution without rechecking creation defaults", async () => {
    const recorded = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runner: "paperclip" as const };
    expect(await resolveNewAgentRunnerForCompany({} as never, "company", recorded)).toEqual({ adapterType: recorded.adapterType, adapterConfig: recorded.adapterConfig });
    expect(state.getEnvironment).not.toHaveBeenCalled();
    expect(state.ssh).not.toHaveBeenCalled();
  });
  it("does not infer a sandbox image architecture from its driver", async () => {
    state.getEnvironment.mockResolvedValue({ id: "sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" } });
    const result = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "sandbox" });
    expect(result.adapterType).toBe("paperclip_runner"); expect(state.ssh).not.toHaveBeenCalled();
  });
});

describe("Codex creation runner contract", () => {
  it("graduates only Codex and retains saved provider identity", () => {
    expect(paperclipRunnerProfileForHarness("codex_local")).toEqual({ provider: "codex" });
    for (const harness of ["claude_local", "opencode_local", "grok_local", "cursor", "pi_local", "process"]) expect(paperclipRunnerProfileForHarness(harness)).toBeUndefined();
    expect(agentHarnessType("paperclip_runner", { provider: "codex" })).toBe("codex_local");
    expect(agentHarnessType("paperclip_runner", { provider: "acpx", acpxAgent: "claude" })).toBe("claude_local");
    expect(agentHarnessType("paperclip_runner", { provider: "unknown" })).toBe("unknown");
    expect(agentHarnessType("paperclip_runner", { provider: "acpx", acpxAgent: "unknown" })).toBe("acpx:unknown");
    expect(agentRunner("codex_local")).toBe("legacy");
    expect(agentRunner("paperclip_runner")).toBe("paperclip");
  });
  it("qualifies only the daemon actually shipped in public server packages", () => {
    expect(paperclipRunnerSupportsPlatform("codex_local", "linux", "x64")).toBe(true);
    for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"], ["freebsd", "x64"]]) expect(paperclipRunnerSupportsPlatform("codex_local", platform, architecture)).toBe(false);
  });
  it("keeps auto out of saved update defaults and validates request intent", () => {
    expect(createAgentSchema.parse({ name: "Codex", adapterType: "codex_local" }).runner).toBeUndefined();
    expect(updateAgentSchema.parse({ title: "same execution" })).not.toHaveProperty("runner");
    expect(testAdapterEnvironmentSchema.parse({ runner: "legacy" }).runner).toBe("legacy");
    expect(createAgentSchema.safeParse({ name: "Codex", adapterType: "codex_local", runner: "other" }).success).toBe(false);
  });
});

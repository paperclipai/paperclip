import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentHarnessType, agentRunner, paperclipRunnerProfileForHarness, paperclipRunnerSupportsPlatform, PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION, createAgentSchema, updateAgentSchema, testAdapterEnvironmentSchema } from "@paperclipai/shared";
const state = vi.hoisted(() => ({ disabled: [] as string[], overridden: new Set<string>(), settings: {} as Record<string, unknown>, getEnvironment: vi.fn(), bindings: vi.fn(), managedEnvironment: vi.fn(), kubernetesEnvironment: vi.fn(), ensureKubernetesEnvironment: vi.fn(), ssh: vi.fn(), resolveEnvironment: vi.fn(), sandboxQualification: vi.fn() }));
vi.mock("../adapters/registry.js", () => ({ findActiveServerAdapter: (type: string) => ({ type }), hasActiveAdapterOverride: (type: string) => state.overridden.has(type), waitForExternalAdapters: async () => {} }));
vi.mock("./adapter-plugin-store.js", () => ({ getDisabledAdapterTypes: () => state.disabled }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ get: async () => state.settings }) }));
vi.mock("./environments.js", () => ({ environmentService: () => ({ getById: state.getEnvironment, listBoundCompanyIds: state.bindings, findManagedSandboxEnvironment: state.managedEnvironment, findKubernetesEnvironment: state.kubernetesEnvironment, ensureKubernetesEnvironment: state.ensureKubernetesEnvironment }) }));
vi.mock("./environment-probe.js", () => ({ readSandboxPlatformQualification: state.sandboxQualification }));
vi.mock("./environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: state.resolveEnvironment }));
vi.mock("@paperclipai/adapter-utils/ssh", () => ({ runSshCommand: state.ssh }));
import { AGENT_RUNNER_SSH_PLATFORM_COMMAND, agentRunnerAvailability, resolveAgentRunnerTargetForCompany, resolveNewAgentRunner, resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";
import { buildCodexAcpConfig, resolveCodexExecutionEngine } from "@paperclipai/adapter-codex-local/server";
import { secretService } from "./secrets.js";
import * as localPlatform from "../lib/agent-runner-platform.js";
const target = { driver: "local", platform: "linux", architecture: "x64" };
const qualifiedTargets = [target, { driver: "local", platform: "linux", architecture: "arm64" }, { driver: "local", platform: "darwin", architecture: "arm64" }, { driver: "local", platform: "darwin", architecture: "x64" }];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArchitecture = Object.getOwnPropertyDescriptor(process, "arch")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", originalPlatform); Object.defineProperty(process, "arch", originalArchitecture); });

describe("server-owned Codex runner selection", () => {
  beforeEach(() => { state.disabled = []; state.overridden.clear(); state.settings = {}; state.getEnvironment.mockReset(); state.bindings.mockReset().mockResolvedValue([]); state.managedEnvironment.mockReset(); state.kubernetesEnvironment.mockReset().mockResolvedValue(null); state.ensureKubernetesEnvironment.mockReset(); state.ssh.mockReset().mockResolvedValue({ stdout: "Linux\nx86_64\n" }); state.sandboxQualification.mockReset().mockResolvedValue(null); state.resolveEnvironment.mockReset().mockResolvedValue({ driver: "ssh", config: {} }); });
  it.each(["x64", "arm64"])("keeps detected musl/unknown Linux %s legacy and preserves saved execution", architecture => {
    for (const libc of ["musl", "unknown"] as const) {
      const target = { driver: "local", platform: "linux", architecture, libc };
      expect(agentRunnerAvailability("codex_local", target)).toEqual({ supportedRunners: ["legacy"], defaultRunner: "legacy" });
      const input = { adapterType: "codex_local", adapterConfig: { extraArgs: ["--sandbox", "read-only"] }, target };
      expect(resolveNewAgentRunner(input)).toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
      expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
      const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, target };
      expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
      expect(resolveNewAgentRunner({ ...saved, runner: "paperclip" })).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
      expect(agentRunnerAvailability("codex_local", { ...target, libc: "glibc" }).defaultRunner).toBe("paperclip");
    }
  });
  it.each([[undefined, false], ["2.38", false], ["2.39", true], ["3.0", true], [" 2.39 ", true], ["malformed", false], ["", false]] as const)("uses the measured local libc version (%s) for creation", async (glibcVersionRuntime, native) => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    Object.defineProperty(process, "arch", { ...originalArchitecture, value: "arm64" });
    vi.spyOn(localPlatform, "localAgentRunnerTarget").mockReturnValue({ driver: "local", platform: "linux", architecture: "arm64", libc: glibcVersionRuntime ? "glibc" : "unknown", ...(glibcVersionRuntime ? { glibcVersion: glibcVersionRuntime.trim() } : {}) });
    const localTarget = localPlatform.localAgentRunnerTarget();
    expect(localTarget).toEqual({ driver: "local", platform: "linux", architecture: "arm64", libc: glibcVersionRuntime ? "glibc" : "unknown", ...(glibcVersionRuntime ? { glibcVersion: glibcVersionRuntime.trim() } : {}) });
    expect(agentRunnerAvailability("codex_local").defaultRunner).toBe(native ? "paperclip" : "legacy");
    const saved = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local" });
    expect(saved.adapterType).toBe(native ? "paperclip_runner" : "codex_local");
  });
  it.each([
    ["2.38", false], ["2.39", true], ["2.40", true], ["3.0", true], ["2.9", false],
    ["glibc 2.39", true], [" 2.39 ", true], ["2.39.1", true], ["02.039", true],
    ["2.39ubuntu1", false], ["unknown", false], ["", false], ["2", false], ["2.-39", false],
    ["999999999999999999999999.0", false],
  ])("qualifies the measured GNU/Linux daemon ABI for glibc %s (%s)", (glibcVersion, native) => {
    expect(PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION).toBe("2.39");
    for (const architecture of ["x64", "arm64"]) {
      const target = { driver: "local", platform: "linux", architecture, libc: "glibc" as const, glibcVersion: String(glibcVersion) };
      expect(paperclipRunnerSupportsPlatform("codex_local", target.platform, architecture, target.libc, target.glibcVersion)).toBe(native);
      expect(agentRunnerAvailability("codex_local", target).defaultRunner).toBe(native ? "paperclip" : "legacy");
      expect(resolveNewAgentRunner({ adapterType: "codex_local", target }).adapterType).toBe(native ? "paperclip_runner" : "codex_local");
      if (!native) expect(() => resolveNewAgentRunner({ adapterType: "codex_local", runner: "paperclip", target })).toThrow("unavailable");
      const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, target, runner: "paperclip" as const };
      expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
    }
  });
  it("keeps an unidentified local Linux libc legacy if the platform probe is unavailable", () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    vi.spyOn(localPlatform, "localAgentRunnerTarget").mockReturnValue({ driver: "local", platform: "linux", architecture: "x64", libc: "unknown" });
    expect(localPlatform.localAgentRunnerTarget()).toMatchObject({ libc: "unknown" });
    expect(agentRunnerAvailability("codex_local").defaultRunner).toBe("legacy");
  });
  it.each(qualifiedTargets)("uses native Codex automatically with compatible configuration and is idempotent on $platform/$architecture", target => {
    const input = { adapterType: "codex_local", target, adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high", env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret" } }, cwd: "/workspace", instructionsFilePath: "/workspace/AGENTS.md", workspaceStrategy: { type: "git_worktree" }, timeoutSec: 60, search: false, fastMode: false, dangerouslyBypassApprovalsAndSandbox: true } };
    const resolved = resolveNewAgentRunner(input);
    expect(resolved).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", codexPermissionMode: "never", modelReasoningEffort: "high", env: input.adapterConfig.env, workspaceStrategy: input.adapterConfig.workspaceStrategy, timeoutSec: 60 } });
    expect(resolved.adapterConfig).not.toHaveProperty("search");
    expect(resolveNewAgentRunner(resolved)).toEqual(resolved);
    expect(input.adapterConfig).toHaveProperty("search", false);
  });
  it.each(["grok_local", "cursor", "process", "external"])("keeps %s default unchanged", adapterType => {
    expect(resolveNewAgentRunner({ adapterType, target, adapterConfig: { custom: "preserved" } })).toEqual({ adapterType, adapterConfig: { custom: "preserved" } });
  });
  it.each(qualifiedTargets.filter(target => !(target.platform === "linux" && target.architecture === "arm64")))("defaults Pi to native on $platform/$architecture and round trips exact thinking", target => {
    const adapterConfig = { model: "openrouter/anthropic/claude-sonnet-4.6", thinking: "high", command: "pi", env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "connection" } }, cwd: "/workspace" };
    const selected = resolveNewAgentRunner({ adapterType: "pi_local", adapterConfig, target });
    expect(agentRunnerAvailability("pi_local", target).defaultRunner).toBe("paperclip");
    expect(selected).toEqual({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi", model: adapterConfig.model, piThinkingLevel: "high", acpxPermissionMode: "approve-all", lifecycleMode: "per_turn", cwd: adapterConfig.cwd, env: adapterConfig.env } });
    expect(resolveNewAgentRunner(selected)).toEqual(selected);
    expect(resolveNewAgentRunner({ ...selected, runner: "legacy" })).toEqual({ adapterType: "pi_local", adapterConfig: { model: adapterConfig.model, thinking: "high", cwd: adapterConfig.cwd, env: adapterConfig.env } });
  });
  it.each(["minimal", "medium", "xhigh"])("keeps unsupported Pi thinking %s explicit", thinking => {
    const input = { adapterType: "pi_local", target, adapterConfig: { model: "custom/model", thinking } };
    expect(() => resolveNewAgentRunner(input)).toThrow("Legacy runner");
    expect(resolveNewAgentRunner({ ...input, runner: "legacy" })).toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
  });
  it.each([{ command: "custom-pi" }, { args: ["--extension", "custom.ts"] }, { extraArgs: "--no-tools" }, { stdoutLogMode: "raw" }, { thinking: "low", piThinkingLevel: "high" }])("rejects unsupported Pi configuration %j", extra => {
    expect(() => resolveNewAgentRunner({ adapterType: "pi_local", target, adapterConfig: { model: "custom/model", ...extra } })).toThrow("Legacy runner");
  });
  it.each([undefined, "", "model", "provider/"])("requires a Pi provider/model outside inactive setup: %s", model => {
    expect(() => resolveNewAgentRunner({ adapterType: "pi_local", target, adapterConfig: { model } })).toThrow("provider/model");
  });
  it("allows an inactive Pi draft before model selection and preserves saved native policy", () => {
    expect(resolveNewAgentRunner({ adapterType: "pi_local", target, setupOnly: true })).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "", piThinkingLevel: "low" } });
    const saved = { adapterType: "paperclip_runner", target, adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "custom/model", piThinkingLevel: "max", acpxPermissionMode: "approve-reads", lifecycleMode: "warm", idleTimeoutMs: 1234 } };
    expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
    expect(() => resolveNewAgentRunner({ ...saved, runner: "legacy" })).toThrow("Legacy Pi cannot honor");
  });
  it.each([{ driver: "local", platform: "win32", architecture: "x64" }, { driver: "local", platform: "linux", architecture: "arm64", libc: "glibc" as const, glibcVersion: "2.39" }, { driver: "ssh", platform: "linux", architecture: "arm64", libc: "glibc" as const, glibcVersion: "2.39" }, { driver: "sandbox" }, { driver: "local", platform: "linux", architecture: "x64", libc: "musl" as const }])("keeps Pi legacy on unqualified $driver/$platform targets", target => {
    const input = { adapterType: "pi_local", adapterConfig: { model: "custom/model", thinking: "medium" }, target };
    expect(agentRunnerAvailability("pi_local", target).defaultRunner).toBe("legacy");
    expect(resolveNewAgentRunner(input)).toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
  });
  it.each(["minimal", "medium", "xhigh"])("honors an explicit Legacy Pi thinking edit to %s when resuming a native draft", thinking => {
    expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", runner: "legacy", adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "custom/model", piThinkingLevel: "max", thinking } })).toEqual({ adapterType: "pi_local", adapterConfig: { model: "custom/model", thinking } });
  });
  it("honors disabled and overridden Pi adapters", () => {
    const input = { adapterType: "pi_local", target, adapterConfig: { model: "custom/model" } };
    state.overridden.add("pi_local");
    expect(resolveNewAgentRunner(input).adapterType).toBe("pi_local");
    state.overridden.clear(); state.disabled = ["paperclip_runner"];
    expect(resolveNewAgentRunner(input).adapterType).toBe("pi_local");
    state.disabled = ["pi_local"];
    expect(() => resolveNewAgentRunner(input)).toThrow("Pi is disabled");
  });
  it.each(qualifiedTargets.filter(target => !(target.platform === "linux" && target.architecture === "arm64")))("defaults OpenCode to its native provider on $platform/$architecture", target => {
    const adapterConfig = { model: "openrouter/anthropic/claude-sonnet-4.6", dangerouslySkipPermissions: true, command: "opencode", env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "connection" } }, cwd: "/workspace", instructionsFilePath: "/workspace/AGENTS.md" };
    const selected = resolveNewAgentRunner({ adapterType: "opencode_local", adapterConfig, target });
    expect(agentRunnerAvailability("opencode_local", target).defaultRunner).toBe("paperclip");
    expect(selected).toEqual({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: adapterConfig.model, env: adapterConfig.env, cwd: adapterConfig.cwd, instructionsFilePath: adapterConfig.instructionsFilePath, opencodePermissionMode: "allow", lifecycleMode: "per_turn" } });
    expect(resolveNewAgentRunner(selected)).toEqual(selected);
    expect(resolveNewAgentRunner({ ...selected, runner: "legacy" })).toMatchObject({ adapterType: "opencode_local", adapterConfig: { model: adapterConfig.model, dangerouslySkipPermissions: true } });
  });
  it.each([{ driver: "local", platform: "win32", architecture: "x64" }, { driver: "local", platform: "linux", architecture: "arm64", libc: "glibc" as const, glibcVersion: "2.39" }, { driver: "ssh", platform: "linux", architecture: "arm64", libc: "glibc" as const, glibcVersion: "2.39" }, { driver: "sandbox", platform: "linux", architecture: "arm64", libc: "glibc" as const, glibcVersion: "2.39" }, { driver: "local", platform: "linux", architecture: "arm64", libc: "musl" as const }, { driver: "local", platform: "linux", architecture: "x64", libc: "glibc" as const, glibcVersion: "2.38" }, { driver: "sandbox" }])("keeps OpenCode legacy on unqualified $driver/$platform targets", target => {
    const input = { adapterType: "opencode_local", adapterConfig: { model: "custom/model", command: "custom-opencode" }, target };
    expect(agentRunnerAvailability("opencode_local", target)).toEqual({ supportedRunners: ["legacy"], defaultRunner: "legacy" });
    expect(resolveNewAgentRunner(input)).toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
  });
  it.each([{ command: "custom-opencode" }, { variant: "high" }, { extraArgs: ["--agent", "plan"] }, { args: ["--attach", "http://localhost"] }, { dangerouslySkipPermissions: false }])("rejects unsupported OpenCode settings instead of discarding them: %j", adapterConfig => {
    const input = { adapterType: "opencode_local", adapterConfig: { model: "custom/model", ...adapterConfig }, target };
    expect(() => resolveNewAgentRunner(input)).toThrow("Legacy runner");
    expect(resolveNewAgentRunner({ ...input, runner: "legacy" })).toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
  });
  it.each([undefined, "", "model", "provider/"])("requires an explicit OpenCode provider/model: %s", model => {
    expect(() => resolveNewAgentRunner({ adapterType: "opencode_local", adapterConfig: { model }, target })).toThrow("provider/model");
  });
  it("stores an inactive native OpenCode setup draft before model selection, but cannot hire it", () => {
    const input = { adapterType: "opencode_local", target };
    expect(resolveNewAgentRunner({ ...input, setupOnly: true })).toEqual({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "", opencodePermissionMode: "allow", lifecycleMode: "per_turn" } });
    expect(() => resolveNewAgentRunner(input)).toThrow("provider/model");
  });
  it("honors native OpenCode permissions and refuses to discard them on return to legacy", () => {
    const selected = resolveNewAgentRunner({ adapterType: "opencode_local", adapterConfig: { model: "custom/model", opencodePermissionMode: "ask" }, target });
    expect(selected.adapterConfig.opencodePermissionMode).toBe("ask");
    expect(() => resolveNewAgentRunner({ ...selected, runner: "legacy" })).toThrow("opencodePermissionMode");
  });
  it("resolves OpenCode against the company sandbox qualification and preserves disabled/overridden adapters", async () => {
    const input = { adapterType: "opencode_local", adapterConfig: { model: "custom/model" } };
    state.settings = { defaultEnvironmentId: "sandbox" };
    state.getEnvironment.mockResolvedValue({ id: "sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" } });
    expect((await resolveNewAgentRunnerForCompany({} as never, "company", input)).adapterType).toBe("opencode_local");
    state.sandboxQualification.mockResolvedValue({ platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.39" });
    expect((await resolveNewAgentRunnerForCompany({} as never, "company", input)).adapterType).toBe("paperclip_runner");
    state.overridden.add("opencode_local");
    expect(resolveNewAgentRunner({ ...input, target }).adapterType).toBe("opencode_local");
    state.overridden.clear(); state.disabled = ["paperclip_runner"];
    expect(resolveNewAgentRunner({ ...input, target }).adapterType).toBe("opencode_local");
    state.disabled = ["opencode_local"];
    expect(() => resolveNewAgentRunner({ ...input, target })).toThrow("OpenCode is disabled");
  });
  it.each(qualifiedTargets)("allows an explicit legacy runner and native to legacy round trip on $platform/$architecture", target => {
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target, runner: "legacy", adapterConfig: { extraArgs: ["--search"] } }).adapterType).toBe("codex_local");
    expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", runner: "legacy", adapterConfig: { provider: "codex", model: "gpt-5.6-sol", lifecycleMode: "per_turn", codexPermissionMode: "never", modelReasoningEffort: "high" } })).toEqual({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high", dangerouslyBypassApprovalsAndSandbox: true } });
  });
  it("preserves explicit legacy permission policy alongside compatible native lifecycle defaults", () => {
    expect(resolveNewAgentRunner({ adapterType: "codex_local", runner: "legacy", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false, lifecycleMode: "per_turn" } }))
      .toEqual({ adapterType: "codex_local", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } });
    expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", runner: "legacy", adapterConfig: { provider: "codex", codexPermissionMode: "never", lifecycleMode: "per_turn", dangerouslyBypassApprovalsAndSandbox: false } }))
      .toEqual({ adapterType: "codex_local", adapterConfig: { dangerouslyBypassApprovalsAndSandbox: false } });
  });
  it.each([{ platform: "win32", architecture: "x64" }, { platform: "linux", architecture: "arm" }, { platform: "darwin", architecture: "ia32" }])("keeps unqualified $platform/$architecture targets legacy while preserving explicit native profiles", ({ platform, architecture }) => {
    const input = { adapterType: "codex_local", target: { driver: "local", platform, architecture } };
    expect(resolveNewAgentRunner(input).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
    const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, target: input.target };
    expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
    expect(resolveNewAgentRunner({ ...saved, runner: "paperclip" })).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
  });
  it.each(qualifiedTargets)("automatically keeps unsupported targets and active external overrides legacy on $platform/$architecture", target => {
    const input = { adapterType: "codex_local", target: { driver: "local", platform: "win32", architecture: "x64" } };
    expect(resolveNewAgentRunner(input).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow("unavailable");
    state.overridden.add("codex_local");
    expect(agentRunnerAvailability("codex_local", target).defaultRunner).toBe("legacy");
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target }).adapterType).toBe("codex_local");
    state.overridden.clear();
    state.overridden.add("paperclip_runner");
    expect(resolveNewAgentRunner({ adapterType: "codex_local", target }).adapterType).toBe("codex_local");
  });
  it.each(qualifiedTargets)("does not select a disabled runner on $platform/$architecture", target => {
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
  it.each([
    ["agentCommand", "acpAgentCommand", "custom-codex-acp"],
    ["stateDir", "acpStateDir", "/custom/acp-state"],
    ["mode", "acpMode", "oneshot"],
    ["permissionMode", "acpPermissionMode", "deny-all"],
    ["nonInteractivePermissions", "acpNonInteractivePermissions", "fail"],
    ["warmHandleIdleMs", "acpWarmHandleIdleMs", 30_000],
  ])("rejects effective Legacy ACP alias %s/%s before automatic native translation", (canonical, alias, value) => {
    const adapterConfig = { engine: "acp", [alias]: value };
    expect(buildCodexAcpConfig(adapterConfig)).toHaveProperty(canonical, value);
    for (const runner of ["auto", "paperclip"] as const) {
      expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner }))
        .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: [alias] } }));
    }
    expect(resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner: "legacy" }))
      .toEqual({ adapterType: "codex_local", adapterConfig });
  });

  it.each([
    ["agentCommand", "acpAgentCommand", "canonical-command", "alias-command"],
    ["stateDir", "acpStateDir", "/canonical-state", "/alias-state"],
    ["permissionMode", "acpPermissionMode", "approve-all", "deny-all"],
  ])("checks the effective canonical ACP %s ahead of its alias", (canonical, alias, value, aliasedValue) => {
    const adapterConfig = { engine: "acp", [canonical]: value, [alias]: aliasedValue };
    expect(buildCodexAcpConfig(adapterConfig)).toHaveProperty(canonical, value);
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }))
      .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: [canonical] } }));
  });

  it("uses Legacy ACP canonical precedence and removes compatible or shadowed aliases idempotently", () => {
    const adapterConfig = { engine: "acp", mode: "persistent", acpMode: "oneshot",
      nonInteractivePermissions: "deny", acpNonInteractivePermissions: "fail",
      warmHandleIdleMs: 0, acpWarmHandleIdleMs: 30_000 };
    expect(buildCodexAcpConfig(adapterConfig)).toMatchObject({ mode: "persistent", nonInteractivePermissions: "deny", warmHandleIdleMs: 0 });
    const resolved = resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target });
    expect(resolved).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { codexPermissionMode: "never" } });
    for (const field of Object.keys(adapterConfig)) expect(resolved.adapterConfig).not.toHaveProperty(field);
    expect(resolveNewAgentRunner(resolved)).toEqual(resolved);
    expect(resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner: "legacy" }))
      .toEqual({ adapterType: "codex_local", adapterConfig });
  });

  it("accepts equivalent ACP default aliases without persisting legacy-only controls", () => {
    const adapterConfig = { engine: "acp", acpMode: " persistent ", acpNonInteractivePermissions: " deny ", acpWarmHandleIdleMs: 0 };
    expect(buildCodexAcpConfig(adapterConfig)).toMatchObject({ mode: "persistent", nonInteractivePermissions: "deny", warmHandleIdleMs: 0 });
    const resolved = resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target });
    expect(resolved.adapterType).toBe("paperclip_runner");
    for (const field of Object.keys(adapterConfig)) expect(resolved.adapterConfig).not.toHaveProperty(field);
    expect(resolveNewAgentRunner(resolved)).toEqual(resolved);
  });

  it("uses nullish ACP idle precedence instead of treating a canonical zero as absent", () => {
    const adapterConfig = { engine: "acp", warmHandleIdleMs: null, acpWarmHandleIdleMs: 30_000 };
    expect(buildCodexAcpConfig(adapterConfig)).toHaveProperty("warmHandleIdleMs", 30_000);
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }))
      .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: ["acpWarmHandleIdleMs"] } }));
  });

  it("uses a nonempty ACP alias when its canonical string is blank", () => {
    const adapterConfig = { engine: "acp", permissionMode: "  ", acpPermissionMode: " deny-all " };
    expect(buildCodexAcpConfig(adapterConfig)).toHaveProperty("permissionMode", "deny-all");
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }))
      .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: ["acpPermissionMode"] } }));
  });

  it.each([undefined, "acp"])("rejects effective Legacy ACP network denial for engine=%s before native selection", async engine => {
    const adapterConfig = { ...(engine ? { engine } : {}), env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" } };
    expect(resolveCodexExecutionEngine(adapterConfig).engine).toBe("acp");
    expect(buildCodexAcpConfig(adapterConfig)).toMatchObject({ env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" } });
    const { codexNetworkAccess } = await import(new URL(
      "../../../packages/paperclip-runner/src/drivers/codex/codex-security-config.ts", import.meta.url,
    ).href);
    expect(codexNetworkAccess({ PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled", PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" })).toBe(true);
    for (const runner of [undefined, "auto", "paperclip"] as const) {
      expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner }))
        .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: ["env.PAPERCLIP_CODEX_ACP_NETWORK_ACCESS"] } }));
    }
    expect(resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner: "legacy" }))
      .toEqual({ adapterType: "codex_local", adapterConfig });
    expect(adapterConfig.env).toEqual({ PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" });
  });

  it.each([
    { type: "plain", value: "false" },
    { type: "secret_ref", secretId: "fixture-policy", version: "latest" },
    { type: "user_secret_ref", key: "fixture-policy", version: "latest" },
  ])("does not discard a bound ACP network restriction or guess its value (%j)", async binding => {
    const adapterConfig = { engine: "acp", env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: binding } };
    if (binding.type === "plain") {
      const resolved = await secretService({} as never).resolveEnvBindings("fixture-company", adapterConfig.env);
      expect(buildCodexAcpConfig({ ...adapterConfig, env: resolved.env }))
        .toMatchObject({ env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" } });
    }
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }))
      .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: ["env.PAPERCLIP_CODEX_ACP_NETWORK_ACCESS"] } }));
    expect(resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target, runner: "legacy" }))
      .toEqual({ adapterType: "codex_local", adapterConfig });
  });

  it.each([
    { extraArgs: ["-c", "sandbox_workspace_write.network_access=true"] },
    { extraArgs: [], args: ["-c", "sandbox_workspace_write.network_access=true"] },
  ])("retains actionable argument errors when Legacy arguments override a network flag (%j)", args => {
    const adapterConfig = { engine: "acp", ...args, env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" } };
    expect(buildCodexAcpConfig(adapterConfig)).toMatchObject({ env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" } });
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }))
      .toThrow(expect.objectContaining({ status: 422, details: { code: "agent_runner_config_incompatible", fields: [args.extraArgs.length ? "extraArgs" : "args"] } }));
  });

  it.each(["true", "False", " false ", { type: "plain", value: "true" }])("keeps compatible ACP environment settings (%j) and native idempotence", value => {
    const adapterConfig = { engine: "acp", env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: value, OPENAI_API_KEY: { type: "secret_ref", secretId: "fixture-api-key" } } };
    const literal = typeof value === "string" ? value : value.value;
    expect(buildCodexAcpConfig({ ...adapterConfig, env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: literal } }))
      .toMatchObject({ env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" } });
    const resolved = resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target });
    expect(resolved.adapterType).toBe("paperclip_runner");
    expect(resolved.adapterConfig.env).toEqual(adapterConfig.env);
    expect(resolveNewAgentRunner(resolved)).toEqual(resolved);
  });

  it("keeps a saved native profile and an explicitly selected Legacy CLI's unused ACP flag unchanged", () => {
    const adapterConfig = { engine: "cli", env: { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" } };
    expect(resolveCodexExecutionEngine(adapterConfig).engine).toBe("cli");
    expect(resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig, target }).adapterType).toBe("paperclip_runner");
    const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", env: adapterConfig.env } };
    expect(resolveNewAgentRunner(saved)).toEqual(saved);
  });

  it("preserves explicit historical native profiles, including managed configurations", () => {
    for (const config of [{ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }, { provider: "claude_managed", managedProfileId: "profile", managedAgentsRetentionAcknowledged: true }, { provider: "aws_agentcore", agentCoreProfileId: "profile" }]) expect(resolveNewAgentRunner({ adapterType: "paperclip_runner", adapterConfig: config })).toEqual({ adapterType: "paperclip_runner", adapterConfig: config });
  });
  it("advertises Legacy for a forced Kubernetes target before lazy environment creation", async () => {
    state.settings = { general: { executionMode: "kubernetes" } };
    const selected = await resolveAgentRunnerTargetForCompany({} as never, "company");
    expect(selected).toEqual({ driver: "sandbox" });
    expect(agentRunnerAvailability("codex_local", selected)).toEqual({ supportedRunners: ["legacy"], defaultRunner: "legacy" });
    expect(state.kubernetesEnvironment).toHaveBeenCalledWith("company");
    expect(state.ensureKubernetesEnvironment).not.toHaveBeenCalled();
    expect(state.resolveEnvironment).not.toHaveBeenCalled();
    expect(state.sandboxQualification).not.toHaveBeenCalled();
    expect(state.ssh).not.toHaveBeenCalled();
  });
  it.each([undefined, "auto"] as const)("preserves Codex %s creation before a forced Kubernetes environment exists", async runner => {
    state.settings = { general: { executionMode: "kubernetes" } };
    const adapterConfig = { model: "gpt-5.6-sol", extraArgs: ["--search"], env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "synthetic-secret" } } };
    const resolved = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", adapterConfig, runner });
    expect(resolved).toEqual({ adapterType: "codex_local", adapterConfig });
    expect(state.ensureKubernetesEnvironment).not.toHaveBeenCalled();
    expect(state.resolveEnvironment).not.toHaveBeenCalled();
    expect(state.sandboxQualification).not.toHaveBeenCalled();
    expect(state.ssh).not.toHaveBeenCalled();
  });
  it("rejects explicit Paperclip execution on an unqualified forced Kubernetes target without provisioning", async () => {
    state.settings = { general: { executionMode: "kubernetes" } };
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", runner: "paperclip" }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("Legacy runner"), details: { code: "agent_runner_unavailable" } });
    expect(state.ensureKubernetesEnvironment).not.toHaveBeenCalled();
    expect(state.resolveEnvironment).not.toHaveBeenCalled();
    expect(state.sandboxQualification).not.toHaveBeenCalled();
    expect(state.ssh).not.toHaveBeenCalled();
  });
  it("preserves explicit Legacy and recorded native execution without reading the forced Kubernetes target", async () => {
    state.settings = { general: { executionMode: "kubernetes" } };
    for (const input of [
      { adapterType: "codex_local", runner: "legacy" as const, adapterConfig: { extraArgs: ["--search"] } },
      { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } },
    ]) {
      expect(await resolveNewAgentRunnerForCompany({} as never, "company", input))
        .toEqual({ adapterType: input.adapterType, adapterConfig: input.adapterConfig });
    }
    expect(state.kubernetesEnvironment).not.toHaveBeenCalled();
    expect(state.ensureKubernetesEnvironment).not.toHaveBeenCalled();
  });
  it("retains company checks for an existing forced Kubernetes environment", async () => {
    state.settings = { general: { executionMode: "kubernetes" } };
    state.kubernetesEnvironment.mockResolvedValue({ id: "kubernetes", driver: "sandbox", status: "active", config: { provider: "kubernetes" } });
    state.bindings.mockResolvedValue(["another-company"]);
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local" }))
      .rejects.toMatchObject({ status: 403, details: { code: "environment_company_mismatch" } });
    expect(state.ensureKubernetesEnvironment).not.toHaveBeenCalled();
    expect(state.sandboxQualification).not.toHaveBeenCalled();
    expect(state.resolveEnvironment).not.toHaveBeenCalled();
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
    expect(result.adapterType).toBe("paperclip_runner");
  });
  it.each([
    ["Linux\nx86_64\n", "paperclip", "paperclip_runner"],
    ["Darwin\narm64\n", "paperclip", "paperclip_runner"],
    ["Darwin\nx86_64\n", "paperclip", "paperclip_runner"],
    ["Linux\naarch64\n", "paperclip", "paperclip_runner"],
    ["Linux\narm64\n", "paperclip", "paperclip_runner"],
    ["Linux\nx86_64\nglibc\n", "paperclip", "paperclip_runner"],
    ["Linux\naarch64\nglibc\n", "paperclip", "paperclip_runner"],
    ["Linux\nx86_64\nglibc\nglibc 2.38\n", "legacy", "codex_local"],
    ["Linux\naarch64\nglibc\nglibc 2.38\n", "legacy", "codex_local"],
    ["Linux\nx86_64\nglibc\nglibc 2.39\n", "paperclip", "paperclip_runner"],
    ["Linux\naarch64\nglibc\nglibc 3.0\n", "paperclip", "paperclip_runner"],
    ["Linux\nx86_64\nglibc\nmalformed\n", "legacy", "codex_local"],
    ["Linux\nx86_64\nmusl\n", "legacy", "codex_local"],
    ["Linux\naarch64\nmusl\n", "legacy", "codex_local"],
    ["Linux\nx86_64\nunknown\n", "legacy", "codex_local"],
    ["Linux\narmv7l\n", "legacy", "codex_local"],
  ])("uses the same selected SSH target for discovery and saving (%s)", async (stdout, expectedRunner, expectedAdapter) => {
    state.getEnvironment.mockResolvedValue({ id: "selected", driver: "ssh", status: "active", config: {} });
    state.ssh.mockResolvedValue({ stdout });
    const discoveredTarget = await resolveAgentRunnerTargetForCompany({} as never, "company", "selected");
    expect(agentRunnerAvailability("codex_local", discoveredTarget).defaultRunner).toBe(expectedRunner);
    const saved = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "selected" });
    expect(saved.adapterType).toBe(expectedAdapter);
    expect(state.ssh).toHaveBeenCalledTimes(2);
    expect(state.ssh).toHaveBeenCalledWith({}, AGENT_RUNNER_SSH_PLATFORM_COMMAND, { timeoutMs: 10_000 });
  });
  it("preserves recorded explicit native execution without rechecking creation defaults", async () => {
    const recorded = { adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runner: "paperclip" as const };
    expect(await resolveNewAgentRunnerForCompany({} as never, "company", recorded)).toEqual({ adapterType: recorded.adapterType, adapterConfig: recorded.adapterConfig });
    expect(state.getEnvironment).not.toHaveBeenCalled();
    expect(state.ssh).not.toHaveBeenCalled();
  });
  it.each([
    [{ platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.39" }, "paperclip_runner"],
    [{ platform: "linux", architecture: "arm64", libc: "glibc", glibcVersion: "3.0" }, "paperclip_runner"],
    [{ platform: "linux", architecture: "arm64", libc: "glibc", glibcVersion: "2.38" }, "codex_local"],
    [{ platform: "linux", architecture: "x64", libc: "glibc" }, "codex_local"],
    [{ platform: "linux", architecture: "arm64", libc: "musl" }, "codex_local"],
    [{ platform: "linux", architecture: "unknown", libc: "glibc", glibcVersion: "2.39" }, "codex_local"],
  ])("uses cached selected-image measurements for sandbox creation/discovery (%j)", async (facts, expected) => {
    state.getEnvironment.mockResolvedValue({ id: "sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" } });
    state.sandboxQualification.mockResolvedValue(facts);
    const selectedTarget = await resolveAgentRunnerTargetForCompany({} as never, "company", "sandbox");
    expect(agentRunnerAvailability("codex_local", selectedTarget).defaultRunner).toBe(expected === "paperclip_runner" ? "paperclip" : "legacy");
    const result = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "sandbox" });
    expect(result.adapterType).toBe(expected);
    expect(state.ssh).not.toHaveBeenCalled();
    expect(state.resolveEnvironment).not.toHaveBeenCalled();
    if (expected === "codex_local") await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", runner: "paperclip", defaultEnvironmentId: "sandbox" })).rejects.toMatchObject({ status: 422 });
  });
  it("does not infer a sandbox image architecture from its driver", async () => {
    state.getEnvironment.mockResolvedValue({ id: "sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" } });
    const result = await resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "sandbox" });
    expect(result.adapterType).toBe("codex_local"); expect(state.ssh).not.toHaveBeenCalled();
    expect(state.sandboxQualification).toHaveBeenCalledWith({}, expect.objectContaining({ id: "sandbox" }), "company");
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", runner: "paperclip", defaultEnvironmentId: "sandbox" })).rejects.toMatchObject({ status: 422, details: { code: "agent_runner_unavailable" } });
  });
});

describe("Codex creation runner contract", () => {
  it("graduates qualified harnesses and retains saved provider identity", () => {
    expect(paperclipRunnerProfileForHarness("codex_local")).toEqual({ provider: "codex" });
    expect(paperclipRunnerProfileForHarness("claude_local")).toEqual({ provider: "acpx", acpxAgent: "claude" });
    expect(paperclipRunnerProfileForHarness("opencode_local")).toEqual({ provider: "opencode" });
    expect(paperclipRunnerProfileForHarness("pi_local")).toEqual({ provider: "acpx", acpxAgent: "pi" });
    for (const harness of ["grok_local", "cursor", "process"]) expect(paperclipRunnerProfileForHarness(harness)).toBeUndefined();
    expect(agentHarnessType("paperclip_runner", { provider: "codex" })).toBe("codex_local");
    expect(agentHarnessType("paperclip_runner", { provider: "acpx", acpxAgent: "claude" })).toBe("claude_local");
    expect(agentHarnessType("paperclip_runner", { provider: "unknown" })).toBe("unknown");
    expect(agentHarnessType("paperclip_runner", { provider: "acpx", acpxAgent: "unknown" })).toBe("acpx:unknown");
    expect(agentRunner("codex_local")).toBe("legacy");
    expect(agentRunner("paperclip_runner")).toBe("paperclip");
  });
  it("qualifies only the Codex daemon targets shipped in public server packages", () => {
    for (const { platform, architecture } of qualifiedTargets) expect(paperclipRunnerSupportsPlatform("codex_local", platform, architecture)).toBe(true);
    for (const architecture of ["x64", "arm64"]) {
      expect(paperclipRunnerSupportsPlatform("codex_local", "linux", architecture, "glibc")).toBe(true);
      expect(paperclipRunnerSupportsPlatform("codex_local", "linux", architecture, "musl")).toBe(false);
      expect(paperclipRunnerSupportsPlatform("codex_local", "linux", architecture, "unknown")).toBe(false);
    }
    for (const [platform, architecture] of [["darwin", "ia32"], ["linux", "arm"], ["win32", "x64"], ["win32", "arm64"], ["freebsd", "x64"]]) expect(paperclipRunnerSupportsPlatform("codex_local", platform, architecture)).toBe(false);
    expect(paperclipRunnerSupportsPlatform("claude_local", "darwin", "arm64")).toBe(true);
  });
  it("keeps auto out of saved update defaults and validates request intent", () => {
    expect(createAgentSchema.parse({ name: "Codex", adapterType: "codex_local" }).runner).toBeUndefined();
    expect(updateAgentSchema.parse({ title: "same execution" })).not.toHaveProperty("runner");
    expect(testAdapterEnvironmentSchema.parse({ runner: "legacy" }).runner).toBe("legacy");
    expect(createAgentSchema.safeParse({ name: "Codex", adapterType: "codex_local", runner: "other" }).success).toBe(false);
  });
});


describe("Claude runner defaults", () => {
  const mac = { driver: "local", platform: "darwin", architecture: "arm64" };
  beforeEach(() => { state.disabled = []; state.overridden.clear(); });
  it.each(qualifiedTargets)("defaults Claude to the qualified $platform $architecture profile", target => {
    expect(agentRunnerAvailability("claude_local", target)).toEqual({ supportedRunners: ["paperclip", "legacy"], defaultRunner: "paperclip" });
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target })).toEqual({
      adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5", acpxPermissionMode: "approve-all", lifecycleMode: "per_turn" },
    });
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target, runner: "legacy", adapterConfig: { model: "custom", dangerouslySkipPermissions: true } }))
      .toEqual({ adapterType: "claude_local", adapterConfig: { model: "custom", dangerouslySkipPermissions: true } });
  });
  it.each(["x64", "arm64"])("keeps Darwin SSH %s automatic selection Legacy while preserving explicit assets", architecture => {
    const target = { driver: "ssh", platform: "darwin", architecture };
    expect(agentRunnerAvailability("claude_local", target)).toEqual({ supportedRunners: ["paperclip", "legacy"], defaultRunner: "legacy" });
    const config = { model: "custom-model", dangerouslySkipPermissions: false };
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target, adapterConfig: config })).toEqual({ adapterType: "claude_local", adapterConfig: config });
    const assets = { runnerRemoteProviderPackPath: "/operator/mac-pack", runnerRemoteBinaryPath: "/operator/mac-daemon" };
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target, runner: "paperclip", adapterConfig: assets }))
      .toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { ...assets, provider: "acpx", acpxAgent: "claude" } });
    const saved = { adapterType: "paperclip_runner", adapterConfig: { ...assets, provider: "acpx", acpxAgent: "claude" }, target };
    expect(resolveNewAgentRunner(saved)).toEqual({ adapterType: saved.adapterType, adapterConfig: saved.adapterConfig });
  });
  it.each(["x64", "arm64"])("keeps incompatible Linux Claude %s targets legacy", architecture => {
    for (const libc of ["musl", "unknown"] as const) {
      expect(agentRunnerAvailability("claude_local", { driver: "local", platform: "linux", architecture, libc }).defaultRunner).toBe("legacy");
    }
    expect(agentRunnerAvailability("claude_local", { driver: "local", platform: "linux", architecture, libc: "glibc", glibcVersion: "2.17" }).defaultRunner).toBe("legacy");
  });
  it("saves native Claude with Opus 5.5, preserving credentials and shared settings", () => {
    const config = { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "key" } }, instructionsFilePath: "/workspace/AGENTS.md", timeoutSec: 180, dangerouslySkipPermissions: true };
    const result = resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: config });
    expect(result).toEqual({ adapterType: "paperclip_runner", adapterConfig: { env: config.env, instructionsFilePath: config.instructionsFilePath, timeoutSec: 180, provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5", acpxPermissionMode: "approve-all", lifecycleMode: "per_turn" } });
    expect(resolveNewAgentRunner(result)).toEqual(result);
    expect(config.dangerouslySkipPermissions).toBe(true);
  });
  it("preserves explicit models and Legacy choices", () => {
    const legacy = { adapterType: "claude_local", target: mac, runner: "legacy" as const, adapterConfig: { model: "custom", chrome: true } };
    expect(resolveNewAgentRunner(legacy)).toEqual({ adapterType: legacy.adapterType, adapterConfig: legacy.adapterConfig });
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { model: "custom" } }).adapterConfig.model).toBe("custom");
  });
  it.each(["claude-sonnet-5-5", "custom-model"])("preserves the plain environment model binding %s", model => {
    const env = { ANTHROPIC_MODEL: { type: "plain", value: model } };
    const native = resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { env } });
    expect(native.adapterConfig.model).toBe(model);
    expect(native.adapterConfig.env).toEqual(env);
  });
  it.each(["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_BEDROCK_BASE_URL"])("rejects unresolved %s before choosing a default", key => {
    const env = { [key]: { type: "secret_ref", secretId: "override" } };
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { env } })).toThrow(`env.${key}`);
    expect(resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { env, model: "custom-model" } }).adapterConfig.model).toBe("custom-model");
  });
  it("does not pin the ordinary model over a plain provider-routing binding", () => {
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac,
      adapterConfig: { env: { CLAUDE_CODE_USE_BEDROCK: { type: "plain", value: "1" } } } })).toThrow("Legacy runner");
  });
  it.each(["permissionMode", "acpPermissionMode"])("translates the legacy Claude %s without granting broader permissions", key => {
    for (const mode of ["deny-all", "approve-reads", "approve-all"]) {
      const native = resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { engine: "acp", [key]: mode } });
      expect(native.adapterConfig.acpxPermissionMode).toBe(mode);
      expect(native.adapterConfig[key]).toBeUndefined();
    }
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { [key]: "deny-all", acpxPermissionMode: "approve-all" } })).toThrow("cannot honor");
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { [key]: "unrecognized" } })).toThrow("Legacy runner");
  });
  it("retains saved native Claude and allows an explicit compatible Legacy switch", () => {
    const saved = { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "custom", acpxPermissionMode: "approve-all", lifecycleMode: "per_turn" } };
    expect(resolveNewAgentRunner(saved)).toEqual(saved);
    expect(resolveNewAgentRunner({ ...saved, runner: "legacy" })).toEqual({ adapterType: "claude_local", adapterConfig: { model: "custom", dangerouslySkipPermissions: true } });
    expect(() => resolveNewAgentRunner({ ...saved, runner: "legacy", adapterConfig: { ...saved.adapterConfig, acpxPermissionMode: "deny-all" } })).toThrow("cannot honor");
  });
  it.each(["chrome", "agentCommand", "maxTurnsPerRun", "networkScope"])("rejects unsupported %s without fallback", key => {
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { [key]: "configured" } })).toThrow("Legacy runner");
  });
  it.each(["low", "medium", "high", "xhigh", "max"])("translates Claude effort %s and preserves it on an explicit Legacy switch", effort => {
    const native = resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { effort } });
    expect(native.adapterConfig.modelReasoningEffort).toBe(effort);
    expect(native.adapterConfig.effort).toBeUndefined();
    expect(resolveNewAgentRunner({ ...native, runner: "legacy" }).adapterConfig).toMatchObject({ effort });
  });
  it("rejects invalid effort and unknown platform defaults", () => {
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac, adapterConfig: { effort: "ultra" } })).toThrow("Claude effort");
    expect(agentRunnerAvailability("claude_local", { driver: "sandbox" }).defaultRunner).toBe("legacy");
  });
  it("keeps unqualified targets and overrides legacy", () => {
    expect(agentRunnerAvailability("claude_local", { driver: "local", platform: "win32", architecture: "x64" }).defaultRunner).toBe("legacy");
    state.overridden.add("claude_local");
    expect(agentRunnerAvailability("claude_local", mac).defaultRunner).toBe("legacy");
    state.overridden.clear(); state.disabled = ["claude_local"];
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local", target: mac })).toThrow("Claude is disabled");
  });
});

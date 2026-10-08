import { beforeEach, describe, expect, it, vi } from "vitest";
const ssh = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/ssh", () => ({ runSshCommand: ssh.run }));
vi.mock("../services/environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: async () => ({ driver: "ssh", config: { host: "qa-host" } }) }));
const state = vi.hoisted(() => ({ disabled: [] as string[], overrides: new Set<string>(), settings: {} as Record<string, unknown>, environment: null as { id: string; driver: string } | null, managed: null as { id: string; driver: string } | null }));
vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: (type: string) => type === "missing" ? null : { type },
  hasActiveAdapterOverride: (type: string) => state.overrides.has(type),
  listEnabledServerAdapters: () => ["codex_local", "paperclip_runner", "gemini_local"].filter(type => !state.disabled.includes(type)).map(type => ({ type })),
}));
vi.mock("../services/adapter-plugin-store.js", () => ({ getDisabledAdapterTypes: () => state.disabled }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ get: async () => state.settings }) }));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ getById: async () => state.environment, findManagedSandboxEnvironment: async () => state.managed, findKubernetesEnvironment: async () => state.managed }) }));
import { agentRunnerAvailability, resolveNewAgentRunner, resolveNewAgentRunnerForCompany } from "../services/agent-runner-selection.js";

describe("server-owned agent runner selection", () => {
  beforeEach(() => { state.disabled = []; state.overrides.clear(); state.settings = {}; state.environment = null; state.managed = null; ssh.run.mockReset(); });
  it.each([
    ["codex_local", { provider: "codex" }], ["claude_local", { provider: "acpx", acpxAgent: "claude" }],
    ["opencode_local", { provider: "opencode" }], ["grok_local", { provider: "acpx", acpxAgent: "grok" }],
    ["cursor", { provider: "acpx", acpxAgent: "cursor" }],
  ])("resolves %s to its qualified provider", (adapterType, profile) => {
    expect(resolveNewAgentRunner({ adapterType, adapterConfig: { model: adapterType === "opencode_local" ? "openai/gpt-5" : "chosen-model" } })).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: profile });
  });
  it.each(["gemini_local", "pi_local", "kimi_local", "hermes_local", "cursor_cloud", "process", "http", "vendor"])("keeps %s legacy", adapterType => {
    expect(resolveNewAgentRunner({ adapterType }).adapterType).toBe(adapterType);
  });
  it("preserves an explicit legacy choice", () => {
    expect(resolveNewAgentRunner({ adapterType: "codex_local", runner: "legacy", adapterConfig: { command: "/custom/codex" } })).toMatchObject({ adapterType: "codex_local" });
  });
  it("uses legacy when the native adapter is disabled", () => {
    state.disabled = ["paperclip_runner"];
    expect(agentRunnerAvailability("codex_local").defaultRunner).toBe("legacy");
    expect(resolveNewAgentRunner({ adapterType: "codex_local" }).adapterType).toBe("codex_local");
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", runner: "paperclip" })).toThrow(/unavailable/);
  });
  it("rejects a disabled harness before selecting a runner", () => {
    state.disabled = ["claude_local"];
    expect(() => resolveNewAgentRunner({ adapterType: "claude_local" })).toThrow(/not available/);
  });
  it("respects an active external override", () => {
    state.overrides.add("codex_local");
    expect(resolveNewAgentRunner({ adapterType: "codex_local" }).adapterType).toBe("codex_local");
  });
  it.each([
    ["grok_local", "darwin", "x64"],
    ...["codex_local", "claude_local", "opencode_local", "grok_local", "cursor"].map(harness => [harness, "linux", "arm64"]),
  ])("uses legacy for %s on an unqualified %s/%s execution platform", (adapterType, platform, architecture) => {
    const input = { adapterType, target: { driver: "local", platform, architecture } };
    expect(agentRunnerAvailability(adapterType, input.target)).toEqual({ supportedRunners: ["legacy"], defaultRunner: "legacy" });
    expect(resolveNewAgentRunner(input).adapterType).toBe(adapterType);
    expect(() => resolveNewAgentRunner({ ...input, runner: "paperclip" })).toThrow(/unavailable/);
  });
  it("does not fall back for unsupported custom settings or invalid native models", () => {
    expect(() => resolveNewAgentRunner({ adapterType: "codex_local", adapterConfig: { command: "/custom/codex" } })).toThrow(/command/);
    expect(() => resolveNewAgentRunner({ adapterType: "opencode_local", adapterConfig: { model: "invalid" } })).toThrow(/provider\/model/);
    expect(() => resolveNewAgentRunner({ adapterType: "cursor" })).toThrow(/model/);
  });
  it.each(["managed", "kubernetes"])("requires the configured %s target instead of selecting the local host", async mode => {
    state.settings = mode === "managed" ? { defaultEnvironmentId: "local", experimental: { enableManagedSandboxOnly: true } } : { general: { executionMode: "kubernetes" } };
    state.environment = { id: "local", driver: "local" };
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local" })).rejects.toThrow(/unavailable/);
    state.managed = { id: "managed", driver: "sandbox" };
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local" })).resolves.toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
  });
  it("never guesses an unknown provider", () => {
    expect(() => resolveNewAgentRunner({ adapterType: "paperclip_runner", adapterConfig: { provider: "unknown" } })).toThrow(/provider/);
  });
  it.each([
    ["codex_local", "Linux\nx86_64\n", "paperclip_runner"],
    ["codex_local", "Linux\naarch64\n", "codex_local"],
    ["grok_local", "Darwin\nx86_64\n", "grok_local"],
    ["grok_local", "Darwin\narm64\n", "paperclip_runner"],
  ])("checks the SSH platform before resolving %s (%s)", async (adapterType, stdout, expected) => {
    state.environment = { id: "ssh-target", driver: "ssh" };
    ssh.run.mockResolvedValue({ stdout });
    const input = { adapterType, defaultEnvironmentId: "ssh-target" };
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", input)).resolves.toMatchObject({ adapterType: expected });
    expect(ssh.run).toHaveBeenCalledWith({ host: "qa-host" }, "uname -s; uname -m", { timeoutMs: 10_000 });
    if (expected !== "paperclip_runner") await expect(resolveNewAgentRunnerForCompany({} as never, "company", { ...input, runner: "paperclip" })).rejects.toThrow(/unavailable/);
  });
  it("reports an unreachable SSH target without silently changing runners", async () => {
    state.environment = { id: "ssh-target", driver: "ssh" };
    ssh.run.mockRejectedValue(new Error("connection failed"));
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "ssh-target" })).rejects.toThrow(/Check its connection/);
    ssh.run.mockClear();
    await expect(resolveNewAgentRunnerForCompany({} as never, "company", { adapterType: "codex_local", defaultEnvironmentId: "ssh-target", runner: "legacy" })).resolves.toMatchObject({ adapterType: "codex_local" });
    expect(ssh.run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AdapterInfo } from "../api/adapters";
import { qualifyClaudeSetup } from "./qualify-claude-setup";

const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
const discovery = (runner: "paperclip" | "legacy", overrides = {}) => [
  { type: "claude_local", defaultRunner: runner, supportedRunners: [runner], ...overrides },
  { type: "paperclip_runner" },
] as AdapterInfo[];
function setup() {
  return {
    adapterType: "claude_local", runner: "auto" as const,
    environment: { driver: "sandbox" as const, config: { provider: "daytona", image } },
    readAdapters: vi.fn().mockResolvedValueOnce(discovery("legacy")).mockResolvedValue(discovery("paperclip")),
    probeEnvironment: vi.fn().mockResolvedValue({ ok: true, driver: "sandbox", summary: "Measured image",
      details: { platformQualificationRecorded: true, leaseId: "owned-probe-lease" } }),
    isCurrent: vi.fn(() => true),
  };
}

describe("Claude explicit setup qualification", () => {
  it("qualifies a named Daytona snapshot through the normal Connect action", async () => {
    const s = setup();
    const input: Parameters<typeof qualifyClaudeSetup>[0] = { ...s, environment: { driver: "sandbox", config: { provider: "daytona", snapshot: "managed-snapshot" } } };
    expect((await qualifyClaudeSetup(input))?.runner).toBe("paperclip");
    expect(s.probeEnvironment).toHaveBeenCalledTimes(1);
  });
  it.each(["paperclip", "legacy"] as const)("uses fresh discovery and honors measured %s selection", async runner => {
    const s = setup();
    s.readAdapters.mockResolvedValueOnce(discovery(runner));
    const result = await qualifyClaudeSetup(s);
    expect(result?.runner).toBe(runner);
    expect(s.readAdapters).toHaveBeenCalledTimes(2);
    expect(s.probeEnvironment).toHaveBeenCalledTimes(1);
    expect(s.readAdapters.mock.invocationCallOrder[0]).toBeLessThan(s.probeEnvironment.mock.invocationCallOrder[0]);
    expect(s.probeEnvironment.mock.invocationCallOrder[0]).toBeLessThan(s.readAdapters.mock.invocationCallOrder[1]);
  });

  it.each(["permission", "cleanup", "missing-lease", "connection", "discovery"])("stops before adapter setup after %s failure", async failure => {
    const s = setup();
    if (failure === "permission") s.probeEnvironment.mockRejectedValue(new Error("Instance admin access required"));
    else if (failure === "discovery") s.readAdapters.mockRejectedValue(new Error("Discovery unavailable"));
    else s.probeEnvironment.mockResolvedValue({ ok: failure !== "connection", summary: "Qualification rejected",
      details: { platformQualificationRecorded: failure !== "cleanup", ...(failure === "missing-lease" ? {} : { leaseId: "lease" }) } });
    await expect(qualifyClaudeSetup(s)).rejects.toThrow(failure === "permission" ? "Instance admin" : failure === "discovery" ? "Discovery" : "Qualification rejected");
  });

  it.each(["legacy", "native", "local", "snapshot", "tag", "saved", "codex", "qualified", "disabled", "override", "missing-native"])("does not allocate an extra probe for %s", async mode => {
    const s = setup();
    const input: Parameters<typeof qualifyClaudeSetup>[0] = s;
    if (mode === "legacy" || mode === "native") input.runner = mode === "native" ? "paperclip" : "legacy";
    if (mode === "local") input.environment = { driver: "local", config: {} };
    if (mode === "snapshot") input.environment = { driver: "sandbox", config: { image, snapshot: "named-snapshot" } };
    if (mode === "tag") input.environment = { driver: "sandbox", config: { image: "registry.example.test/runtime:latest" } };
    if (mode === "saved") input.savedAgentId = "saved-agent";
    if (mode === "codex") input.adapterType = "codex_local";
    if (mode === "qualified") s.readAdapters.mockReset().mockResolvedValue(discovery("paperclip"));
    if (mode === "disabled" || mode === "override") s.readAdapters.mockReset().mockResolvedValue(discovery("legacy", mode === "disabled" ? { disabled: true } : { overriddenBuiltin: true }));
    if (mode === "missing-native") s.readAdapters.mockReset().mockResolvedValue(discovery("legacy").slice(0, 1));
    await qualifyClaudeSetup(input);
    expect(s.probeEnvironment).not.toHaveBeenCalled();
  });

  it("abandons a stale selection before probing and after probing", async () => {
    const before = setup(); before.isCurrent.mockReturnValue(false);
    expect(await qualifyClaudeSetup(before)).toBeUndefined();
    expect(before.probeEnvironment).not.toHaveBeenCalled();
    const after = setup(); after.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await qualifyClaudeSetup(after)).toBeUndefined();
    expect(after.probeEnvironment).toHaveBeenCalledTimes(1);
    expect(after.readAdapters).toHaveBeenCalledTimes(1);
  });
});

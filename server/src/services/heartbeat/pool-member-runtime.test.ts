import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "@paperclipai/adapter-codex-local/server";
import type { AiConnectionPoolMember } from "@paperclipai/shared";
import { applyAiConnectionRouterTaskSettings, assertPoolAdapterPolicyCompatible, poolMemberRuntimeConfig } from "../ai-connection-router.js";

const claude: AiConnectionPoolMember = {
  id: "33333333-3333-4333-8333-333333333333",
  binding: { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: "11111111-1111-4111-8111-111111111111", grantId: "22222222-2222-4222-8222-222222222222" },
  profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-4-6" },
};

describe("pool member runtime settings", () => {
  it("selects the explicit Claude CLI before a native Codex successor", () => {
    const first = poolMemberRuntimeConfig({ ...claude, runner: "legacy", adapterConfig: { engine: "cli", maxTurnsPerRun: 12, timeoutSec: 180 } }, "paperclip_runner");
    expect(first).toMatchObject({ adapterType: "claude_local", config: { engine: "cli", maxTurnsPerRun: 12, timeoutSec: 180, model: claude.profile.model } });
    const next = poolMemberRuntimeConfig({ ...claude, runner: "paperclip", binding: { ...claude.binding, provider: "openai" }, profile: { provider: "codex", model: "gpt-5.6-sol" } }, "claude_local");
    expect(next).toMatchObject({ adapterType: "paperclip_runner", config: { provider: "codex", model: "gpt-5.6-sol" } });
    expect(next.config.engine).toBeUndefined();
    expect(next.config.maxTurnsPerRun).toBeUndefined();
  });
  it("retains the native runtime envelope when settings are omitted", () => {
    expect(poolMemberRuntimeConfig(claude, "paperclip_runner")).toEqual({ adapterType: "paperclip_runner", config: { provider: "acpx", acpxAgent: "claude", model: claude.profile.model }, notes: [] });
  });
  it("applies only selected member tuning while retaining host-owned authority and workspace", () => {
    const selected = poolMemberRuntimeConfig({ ...claude, runner: "legacy", adapterConfig: { engine: "cli", timeoutSec: 42 } }, "paperclip_runner");
    const config = applyAiConnectionRouterTaskSettings({ cwd: "/workspace", instructionsFilePath: "/agent/AGENTS.md", env: { HOST_TOKEN: "host-owned" } }, { poolId: "pool", memberId: claude.id, binding: claude.binding, adapterType: selected.adapterType, runtimeConfig: selected.config, notes: [] }, "paperclip_runner");
    expect(config).toMatchObject({ cwd: "/workspace", instructionsFilePath: "/agent/AGENTS.md", env: { HOST_TOKEN: "host-owned" }, engine: "cli", timeoutSec: 42 });
  });
  it("preserves native permission restrictions when the same Claude harness changes to Legacy CLI", () => {
    expect(() => assertPoolAdapterPolicyCompatible({ provider: "acpx", acpxAgent: "claude", acpxPermissionMode: "deny-all" }, "paperclip_runner", "claude_local", { provider: "acpx", acpxAgent: "claude", engine: "cli" })).toThrow("Cannot preserve");
  });
  it("rejects replacement of explicit source security even without a harness change", () => {
    expect(() => assertPoolAdapterPolicyCompatible({ dangerouslySkipPermissions: false }, "claude_local", "claude_local", { dangerouslySkipPermissions: true })).toThrow("cannot replace");
    expect(() => assertPoolAdapterPolicyCompatible({ permissionMode: "deny-all" }, "claude_local", "claude_local", { permissionMode: "approve-all" })).toThrow("cannot replace");
    expect(() => assertPoolAdapterPolicyCompatible({ acpPermissionMode: "deny-all" }, "claude_local", "claude_local", { permissionMode: "approve-all" })).toThrow("cannot replace");
    expect(() => assertPoolAdapterPolicyCompatible({ acpNonInteractivePermissions: "deny" }, "claude_local", "claude_local", { nonInteractivePermissions: "fail" })).toThrow("cannot replace");
  });
  it("refuses a native Codex continuation before Legacy CLI can acquire its default bypass", () => {
    const legacy = { provider: "codex", engine: "cli", model: "gpt-5.6-sol" };
    expect(buildCodexExecArgs(legacy).args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const admitted = { poolId: "pool", memberId: "native", binding: { ...claude.binding, provider: "openai" as const },
      adapterType: "paperclip_runner", runtimeConfig: { provider: "codex", model: "gpt-5.6-sol" }, notes: [] };
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "codex_local", legacy, admitted))
      .toThrow("Cannot preserve");
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "claude_local", { engine: "cli" }, admitted))
      .toThrow("Cannot preserve");
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "paperclip_runner", legacy, admitted))
      .not.toThrow();
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "codex_local", legacy, { ...admitted, runtimeConfig: {} }))
      .toThrow("Cannot preserve");
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "codex_local", legacy, { ...admitted, adapterType: undefined }))
      .toThrow("Cannot preserve");
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "codex_local", legacy, { ...admitted, adapterType: "codex_local" }))
      .not.toThrow();
    expect(() => assertPoolAdapterPolicyCompatible({}, "paperclip_runner", "claude_local", { engine: "cli" }))
      .not.toThrow();
  });
  it.each([
    { provider: "acpx", acpxAgent: "claude", key: "acpxPermissionMode", restricted: "deny-all", widened: "approve-all" },
    { provider: "opencode", key: "opencodePermissionMode", restricted: "deny", widened: "allow" },
  ])("retains explicit frozen $provider restrictions on native successors", ({ provider, acpxAgent, key, restricted, widened }) => {
    const config = { provider, ...(acpxAgent ? { acpxAgent } : {}), [key]: restricted };
    const admitted = { poolId: "pool", memberId: "native", binding: claude.binding,
      adapterType: "paperclip_runner", runtimeConfig: config, notes: [] };
    const check = (target: Record<string, unknown>, adapter = "paperclip_runner") =>
      assertPoolAdapterPolicyCompatible({}, "paperclip_runner", adapter, target, admitted);
    expect(() => check({ provider, ...(acpxAgent ? { acpxAgent } : {}) })).toThrow("Cannot preserve");
    expect(() => check({ ...config, [key]: widened })).toThrow("Cannot preserve");
    expect(() => check({ ...config, provider: "codex" })).toThrow("Cannot preserve");
    expect(() => check(config, "claude_local")).toThrow("Cannot preserve");
    if (acpxAgent) expect(() => check({ ...config, acpxAgent: "grok" })).toThrow("Cannot preserve");
    expect(() => check(config)).not.toThrow();
  });
});

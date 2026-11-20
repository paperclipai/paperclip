import { describe, expect, it } from "vitest";
import { isCloudHarnessAllowed, isCloudRunnerProviderAllowed } from "./cloud-harness-policy";
import { isNewAgentAdapterAllowed } from "./new-agent-adapters";

describe("Cloud harness choices", () => {
  it.each(["claude_local", "codex_local", "grok_local", "opencode_local", "copilot_runtime"])("offers %s", type => {
    expect(isCloudHarnessAllowed(type)).toBe(true);
  });

  it.each(["antigravity_runtime", "gemini_local", "kimi_local", "pi_local", "cursor", "cursor_cloud", "hermes_local", "openai_dot", "muse", "plugin_harness"])("withholds %s", type => {
    expect(isCloudHarnessAllowed(type)).toBe(false);
    expect(isNewAgentAdapterAllowed(type, { cloud: true, nativeRunnerEnabled: true, openAiDotEnabled: true, museEnabled: true })).toBe(false);
  });

  it.each(["claude", "codex", "grok", "opencode", "copilot"])("offers native %s", provider => {
    expect(isCloudRunnerProviderAllowed(provider)).toBe(true);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, nativeRunnerEnabled: true, runnerProvider: provider })).toBe(true);
  });

  it.each(["antigravity", "kimi", "pi", "cursor", "cursor_cloud", "claude_managed", "aws_agentcore", "openai_dot", "muse", "grok_bot", "unknown"])("withholds native %s even with experiments and candidate access", runnerProvider => {
    expect(isCloudRunnerProviderAllowed(runnerProvider)).toBe(false);
    expect(isNewAgentAdapterAllowed("paperclip_runner", {
      cloud: true, nativeRunnerEnabled: true, openAiDotEnabled: true, museEnabled: true, runnerProvider,
      candidateHarnesses: [{ agent: "antigravity", model: "candidate-model" }],
    })).toBe(false);
  });

  it("resolves saved Runner profiles by their harness", () => {
    expect(isCloudHarnessAllowed("paperclip_runner")).toBe(true);
    for (const acpxAgent of ["claude", "grok", "copilot"]) {
      expect(isCloudHarnessAllowed("paperclip_runner", { provider: "acpx", acpxAgent })).toBe(true);
      expect(isCloudRunnerProviderAllowed("acpx", acpxAgent)).toBe(true);
    }
    expect(isCloudHarnessAllowed("paperclip_runner", { provider: "acpx", acpxAgent: "antigravity" })).toBe(false);
    expect(isCloudHarnessAllowed("paperclip_runner", { provider: "acpx", acpxAgent: "unknown" })).toBe(false);
  });

  it("preserves self-hosted experiments and Cloud's existing native gate", () => {
    expect(isNewAgentAdapterAllowed("cursor_cloud", { cloud: false, nativeRunnerEnabled: true })).toBe(true);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: false, nativeRunnerEnabled: true, runnerProvider: "antigravity", candidateHarnesses: [{ agent: "antigravity", model: "candidate-model" }] })).toBe(true);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, nativeRunnerEnabled: false, runnerProvider: "codex" })).toBe(false);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, nativeRunnerEnabled: false, runnerProvider: "copilot" })).toBe(true);
  });
});

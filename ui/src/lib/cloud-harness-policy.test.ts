import { describe, expect, it, vi } from "vitest";
import { createCloudHarnessPolicy } from "./cloud-harness-policy";
import { isNewAgentAdapterAllowed } from "./new-agent-adapters";

const harnessPolicy = createCloudHarnessPolicy(["claude_local", "codex_local", "grok_local", "opencode_local", "copilot_runtime"]);
const { isCloudHarnessAllowed, isCloudRunnerProviderAllowed } = harnessPolicy;

describe("configured Cloud harness choices", () => {
  it("uses only the supplied policy, with no built-in Cloud list", () => {
    const unrestricted = createCloudHarnessPolicy();
    const changed = createCloudHarnessPolicy(["gemini_local", "pi_local", "antigravity_runtime", "plugin_harness"]);
    for (const type of ["codex_local", "gemini_local", "plugin_harness"]) {
      expect(unrestricted.isCloudHarnessAllowed(type)).toBe(true);
      expect(createCloudHarnessPolicy([]).isCloudHarnessAllowed(type)).toBe(false);
    }
    expect(changed.isCloudHarnessAllowed("codex_local")).toBe(false);
    expect(changed.isCloudHarnessAllowed("gemini_local")).toBe(true);
    expect(changed.isCloudHarnessAllowed("plugin_harness")).toBe(true);
    expect(changed.isCloudRunnerProviderAllowed("pi")).toBe(true);
    expect(changed.isCloudRunnerProviderAllowed("antigravity")).toBe(true);
    expect(changed.isCloudHarnessAllowed("paperclip_runner", { provider: "acpx", acpxAgent: "pi" })).toBe(true);
    expect(changed.isCloudRunnerProviderAllowed("copilot")).toBe(false);
  });

  it("allows qualified Antigravity when the deployment policy enables it, without a candidate grant", () => {
    const policy = createCloudHarnessPolicy(["antigravity_runtime"]);
    const options = { cloud: true, harnessPolicy: policy, nativeRunnerEnabled: false, runnerProvider: "antigravity" };
    expect(isNewAgentAdapterAllowed("paperclip_runner", options)).toBe(true);
  });

  it.each(["claude_local", "codex_local", "grok_local", "opencode_local", "copilot_runtime"])("offers %s", type => {
    expect(isCloudHarnessAllowed(type)).toBe(true);
  });

  it.each(["antigravity_runtime", "gemini_local", "kimi_local", "pi_local", "cursor", "cursor_cloud", "hermes_local", "openai_dot", "muse", "plugin_harness"])("withholds %s", type => {
    expect(isCloudHarnessAllowed(type)).toBe(false);
    expect(isNewAgentAdapterAllowed(type, { cloud: true, harnessPolicy, nativeRunnerEnabled: true, openAiDotEnabled: true, museEnabled: true })).toBe(false);
  });

  it.each(["claude", "codex", "grok", "opencode", "copilot"])("offers native %s", provider => {
    expect(isCloudRunnerProviderAllowed(provider)).toBe(true);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, harnessPolicy, nativeRunnerEnabled: true, runnerProvider: provider })).toBe(true);
  });

  it.each(["antigravity", "kimi", "pi", "cursor", "cursor_cloud", "claude_managed", "aws_agentcore", "openai_dot", "muse", "grok_bot", "unknown"])("withholds native %s even with experiments and candidate access", runnerProvider => {
    expect(isCloudRunnerProviderAllowed(runnerProvider)).toBe(false);
    expect(isNewAgentAdapterAllowed("paperclip_runner", {
      cloud: true, harnessPolicy, nativeRunnerEnabled: true, openAiDotEnabled: true, museEnabled: true, runnerProvider,
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
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, harnessPolicy, nativeRunnerEnabled: false, runnerProvider: "codex" })).toBe(false);
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: true, harnessPolicy, nativeRunnerEnabled: false, runnerProvider: "copilot" })).toBe(true);
  });

  it("offers a released Antigravity profile on Cloud without nativeRunnerEnabled or candidateHarnesses", async () => {
    vi.resetModules();
    vi.doMock("@paperclipai/adapter-utils", async importOriginal => {
      const actual = await importOriginal<typeof import("@paperclipai/adapter-utils")>();
      return {
        ...actual,
        PAPERCLIP_RUNNER_ACPX_PROFILES: actual.PAPERCLIP_RUNNER_ACPX_PROFILES.map(profile =>
          profile.value === "antigravity" ? { ...profile, qualified: true } : profile),
      };
    });
    try {
      const { isNewAgentAdapterAllowed: allowed } = await import("./new-agent-adapters");
      const policy = createCloudHarnessPolicy(["antigravity_runtime"]);
      expect(allowed("paperclip_runner", {
        cloud: true,
        harnessPolicy: policy,
        nativeRunnerEnabled: false,
        runnerProvider: "antigravity",
      })).toBe(true);
      expect(allowed("paperclip_runner", {
        cloud: true,
        harnessPolicy,
        nativeRunnerEnabled: true,
        runnerProvider: "antigravity",
      })).toBe(false);
    } finally {
      vi.doUnmock("@paperclipai/adapter-utils");
      vi.resetModules();
    }
  });
});

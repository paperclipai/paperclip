import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES } from "../constants.js";
import {
  getEnvironmentCapabilities,
  supportedEnvironmentDriversForAdapter,
} from "../environment-support.js";

describe("supportedEnvironmentDriversForAdapter — k8s adapters", () => {
  it("returns ['local', 'k8s'] for claude_k8s", () => {
    expect(supportedEnvironmentDriversForAdapter("claude_k8s")).toEqual(["local", "k8s"]);
  });

  it("returns ['local', 'k8s'] for opencode_k8s", () => {
    expect(supportedEnvironmentDriversForAdapter("opencode_k8s")).toEqual(["local", "k8s"]);
  });

  it("does not include 'k8s' for non-k8s adapters", () => {
    expect(supportedEnvironmentDriversForAdapter("claude_local")).not.toContain("k8s");
    expect(supportedEnvironmentDriversForAdapter("codex_local")).not.toContain("k8s");
    expect(supportedEnvironmentDriversForAdapter("openclaw_gateway")).not.toContain("k8s");
  });
});

describe("getEnvironmentCapabilities — k8s presence", () => {
  it("marks the k8s driver supported in the global drivers map", () => {
    const caps = getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, { sandboxProviders: {} });
    expect(caps.drivers.k8s).toBe("supported");
  });

  it("per-adapter map exposes k8s for k8s adapters and not for others", () => {
    const caps = getEnvironmentCapabilities(
      [...AGENT_ADAPTER_TYPES, "claude_k8s", "opencode_k8s"],
      { sandboxProviders: {} },
    );
    const claudeK8s = caps.adapters.find((a) => a.adapterType === "claude_k8s");
    const opencodeK8s = caps.adapters.find((a) => a.adapterType === "opencode_k8s");
    const claudeLocal = caps.adapters.find((a) => a.adapterType === "claude_local");
    expect(claudeK8s?.drivers.k8s).toBe("supported");
    expect(opencodeK8s?.drivers.k8s).toBe("supported");
    expect(claudeLocal?.drivers.k8s).toBe("unsupported");
  });
});

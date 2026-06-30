import { describe, expect, it } from "vitest";
import { mapAdapterToCcrotateTarget } from "../services/ccrotate-target.js";

describe("mapAdapterToCcrotateTarget", () => {
  it("maps claude_local to claude", () => {
    expect(mapAdapterToCcrotateTarget("claude_local")).toBe("claude");
  });

  it("maps codex_local to codex", () => {
    expect(mapAdapterToCcrotateTarget("codex_local")).toBe("codex");
  });

  it("maps claude_k8s to claude (shares the org Anthropic billing pool)", () => {
    // claude_k8s runs Claude in a k8s pod with the org API key — that key
    // shares quota/billing with the host's `claude` ccrotate pool. The mapping
    // still keys the heartbeat capacity-exhaustion escalation onto the right
    // target.
    expect(mapAdapterToCcrotateTarget("claude_k8s")).toBe("claude");
  });

  it("maps opencode_k8s to codex for OpenAI-backed OpenCode agents", () => {
    expect(mapAdapterToCcrotateTarget("opencode_k8s")).toBe("codex");
  });

  it("returns null for adapters without a ccrotate provider", () => {
    expect(mapAdapterToCcrotateTarget("cursor")).toBeNull();
    expect(mapAdapterToCcrotateTarget("gemini_local")).toBeNull();
    expect(mapAdapterToCcrotateTarget("process")).toBeNull();
    expect(mapAdapterToCcrotateTarget("http")).toBeNull();
  });
});

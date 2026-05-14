// @vitest-environment node

import { describe, expect, it } from "vitest";
import { canonicalAgentDetailTab, parseAgentDetailView, type AgentDetailView } from "./AgentDetail";

describe("AgentDetail route tabs", () => {
  it.each([
    "dashboard",
    "instructions",
    "configuration",
    "skills",
    "capabilities",
    "runs",
    "budget",
  ] satisfies AgentDetailView[])("keeps %s as a canonical tab", (view) => {
    expect(canonicalAgentDetailTab(parseAgentDetailView(view))).toBe(view);
  });

  it("keeps the CEO capabilities tab canonical instead of redirecting to dashboard", () => {
    expect(canonicalAgentDetailTab(parseAgentDetailView("capabilities"))).toBe("capabilities");
  });

  it("normalizes legacy aliases before canonical redirects", () => {
    expect(canonicalAgentDetailTab(parseAgentDetailView("prompts"))).toBe("instructions");
    expect(canonicalAgentDetailTab(parseAgentDetailView("configure"))).toBe("configuration");
    expect(canonicalAgentDetailTab(parseAgentDetailView("unknown"))).toBe("dashboard");
  });
});

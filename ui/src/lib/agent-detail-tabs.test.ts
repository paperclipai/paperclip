import { describe, expect, it } from "vitest";
import { agentDetailTabPath, isAgentPluginDetailView, parseAgentDetailView, resolveCanonicalAgentTab } from "./agent-detail-tabs";

describe("agent detail tabs", () => {
  it("preserves a plugin tab route instead of redirecting it to the dashboard", () => {
    const tab = "plugin:costs:agent-costs";
    expect(isAgentPluginDetailView(tab)).toBe(true);
    expect(parseAgentDetailView(tab)).toBe(tab);
  });

  it("encodes scoped plugin keys as one route segment", () => {
    expect(agentDetailTabPath("demo-agent", "plugin:@scope/name:costs"))
      .toBe("/agents/demo-agent/plugin%3A%40scope%2Fname%3Acosts");
  });

  it("defers plugin deep links while slots load, then rejects stale tabs", () => {
    const tab = "plugin:costs:agent-costs" as const;
    expect(resolveCanonicalAgentTab(tab, true, new Set())).toBeNull();
    expect(resolveCanonicalAgentTab(tab, false, new Set([tab]))).toBe(tab);
    expect(resolveCanonicalAgentTab(tab, false, new Set())).toBe("dashboard");
  });

  it("keeps existing aliases and falls unknown routes back to dashboard", () => {
    expect(parseAgentDetailView("prompts")).toBe("instructions");
    expect(parseAgentDetailView("configure")).toBe("configuration");
    expect(parseAgentDetailView("unknown")).toBe("dashboard");
  });
});

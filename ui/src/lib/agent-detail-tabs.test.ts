import { describe, expect, it } from "vitest";
import { isAgentPluginDetailView, parseAgentDetailView } from "./agent-detail-tabs";

describe("agent detail tabs", () => {
  it("preserves a plugin tab route instead of redirecting it to the dashboard", () => {
    const tab = "plugin:costs:agent-costs";
    expect(isAgentPluginDetailView(tab)).toBe(true);
    expect(parseAgentDetailView(tab)).toBe(tab);
  });

  it("keeps existing aliases and falls unknown routes back to dashboard", () => {
    expect(parseAgentDetailView("prompts")).toBe("instructions");
    expect(parseAgentDetailView("configure")).toBe("configuration");
    expect(parseAgentDetailView("unknown")).toBe("dashboard");
  });
});

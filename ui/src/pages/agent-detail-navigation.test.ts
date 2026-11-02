import { describe, expect, it } from "vitest";
import {
  AGENT_DETAIL_NAVIGATION,
  agentDetailHref,
  agentDetailViewLabel,
  agentLegacyAuditSection,
  isAgentAuditView,
  agentScopedAuditHref,
  parseAgentDetailView,
} from "./agent-detail-navigation";

describe("agent detail navigation", () => {
  it("exposes the complete local information architecture", () => {
    expect(AGENT_DETAIL_NAVIGATION.map((section) => section.label)).toEqual(["Agent", "Audit"]);
    expect(AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items.map((item) => item.value))).toEqual([
      "overview",
      "instructions",
      "runtime",
      "secrets",
      "permissions",
      "advanced",
      "activity",
      "runs",
      "costs",
      "budgets",
    ]);
    expect(agentDetailViewLabel("instructions")).toBe("Identity");
  });

  it("keeps views that left the nav reachable by URL", () => {
    expect(parseAgentDetailView("skills")).toBe("skills");
    expect(parseAgentDetailView("tools")).toBe("tools");
    expect(parseAgentDetailView("channels")).toBe("channels");
    expect(parseAgentDetailView("api-keys")).toBe("api-keys");
    expect(parseAgentDetailView("revisions")).toBe("revisions");
    expect(agentDetailViewLabel("revisions")).toBe("Agent history");
  });

  it("serves Identity at /identity and the audit pages inside the agent", () => {
    expect(parseAgentDetailView("identity")).toBe("instructions");
    expect(agentDetailHref("codie", "instructions")).toBe("/agents/codie/identity");
    expect(parseAgentDetailView("runs")).toBe("runs");
    expect(parseAgentDetailView("budget")).toBe("budgets");
    expect(isAgentAuditView("costs")).toBe(true);
    expect(isAgentAuditView("runtime")).toBe(false);
    expect(agentDetailHref("codie", "activity")).toBe("/agents/codie/activity");
  });

  it("canonicalizes legacy local paths", () => {
    expect(parseAgentDetailView("advanced")).toBe("advanced");
    expect(agentDetailHref("codie", "advanced")).toBe("/agents/codie/advanced");
    expect(parseAgentDetailView("dashboard")).toBe("overview");
    expect(parseAgentDetailView("configuration")).toBe("runtime");
    expect(parseAgentDetailView("prompts")).toBe("instructions");
    expect(agentDetailHref("codie", "instructions")).toBe("/agents/codie/identity");
    expect(agentDetailHref("codexcoder", "permissions")).toBe("/agents/codexcoder/permissions");
  });

  it("maps legacy operational pages into scoped Audit sections", () => {
    expect(agentLegacyAuditSection("runs")).toBe("runs");
    expect(agentLegacyAuditSection("audit")).toBe("activity");
    expect(agentLegacyAuditSection("budget")).toBe("budgets");
    expect(agentScopedAuditHref("agent-1", "activity")).toBe("/activity?mode=agents&agentId=agent-1");
    expect(agentScopedAuditHref("agent-1", "costs")).toBe("/activity/costs?agentId=agent-1");
  });
});

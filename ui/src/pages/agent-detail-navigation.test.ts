import { describe, expect, it } from "vitest";
import {
  AGENT_DETAIL_NAVIGATION,
  agentDetailHref,
  agentLegacyAuditSection,
  agentScopedAuditHref,
  parseAgentDetailView,
} from "./agent-detail-navigation";

describe("agent detail navigation", () => {
  it("exposes the complete local information architecture", () => {
    expect(AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items.map((item) => item.value))).toEqual([
      "overview",
      "instructions",
      "skills",
      "runtime",
      "secrets",
      "tools",
      "permissions",
      "api-keys",
      "revisions",
    ]);
  });

  it("canonicalizes legacy local paths", () => {
    expect(parseAgentDetailView("dashboard")).toBe("overview");
    expect(parseAgentDetailView("configuration")).toBe("runtime");
    expect(parseAgentDetailView("prompts")).toBe("instructions");
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

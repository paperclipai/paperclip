import { describe, expect, it } from "vitest";
import {
  AGENT_DETAIL_NAVIGATION,
  agentDetailHref,
  agentLegacyAuditSection,
  agentScopedAuditHref,
  isAgentPluginDetailView,
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
      "channels",
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

  it("keeps plugin detail tabs as their own view", () => {
    expect(isAgentPluginDetailView("plugin:acme:insights")).toBe(true);
    expect(isAgentPluginDetailView("overview")).toBe(false);
    expect(isAgentPluginDetailView(null)).toBe(false);
    expect(parseAgentDetailView("plugin:acme:insights")).toBe("plugin:acme:insights");
    expect(agentDetailHref("codexcoder", "plugin:acme:insights")).toBe(
      "/agents/codexcoder/plugin:acme:insights",
    );
  });

  it("maps legacy operational pages into scoped Audit sections", () => {
    expect(agentLegacyAuditSection("runs")).toBe("runs");
    expect(agentLegacyAuditSection("audit")).toBe("activity");
    expect(agentLegacyAuditSection("budget")).toBe("budgets");
    expect(agentScopedAuditHref("agent-1", "activity")).toBe("/activity?mode=agents&agentId=agent-1");
    expect(agentScopedAuditHref("agent-1", "costs")).toBe("/activity/costs?agentId=agent-1");
  });
});

import { describe, expect, it } from "vitest";
import { buildCopilotRouteContext, extractContextIssueRef } from "./copilot-route-context";

describe("copilot-route-context", () => {
  it("builds agent context from an agent run detail path", () => {
    const context = buildCopilotRouteContext("/PAP/agents/agent-7/runs/run-9", "");
    expect(context).toEqual({
      pageKind: "agents",
      pagePath: "/agents/agent-7/runs/run-9",
      entityType: "agent",
      entityId: "agent-7",
      filters: undefined,
    });
  });

  it("builds issue context from a company-prefixed issue detail path", () => {
    const context = buildCopilotRouteContext("/PAP/issues/PAP-42", "?status=todo&q=cleanup");
    expect(context).toEqual({
      pageKind: "issues",
      pagePath: "/issues/PAP-42?status=todo&q=cleanup",
      entityType: "issue",
      entityId: "PAP-42",
      filters: {
        status: "todo",
        q: "cleanup",
      },
    });
  });

  it("builds roadmap context without entity ids", () => {
    const context = buildCopilotRouteContext("/PAP/roadmap", "");
    expect(context).toEqual({
      pageKind: "roadmap",
      pagePath: "/roadmap",
      entityType: "roadmap",
      entityId: "company-roadmap",
      filters: undefined,
    });
  });

  it("extracts issue refs only from issue detail routes", () => {
    expect(extractContextIssueRef("/PAP/issues/PAP-512", "")).toBe("PAP-512");
    expect(extractContextIssueRef("/PAP/projects/abc", "")).toBeNull();
  });
});

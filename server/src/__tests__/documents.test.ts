import { describe, expect, it } from "vitest";
import { extractLegacyPlanBody, summarizeIssueDocumentForHeartbeatContext } from "../services/documents.js";

describe("extractLegacyPlanBody", () => {
  it("returns null when no plan block exists", () => {
    expect(extractLegacyPlanBody("hello world")).toBeNull();
  });

  it("extracts plan body from legacy issue descriptions", () => {
    expect(
      extractLegacyPlanBody(`
intro

<plan>

# Plan

- one
- two

</plan>
      `),
    ).toBe("# Plan\n\n- one\n- two");
  });

  it("ignores empty plan blocks", () => {
    expect(extractLegacyPlanBody("<plan>   </plan>")).toBeNull();
  });
});

describe("summarizeIssueDocumentForHeartbeatContext", () => {
  it("keeps the compact document fields needed by agent heartbeat context", () => {
    expect(
      summarizeIssueDocumentForHeartbeatContext({
        id: "doc-1",
        companyId: "company-1",
        issueId: "issue-1",
        key: "onboarding_starter_context",
        title: "Starter context",
        format: "markdown",
        body: "# Starter context",
        latestRevisionId: "rev-1",
        latestRevisionNumber: 2,
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        createdAt: new Date("2026-05-30T00:00:00.000Z"),
        updatedAt: new Date("2026-05-30T00:01:00.000Z"),
      }),
    ).toEqual({
      key: "onboarding_starter_context",
      title: "Starter context",
      body: "# Starter context",
      latestRevisionId: "rev-1",
      latestRevisionNumber: 2,
      updatedAt: new Date("2026-05-30T00:01:00.000Z"),
    });
  });

  it("returns null when no document is present", () => {
    expect(summarizeIssueDocumentForHeartbeatContext(null)).toBeNull();
  });
});

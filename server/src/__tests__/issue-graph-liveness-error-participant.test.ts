import { describe, expect, it } from "vitest";
import { classifyIssueGraphLiveness, type IssueGraphLivenessInput } from "../services/recovery/issue-graph-liveness.ts";

const COMPANY_ID = "company-1";

function baseInput(agentStatus: string): IssueGraphLivenessInput {
  return {
    issues: [
      {
        id: "issue-1",
        companyId: COMPANY_ID,
        identifier: "RAC-1",
        title: "In review issue with an errored participant",
        status: "in_review",
        assigneeAgentId: "agent-1",
        executionState: {
          currentParticipant: { type: "agent", agentId: "agent-1" },
        },
      },
    ],
    relations: [],
    agents: [
      {
        id: "agent-1",
        companyId: COMPANY_ID,
        name: "Reviewer",
        role: "general",
        status: agentStatus,
      },
    ],
  };
}

describe("classifyIssueGraphLiveness — error-status review participant", () => {
  it("surfaces invalid_review_participant when the participant agent is in error status", () => {
    const findings = classifyIssueGraphLiveness(baseInput("error"));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "issue-1",
      state: "invalid_review_participant",
    });
  });

  it("does not flag an active participant agent as invalid", () => {
    const findings = classifyIssueGraphLiveness(baseInput("active"));

    expect(findings).toHaveLength(0);
  });
});

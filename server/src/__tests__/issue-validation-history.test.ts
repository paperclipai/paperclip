import { describe, expect, it } from "vitest";
import { buildIssueValidationHistory, type IssueExecutionDecisionValidationRow } from "../services/issue-validation-history.js";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VALIDATOR_AGENT_ID = "11111111-1111-4111-8111-111111111111";

function validatorReportBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    writtenByAgentId: "ignored-body-agent",
    verdict: "PASS",
    completionScore: 9,
    criteriaChecked: ["tests passed"],
    evidence: ["targeted vitest passed"],
    hallucinationFlags: [],
    regressionChecks: ["typecheck clean"],
    blockingIssues: [],
    exactFixIfFailed: null,
    ...overrides,
  });
}

function executionDecision(overrides: Partial<IssueExecutionDecisionValidationRow> = {}): IssueExecutionDecisionValidationRow {
  return {
    id: "decision-1",
    issueId: ISSUE_ID,
    stageId: "stage-review",
    stageType: "review",
    actorAgentId: "22222222-2222-4222-8222-222222222222",
    actorUserId: null,
    outcome: "changes_requested",
    body: `Fix leak: to${"ken=synthetic-placeholder"}`,
    createdByRunId: "run-1",
    createdAt: new Date("2026-05-13T12:05:00.000Z"),
    ...overrides,
  };
}

describe("issue validation history", () => {
  it("combines validator-report revisions and execution decisions newest-first", () => {
    const history = buildIssueValidationHistory({
      issueId: ISSUE_ID,
      validatorReportRevisions: [
        {
          id: "revision-1",
          issueId: ISSUE_ID,
          revisionNumber: 1,
          body: validatorReportBody(),
          changeSummary: "validator PASS",
          createdByAgentId: VALIDATOR_AGENT_ID,
          createdByUserId: null,
          createdAt: new Date("2026-05-13T12:00:00.000Z"),
        },
      ],
      executionDecisions: [executionDecision()],
    });

    expect(history.issueId).toBe(ISSUE_ID);
    expect(history.entries.map((entry) => entry.source)).toEqual(["execution_decision", "validator_report"]);
    expect(history.latest?.id).toBe("decision-1");
    expect(history.entries[1]?.verdict).toBe("PASS");
    expect(history.entries[1]?.completionScore).toBe(9);
    expect(history.entries[1]?.report?.writtenByAgentId).toBe(VALIDATOR_AGENT_ID);
  });

  it("maps changes-requested decisions to validator blockers and redacts secret-like text", () => {
    const history = buildIssueValidationHistory({
      issueId: ISSUE_ID,
      validatorReportRevisions: [],
      executionDecisions: [executionDecision()],
    });

    const entry = history.entries[0]!;
    expect(entry.verdict).toBe("REQUEST_CHANGES");
    expect(entry.completionScore).toBe(0);
    expect(entry.blockingIssues[0]).toContain("***REDACTED***");
    expect(entry.bodyPreview).toContain("***REDACTED***");
    expect(entry.bodyPreview).not.toContain("synthetic-placeholder");
  });
});

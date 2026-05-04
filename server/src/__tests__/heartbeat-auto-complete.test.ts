import { describe, expect, it } from "vitest";
import { decideAutoCompleteIssueOnSuccessfulRun, type AutoCompleteIssueDecisionInput } from "../services/heartbeat.js";

function input(overrides: Partial<AutoCompleteIssueDecisionInput> = {}): AutoCompleteIssueDecisionInput {
  return {
    outcome: "succeeded",
    autoCompleteIssueOnSuccess: true,
    livenessState: "advanced",
    issueStatus: "in_progress",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    agentId: "agent-1",
    runId: "run-1",
    ...overrides,
  };
}

describe("decideAutoCompleteIssueOnSuccessfulRun", () => {
  it("allows opt-in successful live assigned runs to complete their issue", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input())).toEqual({ shouldComplete: true });
  });

  it("stays disabled unless autoCompleteIssueOnSuccess is explicitly true", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ autoCompleteIssueOnSuccess: false }))).toEqual({
      shouldComplete: false,
      reason: "disabled",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ autoCompleteIssueOnSuccess: undefined }))).toEqual({
      shouldComplete: false,
      reason: "disabled",
    });
  });

  it("does not complete non-successful runs", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ outcome: "failed" }))).toEqual({
      shouldComplete: false,
      reason: "outcome",
    });
  });

  it("does not complete plan-only, empty-response, or follow-up-only runs", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ livenessState: "plan_only" }))).toEqual({
      shouldComplete: false,
      reason: "liveness",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ livenessState: "empty_response" }))).toEqual({
      shouldComplete: false,
      reason: "liveness",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ livenessState: "needs_followup" }))).toEqual({
      shouldComplete: false,
      reason: "liveness",
    });
  });

  it("does not complete missing or terminal issues", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ issueStatus: null }))).toEqual({
      shouldComplete: false,
      reason: "missing_issue",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ issueStatus: "done" }))).toEqual({
      shouldComplete: false,
      reason: "terminal_issue",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ issueStatus: "cancelled" }))).toEqual({
      shouldComplete: false,
      reason: "terminal_issue",
    });
  });

  it("does not complete when assignee or execution lock no longer match", () => {
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ issueAssigneeAgentId: "agent-2" }))).toEqual({
      shouldComplete: false,
      reason: "assignee",
    });
    expect(decideAutoCompleteIssueOnSuccessfulRun(input({ issueExecutionRunId: "run-2" }))).toEqual({
      shouldComplete: false,
      reason: "execution_lock",
    });
  });
});

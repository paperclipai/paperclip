import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRuns, issues, issueThreadInteractions, issueApprovals, type Db } from "@paperclipai/db";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";

const state = vi.hoisted(() => ({ blockers: 0 }));
vi.mock("./native-deliverable-feedback.js", () => ({ validateNativeDeliverableEvidence: vi.fn(async () => undefined) }));
vi.mock("./automatic-completion-reviews.js", () => ({ findAutomaticCompletionReviews: vi.fn(async () => []) }));
vi.mock("../agent-invokability.js", () => ({ evaluateAgentInvokabilityFromDb: vi.fn() }));
vi.mock("../issues.js", () => ({ issueService: () => ({ getDependencyReadiness: async () => ({ unresolvedBlockerCount: state.blockers }) }) }));
vi.mock("./native-review-participant.js", () => ({ readNativeReviewAssignmentContext: () => null, getNativeReviewAssignment: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({ normalizePrpResultSignals: () => ({ verification: [], actionableAttentionRequests: [] }) }));

const result = { reportedWorkDisposition: "done", summary: "EXACT_PRIVATE_MARKER", completionClaim: { objectiveSatisfied: true, criteria: [], remainingWork: [] } } as unknown as PrpStructuredRunResult;
function database(options: { interaction?: boolean; approval?: boolean; review?: boolean } = {}): Db {
  // Pure query double: no client, PostgreSQL process, or network is created.
  return { select: () => ({ from: (table: unknown) => {
    const rows = table === heartbeatRuns ? [{ id: "run", companyId: "company", nativeIssueId: "issue", contextSnapshot: {} }]
      : table === issues ? [{ id: "issue", companyId: "company", status: "in_progress", ...(options.review ? { executionState: { status: "pending" } } : {}) }]
      : table === issueThreadInteractions && options.interaction ? [{ id: "request", kind: "request_confirmation", title: "Decision" }]
      : table === issueApprovals && options.approval ? [{ id: "approval" }] : [];
    const query = { where: () => query, limit: () => query, innerJoin: () => query, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  } }) } as unknown as Db;
}
beforeEach(() => { state.blockers = 0; });
describe("native completion feedback format precedence", () => {
  it("honors requested final format only after normal completion acceptance without echoing the summary", async () => {
    const feedback = await nativeCompletionFeedback(database(), "run", result);
    expect(feedback).toContain("Follow the user's explicitly requested final-response format, including an exact response when requested.");
    expect(feedback).toContain("Task status will be committed after this turn and workspace finalization finish.");
    expect(feedback).toContain("Do not claim an approval is needed unless one was requested.");
    expect(feedback).not.toContain(result.summary);
  });
  it.each(["interaction", "approval", "review", "dependency"] as const)("preserves %s governance feedback instead of granting format precedence", async mode => {
    state.blockers = mode === "dependency" ? 1 : 0;
    const feedback = await nativeCompletionFeedback(database({ interaction: mode === "interaction", approval: mode === "approval", review: mode === "review" }), "run", result);
    expect(feedback).not.toContain("final-response format");
    expect(feedback).toMatch(/still waiting|still pending|unresolved dependencies/);
  });
});

import { describe, expect, it } from "vitest";
import { issueApprovals, issueDocuments, issueExecutionDecisions, issues } from "@paperclipai/db";
import {
  assertApprovalMergeGateReadyForIssue,
  assertApprovalMergeGateReadyForIssueIds,
  assertIssueCanMoveToDone,
} from "../services/quality-gate-contract.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const adversarialStageId = "22222222-2222-4222-8222-222222222222";
const codeReviewStageId = "33333333-3333-4333-8333-333333333333";

const gateContract = {
  kind: "aetherion_quality_funnel" as const,
  artifactKeys: {
    planAudit: "plan_audit",
    executionReport: "execution_report",
    adversarialReview: "adversarial_review",
    codeReview: "code_review",
    verification: "verification",
    closeout: "closeout",
  },
  reviewBudgetsMinutes: {
    docsTemplate: 15,
    normalCodeChange: 40,
  },
  maxAdversarialChangeRequests: 1,
};

const policy = {
  mode: "normal" as const,
  commentRequired: true,
  gateContract,
  stages: [
    {
      id: adversarialStageId,
      type: "review" as const,
      gateKey: "adversarial_review" as const,
      approvalsNeeded: 1 as const,
      participants: [],
    },
    {
      id: codeReviewStageId,
      type: "review" as const,
      gateKey: "code_review" as const,
      approvalsNeeded: 1 as const,
      participants: [],
    },
  ],
};

function makeIssue() {
  return {
    id: issueId,
    identifier: "AET-359",
    executionPolicy: policy,
    executionState: null,
  };
}

function doc(key: string, body: string, timestamp: string) {
  return {
    key,
    body,
    updatedAt: new Date(timestamp),
  };
}

function approvedDecision(stageId: string, gateKey: "adversarial_review" | "code_review") {
  return {
    id: `${stageId}-decision`,
    stageId,
    gateKey,
    outcome: "approved",
  };
}

function makeDb(input: {
  docs?: Array<{ key: string; body: string; updatedAt: Date }>;
  issueRows?: Array<ReturnType<typeof makeIssue>>;
  linkedIssueRows?: Array<ReturnType<typeof makeIssue>>;
  decisions?: Array<{ id: string; stageId: string; gateKey?: string | null; outcome: string }>;
}) {
  return {
    select: () => {
      const builder = {
        fromTable: null as unknown,
        from(table: unknown) {
          this.fromTable = table;
          return this;
        },
        innerJoin() {
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        rows() {
          if (this.fromTable === issueDocuments) return input.docs ?? [];
          if (this.fromTable === issues) return input.issueRows ?? [];
          if (this.fromTable === issueApprovals) return input.linkedIssueRows ?? [];
          if (this.fromTable === issueExecutionDecisions) return input.decisions ?? [];
          return [];
        },
        then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(this.rows()).then(resolve, reject);
        },
      };
      return builder;
    },
  } as any;
}

function approvedReviewDocs(overrides: Record<string, { body?: string; timestamp?: string }> = {}) {
  const defaults = {
    plan_audit: { body: "Verdict: APPROVED", timestamp: "2026-04-20T10:00:00.000Z" },
    execution_report: { body: "Execution complete", timestamp: "2026-04-20T10:10:00.000Z" },
    adversarial_review: { body: "Verdict: APPROVED", timestamp: "2026-04-20T10:20:00.000Z" },
    code_review: { body: "Verdict: APPROVED", timestamp: "2026-04-20T10:30:00.000Z" },
    verification: { body: "Ready", timestamp: "2026-04-20T10:30:00.000Z" },
  };
  return Object.entries({ ...defaults, ...overrides }).map(([key, value]) =>
    doc(key, value.body ?? defaults[key as keyof typeof defaults].body, value.timestamp ?? defaults[key as keyof typeof defaults].timestamp),
  );
}

describe("quality gate contract", () => {
  it("blocks AET-357's failure mode when code review is missing before merge gate", async () => {
    const docs = approvedReviewDocs().filter((item) => item.key !== "code_review");
    await expect(
      assertApprovalMergeGateReadyForIssueIds(
        makeDb({ docs, issueRows: [makeIssue()] }),
        { payload: { stage: "merge_gate" } },
        [issueId],
      ),
    ).rejects.toThrow("missing code review artifact");
  });

  it("blocks merge-gate linking when code review is missing", async () => {
    const docs = approvedReviewDocs().filter((item) => item.key !== "code_review");
    await expect(
      assertApprovalMergeGateReadyForIssue(
        makeDb({ docs, issueRows: [makeIssue()] }),
        { payload: { stage: "merge_gate" } },
        issueId,
      ),
    ).rejects.toThrow("missing code review artifact");
  });

  it("blocks merge gate when code review is older than adversarial review", async () => {
    await expect(
      assertApprovalMergeGateReadyForIssueIds(
        makeDb({
          docs: approvedReviewDocs({ code_review: { timestamp: "2026-04-20T10:15:00.000Z" } }),
          issueRows: [makeIssue()],
        }),
        { payload: { stage: "merge_gate" } },
        [issueId],
      ),
    ).rejects.toThrow("code review is stale");
  });

  it("allows merge gate after distinct approved adversarial and code review artifacts", async () => {
    await expect(
      assertApprovalMergeGateReadyForIssueIds(
        makeDb({
          docs: approvedReviewDocs(),
          issueRows: [makeIssue()],
          decisions: [
            approvedDecision(adversarialStageId, "adversarial_review"),
            approvedDecision(codeReviewStageId, "code_review"),
          ],
        }),
        { payload: { stage: "merge_gate" } },
        [issueId],
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks merge gate when the latest gate decision requested changes", async () => {
    await expect(
      assertApprovalMergeGateReadyForIssueIds(
        makeDb({
          docs: approvedReviewDocs(),
          issueRows: [makeIssue()],
          decisions: [
            {
              id: "latest-adversarial-decision",
              stageId: adversarialStageId,
              gateKey: "adversarial_review",
              outcome: "changes_requested",
            },
            approvedDecision(adversarialStageId, "adversarial_review"),
            approvedDecision(codeReviewStageId, "code_review"),
          ],
        }),
        { payload: { stage: "merge_gate" } },
        [issueId],
      ),
    ).rejects.toThrow("adversarial_review execution stage is not approved");
  });

  it("blocks Done before closeout evidence exists", async () => {
    await expect(assertIssueCanMoveToDone(makeDb({ docs: [] }), makeIssue())).rejects.toThrow("missing closeout artifact");
  });

  it("blocks Done when closeout sections are empty", async () => {
    await expect(
      assertIssueCanMoveToDone(
        makeDb({
          docs: [
            doc(
              "closeout",
              "## What changed\n\n## What passed\n\n## What still needs follow-up\n",
              "2026-04-20T11:00:00.000Z",
            ),
          ],
        }),
        makeIssue(),
      ),
    ).rejects.toThrow("non-empty What changed");
  });

  it("allows Done when closeout has all required evidence sections", async () => {
    await expect(
      assertIssueCanMoveToDone(
        makeDb({
          docs: [
            doc(
              "closeout",
              "## What changed\nDocs changed.\n\n## What passed\nTests passed.\n\n## What still needs follow-up\nNone.",
              "2026-04-20T11:00:00.000Z",
            ),
          ],
        }),
        makeIssue(),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not let review_findings satisfy routine code review", async () => {
    const customPolicyIssue = {
      ...makeIssue(),
      executionPolicy: {
        ...policy,
        gateContract: {
          ...gateContract,
          artifactKeys: {
            ...gateContract.artifactKeys,
            codeReview: "review_findings",
          },
        },
      },
    };

    await expect(
      assertApprovalMergeGateReadyForIssueIds(
        makeDb({
          docs: [
            ...approvedReviewDocs().filter((item) => item.key !== "code_review"),
            doc("review_findings", "Verdict: APPROVED", "2026-04-20T10:30:00.000Z"),
          ],
          issueRows: [customPolicyIssue],
          decisions: [
            approvedDecision(adversarialStageId, "adversarial_review"),
            approvedDecision(codeReviewStageId, "code_review"),
          ],
        }),
        { payload: { stage: "merge_gate" } },
        [issueId],
      ),
    ).rejects.toThrow("missing code review artifact");
  });
});

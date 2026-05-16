import { describe, expect, it } from "vitest";
import {
  buildIssueDispositionIdempotencyKey,
  type IssueCommentMetadata,
  type IssueCommentMetadataDispositionRow,
} from "@paperclipai/shared";
import {
  countDispositionRows,
  derivePreconditionFlags,
  dispositionBodyEquivalent,
  DISPOSITION_ERROR_CODES,
  extractDispositionRowFromMetadata,
  issueDispositionService,
  validateWorkerSelfAttest,
  type DispositionDecisionRow,
} from "./issue-disposition.js";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";

// A db stub that should never be reached by the pre-transaction validations
// below; if any of these tests do reach a transaction, the test will fail
// loudly with "db.transaction is not a function".
const NEVER_TX_DB = {} as unknown as Db;

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT_ID = "44444444-4444-4444-8444-444444444444";

function buildMetadata(rows: IssueCommentMetadata["sections"][number]["rows"], sourceRunId: string | null = RUN_ID): IssueCommentMetadata {
  return {
    version: 1,
    sourceRunId,
    sections: [{ title: null, rows }],
  };
}

function buildDispositionRow(overrides?: Partial<{
  value: "done" | "blocked" | "needs_review" | "needs_qa" | "needs_approval" | "needs_fix" | "duplicate" | "superseded" | "not_actionable";
  idempotencyKey: string;
  reason: string | null;
}>): IssueCommentMetadata["sections"][number]["rows"][number] {
  const value = overrides?.value ?? "done";
  return {
    type: "disposition",
    value,
    reason: overrides?.reason ?? "All work completed",
    evidenceRefs: [],
    idempotencyKey:
      overrides?.idempotencyKey
      ?? buildIssueDispositionIdempotencyKey({ issueId: ISSUE_ID, sourceRunId: RUN_ID, dispositionValue: value }),
  };
}

describe("extractDispositionRowFromMetadata", () => {
  it("returns null when metadata is missing", () => {
    expect(extractDispositionRowFromMetadata(null)).toBeNull();
    expect(extractDispositionRowFromMetadata(undefined)).toBeNull();
  });

  it("returns null when no disposition row is present", () => {
    const metadata = buildMetadata([
      { type: "text", text: "hello" },
    ]);
    expect(extractDispositionRowFromMetadata(metadata)).toBeNull();
  });

  it("finds the first disposition row across sections", () => {
    const dispositionRow = buildDispositionRow();
    const metadata: IssueCommentMetadata = {
      version: 1,
      sourceRunId: RUN_ID,
      sections: [
        { rows: [{ type: "text", text: "non-disposition" }] },
        { rows: [dispositionRow] },
      ],
    };
    const match = extractDispositionRowFromMetadata(metadata);
    expect(match).not.toBeNull();
    expect(match?.sectionIndex).toBe(1);
    expect(match?.rowIndex).toBe(0);
    expect(match?.row.type).toBe("disposition");
  });
});

describe("countDispositionRows", () => {
  it("counts disposition rows across all sections", () => {
    const metadata: IssueCommentMetadata = {
      version: 1,
      sourceRunId: RUN_ID,
      sections: [
        { rows: [buildDispositionRow({ value: "done" }), { type: "text", text: "note" }] },
        { rows: [buildDispositionRow({ value: "blocked", idempotencyKey: buildIssueDispositionIdempotencyKey({ issueId: ISSUE_ID, sourceRunId: RUN_ID, dispositionValue: "blocked" }) })] },
      ],
    };
    expect(countDispositionRows(metadata)).toBe(2);
  });

  it("returns 0 for empty/null metadata", () => {
    expect(countDispositionRows(null)).toBe(0);
  });
});

describe("dispositionBodyEquivalent", () => {
  const row = buildDispositionRow();
  const baseMetadata = buildMetadata([row]);

  it("treats identical body+metadata as equivalent", () => {
    expect(
      dispositionBodyEquivalent(
        { body: "hello", metadata: baseMetadata },
        { body: "hello", metadata: baseMetadata },
      ),
    ).toBe(true);
  });

  it("ignores key order in nested metadata objects", () => {
    const alt: IssueCommentMetadata = {
      version: 1,
      sections: baseMetadata.sections,
      sourceRunId: baseMetadata.sourceRunId,
    };
    expect(dispositionBodyEquivalent({ body: "hello", metadata: baseMetadata }, { body: "hello", metadata: alt })).toBe(true);
  });

  it("rejects body differences", () => {
    expect(
      dispositionBodyEquivalent(
        { body: "hello", metadata: baseMetadata },
        { body: "world", metadata: baseMetadata },
      ),
    ).toBe(false);
  });

  it("rejects metadata payload differences", () => {
    const otherMetadata = buildMetadata([buildDispositionRow({ reason: "Different reason" })]);
    expect(
      dispositionBodyEquivalent(
        { body: "hello", metadata: baseMetadata },
        { body: "hello", metadata: otherMetadata },
      ),
    ).toBe(false);
  });
});

describe("validateWorkerSelfAttest", () => {
  const STAGE_REVIEW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const STAGE_REVIEW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const STAGE_APPROVAL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const STAGE_APPROVAL_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  const baseInput = {
    dispositionValue: "done" as const,
    actor: { actorType: "agent" as const, agentId: AGENT_ID, userId: null, runId: RUN_ID },
    issueAssigneeAgentId: AGENT_ID,
    issueAssigneeUserId: null,
    approvedDecisionActors: [
      { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review" as const, stageId: STAGE_REVIEW_A },
      { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval" as const, stageId: STAGE_APPROVAL_C },
    ],
    requiredReviewStageIds: [STAGE_REVIEW_A],
    requiredApprovalStageIds: [STAGE_APPROVAL_C],
  };

  it("allows a worker when distinct reviewer and approver decisions exist", () => {
    expect(validateWorkerSelfAttest(baseInput).ok).toBe(true);
  });

  it("rejects worker self-attest when only their own approved review decision exists", () => {
    const result = validateWorkerSelfAttest({
      ...baseInput,
      approvedDecisionActors: [
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.missing).toBe("distinct_reviewer");
    expect(result.stageId).toBe(STAGE_REVIEW_A);
  });

  it("rejects worker self-attest when only their own approval decision exists", () => {
    const result = validateWorkerSelfAttest({
      ...baseInput,
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.missing).toBe("distinct_approval_owner");
    expect(result.stageId).toBe(STAGE_APPROVAL_C);
  });

  it("skips check entirely for non-done dispositions", () => {
    expect(validateWorkerSelfAttest({
      ...baseInput,
      dispositionValue: "needs_review",
      approvedDecisionActors: [],
    }).ok).toBe(true);
  });

  it("skips check entirely when actor is not the assignee", () => {
    expect(validateWorkerSelfAttest({
      ...baseInput,
      actor: { actorType: "agent", agentId: OTHER_AGENT_ID, userId: null, runId: RUN_ID },
      approvedDecisionActors: [],
    }).ok).toBe(true);
  });

  it("skips review check when no review stages are required", () => {
    expect(validateWorkerSelfAttest({
      ...baseInput,
      requiredReviewStageIds: [],
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    }).ok).toBe(true);
  });

  it("defers to transition helper when no approved decision exists for a required stage", () => {
    // Required stage has zero approved decisions — derivePreconditionFlags/
    // transition helper owns that rejection (invalid_disposition_transition),
    // so self-attest stays focused on actor-distinctness and passes here.
    expect(validateWorkerSelfAttest({
      ...baseInput,
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
      ],
    }).ok).toBe(true);
  });

  it("rejects when one of two required review stages is self-approved by the worker", () => {
    // Stage A approved by distinct actor, Stage B self-approved by worker,
    // approval stage approved by distinct actor. The previous (non-stage-precise)
    // implementation passed this case because "some distinct reviewer existed
    // in the review stage type". The fixed implementation must reject on
    // Stage B specifically.
    const result = validateWorkerSelfAttest({
      ...baseInput,
      requiredReviewStageIds: [STAGE_REVIEW_A, STAGE_REVIEW_B],
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_B },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.missing).toBe("distinct_reviewer");
    expect(result.stageId).toBe(STAGE_REVIEW_B);
  });

  it("rejects when one of two required approval stages is self-approved by the worker", () => {
    const result = validateWorkerSelfAttest({
      ...baseInput,
      requiredApprovalStageIds: [STAGE_APPROVAL_C, STAGE_APPROVAL_D],
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_D },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.missing).toBe("distinct_approval_owner");
    expect(result.stageId).toBe(STAGE_APPROVAL_D);
  });

  it("accepts a stage that has both a self-approval and a distinct-actor approval", () => {
    // Same stage approved twice: once by the worker, once by a distinct actor.
    // The distinct-actor approval satisfies the per-stage invariant.
    expect(validateWorkerSelfAttest({
      ...baseInput,
      requiredReviewStageIds: [STAGE_REVIEW_A],
      approvedDecisionActors: [
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    }).ok).toBe(true);
  });

  it("does not let a distinct-actor approval in stage A satisfy a self-approval in stage B", () => {
    // This is the precise regression cited by QA: a single distinct reviewer
    // anywhere in the "review" stage type can no longer rescue a self-approved
    // sibling review stage.
    const result = validateWorkerSelfAttest({
      ...baseInput,
      requiredReviewStageIds: [STAGE_REVIEW_A, STAGE_REVIEW_B],
      approvedDecisionActors: [
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_A },
        { actorAgentId: AGENT_ID, actorUserId: null, stageType: "review", stageId: STAGE_REVIEW_B },
        { actorAgentId: OTHER_AGENT_ID, actorUserId: null, stageType: "approval", stageId: STAGE_APPROVAL_C },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.missing).toBe("distinct_reviewer");
    expect(result.stageId).toBe(STAGE_REVIEW_B);
  });
});

describe("applyCommentDisposition pre-transaction validation", () => {
  const ISSUE_ID_LOCAL = "11111111-1111-4111-8111-111111111111";
  const RUN_ID_LOCAL = "22222222-2222-4222-8222-222222222222";
  const AGENT_ID_LOCAL = "33333333-3333-4333-8333-333333333333";
  const OTHER_RUN_ID_LOCAL = "55555555-5555-4555-8555-555555555555";

  function metadataWithRow(
    overrides?: Partial<{
      idempotencyKey: string;
      finalDisposition: IssueCommentMetadataDispositionRow["finalDisposition"];
      sourceRunId: string | null;
      value: IssueCommentMetadataDispositionRow["value"];
    }>,
  ): IssueCommentMetadata {
    const value = overrides?.value ?? "done";
    const idempotencyKey =
      overrides?.idempotencyKey
      ?? buildIssueDispositionIdempotencyKey({
        issueId: ISSUE_ID_LOCAL,
        sourceRunId: RUN_ID_LOCAL,
        dispositionValue: value,
      });
    return {
      version: 1,
      sourceRunId: overrides?.sourceRunId === undefined ? RUN_ID_LOCAL : overrides.sourceRunId,
      sections: [
        {
          rows: [
            {
              type: "disposition",
              value,
              reason: "ok",
              evidenceRefs: [],
              idempotencyKey,
              ...(overrides?.finalDisposition !== undefined
                ? { finalDisposition: overrides.finalDisposition }
                : {}),
            },
          ],
        },
      ],
    };
  }

  it("rejects a caller-supplied finalDisposition with a typed error code", async () => {
    const svc = issueDispositionService(NEVER_TX_DB);
    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_LOCAL,
        body: "hi",
        authorType: "agent",
        metadata: metadataWithRow({
          finalDisposition: {
            value: "done",
            setAt: new Date().toISOString(),
            setByActor: { type: "agent", id: AGENT_ID_LOCAL },
            sourceRunId: RUN_ID_LOCAL,
            evidenceRefs: [],
            idempotencyKey: buildIssueDispositionIdempotencyKey({
              issueId: ISSUE_ID_LOCAL,
              sourceRunId: RUN_ID_LOCAL,
              dispositionValue: "done",
            }),
          },
        }),
        actor: { actorType: "agent", agentId: AGENT_ID_LOCAL, runId: RUN_ID_LOCAL },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.CALLER_SUPPLIED_FINAL_DISPOSITION },
    });
  });

  it("rejects sourceRunId that does not match the actor's runId", async () => {
    const svc = issueDispositionService(NEVER_TX_DB);
    // sourceRunId in metadata + idempotency key references OTHER_RUN_ID; actor's run is RUN_ID.
    const otherKey = buildIssueDispositionIdempotencyKey({
      issueId: ISSUE_ID_LOCAL,
      sourceRunId: OTHER_RUN_ID_LOCAL,
      dispositionValue: "done",
    });
    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_LOCAL,
        body: "hi",
        authorType: "agent",
        metadata: metadataWithRow({ sourceRunId: OTHER_RUN_ID_LOCAL, idempotencyKey: otherKey }),
        actor: { actorType: "agent", agentId: AGENT_ID_LOCAL, runId: RUN_ID_LOCAL },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.SOURCE_RUN_ACTOR_MISMATCH },
    });
  });

  it("requires sourceRunId to be present in metadata when actor has no runId", async () => {
    const svc = issueDispositionService(NEVER_TX_DB);
    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_LOCAL,
        body: "hi",
        authorType: "user",
        metadata: metadataWithRow({ sourceRunId: null }),
        actor: { actorType: "user", userId: "user-1" },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.SOURCE_RUN_REQUIRED },
    });
  });

  it("rejects when idempotency key sourceRunId does not match metadata.sourceRunId", async () => {
    const svc = issueDispositionService(NEVER_TX_DB);
    // metadata.sourceRunId = RUN_ID, but idempotency key built for OTHER_RUN_ID
    const mismatchKey = buildIssueDispositionIdempotencyKey({
      issueId: ISSUE_ID_LOCAL,
      sourceRunId: OTHER_RUN_ID_LOCAL,
      dispositionValue: "done",
    });
    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_LOCAL,
        body: "hi",
        authorType: "agent",
        metadata: metadataWithRow({ sourceRunId: RUN_ID_LOCAL, idempotencyKey: mismatchKey }),
        actor: { actorType: "agent", agentId: AGENT_ID_LOCAL, runId: RUN_ID_LOCAL },
      }),
    ).rejects.toMatchObject({
      details: { code: DISPOSITION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID },
    });
  });
});

describe("derivePreconditionFlags multi-stage precision", () => {
  const stageReviewA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const stageReviewB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const stageApprovalC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const twoReviewOneApprovalPolicy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [
      { id: stageReviewA, type: "review", approvalsNeeded: 1, participants: [] },
      { id: stageReviewB, type: "review", approvalsNeeded: 1, participants: [] },
      { id: stageApprovalC, type: "approval", approvalsNeeded: 1, participants: [] },
    ],
  };

  const dispositionRow = buildDispositionRow();
  const baseDeps = {
    parentId: null,
    executionPolicy: twoReviewOneApprovalPolicy,
    hasParentBlockerRelation: false,
    hasFirstClassBlockerRelation: false,
    hasPendingApproval: false,
    hasPendingInteraction: false,
    hasHumanAssignee: false,
  };

  it("requires an approved decision keyed on each stage's stageId", () => {
    const decisionRows: DispositionDecisionRow[] = [
      { stageId: stageReviewA, stageType: "review", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
      // No approved decision for stageReviewB. A single approved review must
      // not be allowed to satisfy multiple review stages.
      { stageId: stageApprovalC, stageType: "approval", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
    ];
    const flags = derivePreconditionFlags(dispositionRow as IssueCommentMetadataDispositionRow, {
      ...baseDeps,
      decisionRows,
    });
    expect(flags.hasApprovedReviewDecisions).toBe(false);
    expect(flags.hasApprovedApprovalDecisions).toBe(true);
  });

  it("accepts when every required stageId has its own approved decision", () => {
    const decisionRows: DispositionDecisionRow[] = [
      { stageId: stageReviewA, stageType: "review", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
      { stageId: stageReviewB, stageType: "review", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
      { stageId: stageApprovalC, stageType: "approval", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
    ];
    const flags = derivePreconditionFlags(dispositionRow as IssueCommentMetadataDispositionRow, {
      ...baseDeps,
      decisionRows,
    });
    expect(flags.hasApprovedReviewDecisions).toBe(true);
    expect(flags.hasApprovedApprovalDecisions).toBe(true);
  });

  it("does not let an approved approval decision satisfy a review stage", () => {
    const decisionRows: DispositionDecisionRow[] = [
      // Approved decision for an approval stage is irrelevant to the review gate.
      { stageId: stageApprovalC, stageType: "approval", outcome: "approved", actorAgentId: OTHER_AGENT_ID, actorUserId: null },
    ];
    const flags = derivePreconditionFlags(dispositionRow as IssueCommentMetadataDispositionRow, {
      ...baseDeps,
      decisionRows,
    });
    expect(flags.hasApprovedReviewDecisions).toBe(false);
  });
});

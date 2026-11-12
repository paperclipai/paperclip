import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const REVIEW_WAKE_STATUSES = ["todo", "backlog", "blocked", "in_review"];

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("issue checkout with a pending execution stage", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-checkout-pending-stage-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function seedReviewedIssue(input: { status: string; pending: boolean; blockedTransitionAt?: Date }) {
    const companyId = randomUUID();
    const [executorId, firstReviewerId, secondReviewerId] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companies).values({ id: companyId, name: "Checkout fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values([executorId, firstReviewerId, secondReviewerId].map((id, index) => ({
      id, companyId, name: `Agent ${index}`, role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    const [firstStageId, secondStageId] = [randomUUID(), randomUUID()];
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { id: firstStageId, type: "review", participants: [{ type: "agent", agentId: firstReviewerId }] },
        { id: secondStageId, type: "review", participants: [{ type: "agent", agentId: secondReviewerId }] },
      ],
    });
    const executionState = input.pending ? {
      status: "pending",
      currentStageId: firstStageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: firstReviewerId, userId: null },
      returnAssignee: { type: "agent", agentId: executorId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    } : null;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Reviewed work", status: input.status, priority: "medium",
      assigneeAgentId: firstReviewerId,
      executionPolicy: policy as Record<string, unknown> | null,
      executionState,
      blockedTransitionAt: input.blockedTransitionAt ?? null,
    });
    return { issueId, executorId, firstReviewerId, secondReviewerId, secondStageId, policy, executionState };
  }

  it.each(["in_review", "blocked"])("keeps a %s issue in its status while its review stage is pending", async (status) => {
    const blockedTransitionAt = status === "blocked" ? new Date("2026-01-02T03:04:05.000Z") : undefined;
    const seeded = await seedReviewedIssue({ status, pending: true, blockedTransitionAt });

    const checkedOut = await issueService(db).checkout(seeded.issueId, seeded.firstReviewerId, REVIEW_WAKE_STATUSES, null);

    expect(checkedOut).toMatchObject({
      status,
      assigneeAgentId: seeded.firstReviewerId,
      executionState: seeded.executionState,
      blockedTransitionAt: blockedTransitionAt ?? null,
    });
  });

  it("lets the reviewer approve after checkout and hands the next stage over with the same return assignee", async () => {
    const seeded = await seedReviewedIssue({ status: "in_review", pending: true });
    const checkedOut = await issueService(db).checkout(seeded.issueId, seeded.firstReviewerId, REVIEW_WAKE_STATUSES, null);

    const transition = applyIssueExecutionPolicyTransition({
      issue: checkedOut,
      policy: seeded.policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: seeded.firstReviewerId },
      commentBody: "Approved after review",
    });

    expect(transition.decision).toMatchObject({ outcome: "approved" });
    expect(transition.patch).toMatchObject({ status: "in_review", assigneeAgentId: seeded.secondReviewerId });
    expect(parseIssueExecutionState(transition.patch.executionState)).toMatchObject({
      status: "pending",
      currentStageId: seeded.secondStageId,
      currentParticipant: { type: "agent", agentId: seeded.secondReviewerId },
      returnAssignee: { type: "agent", agentId: seeded.executorId },
    });
  });

  it.each(["in_review", "blocked"])("still starts work on a %s issue without a pending stage", async (status) => {
    const blockedTransitionAt = status === "blocked" ? new Date() : undefined;
    const seeded = await seedReviewedIssue({ status, pending: false, blockedTransitionAt });

    const checkedOut = await issueService(db).checkout(seeded.issueId, seeded.firstReviewerId, REVIEW_WAKE_STATUSES, null);

    expect(checkedOut).toMatchObject({ status: "in_progress", blockedTransitionAt: null });
  });
});

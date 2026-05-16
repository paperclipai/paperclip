/**
 * Deterministic atomicity coverage for `applyCommentDisposition` that runs
 * without embedded Postgres. We hand-build a fake `Db` whose `transaction`
 * callback supplies a `tx` proxy capable of fulfilling the writer's exact
 * call shape (selects, inserts, updates, deletes, and `execute`). Every
 * operation is recorded so a test can assert:
 *   - All writes land on the same `tx` callback invocation.
 *   - On a validation throw inside the transaction, no comment / issue
 *     status / activity-log mutation escapes.
 *   - When the path succeeds, the writer emits the
 *     `issue.disposition_applied` evidence row in the same transaction as
 *     the comment insert and the issue update.
 *
 * This complements the embedded-Postgres integration suite (skipped on
 * hosts that cannot run PostgreSQL as a child process, e.g. root-owned
 * sandboxes) by giving QA/CI a deterministic non-skipped writer-level
 * proof of the atomic evidence chain.
 */
import { describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { buildIssueDispositionIdempotencyKey, type IssueCommentMetadata } from "@paperclipai/shared";
import { issueDispositionService } from "../services/issue-disposition.ts";

interface OperationRecord {
  kind: "execute" | "select" | "insert" | "update" | "delete";
  table?: unknown;
  values?: unknown;
  set?: unknown;
  txId: number;
}

interface FakeDbState {
  issue: Record<string, unknown> | null;
  heartbeatRun: { id: string; companyId: string; agentId: string } | null;
  existingDispositionComments: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  blockerRelations: Array<Record<string, unknown>>;
  pendingApprovals: Array<Record<string, unknown>>;
  pendingInteractions: Array<Record<string, unknown>>;
  insertedComment: Record<string, unknown>;
  deleteResults: Array<{ id: string }>;
}

function buildFakeDb(state: FakeDbState) {
  const operations: OperationRecord[] = [];
  let txCounter = 0;

  function makeTx(txId: number) {
    function makeThenable<T>(value: T) {
      return {
        then: (resolve: (v: T) => unknown, _reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve),
      };
    }

    function makeChainable(seedRows: Array<Record<string, unknown>>) {
      const obj: Record<string, unknown> = {};
      obj.where = () => makeChainable(seedRows);
      obj.innerJoin = () => makeChainable(seedRows);
      obj.then = (resolve: (v: unknown) => unknown) => Promise.resolve(seedRows).then(resolve);
      return obj;
    }

    return {
      execute: async (_sql: unknown) => {
        operations.push({ kind: "execute", txId });
        return [];
      },
      select: (_cols?: unknown) => ({
        from: (table: unknown) => {
          operations.push({ kind: "select", table, txId });
          let seed: Array<Record<string, unknown>> = [];
          if (table === issues) seed = state.issue ? [state.issue] : [];
          else if (table === heartbeatRuns) seed = state.heartbeatRun ? [state.heartbeatRun] : [];
          else if (table === issueComments) seed = state.existingDispositionComments;
          else if (table === issueExecutionDecisions) seed = state.decisions;
          else if (table === issueRelations) seed = state.blockerRelations;
          else if (table === issueApprovals || table === approvals) seed = state.pendingApprovals;
          else if (table === issueThreadInteractions) seed = state.pendingInteractions;
          return makeChainable(seed);
        },
      }),
      insert: (table: unknown) => ({
        values: (v: unknown) => {
          operations.push({ kind: "insert", table, values: v, txId });
          if (table === issueComments) {
            return { returning: () => makeThenable([state.insertedComment]) };
          }
          // activityLog insert does not call .returning(); make the values
          // call itself awaitable so `await tx.insert(...).values(...)` works.
          const thenable = makeThenable(undefined);
          return { ...thenable, returning: () => makeThenable([]) };
        },
      }),
      update: (table: unknown) => ({
        set: (v: unknown) => ({
          where: (_c: unknown) => {
            operations.push({ kind: "update", table, set: v, txId });
            return Promise.resolve(undefined);
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: (_c: unknown) => {
          operations.push({ kind: "delete", table, txId });
          return {
            returning: () => makeThenable(state.deleteResults),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(state.deleteResults).then(resolve),
          };
        },
      }),
    } as unknown;
  }

  const db = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      txCounter += 1;
      const tx = makeTx(txCounter);
      return cb(tx);
    },
  } as unknown as Db;

  return { db, operations };
}

const ISSUE_ID_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID_A = "22222222-2222-4222-8222-222222222222";
const WORKER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKER_RUN_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";

function buildAtomicityMetadata(): IssueCommentMetadata {
  return {
    version: 1,
    sourceRunId: WORKER_RUN_ID,
    sections: [
      {
        rows: [
          {
            type: "disposition",
            value: "done",
            reason: "All good",
            evidenceRefs: [],
            idempotencyKey: buildIssueDispositionIdempotencyKey({
              issueId: ISSUE_ID_A,
              sourceRunId: WORKER_RUN_ID,
              dispositionValue: "done",
            }),
          },
        ],
      },
    ],
  };
}

function baseState(): FakeDbState {
  return {
    issue: {
      id: ISSUE_ID_A,
      companyId: COMPANY_ID_A,
      status: "in_progress",
      parentId: null,
      identifier: "PAP-1",
      title: "Test",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    },
    heartbeatRun: { id: WORKER_RUN_ID, companyId: COMPANY_ID_A, agentId: WORKER_AGENT_ID },
    existingDispositionComments: [],
    decisions: [],
    blockerRelations: [],
    pendingApprovals: [],
    pendingInteractions: [],
    insertedComment: {
      id: COMMENT_ID,
      companyId: COMPANY_ID_A,
      issueId: ISSUE_ID_A,
      body: "Marking done",
      authorAgentId: WORKER_AGENT_ID,
      authorUserId: null,
      authorType: "agent",
      createdByRunId: WORKER_RUN_ID,
      metadata: buildAtomicityMetadata(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    deleteResults: [],
  };
}

describe("applyCommentDisposition atomic evidence (fake-db, deterministic)", () => {
  it("commits comment+issue.update+activityLog on the same transaction callback when applied", async () => {
    const state = baseState();
    const { db, operations } = buildFakeDb(state);
    const svc = issueDispositionService(db);

    const result = await svc.applyCommentDisposition({
      issueId: ISSUE_ID_A,
      body: "Marking done",
      authorType: "agent",
      metadata: buildAtomicityMetadata(),
      actor: { actorType: "agent", agentId: WORKER_AGENT_ID, runId: WORKER_RUN_ID },
    });

    expect(result.applied).toBe(true);
    expect(result.evidence.previousStatus).toBe("in_progress");
    expect(result.evidence.nextStatus).toBe("done");

    // All mutating ops share the same transaction id (single-tx atomicity).
    const mutations = operations.filter((op) =>
      op.kind === "insert" || op.kind === "update" || op.kind === "delete",
    );
    const txIds = new Set(mutations.map((op) => op.txId));
    expect(txIds.size).toBe(1);

    // Comment insert is followed (in the same tx) by the activityLog evidence row.
    const commentInsert = operations.find((op) => op.kind === "insert" && op.table === issueComments);
    const activityInsert = operations.find((op) => op.kind === "insert" && op.table === activityLog);
    expect(commentInsert).toBeTruthy();
    expect(activityInsert).toBeTruthy();
    expect(commentInsert?.txId).toBe(activityInsert?.txId);

    // The activity payload carries the disposition.* evidence shape so an
    // external auditor can rebuild the chain without raw transcripts.
    const evidenceValues = activityInsert?.values as
      | { action: string; entityId: string; details: { disposition: Record<string, unknown> } }
      | undefined;
    expect(evidenceValues?.action).toBe("issue.disposition_applied");
    expect(evidenceValues?.entityId).toBe(ISSUE_ID_A);
    expect(evidenceValues?.details.disposition).toMatchObject({
      value: "done",
      applied: true,
      previousStatus: "in_progress",
      nextStatus: "done",
      sourceRunId: WORKER_RUN_ID,
      sourceCommentId: COMMENT_ID,
    });

    // Issue update set the next status, completedAt, and cleared run lock fields.
    const issueUpdate = operations.find((op) => op.kind === "update" && op.table === issues);
    expect((issueUpdate?.set as { status: string; completedAt: Date; checkoutRunId: string | null }).status).toBe(
      "done",
    );
    expect((issueUpdate?.set as { completedAt: Date }).completedAt).toBeInstanceOf(Date);
    expect((issueUpdate?.set as { checkoutRunId: string | null }).checkoutRunId).toBeNull();
  });

  it("does not insert a comment or evidence row when source-run agent ownership fails", async () => {
    const state = baseState();
    // sourceRun is owned by a different agent than the actor.
    state.heartbeatRun = {
      id: WORKER_RUN_ID,
      companyId: COMPANY_ID_A,
      agentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const { db, operations } = buildFakeDb(state);
    const svc = issueDispositionService(db);

    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_A,
        body: "Marking done",
        authorType: "agent",
        metadata: buildAtomicityMetadata(),
        actor: { actorType: "agent", agentId: WORKER_AGENT_ID, runId: WORKER_RUN_ID },
      }),
    ).rejects.toMatchObject({
      details: { code: "disposition_source_run_actor_mismatch" },
    });

    // Critically: no insert/update/delete escaped the rejection.
    const mutations = operations.filter((op) =>
      op.kind === "insert" || op.kind === "update" || op.kind === "delete",
    );
    expect(mutations).toHaveLength(0);
  });

  it("rejects an agent disposition that would land the issue in_review without a typed next owner", async () => {
    const state = baseState();
    // Configure a review stage on the policy so the transition validator's
    // hasReviewPath flag is satisfied, but leave executionState/assignee/
    // monitor/approval all empty so no real next owner exists. The new
    // stage-state guard must catch this and reject before the writer mutates
    // anything.
    state.issue = {
      ...(state.issue as Record<string, unknown>),
      status: "in_progress",
      executionState: null,
      monitorNextCheckAt: null,
      assigneeUserId: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            type: "review",
            approvalsNeeded: 1,
            participants: [
              {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                type: "agent",
                agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                userId: null,
              },
            ],
          },
        ],
      },
    };
    const { db, operations } = buildFakeDb(state);
    const svc = issueDispositionService(db);

    const metadata: IssueCommentMetadata = {
      version: 1,
      sourceRunId: WORKER_RUN_ID,
      sections: [
        {
          rows: [
            {
              type: "disposition",
              value: "needs_review",
              reason: "Ready for review",
              evidenceRefs: [],
              idempotencyKey: buildIssueDispositionIdempotencyKey({
                issueId: ISSUE_ID_A,
                sourceRunId: WORKER_RUN_ID,
                dispositionValue: "needs_review",
              }),
            },
          ],
        },
      ],
    };

    await expect(
      svc.applyCommentDisposition({
        issueId: ISSUE_ID_A,
        body: "Please review",
        authorType: "agent",
        metadata,
        actor: { actorType: "agent", agentId: WORKER_AGENT_ID, runId: WORKER_RUN_ID },
      }),
    ).rejects.toMatchObject({
      details: { code: "disposition_review_path_required" },
    });

    // No comment / status / evidence row landed.
    const mutations = operations.filter((op) =>
      op.kind === "insert" || op.kind === "update" || op.kind === "delete",
    );
    expect(mutations).toHaveLength(0);
  });
});

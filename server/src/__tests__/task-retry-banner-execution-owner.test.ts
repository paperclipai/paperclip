import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { taskInterruptionPresentation, taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { requestTaskRetry, retireSupersededTaskRetry } from "../services/task-retry.js";
import { heldTaskRetryRefusals } from "../services/task-retry-eligibility.js";

vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();

type RunSpec = Partial<typeof heartbeatRuns.$inferInsert> & { ageSeconds: number };
type Row = {
  name: string;
  predecessor?: Partial<typeof heartbeatRuns.$inferInsert>;
  followUp?: RunSpec;
  continuation?: RunSpec;
  lockOwner: "followUp" | "continuation" | null;
  expected: { state: string; canRetry: boolean; observed: "predecessor" | "followUp" | "continuation"; retryAction?: "move_forward" };
  retryWith?: "predecessor" | "followUp" | "continuation";
  native?: boolean;
  deliveredContinuation?: boolean;
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const lockChanged = { status: "cancelled", errorCode: "issue_execution_lock_changed", startedAt: null,
  error: "Cancelled because another run owns task execution or checkout before replacement dispatch" } as const;
const continuationRun = { scheduledRetryReason: "native_agent_blocker_continuation" } as const;

const STATE_TABLE: Row[] = [
  { name: "continuation scheduled while the follow-up turn runs and owns the lock",
    followUp: { status: "running", startedAt: minutesAgo(0.5), ageSeconds: 100 },
    continuation: { ...continuationRun, status: "scheduled_retry", errorCode: "native_agent_blocker_continuation",
      scheduledRetryAt: new Date(Date.now() + 30_000), ageSeconds: 30 },
    lockOwner: "followUp", expected: { state: "working", canRetry: false, observed: "followUp" } },
  { name: "continuation cancelled because the follow-up turn took the lock (t032 banner)",
    followUp: { status: "running", startedAt: minutesAgo(0.5), ageSeconds: 100 },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(0.4), ageSeconds: 30 },
    lockOwner: "followUp", expected: { state: "working", canRetry: false, observed: "followUp" } },
  { name: "native continuation cancelled because the native follow-up turn took the lock",
    followUp: { status: "running", startedAt: minutesAgo(0.5), ageSeconds: 100 },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(0.4), ageSeconds: 30 },
    lockOwner: "followUp", native: true, expected: { state: "working", canRetry: false, observed: "followUp" } },
  { name: "continuation cancelled by a lock transfer while the lock pointer is between owners",
    followUp: { status: "running", startedAt: minutesAgo(0.5), ageSeconds: 100 },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(0.4), ageSeconds: 30 },
    lockOwner: null, expected: { state: "working", canRetry: false, observed: "followUp" } },
  { name: "overdue scheduled continuation behind a running lock owner",
    followUp: { status: "running", startedAt: minutesAgo(10), ageSeconds: 900 },
    continuation: { ...continuationRun, status: "scheduled_retry", scheduledRetryAt: minutesAgo(5), ageSeconds: 600 },
    lockOwner: "followUp", expected: { state: "working", canRetry: false, observed: "followUp" } },
  { name: "newer failed attempt while an older queued run owns the lock",
    followUp: { status: "queued", ageSeconds: 900 },
    continuation: { status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(3), finishedAt: minutesAgo(1), ageSeconds: 200 },
    lockOwner: "followUp", expected: { state: "working", canRetry: false, observed: "followUp" }, retryWith: "continuation" },
  { name: "continuation queued past its move-forward wait behind a newer failed attempt",
    followUp: { status: "queued", ageSeconds: 1200 },
    continuation: { status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(3), finishedAt: minutesAgo(1), ageSeconds: 200 },
    lockOwner: "followUp", deliveredContinuation: true,
    expected: { state: "working", canRetry: true, observed: "followUp", retryAction: "move_forward" } },
  { name: "follow-up turn finished after superseding the continuation",
    followUp: { status: "succeeded", startedAt: minutesAgo(3), finishedAt: minutesAgo(1), ageSeconds: 300 },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(2.5), ageSeconds: 200 },
    lockOwner: null, expected: { state: "resolved", canRetry: false, observed: "followUp" } },
  { name: "follow-up turn failed after superseding the continuation",
    followUp: { status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(3), finishedAt: minutesAgo(1), ageSeconds: 300 },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(2.5), ageSeconds: 200 },
    lockOwner: null, expected: { state: "failed", canRetry: true, observed: "followUp" }, retryWith: "followUp" },
  { name: "superseded continuation over a failed predecessor with nothing else to run",
    predecessor: { status: "failed", errorCode: "adapter_failed", finishedAt: minutesAgo(1) },
    continuation: { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(0.5), ageSeconds: 30 },
    lockOwner: null, expected: { state: "failed", canRetry: true, observed: "predecessor" }, retryWith: "predecessor" },
  { name: "continuation that started before losing the lock is still a failed attempt",
    continuation: { ...continuationRun, ...lockChanged, startedAt: minutesAgo(1), finishedAt: minutesAgo(0.5), ageSeconds: 90 },
    lockOwner: null, expected: { state: "failed", canRetry: true, observed: "continuation" }, retryWith: "continuation" },
  { name: "a lock pointer left on a finished run does not hide its failure",
    followUp: { status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(3), finishedAt: minutesAgo(1), ageSeconds: 300 },
    lockOwner: "followUp", expected: { state: "failed", canRetry: true, observed: "followUp" }, retryWith: "followUp" },
];

describe.skipIf(!support.supported)("Retry banner while another run owns the task (restart-chaos t032)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("retry-banner-execution-owner-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(row: Row) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner task", issuePrefix: `O${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner agent", adapterType: "process" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user",
      status: "active", membershipRole: "member" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Staging mix parent", status: "in_progress",
      assigneeAgentId: agentId, createdByUserId: "board-user" }).returning();
    const ids = { predecessor: randomUUID(), followUp: randomUUID(), continuation: randomUUID() };
    const base = { companyId, agentId, scopeKind: "issue" as const, contextSnapshot: { issueId: issue!.id },
      ...(row.native ? { nativeIssueId: issue!.id, runtimeMode: "native" } : { issueId: issue!.id }) };
    await db.insert(heartbeatRuns).values({ ...base, id: ids.predecessor, status: "succeeded", livenessState: "advanced",
      createdAt: minutesAgo(30), startedAt: minutesAgo(30), finishedAt: minutesAgo(2), ...row.predecessor });
    for (const key of ["followUp", "continuation"] as const) {
      const spec = row[key];
      if (!spec) continue;
      const { ageSeconds, ...values } = spec;
      await db.insert(heartbeatRuns).values({ ...base, id: ids[key], createdAt: new Date(Date.now() - ageSeconds * 1000),
        ...(key === "continuation" ? { retryOfRunId: ids.predecessor } : {}), ...values });
    }
    if (row.deliveredContinuation) await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "fresh_continuation", fingerprint: `fresh-continuation:${ids.predecessor}`, nextAction: "Continuing.",
      resolvedAt: minutesAgo(19), attemptCount: 1, evidence: { runId: ids.predecessor, continuationDelivery: "delivered",
        continuationRunId: ids.followUp, freshContinuation: { sourceRunId: ids.predecessor, recordedAt: minutesAgo(19).toISOString() } } });
    const [current] = await db.update(issues).set({ executionRunId: row.lockOwner ? ids[row.lockOwner] : null })
      .where(eq(issues.id, issue!.id)).returning();
    return { companyId, issue: current!, ids };
  }

  it.each(STATE_TABLE)("$name", async row => {
    const f = await seed(row);
    const list = (await taskInterruptionPresentations(db, f.companyId, [f.issue])).get(f.issue.id);
    const detail = await taskInterruptionPresentation(db, f.issue);
    for (const presentation of [list, detail]) {
      expect(presentation).toMatchObject({ state: row.expected.state, canRetry: row.expected.canRetry,
        observedRunId: f.ids[row.expected.observed], ...(row.expected.retryAction ? { retryAction: row.expected.retryAction } : {}) });
      expect(presentation?.retryAction).toBe(row.expected.retryAction);
    }
    if (row.expected.canRetry) {
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board-user",
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: list!.observedRunId,
        ...(list!.retryAction ? { retryAction: list!.retryAction } : {}) });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: list!.observedRunId });
    }
    if (row.lockOwner && row.expected.observed === row.lockOwner && !row.expected.canRetry) {
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board-user",
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.ids[row.lockOwner] });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: f.ids[row.lockOwner] });
    }
    if (row.retryWith && !row.expected.canRetry) {
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board-user",
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.ids[row.retryWith] });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: f.ids[row.retryWith] });
    }
  }, 60_000);

  describe("a held Retry beside an unstarted lock-changed cancellation", () => {
    async function seedHeldRetry(newer: "lock_changed" | "failed") {
      const row: Row = { name: "held", lockOwner: null,
        predecessor: { status: "failed", errorCode: "adapter_failed", finishedAt: minutesAgo(1) },
        continuation: newer === "lock_changed"
          ? { ...continuationRun, ...lockChanged, finishedAt: minutesAgo(0.5), ageSeconds: 30 }
          : { status: "failed", errorCode: "adapter_failed", startedAt: minutesAgo(0.8), finishedAt: minutesAgo(0.5), ageSeconds: 50 },
        expected: { state: "failed", canRetry: true, observed: "predecessor" } };
      const f = await seed(row);
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.issue.assigneeAgentId!,
        source: "on_demand", reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: "board-user", payload: { issueId: f.issue.id, taskRetry: { sourceRunId: f.ids.predecessor },
          executionWait: { reason: "process_running" } } }).returning();
      return { ...f, requestId: wake!.id };
    }

    it("keeps the held Retry's refusal current and does not retire the Retry", async () => {
      const f = await seedHeldRetry("lock_changed");
      expect((await heldTaskRetryRefusals(db, f.companyId, [f.issue.id])).get(f.issue.id)).toBe("process_running");
      await expect(db.transaction(tx => retireSupersededTaskRetry(tx as unknown as typeof db, { companyId: f.companyId,
        issueId: f.issue.id, requestId: f.requestId, sourceRunId: f.ids.predecessor }))).resolves.toBe(false);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.requestId));
      expect(wake).toMatchObject({ status: "deferred_issue_execution", error: null });
    }, 60_000);

    it("still retires a held Retry that a newer real attempt superseded", async () => {
      const f = await seedHeldRetry("failed");
      expect((await heldTaskRetryRefusals(db, f.companyId, [f.issue.id])).has(f.issue.id)).toBe(false);
      await expect(db.transaction(tx => retireSupersededTaskRetry(tx as unknown as typeof db, { companyId: f.companyId,
        issueId: f.issue.id, requestId: f.requestId, sourceRunId: f.ids.predecessor }))).resolves.toBe(true);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.requestId));
      expect(wake).toMatchObject({ status: "skipped", error: "task_retry_superseded" });
    }, 60_000);
  });
});

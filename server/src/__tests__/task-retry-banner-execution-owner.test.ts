import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { taskInterruptionPresentation, taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { requestTaskRetry } from "../services/task-retry.js";

vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();

type RunSpec = Partial<typeof heartbeatRuns.$inferInsert> & { ageSeconds: number };
type Row = {
  name: string;
  predecessor?: Partial<typeof heartbeatRuns.$inferInsert>;
  followUp?: RunSpec;
  continuation?: RunSpec;
  lockOwner: "followUp" | "continuation" | null;
  expected: { state: string; canRetry: boolean; observed: "predecessor" | "followUp" | "continuation" };
  retryWith?: "predecessor" | "followUp" | "continuation";
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
    const base = { companyId, agentId, issueId: issue!.id, scopeKind: "issue" as const,
      contextSnapshot: { issueId: issue!.id } };
    await db.insert(heartbeatRuns).values({ ...base, id: ids.predecessor, status: "succeeded", livenessState: "advanced",
      createdAt: minutesAgo(30), startedAt: minutesAgo(30), finishedAt: minutesAgo(2), ...row.predecessor });
    for (const key of ["followUp", "continuation"] as const) {
      const spec = row[key];
      if (!spec) continue;
      const { ageSeconds, ...values } = spec;
      await db.insert(heartbeatRuns).values({ ...base, id: ids[key], createdAt: new Date(Date.now() - ageSeconds * 1000),
        ...(key === "continuation" ? { retryOfRunId: ids.predecessor } : {}), ...values });
    }
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
        observedRunId: f.ids[row.expected.observed] });
    }
    if (row.expected.canRetry) {
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board-user",
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: list!.observedRunId });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: list!.observedRunId });
    }
    if (row.retryWith && !row.expected.canRetry) {
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board-user",
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.ids[row.retryWith] });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: f.ids[row.retryWith] });
    }
  }, 60_000);
});

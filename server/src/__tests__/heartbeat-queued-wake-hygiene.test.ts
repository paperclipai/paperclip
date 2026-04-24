import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued wake hygiene test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("heartbeat queued wake hygiene", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-hygiene-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertQueuedWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestStatus?: "queued" | "deferred_issue_execution";
    requestedAt?: Date;
    requestedByActorType?: string | null;
    withRun?: boolean;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = input.withRun === false ? null : randomUUID();
    const now = input.requestedAt ?? new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: input.requestStatus ?? "queued",
      requestedByActorType: input.requestedByActorType ?? "agent",
      requestedByActorId: input.requestedByActorType ? "actor-1" : input.agentId,
      runId,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (runId) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: { issueId: input.issueId },
        createdAt: now,
        updatedAt: now,
      });
    }
    return { wakeupRequestId, runId };
  }

  it("cancels queued runs whose issues are still dependency-blocked", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedIssueId, companyId, title: "Blocked issue", status: "todo", priority: "medium", assigneeAgentId: agentId },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    const seeded = await insertQueuedWake({ companyId, agentId, issueId: blockedIssueId });

    const result = await (heartbeat as any).reconcileQueuedIssueWakeEligibility();

    expect(result.cancelledDependencyBlocked).toBe(1);
    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]);
    expect(wake).toMatchObject({ status: "skipped", reason: "issue_dependencies_blocked" });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId!)).then((rows) => rows[0]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
  });

  it("cancels blocked-without-edges and terminal pending wakes", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockedIssueId = randomUUID();
    const doneIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockedIssueId, companyId, title: "Blocked no edges", status: "blocked", priority: "medium", assigneeAgentId: agentId },
      { id: doneIssueId, companyId, title: "Done issue", status: "done", priority: "medium", assigneeAgentId: agentId },
    ]);
    const blockedWake = await insertQueuedWake({ companyId, agentId, issueId: blockedIssueId });
    const doneWake = await insertQueuedWake({ companyId, agentId, issueId: doneIssueId, requestStatus: "deferred_issue_execution", withRun: false });

    const result = await (heartbeat as any).reconcileQueuedIssueWakeEligibility();

    expect(result.cancelledBlockedStatus).toBe(1);
    expect(result.cancelledTerminal).toBe(1);

    const wakes = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .orderBy(asc(agentWakeupRequests.requestedAt));
    expect(wakes).toEqual([
      expect.objectContaining({ id: blockedWake.wakeupRequestId, status: "skipped", reason: "issue_status_blocked" }),
      expect.objectContaining({ id: doneWake.wakeupRequestId, status: "skipped", reason: "issue_terminal" }),
    ]);
  });

  it("cancels duplicate queued wakes for the same agent and issue while preserving the earliest request", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Duplicate target", status: "todo", priority: "medium", assigneeAgentId: agentId });
    const first = await insertQueuedWake({ companyId, agentId, issueId, requestedAt: new Date("2026-04-24T10:00:00Z") });
    const second = await insertQueuedWake({ companyId, agentId, issueId, requestedAt: new Date("2026-04-24T10:01:00Z") });

    const result = await (heartbeat as any).reconcileQueuedIssueWakeEligibility();

    expect(result.cancelledDuplicateQueued).toBe(1);
    const wakes = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .orderBy(asc(agentWakeupRequests.requestedAt));
    expect(wakes).toEqual([
      expect.objectContaining({ id: first.wakeupRequestId, status: "queued", reason: "issue_assigned" }),
      expect.objectContaining({ id: second.wakeupRequestId, status: "skipped", reason: "issue_duplicate_queued" }),
    ]);
    const duplicateRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.runId!)).then((rows) => rows[0]);
    expect(duplicateRun).toMatchObject({ status: "cancelled", errorCode: "issue_duplicate_queued" });
  });
});

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { RESERVED_AGENT_BOARD_UI_ONLY_CODE } from "../services/agent-assignment-policy.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Unexpected reserved-agent test execution.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
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

describeEmbeddedPostgres("heartbeat board-ui-only assignment gate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-board-ui-only-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedReservedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Board UI Only Co",
      issuePrefix: `BU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reserved Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: {
            mode: "board_ui_create_only",
            allowedUserIds: [ownerUserId],
          },
        },
      },
    });
    return { companyId, agentId, ownerUserId };
  }

  it("skips issue-less automation without creating a run", async () => {
    const { agentId } = await seedReservedAgent();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "scheduled_monitor",
      requestedByActorType: "system",
      requestedByActorId: "monitor",
    });

    expect(run).toBeNull();
    const wakeup = await db.select().from(agentWakeupRequests).then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: RESERVED_AGENT_BOARD_UI_ONLY_CODE,
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["generated", "issue_productivity_review", false, "owner", true],
    ["agent-created", "manual", true, "owner", true],
    ["created by a non-allowlisted user", "manual", false, "other", true],
    ["assigned to a different principal", "manual", false, "owner", false],
  ] as const)("skips an issue wake when persisted provenance is %s", async (
    _label,
    originKind,
    agentCreated,
    creator,
    assignedToReservedAgent,
  ) => {
    const { companyId, agentId, ownerUserId } = await seedReservedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Generated review",
      status: "todo",
      assigneeAgentId: assignedToReservedAgent ? agentId : null,
      originKind,
      createdByAgentId: agentCreated ? agentId : null,
      createdByUserId: agentCreated ? null : creator === "owner" ? ownerUserId : `other-${randomUUID()}`,
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "productivity_review",
    });

    expect(run).toBeNull();
    const wakeup = await db.select().from(agentWakeupRequests).then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: RESERVED_AGENT_BOARD_UI_ONLY_CODE,
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("queues execution for an eligible manual owner-created issue", async () => {
    const { companyId, agentId, ownerUserId } = await seedReservedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Manual owner task",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "manual",
      createdByUserId: ownerUserId,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
    });

    expect(run).toMatchObject({
      agentId,
      status: "queued",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels a legacy queued run that fails the policy at claim time", async () => {
    const { companyId, agentId, ownerUserId } = await seedReservedAgent();
    const issueId = randomUUID();
    const siblingIssueId = randomUUID();
    const issueIdentifier = `LEGACY-${randomUUID().slice(0, 8).toUpperCase()}`;
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy generated task",
      identifier: issueIdentifier,
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
      createdByUserId: ownerUserId,
    });
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId,
      title: "Sibling lock reference",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
      createdByUserId: ownerUserId,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: issueIdentifier },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        checkoutRunId: runId,
        executionAgentNameKey: "reserved-agent",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        checkoutRunId: runId,
        executionAgentNameKey: "reserved-agent",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, siblingIssueId));

    await heartbeatService(db).resumeQueuedRuns();

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toEqual({
      status: "cancelled",
      errorCode: RESERVED_AGENT_BOARD_UI_ONLY_CODE,
    });
    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");
    const unlockedIssues = await db
      .select({
        id: issues.id,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(inArray(issues.id, [issueId, siblingIssueId]));
    expect(unlockedIssues).toHaveLength(2);
    for (const unlockedIssue of unlockedIssues) {
      expect(unlockedIssue).toMatchObject({
        executionRunId: null,
        checkoutRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 15_000);
});

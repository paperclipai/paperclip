import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Missing-comment handoff test run.",
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

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat missing-comment retry handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-missing-comment-handoff-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Missing-comment handoff test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("prioritizes the new assignee's deferred handoff when a reassigned comment retry is cancelled", async () => {
    const companyId = randomUUID();
    const previousAssigneeId = randomUUID();
    const newAssigneeId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: previousAssigneeId,
        companyId,
        name: "Previous assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
        permissions: {},
      },
      {
        id: newAssigneeId,
        companyId,
        name: "New assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassign without a completion comment",
      status: "todo",
      priority: "high",
      assigneeAgentId: previousAssigneeId,
      responsibleUserId: "responsible-user",
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({
          status: "in_progress",
          assigneeAgentId: newAssigneeId,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      const previousAssigneeFollowupWake = await heartbeat.wakeup(previousAssigneeId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId, followup: "fresh_session" },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
          forceFreshSession: true,
          skipIssueComment: true,
        },
        requestedByActorType: "agent",
        requestedByActorId: previousAssigneeId,
      });
      expect(previousAssigneeFollowupWake).toBeNull();

      const handoffRun = await heartbeat.wakeup(newAssigneeId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
          skipIssueComment: true,
        },
      });
      expect(handoffRun).toBeNull();

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Reassigned without a comment.",
        provider: "test",
        model: "test-model",
      };
    });

    const originalRun = await heartbeat.wakeup(previousAssigneeId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
    });
    expect(originalRun).not.toBeNull();

    const handoffPromoted = await waitForCondition(async () => {
      const [commentRetry, previousAssigneeFollowupWake, handoffWake, newAssigneeRun] = await Promise.all([
        db
          .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, originalRun!.id))
          .then((rows) => rows[0] ?? null),
        db
          .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, previousAssigneeId),
              sql`${agentWakeupRequests.payload} ->> 'followup' = 'fresh_session'`,
            ),
          )
          .then((rows) => rows[0] ?? null),
        db
          .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              eq(agentWakeupRequests.agentId, newAssigneeId),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            ),
          )
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, newAssigneeId),
            ),
          )
          .then((rows) => rows[0] ?? null),
      ]);
      return (
        commentRetry?.status === "cancelled" &&
        commentRetry.errorCode === "issue_assignee_changed" &&
        previousAssigneeFollowupWake?.runId === null &&
        handoffWake?.runId === newAssigneeRun?.id &&
        (newAssigneeRun.status === "running" || newAssigneeRun.status === "succeeded")
      );
    });

    expect(handoffPromoted).toBe(true);
  }, 30_000);
});

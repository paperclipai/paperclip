import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  runIdentityContexts,
} from "@paperclipai/db";
import { runningProcesses } from "../../adapters/index.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export type QueuedCommentsDb = ReturnType<typeof createDb>;

export function createIssueQueuedCommentsHarness(prefix = "paperclip-queued-comments-") {
  let db!: QueuedCommentsDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const testProcesses = new Map<string, ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(prefix);
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const [id, child] of testProcesses) {
      runningProcesses.delete(id);
      child.kill();
    }
    testProcesses.clear();
    // Each case owns the entire disposable database. Clear the full company
    // graph, including attribution rows and constraints added by migrations.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(
    companyId: string,
    userId = "queue-owner",
    agentActor?: { agentId: string; runId: string },
    database = db,
  ) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: agentActor ? "agent" : "board",
        ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(database, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Test Company",
      issuePrefix: "QUE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paperclip Runner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: "queue-owner",
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: "other-operator",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "issue_comment",
      reason: "Follow-up comments arrived during the active run",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "queue-owner",
      payload: {
        issueId,
        commentId: commentIds[1],
        _paperclipWakeContext: {
          commentId: commentIds[1],
          wakeCommentId: commentIds[1],
          wakeCommentIds: commentIds,
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "queue route test",
      status: "running",
      runtimeMode: "native",
      startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "QUE-1",
      title: "Queued steering",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
    });
    await db.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      authorType: "user" as const,
      authorUserId: "queue-owner",
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    return { companyId, agentId, issueId, runId, wakeId, commentIds };
  }

  async function commitNativeSuccess(f: Awaited<ReturnType<typeof seedQueue>>) {
    const contractId = randomUUID();
    const resultId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: f.companyId,
      issueId: f.issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "test",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {},
      canonicalSha256: contractId,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db
      .update(heartbeatRuns)
      .set({ nativeIssueId: f.issueId, completionContractId: contractId })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId: f.companyId,
      issueId: f.issueId,
      runId: f.runId,
      completionContractId: contractId,
      serverFingerprint: resultId,
      schemaStatus: "accepted",
      canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "completed" } },
    });
    await db.insert(nativeRunFinalizations).values({
      companyId: f.companyId,
      issueId: f.issueId,
      runId: f.runId,
      phase: "committed",
      resultId,
    });
  }

  async function promoteQueue(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const queueRunId = randomUUID();
    const wake = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeId))
      .then((rows) => rows[0]);
    const wakeContext = (wake?.payload as any)?._paperclipWakeContext ?? {};
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-08-22T15:05:00.000Z") })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await db.insert(heartbeatRuns).values({
      id: queueRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "issue_comment",
      triggerDetail: "queue route promotion test",
      status: "queued",
      runtimeMode: "native",
      wakeupRequestId: seeded.wakeId,
      contextSnapshot: {
        issueId: seeded.issueId,
        wakeReason: "issue_reopened_via_comment",
        ...wakeContext,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ status: "queued", runId: queueRunId })
      .where(eq(agentWakeupRequests.id, seeded.wakeId));
    await db
      .update(issues)
      .set({ executionRunId: queueRunId })
      .where(eq(issues.id, seeded.issueId));
    return queueRunId;
  }

  async function seedDispatchIdentity(seeded: Awaited<ReturnType<typeof seedQueue>>) {
    const [identity] = await db.insert(runIdentityContexts).values({
      companyId: seeded.companyId,
      runId: seeded.runId,
      revision: 1,
      cause: "dispatch",
      correlationId: "dispatch",
      status: "accepted",
      acceptedAt: new Date("2026-08-22T15:00:00.000Z"),
    }).returning();
    await db.update(heartbeatRuns)
      .set({ activeIdentityContextId: identity!.id })
      .where(eq(heartbeatRuns.id, seeded.runId));
    return identity!;
  }

  return {
    get db() {
      return db;
    },
    get tempDb() {
      return tempDb;
    },
    testProcesses,
    app,
    seedQueue,
    commitNativeSuccess,
    promoteQueue,
    seedDispatchIdentity,
  };
}

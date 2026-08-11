import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  interruptedRunHandoffs,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { interruptedRunRecoveryReadModelSchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { deriveInterruptedRunRecovery } from "../services/interrupted-run-recovery.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

function recoveryRun(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    status: "failed",
    finishedAt: new Date("2026-08-07T18:00:00.000Z"),
    errorCode: "process_lost",
    retryOfRunId: null,
    processLossRetryCount: 0,
    createdAt: new Date("2026-08-07T17:59:00.000Z"),
    updatedAt: new Date("2026-08-07T18:00:00.000Z"),
    ...overrides,
  };
}

function recoveryReceipt(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-07T18:00:00.000Z");
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    issueId: randomUUID(),
    interruptedRunId: randomUUID(),
    kind: "process_loss_handoff",
    status: "suppressed",
    reason: "owner_changed",
    ownerAgentId: randomUUID(),
    successorRunId: null,
    recoveryActionId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("deriveInterruptedRunRecovery", () => {
  it("suppresses stale receipt evidence when a different live continuation exists", () => {
    const source = recoveryRun();
    const receipt = recoveryReceipt({ interruptedRunId: source.id });

    expect(deriveInterruptedRunRecovery({
      issueStatus: "in_progress",
      receipt,
      interruptedRun: source,
      successorRun: null,
      liveRunId: randomUUID(),
      activeRecoveryAction: null,
    })).toBeNull();
  });

  it("surfaces an escalated recovery owner and next action ahead of a live successor", () => {
    const source = recoveryRun({ processLossRetryCount: 1 });
    const successor = recoveryRun({ status: "running", retryOfRunId: source.id, processLossRetryCount: 1 });
    const actionId = randomUUID();
    const ownerAgentId = randomUUID();
    const receipt = recoveryReceipt({
      interruptedRunId: source.id,
      successorRunId: successor.id,
      status: "escalated",
      reason: "automatic_successor_exhausted",
      recoveryActionId: actionId,
    });
    const recovery = deriveInterruptedRunRecovery({
      issueStatus: "in_progress",
      receipt,
      interruptedRun: source,
      successorRun: successor,
      liveRunId: successor.id,
      activeRecoveryAction: {
        id: actionId,
        companyId: receipt.companyId,
        sourceIssueId: receipt.issueId,
        recoveryIssueId: null,
        kind: "stranded_assigned_issue",
        status: "escalated",
        ownerType: "agent",
        ownerAgentId,
        ownerUserId: null,
        previousOwnerAgentId: ownerAgentId,
        returnOwnerAgentId: ownerAgentId,
        cause: "process_loss_handoff_exhausted",
        fingerprint: `process_loss_handoff:${source.id}`,
        evidence: {},
        nextAction: "Restore one authorized normal-model continuation.",
        wakePolicy: null,
        monitorPolicy: null,
        attemptCount: 1,
        maxAttempts: 1,
        timeoutAt: null,
        lastAttemptAt: source.finishedAt,
        outcome: null,
        resolutionNote: null,
        resolvedAt: null,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      },
    });

    expect(recovery).toMatchObject({
      state: "recovery_owner_required",
      escalationReason: "automatic_successor_exhausted",
      recoveryActionId: actionId,
      owner: { type: "agent", agentId: ownerAgentId, userId: null },
      nextAction: "Restore one authorized normal-model continuation.",
    });
    expect(interruptedRunRecoveryReadModelSchema.safeParse(recovery).success).toBe(true);
  });

  it("redacts receipt and run evidence while preserving the recovery state", () => {
    const source = recoveryRun();
    const receipt = recoveryReceipt({ interruptedRunId: source.id });
    const recovery = deriveInterruptedRunRecovery({
      issueStatus: "in_progress",
      receipt,
      interruptedRun: source,
      successorRun: null,
      liveRunId: null,
      activeRecoveryAction: null,
      evidenceAllowed: false,
    });

    expect(recovery).toEqual({
      state: "suppressed",
      interruptedRunId: null,
      interruptedAt: null,
      errorCode: null,
      successorRunId: null,
      successorStatus: null,
      receiptId: null,
      receiptOutcome: null,
      suppressionReason: null,
      escalationReason: null,
      attempt: null,
      maxAttempts: null,
      recoveryActionId: null,
      owner: null,
      nextAction: null,
    });
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interrupted-run recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("interrupted-run recovery API", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interrupted-run-recovery-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(interruptedRunHandoffs);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Coder`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("returns permitted receipt evidence and a state-only blocker summary", async () => {
    const { companyId, agentId } = await seedCompany("IRA");
    const interruptedIssueId = randomUUID();
    const parentIssueId = randomUUID();
    const interruptedRunId = randomUUID();
    const successorRunId = randomUUID();
    const receiptId = randomUUID();
    const interruptedAt = new Date("2026-08-07T18:00:00.000Z");

    await db.insert(issues).values([
      {
        id: interruptedIssueId,
        companyId,
        title: "Interrupted work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: "IRA-1",
      },
      {
        id: parentIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: "IRA-2",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: interruptedIssueId,
      relatedIssueId: parentIssueId,
      type: "blocks",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: interruptedRunId,
        companyId,
        agentId,
        status: "failed",
        errorCode: "server_shutdown_interrupted",
        finishedAt: interruptedAt,
        contextSnapshot: { issueId: interruptedIssueId },
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "queued",
        retryOfRunId: interruptedRunId,
        processLossRetryCount: 1,
        contextSnapshot: { issueId: interruptedIssueId },
      },
    ]);
    await db.insert(interruptedRunHandoffs).values({
      id: receiptId,
      companyId,
      issueId: interruptedIssueId,
      interruptedRunId,
      status: "queued",
      reason: "successor_queued",
      ownerAgentId: agentId,
      successorRunId,
    });

    const app = createApp({ type: "agent", companyId, agentId, runId: randomUUID() });
    const detail = await request(app).get(`/api/issues/${interruptedIssueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.interruptedRunRecovery).toMatchObject({
      state: "recovered",
      interruptedRunId,
      interruptedAt: interruptedAt.toISOString(),
      errorCode: "server_shutdown_interrupted",
      successorRunId,
      successorStatus: "queued",
      receiptId,
      receiptOutcome: "queued",
      attempt: 1,
      maxAttempts: 1,
      owner: { type: "agent", agentId, userId: null },
    });
    expect(interruptedRunRecoveryReadModelSchema.safeParse(detail.body.interruptedRunRecovery).success).toBe(true);

    const parent = await request(app).get(`/api/issues/${parentIssueId}`);
    expect(parent.status, JSON.stringify(parent.body)).toBe(200);
    expect(parent.body.blockedBy).toEqual([
      expect.objectContaining({
        id: interruptedIssueId,
        interruptedRunRecoveryState: "recovered",
      }),
    ]);
    expect(parent.body.blockedBy[0]).not.toHaveProperty("interruptedRunRecovery");
  });

  it("returns a bounded suppression reason without exposing unrelated run fields", async () => {
    const { companyId, agentId } = await seedCompany("IRS");
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Suppressed retry",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "IRS-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "process_lost",
      error: "secret-bearing provider diagnostic that must not enter the receipt read model",
      stderrExcerpt: "private stderr",
      contextSnapshot: { issueId },
    });
    await db.insert(interruptedRunHandoffs).values({
      companyId,
      issueId,
      interruptedRunId: runId,
      status: "suppressed",
      reason: "owner_changed",
      ownerAgentId: agentId,
    });

    const app = createApp({ type: "agent", companyId, agentId, runId: randomUUID() });
    const response = await request(app).get(`/api/issues/${issueId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.interruptedRunRecovery).toMatchObject({
      state: "suppressed",
      receiptOutcome: "suppressed",
      suppressionReason: "owner_changed",
    });
    expect(response.body.interruptedRunRecovery).not.toHaveProperty("error");
    expect(response.body.interruptedRunRecovery).not.toHaveProperty("stderrExcerpt");
  });

  it("returns not found for a cross-company recovery read", async () => {
    const source = await seedCompany("IRX");
    const foreign = await seedCompany("IRY");
    const foreignIssueId = randomUUID();
    const foreignRunId = randomUUID();
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: foreign.companyId,
      title: "Foreign recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: foreign.agentId,
      issueNumber: 1,
      identifier: "IRY-1",
    });
    await db.insert(heartbeatRuns).values({
      id: foreignRunId,
      companyId: foreign.companyId,
      agentId: foreign.agentId,
      status: "failed",
      errorCode: "process_lost",
      contextSnapshot: { issueId: foreignIssueId },
    });
    await db.insert(interruptedRunHandoffs).values({
      companyId: foreign.companyId,
      issueId: foreignIssueId,
      interruptedRunId: foreignRunId,
      status: "suppressed",
      reason: "owner_changed",
      ownerAgentId: foreign.agentId,
    });

    const app = createApp({
      type: "agent",
      companyId: source.companyId,
      agentId: source.agentId,
      runId: randomUUID(),
    });
    const response = await request(app).get(`/api/issues/${foreignIssueId}`);
    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty("interruptedRunRecovery");
  });
});

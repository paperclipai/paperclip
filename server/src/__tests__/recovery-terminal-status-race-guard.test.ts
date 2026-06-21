import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-status race-guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage for the race condition where reconcileStrandedAssignedIssues
// reads an issue (status="in_progress"), the assignee patches it to "done" before
// escalateStrandedAssignedIssue can finish, and the recovery sweep then overwrites
// the completion with "blocked" — causing a reopen / ping-pong loop.
//
// The guard re-reads the issue's status immediately before mutating it. If the
// fresh status is terminal ("done" / "cancelled"), escalation is skipped.
describeEmbeddedPostgres("recovery escalateStrandedAssignedIssue terminal-status race guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-race-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "manual",
      finishedAt: new Date(),
    });

    return { companyId, agentId, runId };
  }

  it("skips escalation and leaves status untouched when the issue is `done` between scan and update", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race: assignee completes between reconcile scan and recovery update",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // Snapshot the issue as the reconcile sweep would have seen it (in_progress).
    const [staleSnapshot] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(staleSnapshot.status).toBe("in_progress");

    // Simulate the assignee winning the race: patch the row to `done` AFTER the
    // sweep took its snapshot but BEFORE escalateStrandedAssignedIssue runs.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.escalateStrandedAssignedIssue({
      issue: staleSnapshot,
      previousStatus: "in_progress",
      latestRun: {
        id: runId,
        agentId,
        status: "failed",
        error: null,
        errorCode: null,
        contextSnapshot: null,
        livenessState: null,
      } as any,
    });

    // The guard short-circuits — no return value, no wake, no flip to blocked.
    expect(result).toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [final] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(final).toEqual({ status: "done", assigneeAgentId: agentId });
  });

  it("also skips when the assignee won the race with `cancelled` rather than `done`", async () => {
    const { companyId, agentId, runId } = await seed();
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race: issue cancelled between reconcile scan and recovery update",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const [staleSnapshot] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));

    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));

    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.escalateStrandedAssignedIssue({
      issue: staleSnapshot,
      previousStatus: "in_progress",
      latestRun: {
        id: runId,
        agentId,
        status: "failed",
        error: null,
        errorCode: null,
        contextSnapshot: null,
        livenessState: null,
      } as any,
    });

    expect(result).toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [final] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(final.status).toBe("cancelled");
  });
});

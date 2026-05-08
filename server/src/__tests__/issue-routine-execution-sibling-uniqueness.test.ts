import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine_execution sibling uniqueness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for GLA-291. The partial unique index
// `issues_open_routine_execution_uq` previously required execution_run_id IS
// NOT NULL, which left a window where two routine_execution siblings sharing
// (company_id, origin_id, origin_fingerprint) could both be inserted with
// null execution_run_id. A later UPDATE that populated execution_run_id (and
// kept the row in the index) admitted both rows into the index — every
// subsequent write that left them in the index, including the reaper's
// PATCH {status:"cancelled"}, then failed with 23505. Migration 0082
// tightens the predicate; this test ensures the wedge state can no longer
// be reached and that the cancellation PATCH against a sibling whose
// execution_run_id is populated still succeeds.
describeEmbeddedPostgres("routine_execution sibling uniqueness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-routine-sibling-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const routineOriginId = randomUUID();
    const fingerprint = "fp-" + randomUUID();

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    return { companyId, agentId, projectId, routineOriginId, fingerprint };
  }

  async function seedHeartbeatRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(),
    });
    return runId;
  }

  it("rejects a duplicate routine_execution sibling at INSERT time even before execution_run_id is populated", async () => {
    const { companyId, agentId, projectId, routineOriginId, fingerprint } = await seed();
    const firstId = randomUUID();
    await db.insert(issues).values({
      id: firstId,
      companyId,
      projectId,
      title: "routine sibling A",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: fingerprint,
      originRunId: randomUUID(),
      // executionRunId intentionally null — this is the window the wedge
      // state previously exploited.
    });

    await expect(
      db.insert(issues).values({
        id: randomUUID(),
        companyId,
        projectId,
        title: "routine sibling B",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: routineOriginId,
        originFingerprint: fingerprint,
        originRunId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "issues_open_routine_execution_uq" });
  });

  it("PATCH {status:'cancelled'} succeeds on a routine_execution sibling whose execution_run_id is populated", async () => {
    // Replicates the GLA-249 reproduction: a single sibling with a populated
    // execution_run_id that the reaper attempts to cancel. Pre-fix the index
    // would have admitted a duplicate companion and wedged this PATCH with
    // 23505. Post-fix the duplicate cannot exist, so the PATCH must return.
    const { companyId, agentId, projectId, routineOriginId, fingerprint } = await seed();
    const runId = await seedHeartbeatRun(companyId, agentId);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "routine sibling with execution_run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: fingerprint,
      originRunId: randomUUID(),
      executionRunId: runId,
      executionLockedAt: new Date(),
    });

    const updated = await svc.update(issueId, { status: "cancelled" });
    expect(updated?.status).toBe("cancelled");

    const persisted = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("cancelled");
  });

  it("permits a fresh routine_execution sibling once the prior one is hidden or terminal", async () => {
    const { companyId, agentId, projectId, routineOriginId, fingerprint } = await seed();
    const firstId = randomUUID();
    await db.insert(issues).values({
      id: firstId,
      companyId,
      projectId,
      title: "routine sibling A",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: fingerprint,
      originRunId: randomUUID(),
    });

    // Move the prior sibling out of the partial index by hiding it. Hidden
    // rows are excluded by the predicate, so a replacement may now exist.
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, firstId));

    const secondId = randomUUID();
    await db.insert(issues).values({
      id: secondId,
      companyId,
      projectId,
      title: "routine sibling B",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: fingerprint,
      originRunId: randomUUID(),
    });

    const replacement = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, secondId))
      .then((rows) => rows[0] ?? null);
    expect(replacement?.id).toBe(secondId);
  });
});

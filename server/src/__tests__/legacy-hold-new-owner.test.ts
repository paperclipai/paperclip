import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { getExecutionBlocker } from "../services/execution-blocker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("a legacy reconciliation hold after the task changes owner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-hold-new-owner-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await truncateTablesWithDeadlockRetry(db, `TRUNCATE TABLE "issue_recovery_actions", "issues", "heartbeat_runs",
      "agents", "companies" RESTART IDENTITY CASCADE`, { attempts: 10, delayMs: () => 100 });
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedHold(input: { finished?: boolean; evidence?: Record<string, unknown> } = {}) {
    const companyId = randomUUID(), reviewerId = randomUUID(), ownerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}` });
    await db.insert(agents).values([reviewerId, ownerId].map((id, index) => ({
      id, companyId, name: index === 0 ? "QA" : "TechLead", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Close-out review", status: "in_review",
      priority: "medium", assigneeAgentId: reviewerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, invocationSource: "assignment",
      triggerDetail: "system", status: input.finished === false ? "running" : "failed", errorCode: "adapter_failed",
      startedAt: new Date(Date.now() - 300_000), finishedAt: input.finished === false ? null : new Date(Date.now() - 60_000),
      contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: runId, status: "resolved",
      outcome: "blocked", nextAction: "Automatic recovery stopped.",
      evidence: { runId, automaticRecovery: { runId, policy: "preserve_without_replay_v1", replay: "blocked",
        actionOutcome: "unknown" }, ...input.evidence } });
    return { companyId, reviewerId, ownerId, issueId, runId };
  }

  it("keeps the hold while the stopped run's agent still owns the task", async () => {
    const f = await seedHold();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId });
  });

  it("releases the hold for a new owner after the stopped run finished", async () => {
    const f = await seedHold();
    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("releases the hold for a person who now owns the task", async () => {
    const f = await seedHold();
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board-user" }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("applies the hold again when the stopped run's agent owns the task again", async () => {
    const f = await seedHold();
    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ assigneeAgentId: f.reviewerId }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId });
  });

  it("keeps the hold while the stopped run's agent is the pending review participant", async () => {
    const f = await seedHold();
    await db.update(issues).set({ assigneeAgentId: f.ownerId, executionState: { status: "pending",
      currentParticipant: { type: "agent", agentId: f.reviewerId } } }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId });
  });

  it("keeps the hold while the stopped run has not finished", async () => {
    const f = await seedHold({ finished: false });
    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("leaves workspace restore holds to their own release rule", async () => {
    const f = await seedHold({ evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } });
    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });
});

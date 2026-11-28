import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, caseHandoffs, cases, companies, companyMemberships, createDb,
  environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { WORKSPACE_BUSY_ERROR_CODE } from "../services/heartbeat/retries.js";
import { withIndependentWorkspaceSourceLocks } from "../services/workspace-source-lock.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { waitForCondition } from "./helpers/native-restart-fixture.js";

const support = await getEmbeddedPostgresTestSupport();

// The public heartbeat path: a real advisory-lock holder makes the run's own
// preparation wait the full bounded window and end in the busy catch, instead
// of invoking finalizeWorkspaceSourceLockWait directly. The 30s wait is the
// production bound; each test holds the key until its run has finished.
describe.skipIf(!support.supported)("workspace source-lock wait through heartbeat preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "heartbeat-source-lock-wait-"));
    database = await startEmbeddedPostgresTestDatabase("heartbeat-source-lock-wait-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "71".repeat(32));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
  }, 90_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function assigneeFixture() {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Workspace owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Source lock wait", issuePrefix: `L${randomUUID().slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ name: `Lock wait ${randomUUID()}`,
      driver: "sandbox", status: "active", config: { provider: "daytona" } }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Locked worker", status: "idle",
      adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Wait on the source lock",
      status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    return { userId, company, agent, issue };
  }

  function holdIssueSource(companyId: string, issueId: string) {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const scope = withIndependentWorkspaceSourceLocks(db, { companyId, issueIds: [issueId] }, async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    return { enteredPromise, release: () => release(), settle: () => scope };
  }

  it("cancels a contended preparation with the assignee decision and parks an uncharged retry", async () => {
    const { userId, company, agent, issue } = await assigneeFixture();
    const holder = holdIssueSource(company.id, issue.id);
    await holder.enteredPromise;
    let runId = "";
    try {
      const run = await heartbeat.wakeup(agent.id, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: userId,
        payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
      expect(run).not.toBeNull();
      runId = run!.id;
      await heartbeat.drainActiveRunExecutions();
    } finally {
      holder.release();
      await holder.settle();
    }
    const [deferred] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(deferred).toMatchObject({ status: "cancelled", errorCode: WORKSPACE_BUSY_ERROR_CODE,
      contextSnapshot: { issueId: issue.id, workspaceBusyDeferredWhileAssignee: true },
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        cancellation: { expected: true, reason: "Waiting for a workspace source lock" } } });
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, deferred.id));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy" });
    const [bound] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(bound).toMatchObject({ executionRunId: retries[0].id });
    expect((await db.select().from(environmentLeases)).filter(lease => lease.heartbeatRunId === deferred.id)).toEqual([]);
  }, 90_000);
});

describeEmbeddedPostgres("source-lock wait settles a native recovery claim", () => {
  const fixture = nativeRestartFixture();

  it("settles the claim as terminal_failure when the parked run cannot be retried", async () => {
    const f = await fixture.seedRun("SOURCE-LOCK-CLAIM");
    await instanceSettingsService(f.db).updateExperimental({ enableNativeRunner: true });
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await f.db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await f.db.insert(companyMemberships).values({ companyId, principalType: "user",
      principalId: userId, membershipRole: "owner" });
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId })
      .where(eq(heartbeatRuns.id, f.runId));
    // A pending case handoff owns successor work, so the bounded retry is
    // refused and the wait's outcome is a failed run with a live claim.
    const [wake] = await f.db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
      idempotencyKey: randomUUID() }).returning();
    const [kase] = await f.db.insert(cases).values({ companyId, caseNumber: 1, identifier: "CASE-1",
      caseType: "standard", title: "Handoff holder" }).returning();
    await f.db.insert(caseHandoffs).values({ companyId, caseId: kase.id, issueId: f.issueId,
      sourceRunId: f.runId, version: 1, destinationKind: "agent", toAgentId: agentId, phase: "work",
      instructions: "Continue the task", actorType: "system", actorId: "system", wakeupRequestId: wake.id,
      idempotencyKey: randomUUID(), inputFingerprint: randomUUID(), state: "pending_dispatch" });
    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const entered = new Promise<void>((resolve) => { holderEntered = resolve; });
    const holder = withIndependentWorkspaceSourceLocks(f.db,
      { companyId: fixture.current.companyId, issueIds: [f.issueId] }, async () => {
        holderEntered();
        await new Promise<void>((resolve) => { releaseHolder = resolve; });
      }).then(value => ({ value }), error => ({ error }));
    const heartbeat = heartbeatService(f.db);
    try {
      await entered;
      const { claims } = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [f.runId]);
      expect(claims.length).toBeGreaterThan(0);
      await heartbeat.drainActiveRunExecutions();
      await waitForCondition("source-lock wait ends the recovery run", async () => {
        const [row] = await f.db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, f.runId));
        return row?.status === "failed";
      }, 60_000);
    } finally {
      releaseHolder();
      await holder;
      await heartbeat.drainActiveRunExecutions();
    }
    const [settled] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [claim] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(settled).toMatchObject({ status: "failed", errorCode: "setup_failed",
      error: expect.stringContaining("55P03"), nativePhase: "terminal_failure" });
    expect(claim).toMatchObject({ phase: "terminal_failure", recoveryState: "blocked",
      leaseOwner: null, resultId: null });
    // The cancelled→failed release settles the claim through the continuation
    // reconciliation incident: the task continues from saved work.
    const holds = await f.db.select({ cause: issueRecoveryActions.cause }).from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(holds.map(row => row.cause)).toContain("native_continuation_requires_reconciliation");
  }, 120_000);
});

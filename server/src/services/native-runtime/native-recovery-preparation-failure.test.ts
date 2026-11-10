import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, applyPendingMigrations, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";
import { settleFailedNativeRecoveryPreparation } from "./native-recovery-preparation-failure.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RECOVERY_PREPARATION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

/** RC-58: a failed re-preparation after a restart must leave a working Retry. */
describe.skipIf(!support.supported)("failed native recovery preparation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} } as typeof database;
    } else database = await startEmbeddedPostgresTestDatabase("native-recovery-preparation-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    const leaseOwner = `boot:2:${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Recovery preparation", defaultResponsibleUserId: "board",
      issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the report", status: "blocked", assigneeAgentId: agentId });
    // The restart claimed the run (bootstrap_incomplete); its re-preparation then failed.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "failed", errorCode: "workspace_validation_failed", nativePhase: "observed", contextSnapshot: { issueId },
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000) });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000), controllerGeneration: 2, recoveryState: "bootstrap_incomplete" });
    // Server-authored process trail: the first bootstrap's runner was verified stopped.
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "native.process_start_requested", stream: "system" },
      { companyId, runId, agentId, seq: 2, eventType: "native.process_identity_recorded", stream: "system" },
      { companyId, runId, agentId, seq: 3, eventType: "native.local_process_stopped", stream: "system" },
    ]);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", fingerprint: runId, status: "active", ownerType: "board",
      returnOwnerAgentId: agentId, nextAction: "Retry the task.", evidence: { runId } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Please continue.", createdAt: new Date() });
    return { companyId, agentId, issueId, runId, commentId, leaseOwner };
  }

  async function admissionBlocks(f: Awaited<ReturnType<typeof seed>>) {
    const blocked: string[] = [];
    await db.transaction(async tx => admitExplicitNativeContinuation({ db: tx as unknown as Db, companyId: f.companyId,
      issueId: f.issueId, agentId: f.agentId, actorId: "board", actorType: "user", reason: "issue_commented",
      commentId: f.commentId, successorRunId: randomUUID(), dryRun: true, onBlocked: reason => blocked.push(reason) }));
    return blocked;
  }

  it("settles its own recovery claim so a later Retry is no longer held by the controller", async () => {
    const f = await seed();
    expect(await admissionBlocks(f)).toEqual(["controller_settling"]);
    expect(await settleFailedNativeRecoveryPreparation(db, { companyId: f.companyId, runId: f.runId,
      claim: { kind: "bootstrap_incomplete", leaseOwner: f.leaseOwner } })).toBe(true);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", leaseOwner: null, resultId: null,
      failureCode: "workspace_validation_failed" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
    expect(await admissionBlocks(f)).not.toContain("controller_settling");
    // Settling is idempotent.
    expect(await settleFailedNativeRecoveryPreparation(db, { companyId: f.companyId, runId: f.runId,
      claim: { kind: "bootstrap_incomplete", leaseOwner: f.leaseOwner } })).toBe(false);
  }, 30_000);

  it.each(["other_owner", "reattach_claim", "run_not_failed", "finalizing_elsewhere"] as const)(
    "leaves a coordinator it does not own unchanged: %s", async kind => {
      const f = await seed();
      if (kind === "run_not_failed") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
        .where(eq(heartbeatRuns.id, f.runId));
      if (kind === "finalizing_elsewhere") await db.update(nativeRunFinalizations).set({ phase: "committing" })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      const claim = { kind: kind === "reattach_claim" ? "reattach_existing_runner" as const : "resume_dead_runner" as const,
        leaseOwner: kind === "other_owner" ? `boot:3:${randomUUID()}` : f.leaseOwner };
      const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(await settleFailedNativeRecoveryPreparation(db, { companyId: f.companyId, runId: f.runId, claim })).toBe(false);
      const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(after).toEqual(before);
    }, 30_000);
});

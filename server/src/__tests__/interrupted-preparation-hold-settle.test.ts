import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { heartbeatService } from "../services/heartbeat.js";
import { settleHeldInterruptedPreparations } from "../services/legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

/**
 * The K2-during-preparation shape from Daytona warm wave w-20261108T142906-s9501
 * (t05, run c99b3a2e): a scheduled retry was 2 s into preparation when a
 * graceful shutdown interrupted it. The draining process recorded a
 * preserve-without-replay hold, because at that moment its own controller was
 * still live and the sandbox lease was still being cleaned up. The lease was
 * released with a confirmed stop moments later, and the next process booted,
 * but nothing re-judged the hold, so the task waited for a manual Retry.
 */
suite("held interrupted preparations after a restart", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", environmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-interrupted-preparation-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "IPH",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Sandbox", driver: "sandbox", status: "active",
      config: { provider: "fake" } });
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  async function interruptedPreparation(options: { controllerBootId?: string; leaseReleased?: boolean } = {}) {
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${leaseId}`;
    const finishedAt = new Date(Date.now() - 10_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm follow-up", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation",
      status: "interrupted", errorCode: "server_shutdown_interrupted", runtimeMode: "legacy", executionStage: "preparing",
      startedAt: new Date(finishedAt.getTime() - 2_000), finishedAt, nextEventSeq: 1,
      controllerBootId: options.controllerBootId ?? randomUUID(),
      scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { stopReason: "interrupted", cancellation: { reason: "Server shutdown interrupted execution",
        source: "shutdown", expected: true, initiator: { type: "system" }, recordedAt: finishedAt.toISOString() } } });
    const released = options.leaseReleased !== false;
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: released ? "released" : "pending_cleanup", cleanupStatus: released ? "success" : "failed",
      leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      releasedAt: released ? new Date(finishedAt.getTime() + 2_000) : null,
      metadata: released ? { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId,
        leaseId, provider: "fake", providerLeaseId, state: "stopped", confirmedAt: finishedAt.toISOString() } } : {} });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "execution_reconciliation", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${runId}`, status: "resolved", outcome: "blocked", ownerType: "board",
      nextAction: "Inspect the stopped provider and recorded actions.", resolvedAt: finishedAt,
      evidence: { runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked",
        actionOutcome: "unknown", recordedAt: finishedAt.toISOString() } } }).returning();
    return { issueId, runId, holdId: hold!.id };
  }

  const hold = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const runRow = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("replays a preparation interrupted by a restart once durable proof shows no provider work started", async () => {
    const f = await interruptedPreparation();
    await settleHeldInterruptedPreparations(db);
    const settled = await hold(f.holdId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(settled.evidence).toMatchObject({ automaticRecovery: { replay: "allowed" },
      bootstrapPreparationContinuation: "pending", bootstrapPreparationSettledAt: expect.any(String) });
    expect((await runRow(f.runId)).resultJson).toMatchObject({
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
  });

  it("orphan recovery after a restart settles the hold without a user Retry", async () => {
    const f = await interruptedPreparation();
    await heartbeatService(db).reapOrphanedRuns();
    expect(await hold(f.holdId)).toMatchObject({ status: "resolved", outcome: "false_positive" });
  });

  it.each([
    ["provider work may have started", async (f: { runId: string }) => {
      await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "turn.started",
        stream: "system", level: "info", message: "turn started" });
    }],
    ["the controller that owned it is still this process", async (f: { runId: string }) => {
      await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId }).where(eq(heartbeatRuns.id, f.runId));
    }],
  ] as const)("keeps the hold when %s", async (_label, arrange) => {
    const f = await interruptedPreparation();
    await arrange(f);
    const before = await hold(f.holdId);
    await settleHeldInterruptedPreparations(db);
    expect(await hold(f.holdId)).toEqual(before);
  });

  it("keeps the hold while the sandbox lease is still being cleaned up", async () => {
    const f = await interruptedPreparation({ leaseReleased: false });
    const before = await hold(f.holdId);
    await settleHeldInterruptedPreparations(db);
    expect(await hold(f.holdId)).toEqual(before);
  });
});

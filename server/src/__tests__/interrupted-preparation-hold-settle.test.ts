import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { settleHeldInterruptedPreparation } from "../services/interrupted-preparation-hold-settlement.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "legacy_interrupted_preparation_hold";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

/**
 * The K2-during-preparation shape from Daytona warm wave w-20261108T142906-s9501
 * (t05, run c99b3a2e): a scheduled retry was 2 s into preparation when a
 * graceful shutdown interrupted it. The draining process recorded a
 * preserve-without-replay hold, because its own controller was still live and
 * the sandbox lease was still cleaning up. The lease was released with a
 * confirmed stop moments later and the next process booted, but nothing
 * re-judged the hold, so the task waited for a manual Retry.
 */
suite("held interrupted preparations on the shared ownership path", () => {
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

  /** The draining controller, now exited, in this PID space. */
  async function deadController(overrides: Record<string, unknown> = {}) {
    const bootId = randomUUID();
    return { bootId, process: { bootId, pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
      processStartedAt: new Date(Date.now() - 60_000).toISOString(), ...overrides } as Record<string, unknown> | null };
  }

  async function interruptedPreparation(options: { controller?: { bootId: string; process: Record<string, unknown> | null };
    leaseReleased?: boolean; holdEvidence?: Record<string, unknown> } = {}) {
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${leaseId}`;
    const finishedAt = new Date(Date.now() - 10_000);
    const controller = options.controller ?? await deadController();
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm follow-up", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation",
      status: "interrupted", errorCode: "server_shutdown_interrupted", runtimeMode: "legacy", executionStage: "preparing",
      startedAt: new Date(finishedAt.getTime() - 2_000), finishedAt, nextEventSeq: 1,
      controllerBootId: controller.bootId, controllerProcess: controller.process,
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
        actionOutcome: "unknown", recordedAt: finishedAt.toISOString() }, ...options.holdEvidence } }).returning();
    return { issueId, runId, holdId: hold!.id };
  }

  const hold = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const pass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: true }))
    .kinds.find(entry => entry.kind === KIND);

  it("replays a preparation a restart interrupted once its controller is proven gone", async () => {
    const f = await interruptedPreparation();
    expect(await pass()).toMatchObject({ inProgress: 1, settled: 1 });
    const settled = await hold(f.holdId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(settled.evidence).toMatchObject({ automaticRecovery: { replay: "allowed" },
      bootstrapPreparationContinuation: "pending", bootstrapPreparationSettledAt: expect.any(String) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.resultJson)
      .toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.runId, f.runId),
      eq(activityLog.action, "issue.recovery_action_resolved")));
    expect(audit?.details).toMatchObject({ reason: "native_bootstrap_stopped_before_provider", ownerProof: "pid_dead" });
  });

  it.each([
    ["provider work may have started", async () => {
      const f = await interruptedPreparation();
      await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "turn.started",
        stream: "system", level: "info", message: "turn started" });
      return f;
    }],
    ["its controller stamp is from another process space", async () =>
      interruptedPreparation({ controller: await deadController({ hostHash: "other-container" }) })],
    ["it has no controller stamp", async () =>
      interruptedPreparation({ controller: { bootId: randomUUID(), process: null } })],
    ["its controller is this process", async () => interruptedPreparation({ controller: { bootId: legacyControllerBootId,
      process: { bootId: legacyControllerBootId, pid: process.pid, hostHash: currentProcessSpaceHash(), processStartedAt: null } } })],
    ["its sandbox lease is still cleaning up", async () => interruptedPreparation({ leaseReleased: false })],
    ["an operator confirmed the owner gone on the hold", async () =>
      interruptedPreparation({ holdEvidence: { ownerGoneAttestation: { actorId: "board-user" } } })],
    ["the user already continued", async () =>
      interruptedPreparation({ holdEvidence: { explicitUserContinuation: { actorId: "board-user" } } })],
  ] as const)("keeps the hold when %s", async (_label, arrange) => {
    const f = await arrange();
    const before = await hold(f.holdId);
    expect((await pass())?.settled ?? 0).toBe(0);
    expect(await hold(f.holdId)).toEqual(before);
  });

  it("settles exactly once when two processes judge the same hold", async () => {
    const f = await interruptedPreparation();
    const record = { recordId: f.runId, companyId, runId: f.runId, issueId: f.issueId, owner: { kind: "none" as const },
      updatedAt: null };
    const context = { now: new Date(), proof: { verdict: "gone" as const, reason: "pid_dead" as const } };
    const outcomes = await Promise.all([settleHeldInterruptedPreparation(db, record, context),
      settleHeldInterruptedPreparation(db, record, context)]);
    expect(outcomes.filter(outcome => outcome.settled)).toHaveLength(1);
    const resolutions = await db.select().from(activityLog).where(and(eq(activityLog.runId, f.runId),
      eq(activityLog.action, "issue.recovery_action_resolved")));
    expect(resolutions).toHaveLength(1);
  });
});

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { isInterruptedNativePreparation } from "./cancelled-native-startup.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

describe("automatic recovery after a drained legacy controller", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("dead-controller-");
    db = createDb(postgres.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });

  function exitedPid(): number {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    return Number(child.stdout);
  }

  async function seedDrainedRun(controller: "exited" | "current", ending: "drained" | "killed" = "drained") {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const live = currentControllerProcessStamp();
    const bootId = controller === "current" ? legacyControllerBootId : randomUUID();
    const controllerProcess = controller === "current" ? live
      : { bootId, pid: exitedPid(), hostHash: live.hostHash, processStartedAt: new Date(Date.now() - 120_000).toISOString() };
    await db.insert(companies).values({ id: companyId, name: "Drain company", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Follow up", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: ending === "drained" ? "interrupted" : "failed",
      errorCode: ending === "drained" ? "server_shutdown_interrupted" : "process_lost", runtimeMode: "legacy", executionStage: "preparing",
      contextSnapshot: { issueId }, finishedAt: new Date(), runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } }, controllerBootId: bootId, controllerProcess,
      controllerLeaseExpiresAt: new Date(Date.now() + 55_000),
      resultJson: { stopReason: "interrupted", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${runId}`, nextAction: "Reconcile the interrupted execution.",
      evidence: { runId, originalFailureCode: "server_shutdown_interrupted" } }).returning();
    return { actionId: action!.id, runId };
  }

  it("settles the hold at once when the drained controller process is proven gone", async () => {
    const { actionId, runId } = await seedDrainedRun("exited");
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await isInterruptedNativePreparation(db, before!)).toBe(true);
    await settleUnrecoverableExecutions(db);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect(action!.evidence.automaticRecovery).toMatchObject({ policy: "preserve_without_replay_v1", replay: "blocked" });
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(after!.controllerLeaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await isInterruptedNativePreparation(db, after!)).toBe(true);
  });

  it("still waits for a live controller lease held by this process", async () => {
    const { actionId, runId } = await seedDrainedRun("current");
    await settleUnrecoverableExecutions(db);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "active", resolvedAt: null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it.each(["exited", "current"] as const)("treats a killed preparation with a %s controller's live lease as interrupted only when that controller is gone", async controller => {
    const { runId } = await seedDrainedRun(controller, "killed");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await isInterruptedNativePreparation(db, run!)).toBe(controller === "exited");
  });
});

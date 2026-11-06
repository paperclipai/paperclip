import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { fenceStoppedQuotaBootstrapRunner } from "./native-quota-bootstrap-stop.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

const suite = process.platform === "win32" ? describe.skip : describe;
suite("quota bootstrap local runner stop fence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-quota-stop-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Quota stop", issuePrefix: "NQS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
  }, 90000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function seed(cancelled = false) {
    const issueId = randomUUID(), runId = randomUUID();
    const child = spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit");
    const startedAt = new Date();
    const selection = { poolId: randomUUID(), memberId: randomUUID() };
    const capability = { schema: "paperclip.native-quota-failover.v1", companyId, agentId, runId, issueId,
      poolId: selection.poolId, taskKey: issueId, memberId: selection.memberId };
    await db.insert(issues).values({ id: issueId, companyId, title: "Quota", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, scopeKind: "issue",
      runtimeMode: "native", status: "failed", finishedAt: new Date(), processPid: pid, processGroupId: pid, processStartedAt: startedAt,
      resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup", category: "quota_exhausted", message: "limit", retryability: "requires_action" }, ...(cancelled ? { startupCancellation: { requestedAt: new Date().toISOString() } } : {}) },
      contextSnapshot: { aiRouterTaskKey: issueId, aiRouterSelection: selection },
      runnerProfileJson: { nativeExecutionInput: { schema: "paperclip.native-execution-input.v11", binding: { companyId, agentId, runId, issueId }, provider: { kind: "acpx" }, builtinQuotaPoolCapability: capability } }, nextEventSeq: 2 });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "retryable_failure", failureDetail: { recoveryMode: "bootstrap_retry", providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "native.process_identity_recorded", payload: { targetKind: "local", hostname: os.hostname(), processPid: pid, processGroupId: pid, processStartedAt: startedAt.toISOString() } });
    return { companyId, issueId, runId };
  }
  it("records only runner stop and prevents same-run claim after the fence", async () => {
    const input = await seed();
    expect(await fenceStoppedQuotaBootstrapRunner(db, input)).toBe(true);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
    expect(run).toMatchObject({ processPid: null, processGroupId: null, status: "failed" });
    expect(coordinator?.failureDetail?.bootstrapRunnerStop).toMatchObject({ schema: "paperclip.native-quota-bootstrap-runner-stop.v1", runId: input.runId });
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "race-test", runIds: [input.runId], deferIneligible: false })).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.eventType, "native.local_process_stopped")))).toHaveLength(1);
    expect(await fenceStoppedQuotaBootstrapRunner(db, input)).toBe(false);
  });
  it("does not fence a run after Stop was requested", async () => {
    const input = await seed(true);
    expect(await fenceStoppedQuotaBootstrapRunner(db, input)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(run?.processPid).not.toBeNull();
  });
  it("rolls back the receipt, fence and process release together", async () => {
    const input = await seed();
    await expect(fenceStoppedQuotaBootstrapRunner(db, input, { failpoint: () => { throw new Error("injected rollback"); } })).rejects.toThrow("injected rollback");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
    expect(run?.processPid).not.toBeNull();
    expect(coordinator?.failureDetail?.bootstrapRunnerStop).toBeUndefined();
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.eventType, "native.local_process_stopped")))).toHaveLength(0);
  });
});

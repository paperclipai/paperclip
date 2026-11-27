import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { fenceStoppedQuotaBootstrapRunner } from "./native-quota-bootstrap-stop.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

import { lockNativeQuotaBootstrapEvidence } from "./native-quota-bootstrap-evidence.js";

describe("native quota bootstrap", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  const selection: AiConnectionRouterSelection = {
    poolId: randomUUID(), memberId: randomUUID(),
    binding: { mode: "delegated", provider: "openai", method: "api_key", connectionId: randomUUID(), grantId: randomUUID() },
    runtimeConfig: { provider: "codex", model: "gpt-5" }, notes: [],
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-quota-bootstrap-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Quota evidence", issuePrefix: "NQB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
  }, 90000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(changes: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Quota", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", status: "failed", finishedAt: new Date(), errorCode: "provider_quota",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { aiRouterTaskKey: issueId, aiRouterSelection: selection }, ...changes });
    return { companyId, agentId, issueId, runId, expectedSelection: selection };
  }
  it("accepts only an exactly bound failed quota run with a pre-provider receipt", async () => {
    const input = await fixture();
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toMatchObject({ runId: input.runId });
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, { ...input, expectedSelection: { ...selection, memberId: randomUUID() } }))).resolves.toBeNull();
  });
  it.each([
    { resultJson: {} },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, startupCancellation: {} } },
    { errorCode: "provider_transport_failed" },
    { nativeSessionId: randomUUID() },
    { status: "cancelled" },
  ])("rejects unproven or stopped work: %j", async changes => {
    const input = await fixture(changes);
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toBeNull();
  });
  it("rejects an already-created successor", async () => {
    const input = await fixture();
    await db.insert(heartbeatRuns).values({ companyId, agentId, retryOfRunId: input.runId });
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toBeNull();
  });

  describe.skipIf(process.platform === "win32")("local runner stop fence", () => {
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
});

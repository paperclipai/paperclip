import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

describeEmbeddedPostgres("checkpoint writer business-authority handover", () => {
  const environment = nativeRestartFixture();
  it("refreshes the source writer under the validated successor and refuses stale authority", async () => {
    const { db, runId, issueId, native } = await environment.seedRun("WRITER-HANDOVER");
    const { companyId, agentId, successor, runtimeRoot } = environment.current;
    const leaseOwner = randomUUID();
    await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, runId), identity: {
      runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const register = (authorityRunId: string) => registerNativeRunnerCheckpoint({ db, authority: core,
      bootId: successor.bootId, binding: { companyId, issueId, runId }, authorityRunId });
    try {
      await register(runId);
      core.queueCommand("turn.start", { prompt: "first work" }); await core.flushCheckpoint();
      await register(runId);
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
        completionContractId: contract!.id, serverFingerprint: "writer-fixture", schemaStatus: "accepted", resultJson: { summary: "Completed" },
        canonicalSha256: "writer-fixture" }).returning();
      await db.update(nativeRunFinalizations).set({ resultId: result!.id, phase: "committed", leaseOwner: null,
        leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      core.issueBootstrapTicket();
      await expect(core.flushCheckpoint()).resolves.toBeUndefined(); // Same-fence registration kept its existing-work history.
      const runB = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
      await db.insert(nativeRunFinalizations).values({ runId: runB, companyId, issueId, phase: "observed", controllerBootId: successor.bootId,
        controllerGeneration: 2, leaseOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
      await db.update(issues).set({ executionRunId: runB }).where(eq(issues.id, issueId));
      await register(runB);
      core.queueCommand("turn.start", { prompt: "successor work" });
      await expect(core.flushCheckpoint()).resolves.toBeUndefined();
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 3, leaseOwner: randomUUID() })
        .where(eq(nativeRunFinalizations.runId, runB));
      core.queueCommand("turn.start", { prompt: "old generation must not write" });
      await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
      await expect(register(runB)).resolves.toBeUndefined();
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, runB));
      await expect(register(runB)).rejects.toThrow("native_runner_checkpoint_owner_lost");
      core.queueCommand("turn.start", { prompt: "expired owner must not write" });
      await expect(core.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    } finally { await core.stop(); }
  });
});

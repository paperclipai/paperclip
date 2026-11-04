import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, completionContracts, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, nativeRunResults } from "@paperclipai/db";
import { DurablePrpControlPlane, parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { admitUnclaimedNativeBootstrapRetry } from "./native-bootstrap-retry.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { loadNativeRunnerCheckpoint, nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describeEmbeddedPostgres("unclaimed native bootstrap retry admission", () => {
  const environment = nativeRestartFixture();
  it.each([
    "current proof", "stale claim", "expired claim", "Stop", "paused agent", "changed model", "changed trust",
    "changed account", "provider progress", "issued and pruned credential", "adopted authority", "legacy state",
    "truncated checkpoint", "local fingerprint mismatch", "hidden delivery", "unknown command", "foreign company",
  ])("admits only a current complete proof: %s", async scenario => {
    const { db, runId, issueId, native } = await environment.seedRun(`ADMISSION-${scenario}`);
    const { companyId, agentId, runtimeRoot } = environment.current;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
      runtimeContext: nativeRuntimeContextFixture(),
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "fixture-model", approvalPolicy: "never" },
      task: { identifier: "fixture", title: issue!.title, description: null, prompt: "Controlled admission fixture.", workMode: "standard" },
      workspace: { cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) }, interactionResponses: [], credentialBindings: [],
    });
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    const leaseOwner = `fixture:${randomUUID()}`, bootId = randomUUID();
    await db.update(nativeRunFinalizations).set({ leaseOwner, controllerBootId: bootId, controllerGeneration: 7,
      leaseExpiresAt: new Date(Date.now() + 60_000), attempt: 1 }).where(eq(nativeRunFinalizations.runId, runId));
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: runId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const root = join(runtimeRoot, runId, "control-plane");
    const core = new DurablePrpControlPlane({ stateDirectory: root, identity, expectedRunnerVersion: "0.3.0",
      expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const template = { provider: { provider: "codex", command: "fixture" }, authorizedTools: {} };
    core.persistRunAttachTemplate(template);
    core.queueCommand("run.prepare", template);
    core.queueCommand("session.open", { reuse: "same_session" });
    try {
      if (scenario === "issued and pruned credential") { core.issueBootstrapTicket(); core.store.state.tickets = {}; }
      if (scenario === "adopted authority") core.store.state.bootstrapHistory!.adopted = true;
      if (scenario === "legacy state") {
        core.store.state.schema = "paperclip.runner.durable.control-plane-state.v1";
        delete core.store.state.bootstrapHistory;
      }
      if (scenario === "hidden delivery") core.store.state.commandDeliveryCounts = { removedCommand: 1 };
      if (scenario === "unknown command") core.queueCommand("turn.start", { prompt: "Prior work must stay held." });
      core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, {
        companyId, issueId, runId, authorityRunId: runId, bootId, leaseOwner, generation: 7,
      }));
      await core.flushCheckpoint();
      const projection = join(runtimeRoot, runId, "projection");
      const checkpoint = await loadNativeRunnerCheckpoint(db, execution.binding);
      expect(checkpoint).not.toBeNull();
      checkpoint!.restoreSessionDirectory(projection);
      let localStateContents = await readFile(join(projection, "control-plane", "control-plane-state.json"), "utf8");
      const original = JSON.parse(localStateContents);
      if (scenario === "local fingerprint mismatch") {
        original.commands[1].payload = { reuse: "same_session", changed: true };
        localStateContents = JSON.stringify(original);
      }
      if (scenario === "truncated checkpoint") await db.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.runId, runId), eq(nativeRunnerCheckpoints.part, "command:2")));
      if (scenario === "provider progress") await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 900,
        eventType: "turn.started", stream: "system", level: "info", message: "Prior provider progress", payload: {} });
      if (scenario === "stale claim") await db.update(nativeRunFinalizations).set({ leaseOwner: "successor",
        controllerGeneration: 8 }).where(eq(nativeRunFinalizations.runId, runId));
      if (scenario === "expired claim") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, runId));
      if (scenario === "Stop") await db.update(heartbeatRuns).set({ resultJson: {
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId,
          scope: "run", dispatchState: "pending", intentAuditId: randomUUID() },
      } }).where(eq(heartbeatRuns.id, runId));
      if (scenario === "paused agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      const proposed = structuredClone(execution);
      if (scenario === "changed model") proposed.provider.model = "different-model";
      if (scenario === "changed trust" && proposed.provider.kind === "codex") proposed.provider.approvalPolicy = "on-request";
      if (scenario === "changed account") proposed.credentialBindings = [{ bindingId: "different-account", service: "openai",
        destination: "environment", expiresAt: null, displayName: null }];
      if (scenario === "foreign company") proposed.binding.companyId = randomUUID();
      const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [beforeClaim] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(await admitUnclaimedNativeBootstrapRetry({ db, execution: proposed, leaseOwner, localStateContents }))
        .toBe(scenario === "current proof");
      const [afterRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [afterClaim] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(afterRun).toEqual(beforeRun);
      expect(afterClaim).toEqual(beforeClaim);
      expect(afterRun.usageJson?.accountingProviderWorkStarted).not.toBe(false);
      expect(afterRun.costAccountedAt).toBeNull();
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual([]);
    } finally {
      await core.stop();
      if (scenario === "paused agent") await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    }
  });
});

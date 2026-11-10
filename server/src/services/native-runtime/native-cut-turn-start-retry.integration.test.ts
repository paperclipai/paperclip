import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { completionContracts, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { expect, vi } from "vitest";
import { NativeSessionCloseUnrecoverableError, executeNativeSession, parseNativeExecutionInput, nativeSessionCleanupBlock, createNativeSessionBackend, createRunnerdCodexTransport, canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { describeEmbeddedPostgres, nativeRestartFixture, processAlive, realProcessIt, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { executePaperclipNativeSession, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativeRunNeverLaunched, PRIOR_OWNER_FENCE_REFUSED, recordNativeLocalProcessStop } from "../native-local-process-stop.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";

/**
 * w-20261110T033426-s108/t03, the branch the runner cannot settle by itself:
 * a restart kills the runner and Codex while `turn/start` is in flight, after
 * Codex already recorded the turn. That turn may have done work, so the
 * runner keeps failing closed and nothing replays it. The task must still
 * continue through a person's Retry:
 * - a follow-up on the same conversation is refused at the runner-state fence
 *   before it asks for a runner, and that refusal leaves structured proof that
 *   it never had a process (so Retry after it is admitted, never a 202 with no
 *   run);
 * - the Retry run starts a fresh provider conversation (task Retry always sets
 *   forceFreshSession) and completes with the real runner, without touching or
 *   tripping over the stuck conversation's saved or quarantined state.
 */
describeEmbeddedPostgres("Retry after a turn start cut off once Codex recorded the turn", () => {
  const environment = nativeRestartFixture();

  realProcessIt("keeps the cut-off turn closed and completes a fresh Retry run", async () => {
    const fixture = await environment.seedRun("CUT-TURN-START");
    const { db, issueId } = fixture;
    const { companyId, agentId, runtimeRoot } = environment.current;
    const stateBase = join(runtimeRoot, `cut-turn-start-state-${fixture.runId}`);
    const sandbox = join(runtimeRoot, `cut-turn-start-workspace-${fixture.runId}`);
    const codexHome = join(runtimeRoot, `cut-turn-start-codex-home-${fixture.runId}`);
    await mkdir(sandbox, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Complete only the controlled fixture task.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const executionFor = (runId: string, normalizedSessionId: string) => buildNativeExecutionInput({
      companyId, agentId, runId, provider: "codex",
      issue: { id: issueId, identifier: "NRR-CUT", title: issue!.title, description: null, workMode: "standard" },
      taskPrompt: "Write the brief once.",
      workspace: { id: runId, cwd: sandbox, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId, runtimeContext, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) },
    });
    const resultFile = join(sandbox, "fixture-result.json");
    const hangFile = join(sandbox, "hang-turn-start");
    const calls = join(sandbox, "provider-calls.log");
    const execution = executionFor(fixture.runId, fixture.native.normalizedSessionId);
    await writeFile(resultFile, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "Controlled Retry completed.", completionClaim: { contractRevision: execution.completionContract.contract.revision,
        objectiveSatisfied: true, criteria: execution.completionContract.contract.criteria.map(criterion => ({
          criterionId: criterion.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.preparedProfile, nativeExecutionInput: execution } })
      .where(eq(heartbeatRuns.id, fixture.runId));

    const bundles: ReturnType<typeof createRunnerdCodexTransport>[] = [];
    const run = (runExecution: typeof execution, runnerInstanceId: string, environmentLeaseId: string) => {
      const root = scopedRunnerdStateRoot(runExecution);
      const identity = { runnerInstanceId, environmentLeaseId, runId: runExecution.binding.runId,
        normalizedSessionId: runExecution.session.normalizedSessionId!,
        turnId: `turn-${runExecution.binding.runId}`, itemId: `item-${runExecution.binding.runId}` };
      const backend = createNativeSessionBackend(runExecution, { runnerInstanceId,
        environment: { CODEX_HOME: codexHome, PATH: process.env.PATH },
        codexTransportFactory: () => {
          const options = environment.transportOptions(fixture, root);
          const bundle = createRunnerdCodexTransport({ ...options,
            codexArgs: ["--state-file", join(sandbox, "provider.json"), "--terminal-result-file", resultFile,
              "--call-log", calls, "--durable-turn-ids", "--hang-turn-start", hangFile],
            runtimeContext, runnerRuntimeContext: runtimeContext, sourceCodexHome: codexHome,
            environment: { CODEX_HOME: codexHome, PATH: process.env.PATH }, closeGraceMs: 1_000, turnStartTimeoutMs: 20_000,
            prpIdentity: identity, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
          bundles.push(bundle);
          return bundle.transport;
        } });
      return { root, outcome: executePaperclipNativeSession({ db, execution: runExecution, backend, useRunnerd: true,
        runnerInstanceId, turnTimeoutMs: 15_000 }) };
    };
    const kill = (pid: number | null) => {
      if (!pid) return;
      try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    try {
      // 1. The owner's turn start is in flight when the restart kills its
      //    runner and Codex, after Codex recorded the turn.
      await writeFile(hangFile, "after");
      const owner = run(execution, fixture.native.runnerInstanceId, fixture.native.environmentLeaseId);
      const ownerOutcome = owner.outcome.catch((error: unknown) => error);
      await waitForCondition("Codex to record the owner's turn", async () => existsSync(join(sandbox, "provider.json")) &&
        JSON.parse(await readFile(join(sandbox, "provider.json"), "utf8")).activeTurnId === "provider-turn-1", 20_000);
      const killed = bundles[0]!.evidence();
      kill(killed.providerPid);
      kill(killed.runnerPid);
      await waitForCondition("the owner's runner and Codex to exit", () =>
        !processAlive(killed.runnerPid) && !processAlive(killed.providerPid));
      await rm(hangFile, { force: true });
      expect(await ownerOutcome).toBeInstanceOf(Error);
      const providerState = JSON.parse(await readFile(join(owner.root, "runner", "codex-provider-state.json"), "utf8"));
      expect(providerState.ambiguousTurnStartPending).toBe(true);
      // Codex's process-loss history: the thread keeps the turn, not its run.
      const fake = JSON.parse(await readFile(join(sandbox, "provider.json"), "utf8"));
      await writeFile(join(sandbox, "provider.json"), JSON.stringify({ ...fake, activeTurnId: null }));
      expect((await readFile(join(sandbox, "provider.json.turns"), "utf8")).trim()).toBe("provider-turn-1");
      // The same-run resume restores the owner's runner and fails closed: the
      // recorded turn may have done work, and it is never started again.
      const resumedOwner = createRunnerdCodexTransport({ ...environment.transportOptions(fixture, owner.root),
        codexArgs: ["--state-file", join(sandbox, "provider.json"), "--call-log", calls, "--durable-turn-ids"],
        runtimeContext, runnerRuntimeContext: runtimeContext, sourceCodexHome: codexHome, resumeDynamicTools: [],
        environment: { CODEX_HOME: codexHome, PATH: process.env.PATH }, closeGraceMs: 1_000,
        prpIdentity: { runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
          runId: fixture.runId, normalizedSessionId: fixture.native.normalizedSessionId,
          turnId: `turn-${fixture.runId}`, itemId: `item-${fixture.runId}` },
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
      bundles.push(resumedOwner);
      await expect(resumedOwner.transport.request("thread/read", {}))
        .rejects.toThrow(/cannot safely recover an ambiguous Codex turn start/);
      await resumedOwner.transport.close().catch(() => undefined);
      // What restart recovery records for the owner: its runner identity, then
      // the verified stop of that exact process.
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_session_interrupted", finishedAt: new Date(),
        processPid: killed.runnerPid, processGroupId: killed.runnerProcessGroupId }).where(eq(heartbeatRuns.id, fixture.runId));
      const [stoppedOwner] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as never, stoppedOwner!))).toBe(true);
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: null, recoveryState: null, failureCode: "native_continuation_requires_reconciliation" })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      // The owner's in-process session close cannot prove suspension once its
      // runner died, so this process can keep an operator-required cleanup
      // quarantine for the task. Whether the real close lands there is
      // timing-dependent; pin that state so Retry is checked against it.
      if (nativeSessionCleanupBlock({ companyId, issueId }) !== "operator_required") {
        const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
        const identity = { runId: fixture.runId, sessionId: fixture.native.normalizedSessionId, companyId, issueId, agentId };
        await expect(executeNativeSession({ input: parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1",
          provider: { kind: "codex", model: null }, binding: execution.binding,
          task: { identifier: "NRR-CUT", title: issue!.title, description: null, prompt: "Write the brief once.", workMode: "standard" },
          workspace: { cwd: sandbox, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: fixture.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
            lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: execution.completionContract, interactionResponses: [], credentialBindings: [] }),
          backend: { descriptor: async () => ({ kind: "runner", name: "cut-turn-start-owner", version: "1", capabilities }),
            openSession: async () => ({ identity: () => identity, capabilities: async () => capabilities,
              async *events() { throw new Error("owner runner exited"); },
              startTurn: async () => ({ turnId: "owner-turn" }), result: async () => null,
              snapshot: async () => ({ backendKind: "runner", sessionId: fixture.native.normalizedSessionId, identity,
                providerSessionId: "owner-thread", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
              close: async () => { throw new NativeSessionCloseUnrecoverableError(); } }) },
          controlPlane: { openRun: async () => {}, checkpointSession: async () => {},
            appendEvent: async () => ({ cursor: 0, highestContiguousSourceSeq: 0, disposition: "committed" }),
            replayEvents: async () => ({ events: [], highestContiguousSourceSeq: 0 }), completeRun: async () => {} },
          runnerInstanceId: fixture.native.runnerInstanceId, controlPlaneInstanceId: "cut-turn-start-owner" })).rejects.toThrow("owner runner exited");
      }
      expect(nativeSessionCleanupBlock({ companyId, issueId })).toBe("operator_required");
      const startsBeforeRetry = (await readFile(calls, "utf8")).match(/^turn\/start$/gm)?.length ?? 0;
      expect(startsBeforeRetry).toBe(1);

      // 2. A follow-up that continues the same conversation is refused before
      //    it asks for a runner, and records structured proof of that.
      const followUpId = randomUUID();
      const followUp = await admitRun(followUpId, fixture.native.normalizedSessionId);
      const followUpExecution = executionFor(followUpId, fixture.native.normalizedSessionId);
      const refused = await run(followUpExecution, followUp.runnerInstanceId, followUp.environmentLeaseId).outcome
        .then(() => null, (error: unknown) => error);
      expect(String(refused)).toContain("runner_state_identity_mismatch: prior_owner_");
      expect(String(refused)).not.toContain("quarantine_owner_unverified");
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", error: String(refused), finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, followUpId));
      // What run failure handling records for it: a settled coordinator and
      // the "Automatic recovery stopped" action that offers Retry.
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure",
        failureCode: "native_continuation_requires_reconciliation" }).where(eq(nativeRunFinalizations.runId, followUpId));
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "native_continuation_requires_reconciliation", fingerprint: followUpId, status: "resolved", outcome: "blocked",
        nextAction: "Automatic recovery stopped.", evidence: { runId: followUpId, automaticRecovery: { replay: "blocked" } } });
      const [refusedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, followUpId));
      expect(await db.select({ type: heartbeatRunEvents.eventType }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, followUpId), eq(heartbeatRunEvents.eventType, PRIOR_OWNER_FENCE_REFUSED)))).toHaveLength(1);
      expect(await nativeRunNeverLaunched(db, refusedRun!)).toBe(true);
      // Owner launch and its resume only: the refused follow-up launched nothing.
      expect(bundles).toHaveLength(2);

      // 3. The person's Retry starts a fresh conversation and completes once.
      // The latest run is the refused follow-up, so the person retries it.
      // Admission must not wait for a stop record of a process it never had.
      const retryId = randomUUID();
      const blocked: string[] = [];
      const admitted = await admitExplicitNativeContinuation({ db, companyId, issueId, agentId, actorType: "user",
        actorId: "local-board", reason: "retry_failed_run", failedRunId: followUpId, commentId: null,
        successorRunId: retryId, onBlocked: reason => blocked.push(reason) });
      expect(blocked).toEqual([]);
      expect(admitted).toMatchObject({ previousRunId: followUpId });
      // Admission proved the owner's runner, Codex and tools stopped and
      // released the task's cleanup quarantine; nothing old is resumed.
      expect(nativeSessionCleanupBlock({ companyId, issueId })).toBeNull();
      expect(await db.select({ type: heartbeatRunEvents.eventType }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, followUpId), eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified"))))
        .toHaveLength(1);
      const retry = await admitRun(retryId, null, followUpId);
      expect(retry.normalizedSessionId).not.toBe(fixture.native.normalizedSessionId);
      const retryExecution = executionFor(retryId, retry.normalizedSessionId);
      const retried = run(retryExecution, retry.runnerInstanceId, retry.environmentLeaseId);
      expect(retried.root).not.toBe(owner.root);
      await expect(retried.outcome).resolves.toMatchObject({ exitCode: 0, timedOut: false });
      const providerCalls = await readFile(calls, "utf8");
      // The fresh conversation opened its own thread; the cut-off turn was
      // never started again.
      expect(providerCalls.match(/^turn\/start$/gm)).toHaveLength(2);
      expect(providerCalls.match(/^thread\/start$/gm)).toHaveLength(2);
      const quarantine = join(stateBase, "quarantine");
      const quarantined = existsSync(quarantine) ? await readdir(quarantine) : [];
      expect(quarantined.every(name => !name.startsWith(retried.root.split("/").at(-1)!))).toBe(true);
    } finally {
      for (const bundle of bundles) {
        await bundle.transport.close().catch(() => undefined);
        const evidence = bundle.evidence();
        kill(evidence.providerPid);
        kill(evidence.runnerPid);
      }
      vi.unstubAllEnvs();
      await rm(stateBase, { recursive: true, force: true });
    }

    async function admitRun(runId: string, nativeSessionId: string | null, retryOf?: string) {
      const [row] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
        runtimeMode: "native", nativeIssueId: issueId, nativeSessionId, invocationSource: "on_demand", triggerDetail: "manual",
        runnerInstanceId: nativeSessionId ? fixture.native.runnerInstanceId : null,
        retryOfRunId: retryOf ?? null,
        contextSnapshot: { issueId, ...(retryOf ? { forceFreshSession: true, previousRunId: retryOf } : {}) } })
        .returning();
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const native = await prepareNativeHeartbeatRun({ db, run: row!,
        issue: { id: issueId, title: issue!.title, description: null, reviewPolicy: null },
        environmentLeaseId: `lease-${runId}` });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...(row!.runnerProfileJson ?? {}),
        nativeExecutionInput: executionFor(runId, native.normalizedSessionId) } }).where(eq(heartbeatRuns.id, runId));
      return native;
    }
  }, 120_000);
});

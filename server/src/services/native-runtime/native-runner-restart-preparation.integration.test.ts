import { startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal } from "./native-execution-lease.js";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, issueRecoveryActions, issues, completionContracts, nativeRunResults, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DurablePrpControlPlane, createNativeSessionBackend, createRunnerdCodexTransport, defaultCapabilityRunnerdBinary, canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { reconcileNativeFinalizations, claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { prepareNativeWorkspaceSync } from "./native-workspace-sync.js";
import { workspaceOperationService } from "../workspace-operations.js";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { remotePreparedWorkspace, nativeRestartFixture, describeEmbeddedPostgres } from "../../__tests__/helpers/native-restart.js";

describeEmbeddedPostgres("native runner restart recovery: preparation", () => {
  const environment = nativeRestartFixture();
  const { seedRun, transportOptions } = environment;
  let runtimeRoot: typeof environment.current.runtimeRoot;
  let companyId: typeof environment.current.companyId;
  let agentId: typeof environment.current.agentId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ runtimeRoot, companyId, agentId, successor } = environment.current); });

  it.each(["recover", "provider event", "cancelled task"] as const)("reconciles the drained remote backend with %s", async mode => {
    const fixture = await seedRun(`DRAINED-BACKEND-${mode.replaceAll(" ", "-")}`);
    const environmentId = randomUUID(), leaseId = randomUUID();
    await fixture.db.insert(environments).values({ id: environmentId, name: `Drained backend ${environmentId}`, driver: "sandbox" });
    const [lease] = await fixture.db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId,
      heartbeatRunId: fixture.runId, issueId: fixture.issueId, status: "active",
      provider: "fixture", providerLeaseId: `drained-backend-${leaseId}` }).returning();
    const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const [contract] = await fixture.db.select().from(completionContracts).where(eq(completionContracts.issueId, fixture.issueId));
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Complete the controlled restart fixture task.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const sandbox = join(runtimeRoot, `workspace-${fixture.runId}`);
    await mkdir(sandbox, { recursive: true });
    const savedFile = join(sandbox, "saved-before-drain.txt");
    await writeFile(savedFile, "Preserve admitted work.\n");
    const execution = buildNativeExecutionInput({ companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: "NRR-DRAINED", title: "Continue after drain", description: null, workMode: "standard" },
      taskPrompt: "Continue the admitted work once.", provider: "codex",
      workspace: { id: fixture.runId, cwd: sandbox, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId, runtimeContext,
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
    });
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...fixture.preparedProfile, nativeExecutionInput: execution,
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    const remoteSandbox = join(runtimeRoot, `remote-${fixture.runId}`);
    const shell: CommandManagedRuntimeRunner = { execute: async input => {
      const child = spawn(input.command, input.args ?? [], { cwd: input.cwd,
        env: { ...process.env, ...input.env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin);
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs ?? 30_000);
      try { return await new Promise((resolveResult, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolveResult({ stdout, stderr, exitCode, signal, timedOut }));
      }); } finally { clearTimeout(timeout); }
    } };
    const workspaceSync = await prepareNativeWorkspaceSync({ db: fixture.db, runId: fixture.runId, companyId,
      workspaceId: fixture.runId, workspaceLocalDir: sandbox, lease: lease as unknown as EnvironmentLease,
      target: { kind: "remote", transport: "sandbox", environmentId, leaseId, remoteCwd: remoteSandbox, runner: shell } });
    expect(workspaceSync).not.toBeNull();
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
      resolve(import.meta.dirname, "../../__tests__/helpers/native-drain-controller.test-worker.ts")],
      { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
    const logs: string[] = [];
    child.stdout?.on("data", data => logs.push(String(data)));
    child.stderr?.on("data", data => logs.push(String(data)));
    const exited = new Promise<number | null>(resolveExit => child.once("exit", resolveExit));
    try {
      const result = await new Promise<{ commands: number; errorName: string; errorMessage: string }>((resolveResult, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Controller handoff timed out: ${logs.join("").slice(-2000)}`)), 60_000);
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("exit", code => { clearTimeout(deadline); reject(new Error(`Controller exited before handoff (${code}): ${logs.join("").slice(-2000)}`)); });
        child.on("message", (message: { ready?: boolean; done?: boolean; commands: number; errorName: string; errorMessage: string; error?: string }) => {
          if (message.ready) child.send({ connectionString: environment.current.temporary.connectionString, providerEvidence: mode === "provider event",
            options: { execution, runnerInstanceId: fixture.native.runnerInstanceId, useRunnerd: true,
              runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId, leaseId, remoteCwd: remoteSandbox } } });
          if (message.done) { clearTimeout(deadline); resolveResult(message); }
          if (message.error) { clearTimeout(deadline); reject(new Error(message.error)); }
        });
      });
      expect(result).toMatchObject({ commands: 0, errorMessage: "local_runtime_api_listener_unavailable" });
      expect(await exited).toBe(0);
      const [handoff] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (mode === "provider event") {
        expect(handoff).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null,
          failureDetail: { recoveryMode: "ambiguous_state", providerSessionEstablished: true } });
        expect(await claimNativeSessionResumptions({ db: fixture.db, runnerInstanceId: "no-provider-replay",
          runIds: [fixture.runId], deferIneligible: false })).toHaveLength(0);
        return;
      }
      expect(handoff).toMatchObject({ phase: "retryable_failure", attempt: 1,
        failureDetail: { originalFailureCode: "local_runtime_api_listener_unavailable", recoveryMode: "bootstrap_retry",
          providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false } });
      if (mode === "cancelled task") {
        await fixture.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, fixture.issueId));
      }
      const claims = (await Promise.all(["successor-a", "successor-b"].map(runnerInstanceId =>
        claimNativeSessionResumptions({ db: fixture.db, runnerInstanceId, runIds: [fixture.runId],
          now: new Date(handoff.nextAttemptAt!.getTime() + 1), deferIneligible: false }),
      ))).flat();
      if (mode === "cancelled task") { expect(claims).toHaveLength(0); return; }
      expect(claims).toHaveLength(1);
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run).toMatchObject({ status: "running", nativeSessionId: fixture.native.normalizedSessionId });
      const [action] = await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
      expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: agentId });
      // The focused restart regression needs no Rust artifacts. This opt-in
      // acceptance also runs the real Runner and controlled Codex provider.
      if (process.env.PAPERCLIP_TEST_DRAIN_CONTINUATION === "1") {
        const claim = claims[0];
        const root = join(runtimeRoot, `continued-${fixture.runId}`);
        const home = join(root, "codex-home");
        await mkdir(home, { recursive: true });
        const report = join(root, "result.json");
        const calls = join(root, "calls.log");
        await writeFile(report, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
          summary: "Admitted work completed after controller restart.", completionClaim: {
            contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
            criteria: execution.completionContract.contract.criteria.map(criterion => ({ criterionId: criterion.id,
              status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
          evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
        const bundle = createRunnerdCodexTransport({ ...transportOptions(fixture, root),
          runnerBinary: defaultCapabilityRunnerdBinary(),
          codexArgs: ["--state-file", join(root, "provider.json"), "--terminal-result-file", report,
            "--call-log", calls, "--record-process-start"],
          runtimeContext: execution.runtimeContext, runnerRuntimeContext: execution.runtimeContext,
          sourceCodexHome: home, environment: { CODEX_HOME: home, PATH: process.env.PATH },
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        });
        const backend = createNativeSessionBackend(execution, { runnerInstanceId: fixture.native.runnerInstanceId,
          environment: { CODEX_HOME: home, PATH: process.env.PATH }, codexTransportFactory: () => bundle.transport });
        try {
          expect(await executePaperclipNativeSession({ db: fixture.db, execution, backend, useRunnerd: true,
            runnerInstanceId: fixture.native.runnerInstanceId, leaseOwner: claim.leaseOwner,
            runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId, leaseId, remoteCwd: remoteSandbox,
              runner: { execute: async () => { throw new Error("Unexpected remote preparation after the controlled backend owns execution"); } } as never },
            turnTimeoutMs: 15_000 })).toMatchObject({ exitCode: 0, timedOut: false });
          const recorder = workspaceOperationService(fixture.db).createRecorder({ companyId,
            issueId: fixture.issueId, heartbeatRunId: fixture.runId });
          const saved = await recorder.recordOperation({ phase: "workspace_finalize", cwd: sandbox,
            run: async () => { await workspaceSync!.restoreWorkspace(); return { status: "succeeded", exitCode: 0 }; } });
          expect(saved.status).toBe("succeeded");
          await reconcileNativeFinalizations(fixture.db, [fixture.runId]);
          expect(await fixture.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId)))
            .toMatchObject([{ schemaStatus: "accepted" }]);
          const [finished] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
          expect(finished, JSON.stringify(finished.failureDetail)).toMatchObject({ phase: "committed", attempt: 2 });
          expect(await readFile(savedFile, "utf8")).toBe("Preserve admitted work.\n");
          expect((await readFile(calls, "utf8")).split("\n").filter(line => line === "process-start")).toHaveLength(1);
        } finally { await bundle.transport.close(); }
      }
    } finally { child.kill("SIGKILL"); await exited; await workspaceSync?.cleanup(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["preparation", "claim lock"])("gives a fresh remote claim its full lease through blocked %s", async (blockedPhase) => {
    const fixture = await seedRun(`FRESH-SLOW-${blockedPhase === "claim lock" ? "CLAIM-LOCK" : "PREPARATION"}`);
    const environmentId = randomUUID(), leaseId = randomUUID();
    await fixture.db.insert(environments).values({ id: environmentId, name: `Fresh preparation fixture ${environmentId}`, driver: "sandbox" });
    await fixture.db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId,
      heartbeatRunId: fixture.runId, issueId: fixture.issueId, status: "active",
      provider: "fixture", providerLeaseId: `fresh-preparation-${leaseId}` });
    const execution = buildNativeExecutionInput({ companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: "NRR-FRESH-SLOW", title: "Prepare slowly", description: null, workMode: "standard" },
      taskPrompt: "Prepare a fresh execution.", provider: "codex",
      workspace: { id: fixture.runId, cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Prepare once", criteria: [{ id: "objective", requirement: "Retain ownership" }] } },
    });
    // Stop at the provider boundary after checking ownership; no harness is launched.
    const failure = new Error("end fresh preparation experiment");
    const backend = { descriptor: async () => { throw failure; }, openSession: async () => { throw failure; } };
    let reached!: () => void, release!: () => void;
    const claimed = new Promise<void>(resolveReady => { reached = resolveReady; });
    const preparation = new Promise<void>(resolveReady => { release = resolveReady; });
    let releaseLock: (() => void) | undefined;
    let holder: Promise<void> | undefined;
    let lockPid: number | undefined;
    let leaseStartsAfter: Date | undefined;
    if (blockedPhase === "claim lock") {
      let locked!: () => void;
      const lockTaken = new Promise<void>(resolve => { locked = resolve; });
      const lockReleased = new Promise<void>(resolve => { releaseLock = resolve; });
      holder = fixture.db.transaction(async tx => {
        const [connection] = await tx.execute(sql`select pg_backend_pid() as pid`);
        lockPid = Number(connection.pid);
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).for("update");
        locked(); await lockReleased;
      });
      await lockTaken;
    }
    const running = executePaperclipNativeSession({ db: fixture.db, execution,
      runnerInstanceId: fixture.native.runnerInstanceId, backend,
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId, leaseId, remoteCwd: runtimeRoot },
      onEvent: async event => {
        if (event.payload?.span === "native.coordinator.claim") { reached(); await preparation; }
      },
    }).catch(error => error);
    try {
      if (blockedPhase === "claim lock") {
        // Observe the real claim waiting on the run row after it has locked its
        // coordinator. The lease must start after this wait, not before it.
        await expect.poll(async () => {
          const [waiting] = await fixture.db.execute(sql`select exists (
            select 1 from pg_stat_activity where ${lockPid} = any(pg_blocking_pids(pid))
              and query like 'select %from "heartbeat_runs"%for update%'
          ) as blocked`);
          return waiting.blocked;
        }, { timeout: 10_000 }).toBe(true);
        await fixture.db.execute(sql`select pg_sleep(1)`);
        const [observed] = await fixture.db.execute(sql`select clock_timestamp() as observed_at`);
        leaseStartsAfter = new Date(String(observed.observed_at));
        releaseLock!(); await holder;
      }
      await Promise.race([claimed, running.then(error => { throw error; })]);
      const [initial] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (leaseStartsAfter) {
        expect(initial.leaseExpiresAt!.getTime() - leaseStartsAfter.getTime()).toBeGreaterThan(59_900);
        release();
        expect(await running).toBe(failure);
        return;
      }
      await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, initial.leaseExpiresAt!.getTime() - Date.now() + 2_000)));
      const [current] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(current.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(current.leaseOwner).toBe(initial.leaseOwner);
      expect(current.controllerGeneration).toBe(initial.controllerGeneration);
      expect(current.attempt).toBe(1);
      release();
      expect(await running).toBe(failure);
    } finally { releaseLock?.(); await holder; release(); await running; }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("renews a remote claim through slow preparation and shares renewal with execution", async () => {
    const fixture = await seedRun("SLOW-RECOVERY-PREPARATION");
    const root = resolve(runtimeRoot, fixture.runId);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace(),
      sessionCheckpoint: { identity: { ...binding, agentId, sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "surviving-provider" },
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: 1, leaseOwner: "previous-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: transportOptions(fixture, root).prpIdentity,
      expectedRunnerVersion: "lease-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
    await authority.stop();
    // Establish the abandoned predecessor before the fault; claimed leases are
    // never edited below. The successor must retain ownership for a real minute.
    await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const controller = { ...successor, bootId: randomUUID() };
    const onLost = vi.fn(async () => undefined);
    let preparation: NativeExecutionLeaseRenewal | undefined;
    let execution: NativeExecutionLeaseRenewal | undefined;
    let acquired = false;
    try {
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller,
        restartKind: "hard", runIds: [fixture.runId], onClaim: (claim, scope) => {
          expect(scope.remote).toBe(true);
          preparation = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...scope,
            runId: claim.runId, leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, onLost });
          acquired = true;
        } });
      expect(acquired).toBe(true);
      expect(claim.kind).toBe("reattach_remote_runner");
      if (!("leaseOwner" in claim)) throw new Error("Expected recovery claim");
      const [initial] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      await new Promise(resolveWait => setTimeout(resolveWait, 30_000));
      execution = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...binding,
        leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, controller, remote: true, onLost });
      await preparation!.stop();
      await preparation!.stop(); // A caller cannot release another caller's reference.
      const remaining = Math.max(0, initial.leaseExpiresAt!.getTime() - Date.now() + 2_000);
      await new Promise(resolveWait => setTimeout(resolveWait, remaining));
      const [current] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(current.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(current.controllerGeneration).toBe(claim.controllerGeneration);
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: { ...controller, bootId: randomUUID() },
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([
        expect.objectContaining({ kind: "awaiting_evidence", runId: fixture.runId }),
      ]);
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      await preparation?.stop();
      await execution?.stop();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

});

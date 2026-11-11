import { currentControllerProcess, currentProcessSpaceHash } from "../controller-process-identity.js";
import { renewNativeSessionExecutionLease, startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal } from "./native-execution-lease.js";
import { enableRunFailureReporting } from "../../__tests__/helpers/run-failure-reporting.js";
import { NativeControllerRecoveryWaitingError } from "./native-controller-recovery.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, QUALIFIED_ACPX_PROFILES } from "@paperclipai/paperclip-runner";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary, readRunnerdArtifactBinding, type CapabilityRunnerdCodexTransportOptions } from "@paperclipai/paperclip-runner/live";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  controllerInstances,
  companyMemberships,
  completionContracts,
  environmentLeases,
  environments,
  createDb,
  closeLivenessDb,
  checkpointDb,
  closeCheckpointDb,
  livenessDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  nativeRunnerCheckpoints,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { heartbeatService } from "../heartbeat.js";
import { executionRecoverySettlementNote } from "../execution-recovery-resolution.js";

import {
  canonicalNativeRuntimeContextDigest,
  createRunnerdCodexTransport,
  parseNativeExecutionInput,
  DurablePrpControlPlane,
  decodeDurablePrpCheckpoint,
} from "../../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { materializeAsset } from "./runtime-context.js";
import { createRunnerTestTlsTunnel, dockerCommandRunner } from "../../__tests__/helpers/docker-command-runner.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { waitForPendingRunFailureReports } from "../run-failure-report.js";
import {
  closeIdleWarmNativeSessionsForRestart,
  detachNativeSessionsForRestart,
  executePaperclipNativeSession,
  NativeControllerDetachedForRestartError,
  restoreRemoteBootstrapCheckpointForRecovery,
  runnerdStateProvesIncompleteBootstrap,
  runnerdStateProvesNoRemoteProviderTurn,
  verifyRemoteRunnerOrSettledExit,
} from "./native-session-executor.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  listExpiredNativeRunnerAuthorities,
  loadNativeRunnerCheckpoint,
  nativeRunnerCheckpointRegistration,
  nativeRunnerCheckpointWriter,
  registerNativeRunnerCheckpoint,
  restoreNativeRunnerCheckpoint,
} from "./native-runner-checkpoint.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { setNativeExecutionActive } from "./native-active-runs.js";
import { RUNNER_BRIDGE_READ_OPERATIONS, RUNNER_BRIDGE_SCHEMAS } from "./runner-bridge-tools.js";
import { HttpError } from "../../errors.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { onControllerStamp } from "../controller-process-identity.js";
import { registerControllerInstanceDb, resetControllerInstanceLeaseForTests } from "../controller-instance-lease.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../../sentry.js")>("../../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});
import { claimNativeRestartRecoveries, currentNativeControllerIdentity, NATIVE_NO_PROGRESS_RESTART_LIMIT, NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT, NATIVE_RESTART_RECOVERY_FAILED, nextNativeProviderAttempt, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { requestTaskRetry } from "../task-retry.js";

// Exact v5 wire prompt from before the task-monitor upgrade (#15446).
const historicalPrompt = {
  revision: "paperclip-execution.v5",
  text: "You are running as a Paperclip agent. Complete the assigned task in the provided execution environment. Follow the attached agent instructions and use assigned skills and tools when relevant. Use Paperclip tools for coordination. To hire or reuse a persistent teammate, use list_agents, then search_api for agent-hires and call_api if a hire is needed. Provider helper threads do not create Paperclip agents. When the user assigns work or a revision to a teammate, use create_task with that agent's ID; review their result rather than doing their assigned work yourself. When remaining work depends on a child task, use set_dependencies to add its ID while preserving existing blocker IDs. Complete independent work, then call paperclip_block with the child agent as owner and child completion as the unblock action. End the turn so the child can use the workspace. Do not sleep or poll for child results while holding the workspace. Paperclip resumes the parent when the dependency completes. When the user asks to connect a service, call connections_search before any service tool, even when that tool is already installed. Follow the returned instruction and wait for any required user choice before executing. For other tasks needing a service, use installed tools if available; otherwise use connections_search and follow its instruction. The request appears as a card in the task. Finish independent work before yielding for access; do not poll or request the same connection repeatedly. Paperclip will continue automatically with updated tools after resolution. After a decline, pursue alternatives unless the user explicitly asks to retry. Finish exactly once with `paperclip_finish` or `paperclip_block`.",
  digest: "bec3e633d8d828103ce50b3a8b8dc9991c8ef65e07538bdab1a7663957c2ef9b",
} as const;

// A saved prompt unknown to this release must recover without adding source data.
const unregisteredPrompt = {
  revision: "saved-prompt-before-upgrade",
  text: "Complete the assigned task using the saved instructions.",
  digest: "b0cab3306694028624bbccbf40984a7aca7c809f77b29bfd959325a2af3f7a66",
} as const;
import {
  remotePreparedWorkspace,
  nativeRestartFixture,
  describeEmbeddedPostgres,
  realProcessIt,
  processAlive,
  waitForCondition,
  stopOwnedProcessGroup,
} from "../../__tests__/helpers/native-restart.js";

describeEmbeddedPostgres("native runner restart recovery with real processes", () => {
  const environment = nativeRestartFixture();
  const { seedRun, transportOptions } = environment;
  let temporary: typeof environment.current.temporary;
  let runtimeRoot: typeof environment.current.runtimeRoot;
  let companyId: typeof environment.current.companyId;
  let agentId: typeof environment.current.agentId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ temporary, runtimeRoot, companyId, agentId, successor } = environment.current); });

  realProcessIt.each([2, 3])("relaunches scheduled attempt %i after a fresh ACPX Runner rejects turn.start and closes cleanly", async providerAttempt => {
    const root = await mkdtemp(join(tmpdir(), "fresh-runner-settled-retry-"));
    const fault = join(root, "reject-turn"), journal = join(root, "sidecar-calls"), shim = join(root, "sidecar.cjs");
    const binary = defaultCapabilityRunnerdBinary();
    const fake = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-acpx-sidecar");
    const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const script = `const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { existsSync, appendFileSync } = require("node:fs");
const child = spawn(${JSON.stringify(fake)}, ["--mode", "source-reconcile", "--profile-digest", ${JSON.stringify(QUALIFIED_ACPX_PROFILES.claude.commandDigest)}, "--journal", ${JSON.stringify(journal)}, "--source-fault", ${JSON.stringify(fault)}]);
child.stderr.pipe(process.stderr);
createInterface({ input: child.stdout }).on("line", line => {
  const response = JSON.parse(line);
  if (response.result?.sidecarPid) response.result.sidecarPid = process.pid;
  process.stdout.write(JSON.stringify(response) + "\\n");
});
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.command === "turn.start" && existsSync(${JSON.stringify(fault)})) {
    appendFileSync(${JSON.stringify(journal)}, JSON.stringify(request) + "\\n");
    process.stdout.write(JSON.stringify({ protocolVersion: request.protocolVersion, id: request.id, ok: false,
      error: { code: "SESSION_RESUME_REQUIRED", message: "Resume the provider session again.", retryable: true } }) + "\\n");
  } else child.stdin.write(line + "\\n");
}).on("close", () => child.stdin.end());
child.on("exit", code => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill("SIGTERM"));
`;
    await writeFile(shim, script);
    // Runnerd refuses a group- or world-writable qualified ACPX launch. A
    // hosted CI image can ship such a Node, or run under umask 0002.
    await chmod(shim, 0o600);
    let sidecarNode = process.execPath;
    if ((await stat(sidecarNode)).mode & 0o022) {
      // Same approach as the runner's copyOwnedNodeRuntime test helper.
      const owned = join(root, "sidecar-node");
      await mkdir(owned);
      sidecarNode = join(owned, "runtime");
      await copyFile(process.execPath, sidecarNode);
      await chmod(sidecarNode, 0o700);
      // Homebrew Node resolves its libnode dylib next to the relocated executable.
      const libraries = join(dirname(process.execPath), "..", "lib");
      for (const name of (await readdir(libraries).catch(() => [] as string[])).filter(name => /^libnode\..*\.dylib$/.test(name))) {
        await copyFile(join(libraries, name), join(owned, name));
      }
    }
    const nodeDigest = digest(await readFile(sidecarNode));
    const identity = { runId: "fresh-resume-run", normalizedSessionId: "checkpointed-session", runnerInstanceId: "fresh-runner",
      environmentLeaseId: "same-lease", turnId: "same-turn", itemId: "same-item" };
    const stateDirectory = join(root, ".paperclip-runtime", "paperclip-runner", "sessions",
      createHash("sha256").update(identity.normalizedSessionId).digest("hex"));
    const bundles: ReturnType<typeof createCapabilityRunnerdCodexTransport>[] = [];
    const children: ReturnType<typeof spawn>[] = [];
    const launches = vi.fn();
    const create = (directory: string, resume?: CapabilityRunnerdCodexTransportOptions["resumeProviderSession"],
      adoptExistingRunner?: CapabilityRunnerdCodexTransportOptions["adoptExistingRunner"]) => {
      const bundle = createCapabilityRunnerdCodexTransport({
        runnerBinary: binary, runnerArtifact: readRunnerdArtifactBinding(binary), stateDirectory: directory,
        provider: "acpx", acpxAgent: "claude", prpIdentity: identity, resumeProviderSession: resume, adoptExistingRunner,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null }, closeGraceMs: 3_000,
        controlPlaneRegistration: async authority => {
          await authority.start();
          return { connectUrl: authority.connectUrl, release: () => authority.stop() };
        },
        prepareLaunch: async input => ({ configurationId: "qualified-fixture", requirementsDigest: runnerLaunchRequirementsDigest(input),
          provider: createRunnerProviderLaunch(input, { options: {}, root: directory, cwd: root, codexHome: root,
            codexCommand: "", providerNodeCommand: sidecarNode, opencodeProxyPath: "", acpxSidecarPath: shim }) }),
        runnerProcessLauncher: spec => {
          launches(adoptExistingRunner);
          const child = spawn(binary, [...spec.args, "--acpx-launch-authority-digest", digest("fixture authority"),
            "--acpx-sidecar-command", sidecarNode, "--acpx-sidecar-command-sha256", nodeDigest,
            "--acpx-sidecar-script", shim, "--acpx-sidecar-script-sha256", digest(script)],
          { env: { PATH: process.env.PATH, ...spec.environment }, stdio: ["ignore", "ignore", "pipe"], detached: true });
          children.push(child);
          let stderr = "";
          child.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-16_384); });
          return { child, completion: new Promise((resolveExit, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr }));
          }) };
        },
      });
      bundles.push(bundle);
      return bundle;
    };
    const expectCompleted = async (bundle: ReturnType<typeof create>, expectedTurnId: string) => {
      expect(expectedTurnId).toEqual(expect.any(String));
      expect(expectedTurnId).not.toBe("");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            for await (const event of bundle.transport.notifications()) {
              if (event.method !== "turn/completed") continue;
              const turn = event.params?.turn as { id?: string; status?: string; error?: unknown } | undefined;
              if (turn?.id !== expectedTurnId) continue;
              expect(turn).toMatchObject({ id: expectedTurnId, status: "completed" });
              expect(turn?.error ?? null).toBeNull();
              return;
            }
            throw new Error("Fixture turn ended without completion");
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture turn completion timed out")), 5_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      const seedDirectory = stateDirectory;
      const seed = create(seedDirectory);
      const opened = await seed.transport.request("thread/start", { cwd: root, model: "fixture-model", dynamicTools: [] });
      const thread = opened.thread as { id: string; sessionId: string };
      const seedStarted = await seed.transport.request("turn/start", { input: [{ type: "text", text: "Save the provider checkpoint." }] });
      await expectCompleted(seed, (seedStarted.turn as { id: string }).id);
      await seed.transport.close();
      const provider = JSON.parse(await readFile(join(seedDirectory, "runner", "acpx-provider-state.json"), "utf8"));
      const resume = { driverSessionId: thread.id, providerSessionId: thread.sessionId, providerIdentity: provider.identity };
      await writeFile(fault, "reject-turn-start");
      const fresh = create(stateDirectory, resume);
      await fresh.transport.request("thread/read", { threadId: thread.id, includeTurns: false });
      await fresh.transport.request("thread/resume", { threadId: thread.id, cwd: root, model: "fixture-model", dynamicTools: [] });
      expect(launches.mock.calls).toEqual([[undefined], [undefined]]);
      const child = children.at(-1)!;
      const pid = child.pid!;
      expect(pid).not.toBe(children[0]!.pid);
      let fingerprint = "linux:abcd-1234:100";
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        fingerprint = `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]}`;
      }
      await writeFile(join(stateDirectory, "runner", "runner-process.identity"),
        `fixture_nonce\n${pid}\n${new Date().toISOString()}\n${identity.runnerInstanceId}\n${fingerprint}\n`);
      await expect(fresh.transport.request("turn/start", { input: [{ type: "text", text: "Resume saved work." }] }))
        .rejects.toThrow("classification=session_resume_required");
      const rejectedCheckpoint = JSON.parse(await readFile(join(stateDirectory, "runner", "acpx-provider-state.json"), "utf8"));
      expect(rejectedCheckpoint).toMatchObject({ lifecycle: "prepared", providerExitUnconfirmed: false, identity: provider.identity });
      await fresh.transport.close();
      await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), { timeout: 5_000 });
      const resumedControl = JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
      expect(resumedControl.committedEvents).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "session.resumed" })]));
      const saved = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8"));
      expect(saved).toMatchObject({ ...identity, lifecycle: "suspended", outbox: [] });
      expect(saved.pendingTerminalDelivery ?? null).toBeNull();
      expect(saved.pendingProviderCleanup ?? null).toBeNull();
      expect(saved.warmTransition ?? null).toBeNull();
      const suspendedCheckpoint = JSON.parse(await readFile(join(stateDirectory, "runner", "acpx-provider-state.json"), "utf8"));
      expect(suspendedCheckpoint).toMatchObject({ lifecycle: "suspended", providerExitUnconfirmed: false,
        activeTurnId: null, pendingEvents: [], pendingRuntimeRequests: {}, identity: provider.identity });
      const runner = { execute: async (request: { command: string; args: string[]; timeoutMs?: number }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(resolveResult => {
          execFile(request.command, request.args, { timeout: request.timeoutMs }, (error, stdout, stderr) => resolveResult({
            stdout, stderr, exitCode: error ? Number(error.code) : 0, timedOut: error?.killed ?? false,
          }));
        }) };
      const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: root, runner,
        sandboxLeaseAcquisition: { providerLeaseId: "same-sandbox", outcome: "resumed" as const } };
      const adopted = await verifyRemoteRunnerOrSettledExit({
        claim: { runId: identity.runId, remote: { providerLeaseId: "same-sandbox", remoteCwd: root } },
        target: target as never, identity, runId: identity.runId, normalizedSessionId: identity.normalizedSessionId, providerAttempt,
      });
      expect(adopted).toBeUndefined();
      await rm(fault);
      const retried = create(stateDirectory, resume, adopted);
      await retried.transport.request("thread/read", { threadId: thread.id, includeTurns: false });
      await retried.transport.request("thread/resume", { threadId: thread.id, cwd: root, model: "fixture-model", dynamicTools: [] });
      const retryStarted = await retried.transport.request("turn/start", { input: [{ type: "text", text: "Continue after the bounded retry." }] });
      const retryTurnId = (retryStarted.turn as { id: string }).id;
      await expectCompleted(retried, retryTurnId);
      const calls = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const turnStarts = calls.filter(call => call.command === "turn.start");
      expect(turnStarts).toHaveLength(3);
      expect(new Set(turnStarts.map(call => call.params.turnId)).size).toBe(3);
      expect(turnStarts.at(-1).params.turnId).toBe(retryTurnId);
      expect(calls.filter(call => call.command === "session.open").map(call => call.params.expectedIdentity))
        .toEqual([null, provider.identity, provider.identity]);
      expect(launches.mock.calls).toEqual([[undefined], [undefined], [undefined]]);
      expect(retried.evidence().runnerPid).toBeGreaterThan(0);
      expect(retried.evidence().runnerPid).not.toBe(pid);
    } finally {
      await Promise.allSettled(bundles.map(bundle => bundle.transport.close()));
      for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) await stopOwnedProcessGroup(child.pid, root);
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it.each(["issue", "run", "coordinator"] as const)("defers a busy %s row without blocking replacement startup", async kind => {
    const fixture = await seedRun(`OVERLAP-BUSY-${kind}`);
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = fixture.db.transaction(async tx => {
      if (kind === "issue") await tx.select().from(issues).where(eq(issues.id, fixture.issueId)).for("update");
      else if (kind === "run") await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)).for("update");
      else await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)).for("update");
      acquired(); await released;
    });
    await locked;
    const now = new Date();
    const heartbeat = heartbeatService(fixture.db);
    try {
      const dispositions = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId], now });
      expect(dispositions).toEqual([{ kind: "awaiting_evidence", runId: fixture.runId,
        reason: "recovery_rows_busy", retryAt: new Date(now.getTime() + 1_000) }]);
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(coordinator.controllerGeneration).toBe(0);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const startup = await Promise.race([
          heartbeat.recoverNativeRunsAfterRestart(now, [fixture.runId]),
          new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("startup blocked on the serving controller")), 2_000); }),
        ]);
        expect(startup).toMatchObject({ claims: [], awaitingEvidenceRunIds: [fixture.runId] });
      } finally { clearTimeout(deadline); }
    } finally { await heartbeat.drainActiveRunExecutions(); release(); await holder; }
    const [next] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    expect(next.kind).toBe("bootstrap_incomplete");
  });

  it("preserves a retry when another task owns its routine slot and continues startup recovery", async () => {
    const candidates = [await seedRun("ROUTINE-COLLISION"), await seedRun("AFTER-ROUTINE-COLLISION")]
      .sort((a, b) => a.runId.localeCompare(b.runId));
    const [waiting, unrelated] = candidates;
    const holder = await seedRun("ROUTINE-SLOT-OWNER", waiting.db);
    const routineId = randomUUID();
    const now = new Date();
    await waiting.db.update(issues).set({ executionRunId: null, originKind: "routine_execution",
      originId: routineId, originFingerprint: "scheduled" }).where(eq(issues.id, waiting.issueId));
    await waiting.db.update(issues).set({ originKind: "routine_execution",
      originId: routineId, originFingerprint: "scheduled" }).where(eq(issues.id, holder.issueId));
    await waiting.db.update(heartbeatRuns).set({ status: "failed", finishedAt: now,
      nativePhase: "retryable_failure", runnerProfileJson: { ...waiting.preparedProfile,
        nativeWorkspaceSync: remotePreparedWorkspace(),
        sessionCheckpoint: { identity: { companyId, agentId, issueId: waiting.issueId, runId: waiting.runId,
          sessionId: waiting.native.normalizedSessionId }, providerSessionId: "retained-routine-session" },
      } }).where(eq(heartbeatRuns.id, waiting.runId));
    await waiting.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      leaseOwner: "predecessor-routine-controller", leaseExpiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, waiting.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(runtimeRoot, waiting.runId),
      identity: transportOptions(waiting, runtimeRoot).prpIdentity,
      expectedRunnerVersion: "routine-recovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      await registerNativeRunnerCheckpoint({ db: waiting.db,
        binding: { companyId, issueId: waiting.issueId, runId: waiting.runId }, bootId: successor.bootId, authority });
    } finally { await authority.stop(); }
    await waiting.db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(0), failureCode: "provider_transport_interrupted",
      failureDetail: { recoveryMode: "exact_checkpoint_resume", checkpointExists: true,
        providerSessionEstablished: true, providerEventsExist: false } })
      .where(eq(nativeRunFinalizations.runId, waiting.runId));
    const state = async () => ({
      run: await waiting.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting.runId)),
      coordinator: await waiting.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, waiting.runId)),
      checkpoint: await waiting.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, waiting.runId)),
      task: await waiting.db.select().from(issues).where(eq(issues.id, waiting.issueId)),
      holder: await waiting.db.select().from(issues).where(eq(issues.id, holder.issueId)),
    });
    const before = await state();
    expect(before.checkpoint.length).toBeGreaterThan(0);
    const onClaim = vi.fn();
    const input = { db: waiting.db, controller: successor, restartKind: "hard" as const, now };
    const dispositions = await claimNativeRestartRecoveries({ ...input, onClaim,
      runIds: candidates.map(candidate => candidate.runId) });
    expect(dispositions).toEqual([
      { kind: "awaiting_evidence", runId: waiting.runId, reason: "routine_execution_busy",
        retryAt: new Date(now.getTime() + 30_000) },
      expect.objectContaining({ kind: "bootstrap_incomplete", runId: unrelated.runId }),
    ]);
    expect(onClaim).toHaveBeenCalledOnce();
    expect(onClaim.mock.calls[0][0].runId).toBe(unrelated.runId);
    expect(await state()).toEqual(before);
    expect(await waiting.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, waiting.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toHaveLength(0);
    expect(await waiting.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, waiting.runId))).toHaveLength(0);

    const heartbeat = heartbeatService(waiting.db);
    try {
      await expect(heartbeat.recoverNativeRunsAfterRestart(now, [waiting.runId]))
        .resolves.toMatchObject({ claims: [], awaitingEvidenceRunIds: [waiting.runId] });
    } finally { await heartbeat.drainActiveRunExecutions(); }
    expect(await state()).toEqual({ ...before, run: [{ ...before.run[0],
      nextEventSeq: before.run[0].nextEventSeq + 1, updatedAt: expect.any(Date) }] });

    await waiting.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, holder.issueId));
    const recovered = (await Promise.all([1, 2].map(() => claimNativeRestartRecoveries({ ...input,
      runIds: [waiting.runId] })))).flat();
    expect(recovered.filter(row => row.kind === "reattach_remote_runner")).toHaveLength(1);
    const after = await state();
    expect(after.run[0].runnerProfileJson).toEqual(before.run[0].runnerProfileJson);
    expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.coordinator[0]).toMatchObject({ attempt: 2, controllerGeneration: 1 });
    expect(after.task[0].executionRunId).toBe(waiting.runId);
    expect(await waiting.db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, waiting.runId),
      eq(heartbeatRunEvents.eventType, "native.recovery.execution_reclaimed")))).toHaveLength(1);
  });

  it("defers another database constraint failure without calling it a routine wait", async () => {
    const fixture = await seedRun("UNRELATED-DATABASE-FAILURE");
    const db = new Proxy(fixture.db, { get(target, key) {
      if (key === "transaction") return () => target.transaction(async tx => {
        await tx.execute(sql`create temp table recovery_constraint_control
          (id integer constraint recovery_unrelated_unique unique) on commit drop`);
        await tx.execute(sql`insert into recovery_constraint_control values (1), (1)`);
      });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const onClaim = vi.fn();
    await expect(claimNativeRestartRecoveries({ db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId], onClaim })).resolves.toEqual([{ kind: "awaiting_evidence",
      runId: fixture.runId, reason: NATIVE_RESTART_RECOVERY_FAILED, retryAt: expect.any(Date) }]);
    expect(onClaim).not.toHaveBeenCalled();
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "observed", controllerGeneration: 0, leaseOwner: null });
  });

  it.skipIf(!process.env.PAPERCLIP_TEST_RUNNER_CONTAINER).each(["warm", "hard", "finalizer-wait", "warm-suspended", "stale-projection", "legacy", "changed", "same-server", "diskless", "diskless-per-turn", "diskless-per-turn-read-retry", "diskless-warm-suspended", "diskless-warm-suspended-read-retry", "diskless-live-inspection"])("preserves remote warm continuity across completed turns: %s", async (scenario) => {
    const hardRestart = !["warm", "same-server", "warm-suspended"].includes(scenario);
    const diskless = scenario.startsWith("diskless");
    const perTurn = scenario.startsWith("diskless-per-turn");
    const warmSuspended = scenario === "warm-suspended" || scenario.startsWith("diskless-warm-suspended");
    const resumedAfterSuspension = perTurn || warmSuspended;
    const suspendedBeforeThird = perTurn || (diskless && warmSuspended);
    const container = process.env.PAPERCLIP_TEST_RUNNER_CONTAINER!;
    const tunnel = await createRunnerTestTlsTunnel({ port: Number(process.env.PAPERCLIP_TEST_RUNNER_PORT),
      key: process.env.PAPERCLIP_TEST_RUNNER_TLS_KEY!, cert: process.env.NODE_EXTRA_CA_CERTS! });
    const runner = dockerCommandRunner(container);
    const fixture = await seedRun(`REMOTE-WARM-CONTINUITY-${scenario}`);
    const boundContract = async (runId: string) => {
      const [row] = await fixture.db.select({ contract: completionContracts }).from(heartbeatRuns)
        .innerJoin(completionContracts, eq(completionContracts.id, heartbeatRuns.completionContractId))
        .where(eq(heartbeatRuns.id, runId));
      return { id: row.contract.id, sha256: row.contract.canonicalSha256,
        schemaVersion: row.contract.schemaVersion, contract: row.contract.contractJson as never };
    };
    const workspace = resolve(runtimeRoot, fixture.issueId);
    await mkdir(workspace, { recursive: true });
    const context = nativeRuntimeContextFixture();
    context.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", content: Buffer.from("Complete the assigned conversation turn.\n"), mode: 0o444 }]);
    context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    const execution = buildNativeExecutionInput({
      companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: "NRR-REMOTE-WARM-CONTINUITY", title: "Continue the same conversation", description: null, workMode: "standard" },
      taskPrompt: "Complete the first turn.",
      workspace: { id: randomUUID(), cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId,
      lifecyclePolicy: perTurn ? { mode: "per_turn", idleTimeoutMs: null } : { mode: "warm", idleTimeoutMs: 60_000 },
      runtimeContext: context,
      completionContract: await boundContract(fixture.runId),
    });
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...fixture.preparedProfile, nativeExecutionInput: execution,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", execution.provider.kind),
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    const remoteCwd = `/tmp/paperclip-continuity-${fixture.issueId}`;
    expect((await runner.execute({ command: "mkdir", args: ["-p", remoteCwd] })).exitCode).toBe(0);
    const target = {
      kind: "remote" as const, transport: "sandbox" as const,
      providerKey: "test-container", providerLeaseId: container,
      environmentId: randomUUID(), leaseId: randomUUID(), remoteCwd, runner,
      effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true,
        nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
        independentControlCommands: true, incrementalSessionOutput: false,
        concurrentSyncOperations: false, duplexCommandStream: false },
      sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: container },
      getRunnerIngressEndpoint: async ({ path }: { path: string }) => {
        const endpoint = { kind: "authenticated_websocket" as const,
          websocketUrl: `wss://127.0.0.1:${tunnel.port}${path}`, secretHeaders: [], generation: container,
          refresh: async () => endpoint, close: async () => undefined };
        return endpoint;
      },
    };
    const logs: string[] = [];
    await fixture.db.insert(environments).values({ id: target.environmentId, name: `Continuity ${fixture.issueId}`, driver: "sandbox" });
    await fixture.db.insert(environmentLeases).values({ id: target.leaseId, companyId, environmentId: target.environmentId,
      heartbeatRunId: fixture.runId, issueId: fixture.issueId, provider: target.providerKey,
      providerLeaseId: container, leasePolicy: "reuse_by_environment", metadata: { remoteCwd } });
    const options = {
      db: fixture.db, runnerInstanceId: fixture.native.runnerInstanceId,
      useRunnerd: true, runnerIngressAuthorized: true,
      runnerRemoteBinaryPath: process.env.PAPERCLIP_TEST_LINUX_RUNNER_BINARY!,
      runnerRemoteCodexPath: process.env.PAPERCLIP_TEST_FAKE_CODEX_WRAPPER!,
      runnerEnvironment: { PATH: "/usr/local/bin:/usr/bin:/bin", PAPERCLIP_CONFIGURED_ENV_KEYS: '["CONTINUITY_TEST_CONFIG"]', CONTINUITY_TEST_CONFIG: "first" },
      onLog: async (_stream: "stdout" | "stderr", text: string) => { logs.push(text); },
    };
    let controller: ReturnType<typeof spawn> | undefined;
    const executeInController = (executionOptions: Parameters<typeof executePaperclipNativeSession>[0]) => new Promise<{ exitCode: number | null; inspectionOverridden?: boolean }>((resolveResult, reject) => {
        controller = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), resolve("server/src/__tests__/helpers/remote-warm-controller.test-worker.ts")],
          { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
        let timer = setTimeout(() => { controller?.kill("SIGKILL"); reject(new Error("Controller fixture imports exceeded 120 seconds")); }, 120_000);
        controller.stdout?.on("data", data => logs.push(String(data)));
        controller.stderr?.on("data", data => logs.push(String(data)));
        controller.on("error", error => { clearTimeout(timer); reject(error); });
        controller.on("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Warm controller exited: ${code}/${signal}: ${logs.join("").slice(-3_000)}`)); });
        controller.on("message", (message: { ready?: boolean; log?: { text: string }; result?: { exitCode: number | null }; error?: string }) => {
          if (message.ready) {
            clearTimeout(timer);
            timer = setTimeout(() => { controller?.kill("SIGKILL"); reject(new Error(`Warm controller admission exceeded 60 seconds: ${logs.join("").slice(-3_000)}`)); }, 60_000);
            controller!.send?.({ connectionString: temporary.connectionString, container, suspendAfterTurn: warmSuspended, transientBackpressureInspection: scenario === "diskless-live-inspection" && executionOptions.execution.binding.runId !== fixture.runId, ingressUrl: `wss://127.0.0.1:${tunnel.port}`,
              options: { ...executionOptions, db: undefined, onLog: undefined, runnerExecutionTarget: { ...executionOptions.runnerExecutionTarget, runner: undefined } } });
          }
          if (message.log) logs.push(message.log.text);
          if (message.error) { clearTimeout(timer); reject(new Error(message.error)); }
          if (message.result) { clearTimeout(timer); resolveResult(message.result); }
        });
      });
    try {
      const firstOptions = { ...options, execution, runnerExecutionTarget: target };
      const executeFirst = async () => {
        if (scenario !== "same-server") return executePaperclipNativeSession(firstOptions);
        await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
          ...fixture.preparedProfile, nativeExecutionInput: execution,
          nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
            descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
            workspaceId: randomUUID(), leaseId: target.leaseId, providerLeaseId: container, remoteCwd },
        } }).where(eq(heartbeatRuns.id, fixture.runId));
        let detach: ReturnType<typeof detachNativeSessionsForRestart> | undefined;
        await expect(executePaperclipNativeSession({ ...firstOptions, onLog: async (stream, text) => {
          await options.onLog(stream, text);
          if (!detach && text.includes('"eventType":"turn.started"')) {
            detach = detachNativeSessionsForRestart([fixture.runId]);
          }
        } })).rejects.toBeInstanceOf(NativeControllerDetachedForRestartError);
        expect(await detach).toMatchObject({ detachedRunIds: [fixture.runId] });
        const checkpoints = resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions");
        let staleCaches = 0;
        for (const name of await readdir(checkpoints)) {
          if (!name.endsWith(".json")) continue;
          const path = resolve(checkpoints, name);
          const cached = JSON.parse(await readFile(path, "utf8"));
          if (cached.snapshot?.identity?.runId !== fixture.runId) continue;
          cached.snapshot.activeTurnId = null;
          cached.snapshot.semanticResult = null;
          cached.snapshot.terminal = null;
          cached.snapshot.terminalTurns = [];
          await writeFile(path, JSON.stringify(cached), { mode: 0o600 });
          staleCaches++;
        }
        expect(staleCaches).toBe(1);
        const priorProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
        await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1) })
          .where(eq(nativeRunFinalizations.runId, fixture.runId));
        let preparation: NativeExecutionLeaseRenewal | undefined;
        const [claim] = await claimNativeRestartRecoveries({ db: fixture.db,
          controller: await currentNativeControllerIdentity(), restartKind: "hard", runIds: [fixture.runId],
          onClaim: (claim, scope) => {
            preparation = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...scope,
              runId: claim.runId, leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt,
              onLost: () => detachNativeSessionsForRestart([claim.runId], claim.leaseOwner) });
          } });
        if (!claim || claim.kind !== "reattach_remote_runner") {
          throw new Error(`same-server claim missing: ${claim && "reason" in claim ? claim.reason : claim?.kind}`);
        }
        const result = await executePaperclipNativeSession({ ...firstOptions, leaseOwner: claim.leaseOwner, restartRecovery: claim,
          onExecutionLeaseAcquired: () => preparation!.stop(),
          instructionWorkingCopy: {
            hasChanges: async () => {
              const [settled] = await fixture.db.select().from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, fixture.runId));
              expect(settled).toMatchObject({ leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt });
              await new Promise(resolve => setTimeout(resolve, 21_000));
              return false;
            },
            collectStopped: async () => undefined,
          },
        }).finally(() => preparation?.stop().catch(() => undefined));
        const [released] = await fixture.db.select().from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, fixture.runId));
        expect(released.leaseOwner).toBeNull();
        expect(logs.filter(line => line.includes("controller authority detached for restart"))).toHaveLength(1);
        const recoveredCalls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
        expect(recoveredCalls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(1);
        const nextProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
        expect(nextProcess.stdout).toBe(priorProcess.stdout);
        return result;
      };
      const first = hardRestart ? await executeInController(firstOptions) : await executeFirst();
      expect(first.exitCode).toBe(0);
      if (scenario === "warm-suspended") expect(await closeIdleWarmNativeSessionsForRestart())
        .toEqual({ closed: 1, busy: 0, failed: 0 });
      await finalizeNativeRun({ db: fixture.db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const snapshot = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-state.json`] });
      expect(snapshot.exitCode).toBe(0);
      const saved = JSON.parse(snapshot.stdout);
      expect(saved.lifecycle).toBe(resumedAfterSuspension ? "suspended" : "ready");
      const processBefore = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      expect(processBefore.exitCode).toBe(0);
      const historyBefore = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/filesystem/codex-home/fake-codex-state.json`] });
      const providerBefore = JSON.parse(historyBefore.stdout);
      const nextRunId = randomUUID();
      const nextLeaseId = randomUUID();
      const [nextRun] = await fixture.db.insert(heartbeatRuns).values({
        id: nextRunId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: fixture.issueId,
        invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: fixture.issueId },
        nativeSessionId: fixture.native.normalizedSessionId,
      }).returning();
      await fixture.db.update(issues).set({ executionRunId: nextRunId, status: "in_progress" }).where(eq(issues.id, fixture.issueId));
      await fixture.db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, target.leaseId));
      await fixture.db.insert(environmentLeases).values({ id: nextLeaseId, companyId, environmentId: target.environmentId,
        heartbeatRunId: nextRunId, issueId: fixture.issueId, provider: target.providerKey,
        providerLeaseId: container, leasePolicy: "reuse_by_environment", metadata: { remoteCwd } });
      const next = await prepareNativeHeartbeatRun({ db: fixture.db, run: nextRun,
        issue: { id: fixture.issueId, title: "Continue the same conversation", description: null, reviewPolicy: null },
        environmentLeaseId: nextLeaseId });
      await fixture.db.insert(nativeRunFinalizations).values({ runId: nextRunId, companyId, issueId: fixture.issueId, phase: "observed" });
      const nextOptions = { ...options, runnerInstanceId: next.runnerInstanceId,
        runnerEnvironment: scenario === "changed" ? { ...options.runnerEnvironment, CONTINUITY_TEST_CONFIG: "second" } : options.runnerEnvironment,
        execution: { ...execution, completionContract: await boundContract(nextRunId), binding: { ...execution.binding, runId: nextRunId }, task: { ...execution.task, prompt: "Complete the second conversation turn." } },
        runnerExecutionTarget: { ...target, leaseId: nextLeaseId, sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: container } },
      };
      if (controller) {
        const exited = new Promise<void>(resolveExit => controller!.once("exit", () => resolveExit()));
        (controller as ReturnType<typeof spawn>).kill("SIGKILL");
        await exited;
        controller = undefined;
        // A replacement sandbox would now retire this finished owner and start
        // a new Runner (native-recovered-owner-followup.test.ts), which this
        // continuity scenario must not do before resuming the same sandbox.
      }
      if (scenario === "legacy") {
        const checkpoints = resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "sessions");
        let changed = 0;
        for (const name of await readdir(checkpoints)) {
          if (!name.endsWith(".json")) continue;
          const path = resolve(checkpoints, name);
          const envelope = JSON.parse(await readFile(path, "utf8"));
          if (envelope.snapshot?.identity?.runId !== fixture.runId) continue;
          delete envelope.processConfigDigest;
          await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
          changed++;
        }
        expect(changed).toBe(1);
      }
      if (scenario === "stale-projection") {
        const checkpoint = await loadNativeRunnerCheckpoint(fixture.db, { companyId,
          issueId: fixture.issueId, runId: fixture.runId });
        expect(checkpoint).not.toBeNull();
        const sessions = resolve(resolvePaperclipInstanceRoot(), "runtime/paperclip-runner/durable-sessions");
        let projected = 0;
        for (const name of await readdir(sessions)) {
          const root = resolve(sessions, name), path = resolve(root, "control-plane/control-plane-state.json");
          if (!existsSync(path) || JSON.parse(await readFile(path, "utf8")).identity?.runId !== fixture.runId) continue;
          checkpoint!.restoreSessionDirectory(root);
          const state = JSON.parse(await readFile(path, "utf8"));
          const terminalIndex = state.committedEvents.findLastIndex((event: { eventType: string }) => event.eventType === "run.terminal");
          expect(terminalIndex).toBeGreaterThan(0);
          // Retain a full local projection from just before the terminal. The
          // database keeps the complete same-run checkpoint and all receipts.
          state.committedEvents = state.committedEvents.slice(0, terminalIndex);
          state.ackedSourceSeq = state.committedEvents.at(-1).sourceSeq;
          await writeFile(path, JSON.stringify(state), { mode: 0o600 });
          projected++;
        }
        expect(projected).toBe(1);
      }
      if (diskless) {
        // Preserve sandbox/provider storage and workspace dependencies. Delete
        // both native controller projections; admission must discover the source.
        await rm(resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner"), { recursive: true, force: true });
      }
      // Exercise the existing admission selector/rebinder, which supplies per-turn
      // runtime snapshots. It does not restore PRP or supervisor files.
      const admitContinuation = async (current: typeof execution) => {
        const [row] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.binding.runId));
        const selected = await findNativeSessionResumeRun(fixture.db, { ...current.binding, currentRunId: row.id,
          normalizedSessionId: fixture.native.normalizedSessionId, beforeCreatedAt: row.createdAt });
        const admission = buildNativeExecutionWithCheckpoint({ previousRun: selected,
          normalizedSessionId: fixture.native.normalizedSessionId, executionTargetKind: "remote", buildExecution: () => current });
        if (perTurn) expect(admission.checkpoint).not.toBeNull();
        await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...row.runnerProfileJson,
          nativeExecutionInput: current, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", current.provider.kind),
          ...(perTurn ? { sessionCheckpoint: admission.checkpoint } : {}) } }).where(eq(heartbeatRuns.id, row.id));
      };
      await admitContinuation(nextOptions.execution);
      let continuationLeaseOwner: string | undefined;
      if (scenario === "finalizer-wait") {
        const retryAt = new Date(Date.now() + 60_000);
        await fixture.db.update(nativeRunFinalizations).set({ leaseOwner: "fixture-finalizer", leaseExpiresAt: retryAt })
          .where(eq(nativeRunFinalizations.runId, fixture.runId));
        await expect(executePaperclipNativeSession(nextOptions)).rejects.toBeInstanceOf(NativeControllerRecoveryWaitingError);
        const [waiting] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, nextRunId));
        expect(waiting).toMatchObject({ phase: "retryable_failure", attempt: 0, nextAttemptAt: retryAt });
        const calls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
        expect(calls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(1);
        await fixture.db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null })
          .where(eq(nativeRunFinalizations.runId, fixture.runId));
        const [claim] = await claimNativeSessionResumptions({ db: fixture.db, runnerInstanceId: next.runnerInstanceId,
          runIds: [nextRunId], now: retryAt });
        expect(claim).toBeDefined();
        continuationLeaseOwner = claim.leaseOwner;
      }
      if (scenario.endsWith("-read-retry")) {
        let rejectedReads = 0;
        await expect(executePaperclipNativeSession({ ...nextOptions,
          runnerExecutionTarget: { ...nextOptions.runnerExecutionTarget, runner: { ...runner,
            execute: async request => {
              if (request.args?.some(arg => arg.includes("base64 <") && arg.includes("runner-state.json"))) {
                rejectedReads++;
                throw new Error("fixture_remote_state_timeout");
              }
              return runner.execute(request);
            },
          } },
        })).rejects.toThrow("fixture_remote_state_timeout");
        expect(rejectedReads).toBe(1);
        // Retry with the partial PRP projection left by the failed read. No
        // fixture writes a suspended receipt or changes the surviving Runner.
      }
      const second = diskless ? await executeInController(nextOptions) : await executePaperclipNativeSession({ ...nextOptions,
        ...(continuationLeaseOwner ? { leaseOwner: continuationLeaseOwner } : {}) });
      expect(second.exitCode).toBe(0);
      if (scenario === "diskless-live-inspection") expect("inspectionOverridden" in second && second.inspectionOverridden).toBe(true);
      const historyAfter = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/filesystem/codex-home/fake-codex-state.json`] });
      const providerAfter = JSON.parse(historyAfter.stdout);
      expect(providerAfter.threadId).toBe(providerBefore.threadId);
      expect(providerAfter.nextTurn).toBe(2);
      const calls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
      expect(calls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(2);
      expect(calls.stdout.split("\n").filter(line => line === "thread/start")).toHaveLength(1);
      const providerStarts = calls.stdout.split("\n").filter(line => line === "process-start").length;
      expect(providerStarts).toBeGreaterThanOrEqual(1);
      expect(providerStarts).toBeLessThanOrEqual(resumedAfterSuspension || ["legacy", "changed"].includes(scenario) ? 3 : hardRestart ? 2 : 1);
      const processAfter = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      expect(processAfter.exitCode).toBe(0);
      if (resumedAfterSuspension || ["legacy", "changed"].includes(scenario)) expect(processAfter.stdout).not.toBe(processBefore.stdout);
      else expect(processAfter.stdout).toBe(processBefore.stdout);
      await finalizeNativeRun({ db: fixture.db, runId: nextRunId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      if (diskless && controller) {
        const exited = new Promise<void>(resolveExit => controller!.once("exit", () => resolveExit()));
        (controller as ReturnType<typeof spawn>).kill("SIGKILL");
        await exited;
        controller = undefined;
        await rm(resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner"), { recursive: true, force: true });
      }
      const thirdRunId = randomUUID();
      const thirdLeaseId = randomUUID();
      const [thirdRun] = await fixture.db.insert(heartbeatRuns).values({
        id: thirdRunId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: fixture.issueId,
        invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: fixture.issueId },
        nativeSessionId: fixture.native.normalizedSessionId,
      }).returning();
      await fixture.db.update(issues).set({ executionRunId: thirdRunId, status: "in_progress" }).where(eq(issues.id, fixture.issueId));
      await fixture.db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, nextLeaseId));
      await fixture.db.insert(environmentLeases).values({ id: thirdLeaseId, companyId, environmentId: target.environmentId,
        heartbeatRunId: thirdRunId, issueId: fixture.issueId, provider: target.providerKey,
        providerLeaseId: container, leasePolicy: "reuse_by_environment", metadata: { remoteCwd } });
      const thirdNative = await prepareNativeHeartbeatRun({ db: fixture.db, run: thirdRun,
        issue: { id: fixture.issueId, title: "Continue the same conversation", description: null, reviewPolicy: null },
        environmentLeaseId: thirdLeaseId });
      await fixture.db.insert(nativeRunFinalizations).values({ runId: thirdRunId, companyId, issueId: fixture.issueId, phase: "observed" });
      const thirdExecution = { ...nextOptions.execution, completionContract: await boundContract(thirdRunId),
        binding: { ...execution.binding, runId: thirdRunId }, task: { ...execution.task, prompt: "Complete the third conversation turn." } };
      await admitContinuation(thirdExecution);
      const third = await executePaperclipNativeSession({ ...nextOptions, runnerInstanceId: thirdNative.runnerInstanceId,
        execution: thirdExecution,
        runnerExecutionTarget: { ...nextOptions.runnerExecutionTarget, leaseId: thirdLeaseId },
      });
      expect(third.exitCode).toBe(0);
      const finalHistory = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/filesystem/codex-home/fake-codex-state.json`] });
      expect(JSON.parse(finalHistory.stdout)).toMatchObject({ threadId: providerBefore.threadId, nextTurn: 3 });
      const finalCalls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
      expect(finalCalls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(3);
      expect(finalCalls.stdout.split("\n").filter(line => line === "thread/start")).toHaveLength(1);
      expect(finalCalls.stdout.split("\n").filter(line => line === "process-start")).toHaveLength(providerStarts + (suspendedBeforeThird ? 1 : 0));
      const finalProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      if (suspendedBeforeThird) expect(finalProcess.stdout).not.toBe(processAfter.stdout);
      else expect(finalProcess.stdout).toBe(processAfter.stdout);
      expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: perTurn ? 0 : 1, busy: 0, failed: 0 });
      const suspended = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-state.json`] });
      expect(suspended.exitCode).toBe(0);
      expect(JSON.parse(suspended.stdout).lifecycle).toBe("suspended");
    } catch (error) {
      await writeFile(resolve(runtimeRoot, "remote-continuity-failure.log"), logs.join(""));
      throw new Error(`Remote continuity regression failed: ${logs.filter(line => line.startsWith("[paperclip-runner]")).join("").slice(-4_000)}`, { cause: error });
    } finally {
      controller?.kill("SIGKILL");
      await closeIdleWarmNativeSessionsForRestart();
      await tunnel.close();
    }
  }, 360_000);

  // These historical controllers belong to the same kernel/PID namespace as
  // the real local processes this fixture starts. Other-space/legacy NULL
  // authority has separate explicit negatives; do not invent a constant hash.
  async function knownFixtureControllerHostHash() {
    const current = await currentControllerProcess();
    expect(current.hostHash, "Same-host recovery fixture requires actual known process space").not.toBe("unknown");
    return current.hostHash;
  }

  async function persistRestartEvidence(input: {
    fixture: Awaited<ReturnType<typeof seedRun>>;
    runnerPid: number;
    processGroupId: number | null;
    providerPid: number | null;
    providerSessionId: string;
  }) {
    const startedAt = await readProcessStartedAt(input.runnerPid);
    if (!startedAt) throw new Error("Runner process start fingerprint unavailable");
    const providerStartedAt = input.providerPid
      ? await readProcessStartedAt(input.providerPid)
      : null;
    const now = new Date();
    await input.fixture.db
      .update(heartbeatRuns)
      .set({
        processPid: input.runnerPid,
        processGroupId: input.processGroupId,
        processStartedAt: new Date(startedAt),
        runnerProfileJson: {
          sessionCheckpoint: {
            sessionId: input.fixture.native.normalizedSessionId,
            identity: {
              companyId,
              issueId: input.fixture.issueId,
              runId: input.fixture.runId,
              agentId,
              sessionId: input.fixture.native.normalizedSessionId,
            },
            providerSessionId: input.providerSessionId,
            providerIdentity: {
              kind: "codex",
              providerSessionId: input.providerSessionId,
            },
            process: {
              runnerPid: input.runnerPid,
              runnerProcessGroupId: input.processGroupId,
              providerPid: input.providerPid,
              providerProcessStartedAt: providerStartedAt,
              codexPid: input.providerPid,
              codexProcessStartedAt: providerStartedAt,
            },
          },
        },
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, input.fixture.runId));
    await input.fixture.db
      .update(nativeRunFinalizations)
      .set({
        leaseOwner: "dead-controller",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        controllerBootId: "dead-controller-boot",
        controllerHostHash: await knownFixtureControllerHostHash(),
        controllerPid: 2_000_000_000,
        controllerProcessStartedAt: new Date("2026-09-04T11:00:00.000Z"),
        controllerGeneration: 1,
        updatedAt: now,
      })
      .where(eq(nativeRunFinalizations.runId, input.fixture.runId));
    return new Date(startedAt);
  }

  async function persistUnconnectedRunner(input: {
    fixture: Awaited<ReturnType<typeof seedRun>>;
    runnerPid: number;
    processGroupId: number | null;
  }) {
    const startedAt = await readProcessStartedAt(input.runnerPid);
    if (!startedAt) throw new Error("Runner process start fingerprint unavailable");
    const now = new Date();
    await input.fixture.db
      .update(heartbeatRuns)
      .set({
        processPid: input.runnerPid,
        processGroupId: input.processGroupId,
        processStartedAt: new Date(startedAt),
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, input.fixture.runId));
    await input.fixture.db
      .update(nativeRunFinalizations)
      .set({
        leaseOwner: "dead-controller",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        controllerBootId: "dead-controller-boot",
        controllerHostHash: await knownFixtureControllerHostHash(),
        controllerPid: 2_000_000_003,
        controllerProcessStartedAt: new Date("2026-09-04T11:00:00.000Z"),
        controllerGeneration: 1,
        updatedAt: now,
      })
      .where(eq(nativeRunFinalizations.runId, input.fixture.runId));
  }

  it("recovers completed tool receipts, retries authorized reads, and preserves uncertain effects", async () => {
    const fixture = await seedRun("TOOL-RECOVERY");
    const binding = { companyId, issueId: fixture.issueId, agentId, runId: fixture.runId };
    const call = { callId: "tool-call", operationId: "write_document", input: { idempotencyKey: "write-1", body: "saved" } };
    const authority = new PaperclipRunnerToolAuthority(fixture.db, { ...binding, apiToolsEnabled: true });
    const executeRead = vi.spyOn(authority, "execute").mockResolvedValue({ context: "current" });
    const recover = (call: { callId: string; operationId: string; input: unknown }) =>
      authority.recover({ tool: call.operationId, callId: call.callId, arguments: call.input });
    await fixture.db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
      "write-1": { operationId: call.operationId, input: call.input, result: { revision: "revision-1" } },
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    await expect(recover(call))
      .resolves.toEqual({ result: { revision: "revision-1" } });
    // write_document's receipt commits with its revision, so a key whose
    // receipt holds other input proves this call can never apply under it.
    await expect(recover({ ...call, input: { ...call.input, body: "changed" } }))
      .resolves.toMatchObject({ isError: true, result: { success: false, contentItems: [
        { type: "inputText", text: expect.stringContaining("paperclip_runner_tool_idempotency_conflict") }] } });
    await expect(recover({ ...call, operationId: "unknown_external_write" }))
      .resolves.toBeNull();
    expect(executeRead).not.toHaveBeenCalled();
    await expect(recover({ ...call, operationId: "get_task_context" }))
      .resolves.toEqual({ result: { context: "current" } });
    expect(executeRead).toHaveBeenCalledTimes(1);
    const apiRead = { callId: "api-read", operationId: "call_api", input: { operationId: "GET /api/agents/me" } };
    await expect(recover(apiRead))
      .resolves.toEqual({ result: { context: "current" } });
    expect(executeRead).toHaveBeenCalledTimes(2);
    await expect(recover({ ...apiRead, input: { operationId: "POST /api/issues/{id}/comments" } })).resolves.toBeNull();
    await expect(recover({ ...apiRead, input: { operationId: "GET /unknown" } })).resolves.toBeNull();
    expect(executeRead).toHaveBeenCalledTimes(2);
    await fixture.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, fixture.runId));
    await expect(recover(call)).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
    await expect(recover(apiRead)).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
    expect(executeRead).toHaveBeenCalledTimes(2);
  });

  it("recovers bridge reads through current permissions and never replays an uncertain bridge mutation", async () => {
    const fixture = await seedRun("BRIDGE-READ-RECOVERY");
    const binding = { companyId, issueId: fixture.issueId, agentId, runId: fixture.runId };
    const workspaceRoot = resolve(runtimeRoot, fixture.runId, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(resolve(workspaceRoot, "note.txt"), "surviving workspace");
    const [originalAgent] = await fixture.db.select().from(agents).where(eq(agents.id, agentId));
    await fixture.db.update(agents).set({ adapterConfig: { ...originalAgent.adapterConfig, dotWorkspaceAccess: true } }).where(eq(agents.id, agentId));
    const personId = randomUUID(), foreignPersonId = randomUUID(), foreignCompanyId = randomUUID();
    await fixture.db.insert(companies).values({ id: foreignCompanyId, name: "Other recovery scope", issuePrefix: `F${foreignCompanyId.slice(0, 6)}` });
    await fixture.db.insert(authUsers).values([personId, foreignPersonId].map(id => ({
      id, name: id === personId ? "Visible person" : "Foreign person", email: `${id}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    })));
    await fixture.db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: personId, status: "active", membershipRole: "member" },
      { companyId: foreignCompanyId, principalType: "user", principalId: foreignPersonId, status: "active", membershipRole: "member" },
    ]);
    const assertBridgeAuthority = vi.fn(async () => {});
    const authority = new PaperclipRunnerToolAuthority(fixture.db, { ...binding,
      workspaceRoot, workspaceBridge: true, runtimeContext: nativeRuntimeContextFixture(), assertBridgeAuthority });
    const read = (tool: string, args: unknown = {}) => authority.recover({ tool, callId: `saved-${tool}`, arguments: args });
    try {
      await expect(read("get_identity")).resolves.toMatchObject({ result: { agent: { id: agentId } } });
      await expect(read("list_people")).resolves.toMatchObject({ result: [{ id: personId, name: "Visible person" }] });
      await expect(read("list_assigned_skills")).resolves.toEqual({ result: [] });
      await expect(read("read_assigned_skill", { skill: "no-longer-assigned" })).resolves.toMatchObject({ result: { outcome: "failed", code: "runner_skill_not_assigned" } });
      await expect(read("workspace_list")).resolves.toMatchObject({ result: { entries: [{ name: "note.txt", kind: "file" }] } });
      await expect(read("workspace_read", { path: "note.txt" })).resolves.toMatchObject({ result: { text: "surviving workspace" } });
      await expect(read("workspace_read", { path: "deleted.txt" })).resolves.toMatchObject({ result: { outcome: "failed", code: "runner_bridge_file_not_found" } });
      for (const tool of ["workspace_write", "workspace_run", "connection_request", "unknown_external_write"])
        await expect(read(tool)).resolves.toBeNull();
      await fixture.db.update(agents).set({ adapterConfig: originalAgent.adapterConfig }).where(eq(agents.id, agentId));
      await expect(read("workspace_read", { path: "note.txt" })).rejects.toThrow("Dot workspace access was disabled");
      const unavailable = new PaperclipRunnerToolAuthority(fixture.db, binding);
      await expect(unavailable.recover({ tool: "read_assigned_skill", callId: "unadvertised", arguments: { skill: "missing" } }))
        .rejects.toThrow("Tool is not available to this run");
      assertBridgeAuthority.mockRejectedValueOnce(new Error("controller lease lost"));
      await expect(read("get_identity")).rejects.toThrow("controller lease lost");
      await fixture.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, fixture.runId));
      await expect(read("list_people")).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
    } finally {
      await fixture.db.update(agents).set({ adapterConfig: originalAgent.adapterConfig }).where(eq(agents.id, agentId));
    }
  });

  it("classifies every bridge tool and routes declared first-party reads through the normal executor", async () => {
    expect([...RUNNER_BRIDGE_SCHEMAS.keys()].filter(name => !RUNNER_BRIDGE_READ_OPERATIONS.has(name)).sort())
      .toEqual(["comment_on_task", "workspace_run", "workspace_write", "write_task_document"]);
    const fixture = await seedRun("READ-CLASSIFICATION");
    const authority = new PaperclipRunnerToolAuthority(fixture.db, { companyId, issueId: fixture.issueId, agentId, runId: fixture.runId });
    const execute = vi.spyOn(authority, "execute").mockResolvedValue("current authorized result");
    try {
      for (const tool of [...RUNNER_BRIDGE_READ_OPERATIONS, "search_api", "get_workspace", "list_workspaces",
        "list_project_repositories", "connections_search", "list_task_attachments", "read_task_attachment",
        "read_current_wake_comments", "list_chat_attachments", "read_chat_attachment", "read_tool_result"]) {
        const call = { tool, callId: `saved-${tool}`, arguments: {} };
        await expect(authority.recover(call), tool).resolves.toEqual({ result: "current authorized result" });
        expect(execute).toHaveBeenLastCalledWith(call);
      }
    } finally { execute.mockRestore(); }
  });

  it("recovers missing-document reads as tool errors while fencing lost authority and unknown failures", async () => {
    const fixture = await seedRun("READ-RECOVERY");
    const assertBridgeAuthority = vi.fn(async () => {});
    const authority = new PaperclipRunnerToolAuthority(fixture.db, {
      companyId, issueId: fixture.issueId, agentId, runId: fixture.runId,
      apiToolsEnabled: true, assertBridgeAuthority,
    });
    const read = { tool: "read_document", callId: "missing-document", arguments: { key: "deleted" } };
    await expect(authority.recover(read)).resolves.toEqual({ isError: true, result: {
      success: false, contentItems: [{ type: "inputText", text: "paperclip_runner_document_not_found" }],
    } });
    await expect(authority.recover({ tool: "get_task_context", callId: "next-read", arguments: {} }))
      .resolves.toMatchObject({ result: { activeTask: { id: fixture.issueId } } });

    const execute = vi.spyOn(authority, "execute");
    const apiRead = { tool: "call_api", callId: "missing-api-resource", arguments: { operationId: "GET /api/agents/me" } };
    execute.mockRejectedValueOnce(new HttpError(404, "Resource disappeared"));
    await expect(authority.recover(apiRead)).resolves.toMatchObject({ isError: true, result: { success: false } });
    execute.mockRejectedValueOnce(new HttpError(403, "Authority revoked"));
    await expect(authority.recover(apiRead)).rejects.toThrow("Authority revoked");
    execute.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(authority.recover(read)).rejects.toThrow("database unavailable");
    execute.mockImplementationOnce(async () => {
      await fixture.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, fixture.runId));
      throw new Error("paperclip_runner_document_not_found");
    });
    await expect(authority.recover(read)).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
    execute.mockRestore();
    assertBridgeAuthority.mockRejectedValueOnce(new Error("controller lease lost"));
    await expect(authority.recover(read)).rejects.toThrow("controller lease lost");
  });

  it("restores encrypted controller authority from Postgres and fences a stale writer", async () => {
    const fixture = await seedRun("DURABLE-CONTROLLER");
    const root = resolve(runtimeRoot, fixture.runId);
    const options = transportOptions(fixture, root);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    await fixture.db.update(nativeRunFinalizations).set({
      controllerBootId: successor.bootId, controllerGeneration: 1,
      leaseOwner: "first-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: options.prpIdentity, expectedRunnerVersion: "old-version", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
    const token = authority.issueBootstrapTicket();
    authority.queueCommand("session.snapshot", {}, "durable-command");
    await authority.flushCheckpoint();
    const saved = await loadNativeRunnerCheckpoint(fixture.db, binding);
    expect(saved).toMatchObject({ runId: fixture.runId, runnerVersion: "old-version", predecessor: null });
    const raw = await fixture.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, fixture.runId));
    expect(raw.map(row => row.part).sort()).toEqual([...saved!.records.keys()].sort());
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(JSON.stringify(raw)).not.toContain("durable-command");
    await rm(root, { recursive: true, force: true });
    await expect(restoreNativeRunnerCheckpoint(fixture.db, binding, root, "another-session"))
      .rejects.toThrow("native_runner_checkpoint_binding_mismatch");
    expect(existsSync(root)).toBe(false);
    expect((await restoreNativeRunnerCheckpoint(fixture.db, binding, root))?.records).toEqual(saved?.records);
    const restored = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: options.prpIdentity, expectedRunnerVersion: saved!.runnerVersion, expectedRunnerDigest: saved!.runnerDigest });
    expect(restored.getCommand("durable-command")).toMatchObject({ type: "session.snapshot" });
    await restored.stop();
    expect(await loadNativeRunnerCheckpoint(fixture.db, { ...binding, companyId: randomUUID() })).toBeNull();

    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerGeneration: 2,
      leaseOwner: "successor-controller" }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    authority.queueCommand("session.snapshot", {}, "stale-command");
    await expect(authority.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
    expect((await loadNativeRunnerCheckpoint(fixture.db, binding))?.records).toEqual(saved?.records);
    await authority.stop();
  });

  it("fences checkpoint delivery when ownership expires during an unchanged row-lock wait", async () => {
    const fixture = await seedRun("CHECKPOINT-LOCK-EXPIRY");
    const root = resolve(runtimeRoot, fixture.runId);
    const options = transportOptions(fixture, root);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    const writerDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const [backend] = await checkpointDb(writerDb).execute(sql`select pg_backend_pid() as pid`);
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: options.prpIdentity, expectedRunnerVersion: "lock-test", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    let unlock: (() => void) | undefined;
    let holder: Promise<void> | undefined;
    try {
      await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
        controllerGeneration: 1, leaseOwner: "locked-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await registerNativeRunnerCheckpoint({ db: writerDb, binding, bootId: successor.bootId, authority });
      const saved = await loadNativeRunnerCheckpoint(fixture.db, binding);
      await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: sql`clock_timestamp() + interval '2 seconds'` })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      let acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const released = new Promise<void>(resolve => { unlock = resolve; });
      holder = fixture.db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)).for("update");
        acquired(); await released; // Do not update the tuple while holding it.
      });
      await locked;
      authority.queueCommand("turn.start", {}, "expired-owner-work");
      const flushed = authority.flushCheckpoint().then(() => null, error => error);
      await vi.waitFor(async () => {
        const [activity] = await fixture.db.execute(sql`select wait_event_type from pg_stat_activity where pid = ${backend.pid}`);
        expect(activity.wait_event_type).toBe("Lock");
      }, { timeout: 1_000 });
      const [before] = await fixture.db.execute(sql`select lease_expires_at > clock_timestamp() as active
        from native_run_finalizations where run_id = ${fixture.runId}`);
      expect(before.active).toBe(true);
      await fixture.db.execute(sql`select pg_sleep(2.1)`);
      unlock!(); await holder;
      expect(await flushed).toMatchObject({ message: "native_runner_checkpoint_owner_lost" });
      expect((await loadNativeRunnerCheckpoint(fixture.db, binding))?.records).toEqual(saved?.records);
    } finally {
      unlock?.(); await holder;
      await authority.stop(); await closeCheckpointDb(writerDb, 1); await writerDb.$client.end();
    }
  });

  it("keeps requests and liveness queries moving through a bounded checkpoint backlog", async () => {
    const fixtures = await Promise.all([0, 1, 2].map(index => seedRun(`CHECKPOINT-POOL-${index}`)));
    const owner = createDb(temporary.connectionString, { maxConnections: 1, applicationName: "checkpoint-pool-fixture" });
    const authorities: DurablePrpControlPlane[] = [];
    const pending: Promise<void>[] = [];
    let release = () => {};
    let locked: Promise<unknown> | undefined;
    try {
      for (const fixture of fixtures) {
        await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
          controllerGeneration: 1, leaseOwner: "checkpoint-pool-owner", leaseExpiresAt: new Date(Date.now() + 60_000),
        }).where(eq(nativeRunFinalizations.runId, fixture.runId));
        const root = resolve(runtimeRoot, fixture.runId);
        const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
          identity: transportOptions(fixture, root).prpIdentity,
          expectedRunnerVersion: "checkpoint-pool-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
        authorities.push(authority);
        await registerNativeRunnerCheckpoint({ db: owner, binding: { companyId, issueId: fixture.issueId, runId: fixture.runId },
          bootId: successor.bootId, authority });
      }
      let entered!: () => void;
      const acquired = new Promise<void>(resolveReady => { entered = resolveReady; });
      const held = new Promise<void>(resolveRelease => { release = resolveRelease; });
      locked = fixtures[0].db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations)
          .where(inArray(nativeRunFinalizations.runId, fixtures.slice(0, 2).map(fixture => fixture.runId))).for("update");
        entered(); await held;
      });
      await acquired;
      authorities.forEach((authority, index) => {
        authority.queueCommand("session.snapshot", {}, `pool-command-${index}`);
        const writing = authority.flushCheckpoint();
        void writing.catch(() => undefined); // The assertions and cleanup await the original promise below.
        pending.push(writing);
      });
      await vi.waitFor(async () => {
        const [blocked] = await fixtures[0].db.execute(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and application_name in ('paperclip-runner-checkpoint', 'checkpoint-pool-fixture')`);
        expect(Number(blocked.count)).toBeGreaterThan(0);
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const responses = await Promise.race([
          Promise.all([owner.execute(sql`select 1 as ok`), livenessDb(owner).execute(sql`select 1 as ok`)]),
          new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("requests_and_liveness_starved_by_checkpoint_backlog")), 2_000); }),
        ]);
        expect(responses.map(rows => rows[0])).toEqual([{ ok: 1 }, { ok: 1 }]);
      } finally { clearTimeout(deadline); }
      const [connections] = await fixtures[0].db.execute(sql`select count(*)::int as count from pg_stat_activity
        where datname = current_database() and application_name = 'paperclip-runner-checkpoint'
          and pid in (select pid from pg_locks where not granted)`);
      expect(Number(connections.count)).toBe(2);
      release(); await locked;
      await Promise.all(pending);
      for (const [index, fixture] of fixtures.entries()) {
        const checkpoint = await loadNativeRunnerCheckpoint(owner, { companyId, issueId: fixture.issueId, runId: fixture.runId });
        const root = resolve(runtimeRoot, fixture.runId, "restored-pool-checkpoint");
        checkpoint!.restoreSessionDirectory(root);
        const restored = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
          identity: transportOptions(fixture, root).prpIdentity,
          expectedRunnerVersion: "checkpoint-pool-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
        expect(restored.getCommand(`pool-command-${index}`)).toMatchObject({ type: "session.snapshot" });
        await restored.stop();
      }
      await closeCheckpointDb(owner, 1);
      authorities[0].queueCommand("session.snapshot", {}, "late-closed-pool-command");
      await expect(authorities[0].flushCheckpoint()).rejects.toThrow();
      expect((await owner.execute(sql`select 1 as ok`))[0]).toEqual({ ok: 1 });
    } finally {
      release(); await locked;
      await Promise.allSettled(pending);
      await Promise.allSettled(authorities.map(authority => authority.stop()));
      await closeCheckpointDb(owner, 1); await closeLivenessDb(owner, 1);
      await owner.$client.end({ timeout: 1 });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("renews remote ownership while the application pool is saturated and bounds row-lock waits", async () => {
    const fixture = await seedRun("RENEWAL-LIVENESS-POOL");
    const owner = createDb(temporary.connectionString, { maxConnections: 1 });
    const input = { db: owner, runId: fixture.runId, companyId, issueId: fixture.issueId,
      controller: successor, leaseOwner: "liveness-owner", attempt: 1, leaseTtlMs: 60_000 };
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt,
      leaseOwner: input.leaseOwner, attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    let releaseLock: (() => void) | undefined;
    let holder: Promise<void> | undefined;
    let slow: Promise<unknown> | undefined;
    try {
      // Reserve the only application connection before renewing. The liveness
      // pool must make progress without waiting for this application query.
      let busy!: () => void;
      const occupied = new Promise<void>(resolve => { busy = resolve; });
      slow = owner.transaction(async tx => { busy(); await tx.execute(sql`select pg_sleep(3)`); });
      await occupied;
      const started = Date.now();
      await renewNativeSessionExecutionLease(input);
      expect(Date.now() - started).toBeLessThan(2_000);
      await slow;
      let taken!: () => void;
      const locked = new Promise<void>(resolve => { taken = resolve; });
      const released = new Promise<void>(resolve => { releaseLock = resolve; });
      holder = fixture.db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)).for("update");
        taken(); await released;
      });
      await locked;
      const blocked = Date.now();
      await expect(renewNativeSessionExecutionLease(input, { statementTimeoutMs: 200 })).rejects.toMatchObject({ cause: { code: "57014" } });
      expect(Date.now() - blocked).toBeLessThan(2_000);
      releaseLock!(); await holder;
      await expect(renewNativeSessionExecutionLease(input)).resolves.toBeUndefined();
      const [saved] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(saved.leaseOwner).toBe(input.leaseOwner);
      expect(saved.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      // A lock may be released before statement_timeout but after authority
      // expires. The renewal must check wall time after obtaining that lock.
      await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 500) })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      let expiryLockTaken!: () => void;
      const expiryLocked = new Promise<void>(resolve => { expiryLockTaken = resolve; });
      holder = fixture.db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)).for("update");
        expiryLockTaken(); await tx.execute(sql`select pg_sleep(1)`);
      });
      await expiryLocked;
      await expect(renewNativeSessionExecutionLease(input)).rejects.toThrow("native_session_lease_lost");
      await holder;
    } finally {
      releaseLock?.(); await holder; await slow;
      await closeLivenessDb(owner, 1); await owner.$client.end({ timeout: 1 });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("fences plugin warm attachment checkpoints with the current run, including completed-session recovery", async () => {
    const fixture = await seedRun("WARM-CHECKPOINT-CALLBACK");
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    const root = resolve(runtimeRoot, fixture.runId);
    const identity = transportOptions(fixture, root).prpIdentity;
    const artifact = { expectedRunnerVersion: "warm-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` };
    const authority = new DurablePrpControlPlane({ ...artifact, stateDirectory: resolve(root, "control-plane"), identity });
    let admittedRunId = fixture.runId;
    // This is the production callback shared by plugin tasks and built-in drivers.
    // Its closure survives the first run, just as the warm backend does.
    const register = nativeRunnerCheckpointRegistration({ db: fixture.db, binding,
      bootId: successor.bootId, authorityRunId: () => admittedRunId });
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: 1, leaseOwner: "first-warm-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    try {
      await register(authority, identity);
      const saved = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
      const nextRunId = randomUUID();
      await fixture.db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, nativeIssueId: fixture.issueId,
        nativeSessionId: identity.normalizedSessionId, runtimeMode: "native", status: "running", invocationSource: "manual" });
      await fixture.db.insert(nativeRunFinalizations).values({ runId: nextRunId, companyId, issueId: fixture.issueId,
        phase: "observed", controllerBootId: successor.bootId, controllerGeneration: 1,
        leaseOwner: "second-warm-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await fixture.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, fixture.issueId));
      await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      admittedRunId = nextRunId;
      const nextIdentity = { ...identity, runId: nextRunId, turnId: `turn-${nextRunId}`, itemId: `item-${nextRunId}` };
      await register(authority, nextIdentity);
      authority.rotateRunIdentity(nextIdentity);
      authority.queueCommand("session.snapshot", {}, "second-warm-snapshot");
      await authority.flushCheckpoint();
      expect((await loadNativeRunnerCheckpoint(fixture.db, { ...binding, runId: nextRunId }))?.runId).toBe(nextRunId);
      expect((await loadNativeRunnerCheckpoint(fixture.db, binding))?.records).toEqual(saved.records);

      // A replacement adopts the old settled identity before attaching the new
      // run. Only the new run has a live controller lease at this point.
      const recoveredRoot = resolve(runtimeRoot, `recovered-warm-${nextRunId}`);
      saved.restoreSessionDirectory(recoveredRoot);
      const recovered = new DurablePrpControlPlane({ ...artifact, stateDirectory: resolve(recoveredRoot, "control-plane"), identity });
      try {
        await register(recovered, identity);
        recovered.queueCommand("session.snapshot", {}, "restored-warm-snapshot");
        await recovered.flushCheckpoint();
        expect((await loadNativeRunnerCheckpoint(fixture.db, binding))?.records.has("command:1")).toBe(true);
        await fixture.db.update(nativeRunFinalizations).set({ controllerGeneration: 2, leaseOwner: "replacement" })
          .where(eq(nativeRunFinalizations.runId, nextRunId));
        recovered.queueCommand("session.snapshot", {}, "stale-warm-snapshot");
        await expect(recovered.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
      } finally { await recovered.stop(); }
    } finally { await authority.stop(); }
  });

  it.each((["idle", "preparing_successor", "unclaimed_successor", "claimed_successor", "expired_preparation", "dispatching_successor", "foreign_preparation", "foreign_native_preparation", "wrong_issue", "new_work", "replaced_controller", "unaccepted"] as const).flatMap(scenario =>
    (["runner.suspend", "turn.stop"] as const).map(command => ({ scenario, command }))))(
    "settles a completed warm checkpoint during early retirement without granting work: $scenario/$command",
    async ({ scenario, command }) => {
      const fixture = await seedRun(`WARM-EARLY-RETIREMENT-${scenario}-${command}`);
      const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
      const identity = transportOptions(fixture, runtimeRoot).prpIdentity;
      const authority = new DurablePrpControlPlane({
        stateDirectory: resolve(runtimeRoot, fixture.runId, "early-retirement", "control-plane"),
        identity, expectedRunnerVersion: "warm-retirement-fixture",
        expectedRunnerDigest: `sha256:${"a".repeat(64)}`,
      });
      await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
        controllerGeneration: 1, leaseOwner: "completed-warm-owner", leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      try {
        await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
        const [run] = await fixture.db.select({ completionContractId: heartbeatRuns.completionContractId })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        if (!run?.completionContractId) throw new Error("Prepared warm run has no completion contract");
        const resultId = randomUUID();
        await fixture.db.insert(nativeRunResults).values({
          id: resultId, ...binding, turnId: identity.turnId, completionContractId: run.completionContractId,
          serverFingerprint: `completed-warm-${scenario}`, schemaStatus: "accepted",
          resultJson: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed warm turn." },
          canonicalSha256: "a".repeat(64),
        });
        await fixture.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: scenario === "unaccepted" ? null : resultId,
          leaseOwner: null, leaseExpiresAt: null,
          ...(scenario === "replaced_controller" ? { controllerBootId: randomUUID(), controllerGeneration: 2 } : {}),
        }).where(eq(nativeRunFinalizations.runId, fixture.runId));

        let nextRunId: string | null = null;
        if (scenario !== "idle") {
          nextRunId = randomUUID();
          const preparing = scenario !== "claimed_successor" && scenario !== "unclaimed_successor";
          const otherIssue = scenario === "wrong_issue" ? (await seedRun(`WARM-OTHER-ISSUE-${command}`)).issueId : fixture.issueId;
          await fixture.db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId,
            issueId: otherIssue, scopeKind: "issue", contextSnapshot: { issueId: otherIssue },
            ...(preparing ? { runtimeMode: "legacy", executionStage: scenario === "dispatching_successor" ? "dispatching" : "preparing",
              controllerBootId: scenario === "foreign_preparation" ? randomUUID() : legacyControllerBootId,
              controllerLeaseExpiresAt: scenario === "expired_preparation" ? new Date(0) : new Date(Date.now() + 60_000),
              ...(scenario === "foreign_native_preparation" ? { nativeIssueId: fixture.issueId } : {}),
            } : { runtimeMode: "native", nativeIssueId: fixture.issueId, nativeSessionId: randomUUID() }),
            status: "running", invocationSource: "manual" });
          if (!preparing || scenario === "foreign_native_preparation") await fixture.db.insert(nativeRunFinalizations).values({ runId: nextRunId, companyId, issueId: fixture.issueId,
              phase: "observed", ...(scenario === "claimed_successor" || scenario === "foreign_native_preparation" ? {
                controllerBootId: scenario === "foreign_native_preparation" ? randomUUID() : successor.bootId,
                controllerGeneration: 1, leaseOwner: "next-warm-owner", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
            });
        }
        await fixture.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, fixture.issueId));
        const before = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
        authority.queueCommand(scenario === "new_work" ? "turn.start" : command, {}, `early-retirement-${scenario}`);
        if (!["idle", "preparing_successor", "claimed_successor"].includes(scenario)) {
          await expect(authority.flushCheckpoint()).rejects.toThrow("native_runner_checkpoint_owner_lost");
          expect((await loadNativeRunnerCheckpoint(fixture.db, binding))?.records).toEqual(before.records);
        } else {
          await expect(authority.flushCheckpoint()).resolves.toBeUndefined();
          const saved = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
          const restoredRoot = resolve(runtimeRoot, fixture.runId, "retirement-proof");
          saved.restoreSessionDirectory(restoredRoot);
          const restored = JSON.parse(await readFile(resolve(restoredRoot, "control-plane", "control-plane-state.json"), "utf8"));
          expect(restored.identity).toEqual(identity);
          expect(restored.commands).toContainEqual(expect.objectContaining({ type: command, status: "pending" }));
        }
        const [task] = await fixture.db.select({ executionRunId: issues.executionRunId }).from(issues)
          .where(eq(issues.id, fixture.issueId));
        expect(task.executionRunId).toBe(nextRunId);
      } finally { await authority.stop(); }
    },
  );

  realProcessIt("durably retires an accepted warm Runner while its same-controller successor prepares", async () => {
    const fixture = await seedRun("REAL-WARM-RETIREMENT");
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    const root = resolve(runtimeRoot, fixture.runId, "real-retirement");
    const options = transportOptions(fixture, root);
    const retirementController = await currentNativeControllerIdentity();
    const diagnostics: string[] = [], checkpointFailures: unknown[] = [];
    let authority!: DurablePrpControlPlane;
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: retirementController.bootId,
      controllerGeneration: 1, leaseOwner: "real-retirement-owner", leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const transport = createRunnerdCodexTransport({ ...options,
      codexArgs: [...options.codexArgs, "--linger-after-turn-start"],
      onDiagnostic: message => diagnostics.push(message),
      controlPlaneRegistration: async core => {
        authority = core;
        const write = nativeRunnerCheckpointWriter(fixture.db, { ...binding, authorityRunId: fixture.runId,
          bootId: retirementController.bootId, generation: 1, leaseOwner: "real-retirement-owner" });
        core.setCheckpointPersistence(async checkpoint => {
          try { await write(checkpoint); }
          catch (error) { checkpointFailures.push(error); throw error; }
        });
        return registerRunnerPrpAuthority({ ...binding, authority: core });
      },
    });
    let runnerPid: number | null = null, providerPid: number | null = null;
    try {
      await transport.transport.request("thread/start", { cwd: root, dynamicTools: [] });
      await transport.transport.request("turn/start", { input: [{ type: "text", text: "Keep the provider alive after accepting its result." }] });
      runnerPid = transport.evidence().runnerPid;
      providerPid = transport.evidence().providerPid;
      expect(runnerPid).toEqual(expect.any(Number));
      expect(providerPid).toEqual(expect.any(Number));
      await waitForCondition("active real provider before accepted-result retirement", () =>
        authority.store.state.committedEvents.some(event => event.eventType === "turn.started"));
      await authority.flushCheckpoint();
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const resultId = randomUUID();
      await fixture.db.insert(nativeRunResults).values({ id: resultId, ...binding, turnId: options.prpIdentity.turnId,
        completionContractId: run.completionContractId!, serverFingerprint: "real-retirement-accepted",
        schemaStatus: "accepted", canonicalSha256: "a".repeat(64),
        resultJson: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Accepted before provider cleanup." },
      });
      await fixture.db.update(nativeRunFinalizations).set({ phase: "committed", resultId, leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      await fixture.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, fixture.runId));
      const nextRunId = randomUUID();
      const [nextRun] = await fixture.db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId,
        issueId: fixture.issueId, nativeIssueId: fixture.issueId, scopeKind: "issue", status: "running", runtimeMode: "native",
        invocationSource: "assignment", contextSnapshot: { issueId: fixture.issueId } }).returning();
      const next = await prepareNativeHeartbeatRun({ db: fixture.db, run: nextRun,
        issue: { id: fixture.issueId, title: "Next conversation", description: null }, environmentLeaseId: randomUUID() });
      await fixture.db.insert(nativeRunFinalizations).values({ runId: nextRunId, companyId, issueId: fixture.issueId, phase: "observed" });
      await fixture.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, fixture.issueId));
      const [contract] = await fixture.db.select().from(completionContracts).where(eq(completionContracts.id, run.completionContractId!));
      const nextExecution = buildNativeExecutionInput({ companyId, agentId, runId: nextRunId,
        issue: { id: fixture.issueId, identifier: "NRR-NATIVE-RETIREMENT", title: "Next conversation", description: null, workMode: "standard" },
        taskPrompt: "Start only after the previous provider durably suspends.",
        workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null },
        normalizedSessionId: next.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: contract.schemaVersion, contract: contract.contractJson as never },
      });
      const fixtureStoppedAfterRealClaim = new Error("fixture stopped before next provider dispatch");
      await expect(executePaperclipNativeSession({ db: fixture.db, execution: nextExecution, runnerInstanceId: next.runnerInstanceId,
        onExecutionLeaseAcquired: async () => {
          const [claimed] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, nextRunId));
          expect(claimed.controllerBootId).toBe(retirementController.bootId);
          expect(claimed.leaseOwner).toEqual(expect.any(String));
          expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
          await expect(transport.transport.close(), diagnostics.join("\n")).resolves.toBeUndefined();
          throw fixtureStoppedAfterRealClaim;
        },
      })).rejects.toBe(fixtureStoppedAfterRealClaim);
      expect(checkpointFailures).toEqual([]);
      const state = JSON.parse(await readFile(resolve(root, "runner", "runner-state.json"), "utf8"));
      expect(state).toMatchObject({ lifecycle: "suspended", runId: fixture.runId,
        normalizedSessionId: options.prpIdentity.normalizedSessionId, runnerInstanceId: options.prpIdentity.runnerInstanceId });
      const saved = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
      const commands = [...saved.records].filter(([key]) => key.startsWith("command:")).map(([, value]) => JSON.parse(value));
      for (const type of ["turn.stop", "runner.drain", "runner.suspend"]) {
        expect(commands, diagnostics.join("\n")).toContainEqual(expect.objectContaining({ type, status: "completed" }));
      }
      expect(commands.filter(command => command.type === "turn.start")).toHaveLength(1);
      const [task] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      expect(task.executionRunId).toBe(nextRunId);
    } catch (error) {
      throw new Error(`${String(error)}; owned retirement diagnostics ${JSON.stringify({
        checkpointFailures: checkpointFailures.map(String), diagnostics,
        commands: authority?.store.state.commands.map(({ type, status }) => ({ type, status })),
      })}`);
    } finally {
      await transport.transport.close().catch(() => undefined);
      if (providerPid && processAlive(providerPid)) process.kill(providerPid, "SIGKILL");
      await stopOwnedProcessGroup(runnerPid, root).catch(() => undefined);
    }
  }, 45_000);

  it("applies checkpoint deltas in Postgres without rewriting authority and removes only evicted events", async () => {
    const fixture = await seedRun("CHECKPOINT-DELTA");
    const root = resolve(runtimeRoot, fixture.runId);
    const options = transportOptions(fixture, root);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: 1, leaseOwner: "delta-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: options.prpIdentity, expectedRunnerVersion: "delta-test", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const event = (sourceSeq: number) => ({ sourceSeq, sourceEventId: `control-${sourceSeq}`, eventType: "item.completed",
      priority: 2 as const, envelope: { text: "output" }, deliveryCount: 1, logicalEffectCount: 1 as const });
    try {
      await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
      const saved = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
      const records = new Map(saved.records);
      const cursor = JSON.parse(records.get("cursor")!);
      for (const seq of [1, 2]) records.set(`event:${seq}`, JSON.stringify(event(seq)));
      records.set("cursor", JSON.stringify({ ...cursor, ackedSourceSeq: 2, eventCount: 2 }));
      const write = nativeRunnerCheckpointWriter(fixture.db, { ...binding, authorityRunId: fixture.runId,
        bootId: successor.bootId, generation: 1, leaseOwner: "delta-controller" });
      await write(decodeDurablePrpCheckpoint(records));
      const before = await fixture.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, fixture.runId));
      records.delete("event:1");
      records.set("event:3", JSON.stringify(event(3)));
      records.set("cursor", JSON.stringify({ ...cursor, ackedSourceSeq: 3, eventCount: 2 }));
      await write({ ...decodeDurablePrpCheckpoint(records), reset: false, removedRecords: ["event:1"],
        changedRecords: new Map(["event:3", "cursor"].map(key => [key, records.get(key)!])) });
      const after = await fixture.db.select().from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, fixture.runId));
      for (const part of ["header", "event:2"]) {
        expect(after.find(row => row.part === part)).toEqual(before.find(row => row.part === part));
      }
      expect(after.map(row => row.part).sort()).toEqual(["cursor", "event:2", "event:3", "header"]);
      const restored = await loadNativeRunnerCheckpoint(fixture.db, binding);
      expect(JSON.parse(restored!.records.get("cursor")!).ackedSourceSeq).toBe(3);
      expect(restored!.records.has("event:1")).toBe(false);
    } finally {
      await authority.stop();
    }
  });

  it.each([null, process.pid])("claims sandbox recovery without interpreting remote PID %s locally", async (remotePid) => {
    const fixture = await seedRun(`remote-${remotePid ?? "warm"}`);
    await fixture.db.update(heartbeatRuns).set({
      processPid: remotePid,
      processStartedAt: new Date("2020-01-01T00:00:00Z"),
      runnerProfileJson: {
        nativeWorkspaceSync: {
          schema: "paperclip.native-workspace-sync/v1", state: "prepared",
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
          workspaceId: "workspace", leaseId: "lease", providerLeaseId: "sandbox",
          remoteCwd: "/workspace",
        },
        sessionCheckpoint: {
          identity: { companyId, agentId, issueId: fixture.issueId, runId: fixture.runId,
            sessionId: fixture.native.normalizedSessionId },
          providerSessionId: "provider-session",
          process: { providerPid: process.pid },
        },
      },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "graceful", runIds: [fixture.runId] });
    expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: fixture.runId,
      providerAttempt: 0, remote: { providerLeaseId: "sandbox", remoteCwd: "/workspace" } });
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator?.recoveryState).toBe("awaiting_runner_reattach");
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run?.status).toBe("running");
    expect(run?.processPid).toBe(remotePid);
  });

  it.each(["running", "interrupted-stop", "interrupted-no-intent", "interrupted-foreign-intent", "interrupted-missing-audit", "interrupted-foreign-owner", "interrupted-terminal", "interrupted-no-checkpoint"])("gives only eligible recovery a full lease after an old batch observation (%s)", async mode => {
    const fixture = await seedRun(`LATE-BATCH-CLAIM-${mode}`);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    const root = resolve(runtimeRoot, fixture.runId);
    const observedAt = new Date(Date.now() - 90_000);
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId: "workspace",
        leaseId: "lease", providerLeaseId: "sandbox", remoteCwd: "/workspace" },
      sessionCheckpoint: { identity: { ...binding, agentId, sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "surviving-provider" },
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerGeneration: 1, leaseOwner: "previous-batch-owner", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
      identity: transportOptions(fixture, root).prpIdentity,
      expectedRunnerVersion: "late-batch-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    try {
      await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId: successor.bootId, authority });
      // Set up an abandoned predecessor. Never alter the successor's deadline.
      await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(observedAt.getTime() - 1_000) })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (mode !== "running") {
        const intentAuditId = randomUUID(), requestedAt = new Date().toISOString();
        await fixture.db.insert(activityLog).values({ id: intentAuditId, companyId, actorType: "system", actorId: "native-session-cancellation",
          action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: fixture.runId, runId: fixture.runId, agentId });
        await fixture.db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: new Date(),
          errorCode: "lease_released_before_terminal", resultJson: {
            cancelledByActorType: "user", cancelledByUserId: "test-board",
            cancellation: { expected: true, initiator: { type: "user" }, reason: "Operator requested Stop" },
            startupCancellation: { beforeNativeSelection: false, requestedAt, errorCode: "cancelled" },
            executionCancellation: { state: "requested", requestedAt },
            nativeCancellation: { schema: "paperclip.native-cancellation.v1", ...binding,
              ...(mode === "interrupted-foreign-intent" ? { issueId: randomUUID() } : {}), scope: "run", reasonCode: "cancellation_run_only",
              intentId: `native-cancellation:${randomUUID()}`, intentAuditId: mode === "interrupted-missing-audit" ? randomUUID() : intentAuditId, dispatchState: "pending", dispatched: false,
              effects: ["release_run_resources"] },
          } }).where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, fixture.issueId));
        if (mode === "interrupted-no-intent") await fixture.db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, fixture.runId));
        if (mode === "interrupted-foreign-owner") {
          const other = await seedRun(`OTHER-${mode}`);
          await fixture.db.update(issues).set({ executionRunId: other.runId }).where(eq(issues.id, fixture.issueId));
        }
        if (mode === "interrupted-terminal") await fixture.db.update(nativeRunFinalizations).set({ phase: "terminal_failure" })
          .where(eq(nativeRunFinalizations.runId, fixture.runId));
        if (mode === "interrupted-no-checkpoint") await fixture.db.update(heartbeatRuns).set({
          runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - 'sessionCheckpoint'`,
        }).where(eq(heartbeatRuns.id, fixture.runId));
      }
      const controller = { ...successor, bootId: randomUUID() };
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller,
        restartKind: "hard", now: observedAt, runIds: [fixture.runId] });
      if (mode !== "running" && mode !== "interrupted-stop") {
        expect(["reattach_existing_runner", "reattach_remote_runner", "resume_dead_runner", "bootstrap_incomplete"]).not.toContain(claim?.kind);
        const [unchanged] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        expect(unchanged.status).toBe("interrupted");
        const [owner] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        expect(owner.controllerGeneration).toBe(1);
        expect(owner.leaseOwner).toBe("previous-batch-owner");
        return;
      }
      expect(claim).toMatchObject({ kind: "reattach_remote_runner", runId: fixture.runId });
      if (!("leaseOwner" in claim)) throw new Error("Expected a recovery claim");
      const [saved] = await fixture.db.execute(sql`select extract(epoch from (lease_expires_at - clock_timestamp())) as remaining
        from native_run_finalizations where run_id = ${fixture.runId}`);
      expect(Number(saved.remaining)).toBeGreaterThan(55);
      expect(Number(saved.remaining)).toBeLessThanOrEqual(60);
      await expect(renewNativeSessionExecutionLease({ db: fixture.db, ...binding, controller,
        leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, leaseTtlMs: 60_000 })).resolves.toBeUndefined();
    } finally { await authority.stop(); }
  });

  realProcessIt("adopts one active runner across hot and hard controller restarts without duplicating steering", async () => {
    const fixture = await seedRun("LIVE");
    const stateDirectory = resolve(runtimeRoot, fixture.runId);
    const baseOptions = transportOptions(fixture, stateDirectory);
    const options = {
      ...baseOptions,
      codexArgs: [...baseOptions.codexArgs, "--linger-after-turn-start"],
    };
    const first = createRunnerdCodexTransport(options);
    let runnerPid: number | null = null;
    let adopted: ReturnType<typeof createRunnerdCodexTransport> | null = null;
    let adoptedAfterHardRestart:
      | ReturnType<typeof createRunnerdCodexTransport>
      | null = null;
    try {
      const started = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      });
      const thread = started.thread as Record<string, unknown>;
      const turnStarted = await first.transport.request("turn/start", {
        input: [{ type: "text", text: "Hold this turn across restarts." }],
      });
      const providerTurnId = String(
        (turnStarted.turn as Record<string, unknown>).id,
      );
      await first.transport.request("turn/steer", {
        input: [{ type: "text", text: "before hot restart" }],
        expectedTurnId: providerTurnId,
        correlationId: "steer-before-hot",
      });
      runnerPid = first.evidence().runnerPid;
      if (!runnerPid) throw new Error("Real runner PID was not observed");
      await persistRestartEvidence({
        fixture,
        runnerPid,
        processGroupId: first.evidence().runnerProcessGroupId,
        providerPid: first.evidence().providerPid,
        providerSessionId: String(thread.id),
      });

      await first.detachControllerForRestart();
      const [claim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hot",
        recoveryRequestId: "hot-restart-request",
        now: new Date(),
        runIds: [fixture.runId],
      });
      expect(claim).toMatchObject({
        kind: "reattach_existing_runner",
        runId: fixture.runId,
        controllerGeneration: 2,
        providerAttempt: 0,
        process: { pid: runnerPid },
      });
      if (!claim || claim.kind !== "reattach_existing_runner") {
        throw new Error("Expected live-runner recovery claim");
      }

      const duplicateLauncher = vi.fn(() => {
        throw new Error("duplicate runner spawn attempted");
      });
      adopted = createRunnerdCodexTransport({
        ...options,
        resumeDynamicTools: [],
        runnerProcessLauncher: duplicateLauncher,
        adoptExistingRunner: {
          ...claim.process,
          isAlive: () => processAlive(runnerPid),
        },
      });
      const restored = await adopted.transport.request("thread/read", {});
      expect(restored.thread).toMatchObject({
        id: thread.id,
        turns: [{ id: providerTurnId, status: "inProgress" }],
      });
      expect(adopted.evidence().runnerPid).toBe(runnerPid);
      expect(duplicateLauncher).not.toHaveBeenCalled();
      await adopted.transport.request("turn/steer", {
        input: [{ type: "text", text: "after hot restart" }],
        expectedTurnId: providerTurnId,
        correlationId: "steer-after-hot",
      });

      await adopted.detachControllerForRestart();
      const hardRestartController: NativeControllerIdentity = {
        ...successor,
        bootId: randomUUID(),
      };
      await fixture.db
        .update(nativeRunFinalizations)
        .set({
          controllerPid: 2_000_000_001,
          controllerProcessStartedAt: new Date(
            "2026-09-04T11:30:00.000Z",
          ),
        })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      const [hardClaim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: hardRestartController,
        restartKind: "hard",
        now: new Date(),
        runIds: [fixture.runId],
      });
      expect(hardClaim).toMatchObject({
        kind: "reattach_existing_runner",
        runId: fixture.runId,
        controllerGeneration: 3,
        providerAttempt: 0,
        process: { pid: runnerPid },
      });
      if (!hardClaim || hardClaim.kind !== "reattach_existing_runner") {
        throw new Error("Expected second live-runner recovery claim");
      }
      const secondDuplicateLauncher = vi.fn(() => {
        throw new Error("duplicate runner spawn attempted after hard restart");
      });
      adoptedAfterHardRestart = createRunnerdCodexTransport({
        ...options,
        resumeDynamicTools: [],
        runnerProcessLauncher: secondDuplicateLauncher,
        adoptExistingRunner: {
          ...hardClaim.process,
          isAlive: () => processAlive(runnerPid),
        },
      });
      await expect(
        adoptedAfterHardRestart.transport.request("thread/read", {}),
      ).resolves.toMatchObject({
        thread: {
          id: thread.id,
          turns: [{ id: providerTurnId, status: "inProgress" }],
        },
      });
      await adoptedAfterHardRestart.transport.request("turn/steer", {
        input: [{ type: "text", text: "after hard restart" }],
        expectedTurnId: providerTurnId,
        correlationId: "steer-after-hard",
      });
      expect(adoptedAfterHardRestart.evidence().runnerPid).toBe(runnerPid);
      expect(secondDuplicateLauncher).not.toHaveBeenCalled();
      const providerCalls = await readFile(
        resolve(stateDirectory, "fake-codex-calls.log"),
        "utf8",
      );
      expect(providerCalls.match(/^turn\/start$/gm)).toHaveLength(1);
      expect(providerCalls.match(/^turn\/steer$/gm)).toHaveLength(3);
      expect(
        await fixture.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.retryOfRunId, fixture.runId),
              eq(heartbeatRuns.companyId, companyId),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await adoptedAfterHardRestart?.transport.close().catch(() => undefined);
      await adopted?.transport.close().catch(() => undefined);
      await stopOwnedProcessGroup(runnerPid, stateDirectory).catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 45_000);

  realProcessIt.each([
    ["hard", "current"],
    ["hot", "historical"],
    ["hot", "unregistered"],
  ] as const)("%s-restarts a dead runner with a %s prompt on the same run and provider session", async (restartKind, promptKind) => {
    const fixture = await seedRun(`DEAD-${promptKind}`);
    const context = nativeRuntimeContextFixture();
    const runtimeContext = { ...context, prompt: promptKind === "current"
      ? context.prompt
      : promptKind === "historical" ? historicalPrompt : unregisteredPrompt };
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const execution = { ...buildNativeExecutionInput({
      companyId,
      runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: `NRR-DEAD-${promptKind}`, title: "Recover a dead runner", description: null, workMode: "standard" },
      taskPrompt: "Resume this active turn after process loss.",
      agentId,
      workspace: { id: fixture.runId, cwd: tmpdir(), repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId,
      provider: "codex",
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Recover the same turn", criteria: [{ id: "objective", requirement: "Resume without a duplicate turn" }] } },
      runtimeContext: context,
    }), runtimeContext };
    const stateDirectory = resolve(runtimeRoot, fixture.runId);
    const baseOptions = transportOptions(fixture, stateDirectory);
    const options = {
      ...baseOptions,
      codexArgs: [...baseOptions.codexArgs, "--linger-after-turn-start"],
    };
    const first = createRunnerdCodexTransport(options);
    let firstRunnerPid: number | null = null;
    let recoveredRunnerPid: number | null = null;
    let restored: ReturnType<typeof createRunnerdCodexTransport> | null = null;
    try {
      const started = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
        baseInstructions: runtimeContext.prompt.text,
      });
      const thread = started.thread as Record<string, unknown>;
      const turnStarted = await first.transport.request("turn/start", {
        input: [{ type: "text", text: "Resume this active turn after process loss." }],
      });
      const providerTurnId = String(
        (turnStarted.turn as Record<string, unknown>).id,
      );
      firstRunnerPid = first.evidence().runnerPid;
      if (!firstRunnerPid) throw new Error("Real runner PID was not observed");
      const providerPid = first.evidence().providerPid;
      await persistRestartEvidence({
        fixture,
        runnerPid: firstRunnerPid,
        processGroupId: first.evidence().runnerProcessGroupId,
        providerPid,
        providerSessionId: String(thread.id),
      });
      const [persistedRun] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      await fixture.db.update(heartbeatRuns).set({
        runnerProfileJson: { ...persistedRun.runnerProfileJson, nativeExecutionInput: execution },
      }).where(eq(heartbeatRuns.id, fixture.runId));

      await first.detachControllerForRestart();
      await stopOwnedProcessGroup(firstRunnerPid, stateDirectory);
      await waitForCondition(
        "provider process to observe runner pipe closure",
        () => !processAlive(providerPid),
      );

      const [claim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind,
        now: new Date(),
        runIds: [fixture.runId],
      });
      expect(claim).toMatchObject({
        kind: "resume_dead_runner",
        runId: fixture.runId,
        controllerGeneration: 2,
        providerAttempt: 0,
      });
      if (!claim || claim.kind !== "resume_dead_runner") {
        throw new Error("Expected dead-runner recovery claim");
      }
      expect(await hasNativeLocalProcessStop(fixture.db, companyId, fixture.runId)).toBe(true);
      const [stoppedRun] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(stoppedRun.processPid).toBeNull();
      expect(stoppedRun.processGroupId).toBeNull();
      // executeRun reads this immutable input before resuming after a restart.
      const recoveredExecution = parseNativeExecutionInput(stoppedRun.runnerProfileJson?.nativeExecutionInput);
      if (!("runtimeContext" in recoveredExecution)) throw new Error("Expected a pinned runtime context");
      expect(recoveredExecution.binding).toEqual(execution.binding);
      expect(recoveredExecution.session).toEqual(execution.session);
      expect(recoveredExecution.runtimeContext).toEqual(runtimeContext);

      restored = createRunnerdCodexTransport({
        ...options,
        resumeDynamicTools: [],
      });
      const recovered = await restored.transport.request("thread/read", {});
      recoveredRunnerPid = restored.evidence().runnerPid;
      expect(recovered.thread).toMatchObject({
        id: thread.id,
        turns: [{ id: providerTurnId, status: "inProgress" }],
      });
      expect(recoveredRunnerPid).toEqual(expect.any(Number));
      expect(recoveredRunnerPid).not.toBe(firstRunnerPid);
      const providerCalls = await readFile(
        resolve(stateDirectory, "fake-codex-calls.log"),
        "utf8",
      );
      expect(providerCalls.match(/^turn\/start$/gm)).toHaveLength(1);
      expect(
        await fixture.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, fixture.runId)),
      ).toHaveLength(0);
    } finally {
      await restored?.transport.close().catch(() => undefined);
      await stopOwnedProcessGroup(recoveredRunnerPid, stateDirectory).catch(
        () => undefined,
      );
      await stopOwnedProcessGroup(firstRunnerPid, stateDirectory).catch(
        () => undefined,
      );
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 45_000);

  realProcessIt("quarantines a pre-auth runner root and bootstraps the same run", async () => {
    const fixture = await seedRun("BOOTSTRAP");
    const stateDirectory = resolve(runtimeRoot, fixture.runId);
    const baseOptions = transportOptions(fixture, stateDirectory);
    const transport = createRunnerdCodexTransport({
      ...baseOptions,
      runnerReconnectGraceMs: 60_000,
      controlPlaneRegistration: async () => ({
        connectUrl: "ws://127.0.0.1:9/api/runner/prp/unreachable",
        release: () => undefined,
      }),
    });
    let runnerPid: number | null = null;
    let replacementRunnerPid: number | null = null;
    let replacement: ReturnType<typeof createRunnerdCodexTransport> | null =
      null;
    const quarantineDirectory = `${stateDirectory}.bootstrap-incomplete`;
    const starting = transport.transport
      .request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      await waitForCondition("pre-auth runner spawn", () => {
        runnerPid = transport.evidence().runnerPid;
        return processAlive(runnerPid);
      });
      if (!runnerPid) throw new Error("Pre-auth runner PID was not observed");
      await persistUnconnectedRunner({
        fixture,
        runnerPid,
        processGroupId: transport.evidence().runnerProcessGroupId,
      });
      await stopOwnedProcessGroup(runnerPid, stateDirectory);
      await expect(starting).resolves.toBeInstanceOf(Error);

      const durable = JSON.parse(
        await readFile(
          resolve(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(durable).toMatchObject({
        connectionCount: 0,
        committedEvents: [],
      });
      const [claim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hard",
        now: new Date(),
        runIds: [fixture.runId],
      });
      expect(claim).toMatchObject({
        kind: "bootstrap_incomplete",
        runId: fixture.runId,
        controllerGeneration: 2,
        providerAttempt: 0,
      });
      if (!claim || claim.kind !== "bootstrap_incomplete") {
        throw new Error("Expected incomplete-bootstrap recovery claim");
      }

      await transport.transport.close();
      await rename(stateDirectory, quarantineDirectory);
      replacement = createRunnerdCodexTransport(baseOptions);
      const restarted = await replacement.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      });
      replacementRunnerPid = replacement.evidence().runnerPid;
      expect(restarted.thread).toMatchObject({ id: expect.any(String) });
      expect(replacementRunnerPid).toEqual(expect.any(Number));
      expect(replacementRunnerPid).not.toBe(runnerPid);
      expect(processAlive(replacementRunnerPid)).toBe(true);
      expect(existsSync(quarantineDirectory)).toBe(true);
      expect(existsSync(stateDirectory)).toBe(true);
      const replacementDurable = JSON.parse(
        await readFile(
          resolve(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(replacementDurable).toMatchObject({
        identity: {
          runId: fixture.runId,
          normalizedSessionId: fixture.native.normalizedSessionId,
          runnerInstanceId: fixture.native.runnerInstanceId,
          environmentLeaseId: fixture.native.environmentLeaseId,
        },
      });
      await expect(
        fixture.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, fixture.runId)),
      ).resolves.toHaveLength(0);
    } finally {
      await replacement?.transport.close().catch(() => undefined);
      await transport.transport.close().catch(() => undefined);
      await starting;
      await stopOwnedProcessGroup(replacementRunnerPid, stateDirectory).catch(
        () => undefined,
      );
      await stopOwnedProcessGroup(runnerPid, stateDirectory).catch(
        () => undefined,
      );
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(quarantineDirectory, { recursive: true, force: true });
    }
  }, 45_000);

  it("prioritizes an already-proposed durable result over runner recovery", async () => {
    const fixture = await seedRun("RESULT");
    const [persistedRun] = await fixture.db
      .select({ completionContractId: heartbeatRuns.completionContractId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.runId));
    if (!persistedRun?.completionContractId) {
      throw new Error("Prepared native run has no completion contract");
    }
    const resultId = randomUUID();
    await fixture.db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: fixture.issueId,
      runId: fixture.runId,
      turnId: fixture.native.turnId,
      completionContractId: persistedRun.completionContractId,
      callerResultId: "result-before-restart",
      callerDedupeKey: "result-before-restart",
      serverFingerprint: "result-before-restart",
      schemaStatus: "accepted",
      resultJson: {
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "done",
        summary: "Durable result proposed before restart.",
      },
      canonicalSha256: "a".repeat(64),
    });
    await fixture.db
      .update(nativeRunFinalizations)
      .set({
        phase: "result_persisted",
        resultId,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));

    await expect(
      claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hot",
        recoveryRequestId: "result-race-restart",
        now: new Date(),
        runIds: [fixture.runId],
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.db
        .select({ id: nativeRunResults.id })
        .from(nativeRunResults)
        .where(eq(nativeRunResults.runId, fixture.runId)),
    ).resolves.toEqual([{ id: resultId }]);
    await expect(
      fixture.db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, fixture.runId)),
    ).resolves.toHaveLength(0);
  });

  it("preserves a future same-run provider recovery wake instead of consuming it during startup", async () => {
    const fixture = await seedRun("SCHEDULED");
    const now = new Date();
    const nextAttemptAt = new Date(now.getTime() + 60_000);
    await fixture.db
      .update(nativeRunFinalizations)
      .set({
        phase: "retryable_failure",
        attempt: 1,
        nextAttemptAt,
        recoveryState: "resuming_session",
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));

    await expect(
      claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hard",
        now,
        runIds: [fixture.runId],
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.db
        .select({
          phase: nativeRunFinalizations.phase,
          attempt: nativeRunFinalizations.attempt,
          nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
          recoveryState: nativeRunFinalizations.recoveryState,
        })
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId)),
    ).resolves.toEqual([
      {
        phase: "retryable_failure",
        attempt: 1,
        nextAttemptAt,
        recoveryState: "resuming_session",
      },
    ]);
  });

  it("fails closed for a live recycled PID without signalling or spawning", async () => {
    const fixture = await seedRun("MISMATCH");
    const stateDirectory = resolve(runtimeRoot, fixture.runId);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", stateDirectory],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
      },
    );
    child.unref();
    const pid = child.pid ?? null;
    if (!pid) throw new Error("Failed to launch mismatch sentinel");
    try {
      await waitForCondition("mismatch sentinel startup", () => processAlive(pid));
      const observedStart = await readProcessStartedAt(pid);
      if (!observedStart) throw new Error("Sentinel fingerprint unavailable");
      await fixture.db
        .update(heartbeatRuns)
        .set({
          processPid: pid,
          processGroupId: process.platform === "win32" ? null : pid,
          processStartedAt: new Date(
            new Date(observedStart).getTime() - 60_000,
          ),
        })
        .where(eq(heartbeatRuns.id, fixture.runId));

      const [disposition] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hard",
        now: new Date(),
        runIds: [fixture.runId],
      });
      expect(disposition).toEqual({
        kind: "blocked",
        runId: fixture.runId,
        reason: "live_runner_identity_mismatch",
      });
      expect(processAlive(pid)).toBe(true);
      expect(existsSync(stateDirectory)).toBe(false);
      await expect(
        fixture.db
          .select({ recoveryState: nativeRunFinalizations.recoveryState })
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, fixture.runId)),
      ).resolves.toEqual([{ recoveryState: "blocked" }]);
      await expect(
        fixture.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, fixture.runId)),
      ).resolves.toHaveLength(0);
    } finally {
      await stopOwnedProcessGroup(pid, stateDirectory).catch(() => undefined);
    }
  });

  it("allows only one of two concurrent successor controllers to claim a dead session", async () => {
    const fixture = await seedRun("CONCURRENT");
    const now = new Date();
    await fixture.db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          sessionCheckpoint: {
            sessionId: fixture.native.normalizedSessionId,
            identity: {
              companyId,
              issueId: fixture.issueId,
              runId: fixture.runId,
              agentId,
              sessionId: fixture.native.normalizedSessionId,
            },
            providerSessionId: "provider-concurrent",
            providerIdentity: {
              kind: "codex",
              providerSessionId: "provider-concurrent",
            },
          },
        },
      })
      .where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db
      .update(nativeRunFinalizations)
      .set({
        leaseOwner: "dead-controller",
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        controllerBootId: "dead-controller-boot",
        controllerHostHash: await knownFixtureControllerHostHash(),
        controllerPid: 2_000_000_002,
        controllerProcessStartedAt: new Date("2026-09-04T10:00:00.000Z"),
        controllerGeneration: 4,
      })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));

    const controllers = [
      successor,
      { ...successor, bootId: randomUUID() },
    ];
    const dispositions = (
      await Promise.all(
        controllers.map((controller) =>
          claimNativeRestartRecoveries({
            db: fixture.db,
            controller,
            restartKind: "hard",
            now,
            runIds: [fixture.runId],
          }),
        ),
      )
    ).flat();
    expect(
      dispositions.filter((entry) => entry.kind === "resume_dead_runner"),
    ).toHaveLength(1);
    expect(
      dispositions.filter((entry) => entry.kind === "awaiting_evidence"),
    ).toHaveLength(1);
    await expect(
      fixture.db
        .select({
          controllerGeneration: nativeRunFinalizations.controllerGeneration,
          providerAttempt: nativeRunFinalizations.attempt,
        })
        .from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId)),
    ).resolves.toEqual([
      { controllerGeneration: 5, providerAttempt: 0 },
    ]);
  });

  it.each(["stopped", "fenced"] as const)("keeps foreign local Runner and provider ownership after its controller is %s", async state => {
    const fixture = await seedRun(`FOREIGN-LOCAL-${state}-${randomUUID()}`);
    const oldBoot = randomUUID(), foreignSpace = `foreign:${currentProcessSpaceHash()}`;
    const runnerPid = 2_000_000_001, runnerGroup = 2_000_000_002, providerPid = 2_000_000_003;
    const controllerPid = 2_000_000_004, startedAt = new Date(Date.now() - 600_000);
    // Historical in-flight local execution on the other process space. A
    // controller-instance stop/fence says nothing about these saved children.
    await fixture.db.update(heartbeatRuns).set({ processPid: runnerPid, processGroupId: runnerGroup,
      processStartedAt: startedAt, processHostHash: foreignSpace,
      runnerProfileJson: { ...fixture.preparedProfile, sessionCheckpoint: {
        identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId,
          sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "foreign-provider-session", activeTurnId: "foreign-in-flight-turn",
        process: { providerPid, providerProcessStartedAt: startedAt.toISOString() },
      } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: oldBoot, controllerPid,
      controllerProcessStartedAt: startedAt, controllerHostHash: foreignSpace,
      leaseOwner: `foreign-in-flight:${randomUUID()}`, leaseExpiresAt: new Date(0), attempt: 1, controllerGeneration: 1,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.insert(controllerInstances).values({ bootId: oldBoot, processSpace: foreignSpace,
      pid: controllerPid, leaseExpiresAt: new Date(Date.now() - 1_000),
      ...(state === "stopped" ? { stoppedAt: new Date() } : { fencedAt: new Date() }),
    });
    registerControllerInstanceDb(fixture.db);
    const [before] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const probes: number[] = [], recordedPids = new Set([runnerPid, runnerGroup, providerPid, controllerPid]);
    const kill = process.kill.bind(process);
    const pidProbe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && recordedPids.has(Math.abs(pid))) {
        probes.push(pid);
        throw Object.assign(new Error("Absent local PID is not foreign execution stop proof"), { code: "ESRCH" });
      }
      return kill(pid, signal);
    });
    const claimed = vi.fn(), stamped = vi.fn(), unsubscribe = onControllerStamp(stamped);
    try {
      const dispositions = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId], onClaim: claimed });
      const [after] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const stopped = await hasNativeLocalProcessStop(fixture.db, companyId, fixture.runId);
      expect(probes).toEqual([]);
      expect(dispositions).toEqual([{ kind: "awaiting_evidence", runId: fixture.runId,
        reason: "controller_process_space_unverified" }]);
      expect(claimed).not.toHaveBeenCalled();
      expect(stamped).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      expect(after).toMatchObject({ phase: before.phase, attempt: before.attempt,
        controllerGeneration: before.controllerGeneration, controllerBootId: before.controllerBootId,
        controllerPid: before.controllerPid, controllerHostHash: before.controllerHostHash,
        leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt, resultId: null });
      expect(run).toMatchObject({ status: "running", processPid: runnerPid, processGroupId: runnerGroup,
        processStartedAt: startedAt, processHostHash: foreignSpace });
      expect(run.runnerProfileJson).toEqual({ ...fixture.preparedProfile, sessionCheckpoint: {
        identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId,
          sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "foreign-provider-session", activeTurnId: "foreign-in-flight-turn",
        process: { providerPid, providerProcessStartedAt: startedAt.toISOString() },
      } });
      const [attention] = await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
      expect(attention).toMatchObject({ status: "active", cause: "native_restart_recovery_blocked",
        evidence: { runId: fixture.runId, reason: "controller_process_space_unverified" } });
      expect(await fixture.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId))).toEqual([]);
    } finally { unsubscribe(); pidProbe.mockRestore(); resetControllerInstanceLeaseForTests(); }
  });

  it("recovers a preparation with no runner PID once its foreign controller stops", async () => {
    const fixture = await seedRun("REMOTE-PREPARATION-OWNER");
    const oldBoot = randomUUID();
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: oldBoot, controllerPid: 7,
      controllerProcessStartedAt: new Date(Date.now() - 600_000), controllerHostHash: "previous-pid-space",
      leaseOwner: "previous-preparation", leaseExpiresAt: new Date(0), attempt: 1, controllerGeneration: 1,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.insert(controllerInstances).values({ bootId: oldBoot, processSpace: "previous-pid-space",
      pid: 7, leaseExpiresAt: new Date(Date.now() + 60_000) });
    registerControllerInstanceDb(fixture.db);
    const stamped = vi.fn(), unsubscribe = onControllerStamp(stamped);
    try {
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [randomUUID()] })).toEqual([]);
      expect(stamped).not.toHaveBeenCalled();
      const [waiting] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] });
      expect(waiting).toMatchObject({ kind: "awaiting_evidence", reason: "controller_lease_held", retryAt: expect.any(Date) });
      expect(stamped).not.toHaveBeenCalled();
      const [before] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId] });
      const [after] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(after!.updatedAt).toEqual(before!.updatedAt);
      await fixture.db.update(controllerInstances).set({ stoppedAt: new Date() }).where(eq(controllerInstances.bootId, oldBoot));
      const dispositions = (await Promise.all([successor, { ...successor, bootId: randomUUID() }].map(controller =>
        claimNativeRestartRecoveries({ db: fixture.db, controller, restartKind: "hard", runIds: [fixture.runId] })))).flat();
      expect(dispositions.filter(row => row.kind === "bootstrap_incomplete")).toHaveLength(1);
      expect(dispositions.filter(row => row.kind === "awaiting_evidence")).toHaveLength(1);
      expect(stamped).toHaveBeenCalledOnce();
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run).toMatchObject({ status: "running", processPid: null, nativeSessionId: fixture.native.normalizedSessionId });
      const [owner] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(owner).toMatchObject({ attempt: 1, controllerGeneration: 2 });
    } finally { unsubscribe(); resetControllerInstanceLeaseForTests(); }
  });

  it.each(["grace", "fenced"] as const)("uses durable foreign controller %s evidence before classifying its namespace", async state => {
    const fixture = await seedRun(`REMOTE-CONTROLLER-${state}-${randomUUID()}`);
    const oldBoot = randomUUID();
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: oldBoot, controllerPid: 7,
      controllerProcessStartedAt: new Date(Date.now() - 600_000), controllerHostHash: "previous-pid-space",
      leaseOwner: "previous-preparation", leaseExpiresAt: new Date(0), attempt: 1, controllerGeneration: 1,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.insert(controllerInstances).values({ bootId: oldBoot, processSpace: "previous-pid-space",
      pid: 7, leaseExpiresAt: new Date(Date.now() - 1_000),
      ...(state === "fenced" ? { fencedAt: new Date() } : {}),
    });
    registerControllerInstanceDb(fixture.db);
    const originalKill = process.kill.bind(process);
    const pidProbe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 7 && signal === 0) throw new Error("A foreign controller PID must not be probed");
      return originalKill(pid, signal);
    });
    const stamped = vi.fn(), unsubscribe = onControllerStamp(stamped);
    try {
      const [before] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      const [disposition] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] });
      const [after] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (state === "grace") {
        expect(disposition).toMatchObject({ kind: "awaiting_evidence", reason: "controller_lease_grace", retryAt: expect.any(Date) });
        expect(stamped).not.toHaveBeenCalled();
        expect(after).toMatchObject({ leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt,
          controllerBootId: before.controllerBootId, controllerHostHash: before.controllerHostHash,
          controllerGeneration: before.controllerGeneration, attempt: before.attempt });
        await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId] });
        const [repeated] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        expect(repeated.updatedAt).toEqual(after.updatedAt);
      } else {
        expect(disposition).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId });
        expect(stamped).toHaveBeenCalledOnce();
        expect(after).toMatchObject({ controllerGeneration: 2, attempt: 1, resultId: null });
      }
      expect((await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0])
        .toMatchObject({ status: "running", processPid: null });
      expect(await fixture.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, fixture.runId))).toEqual([]);
    } finally { unsubscribe(); pidProbe.mockRestore(); resetControllerInstanceLeaseForTests(); }
  });

  it("recovers an unclaimed remote startup once without requiring a provider checkpoint", async () => {
    const fixture = await seedRun("REMOTE-UNCLAIMED");
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const dispositions = (await Promise.all([successor, { ...successor, bootId: randomUUID() }].map(controller =>
      claimNativeRestartRecoveries({ db: fixture.db, controller, restartKind: "hard", runIds: [fixture.runId] }),
    ))).flat();
    expect(dispositions.filter(row => row.kind === "bootstrap_incomplete")).toEqual([
      expect.objectContaining({ runId: fixture.runId, providerAttempt: 0, controllerGeneration: 1 }),
    ]);
    expect(dispositions.filter(row => row.kind === "awaiting_evidence")).toHaveLength(1);
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", nativeSessionId: fixture.native.normalizedSessionId });
    expect(await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
  });

  it("recovers an unclaimed remote startup that a graceful shutdown suspended during preparation", async () => {
    const fixture = await seedRun("REMOTE-UNCLAIMED-DRAINED");
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(fixture.db);
    try {
      await expect(heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [fixture.runId]))
        .resolves.toMatchObject({ restartSuspendedRunIds: [fixture.runId] });
    } finally { await heartbeat.drainActiveRunExecutions(); }
    const [suspended] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(suspended).toMatchObject({ phase: "observed", leaseOwner: null, controllerBootId: null,
      recoveryState: "awaiting_runner_reattach" });

    const dispositions = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    expect(dispositions).toEqual([
      expect.objectContaining({ kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 0, controllerGeneration: 1 }),
    ]);
    expect(await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
  });

  it.each([false, true])("yields an original preparation after remote recovery claims its run (expired lease=%s)", async (expired) => {
    const fixture = await seedRun(`REMOTE-PREPARATION-${expired}`);
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const execution = buildNativeExecutionInput({
      companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: null, title: "Resume prepared work", description: null, workMode: "standard" },
      taskPrompt: "Resume prepared work", provider: "codex",
      workspace: { id: randomUUID(), cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId,
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Resume prepared work", criteria: [{ id: "result", requirement: "Complete work" }] } },
    });
    let prepared!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolveReady => { prepared = resolveReady; });
    const continuePreparation = new Promise<void>(resolveContinue => { release = resolveContinue; });
    const openSession = vi.fn(async () => { throw new Error("Losing preparation must not open a provider"); });
    const descriptor = vi.fn(async () => { throw new Error("Losing preparation must not configure a provider"); });
    const original = executePaperclipNativeSession({
      db: fixture.db, execution, runnerInstanceId: fixture.native.runnerInstanceId,
      backend: { descriptor, openSession },
      preparationSpans: [{ name: "heartbeat.prepare_after_environment", startedAtMs: Date.now(), endedAtMs: Date.now() }],
      onEvent: async event => {
        // Preparation span rows are written in the background, so hold the
        // controller on the awaited environment receipt that precedes them.
        if (event.eventType === "run.startup.reuse" && event.payload?.layer === "environment") {
          prepared();
          await continuePreparation;
        }
      },
    }).catch(error => error);
    try {
      await Promise.race([preparing, original.then(error => { throw error; })]);
      expect(await claimNativeRestartRecoveries({ db: fixture.db, restartKind: "hard", runIds: [fixture.runId] })).toEqual([
        { kind: "awaiting_evidence", runId: fixture.runId, reason: "current_controller_preparing" },
      ]);
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId] });
      expect(claim.kind).toBe("bootstrap_incomplete");
      if (expired) await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      const [before] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      release();
      expect(await original).toBeInstanceOf(NativeControllerDetachedForRestartError);
      expect(openSession).not.toHaveBeenCalled();
      expect(descriptor).not.toHaveBeenCalled();
      expect((await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)))[0]).toEqual(before);
      expect((await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0].status).toBe("running");
      expect(await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
    } finally {
      release();
      await original;
    }
  });

  it.each(["claimed", "generation", "unexpired-lease", "process", "launch", "provider-event", "checkpoint", "invalid-workspace", "unfenced"])(
    "keeps remote startup recovery blocked with contradictory %s evidence", async (kind) => {
      const fixture = await seedRun(`REMOTE-${kind}`);
      let profile = fixture.preparedProfile;
      if (kind === "unfenced") {
        profile = { ...profile };
        delete profile.nativePreparationFencingVersion;
        await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, fixture.runId));
        const [olderRun] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        await prepareNativeHeartbeatRun({ db: fixture.db,
          run: { ...olderRun, runnerProfileJson: { ...profile, nativePreparationFencingVersion: 1 } },
          issue: { id: fixture.issueId, title: "Older preparation", description: null }, environmentLeaseId: "older-lease" });
        const [unchanged] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        expect(unchanged.runnerProfileJson).not.toHaveProperty("nativePreparationFencingVersion");
        profile = unchanged.runnerProfileJson;
      }
      await fixture.db.update(heartbeatRuns).set({
        runnerProfileJson: { ...profile, nativeWorkspaceSync: kind === "invalid-workspace" ? {} : remotePreparedWorkspace(),
          ...(kind === "checkpoint" ? { sessionCheckpoint: {} } : {}) },
        ...(kind === "process" ? { processPid: 2_000_000_001 } : {}),
      }).where(eq(heartbeatRuns.id, fixture.runId));
      if (kind === "claimed" || kind === "generation") await fixture.db.update(nativeRunFinalizations)
        .set(kind === "claimed" ? { attempt: 1 } : { controllerGeneration: 1 })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (kind === "unexpired-lease") await fixture.db.update(nativeRunFinalizations)
        .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (kind === "launch" || kind === "provider-event") await fixture.db.insert(heartbeatRunEvents).values({
        companyId, runId: fixture.runId, agentId, seq: 1, stream: "system", level: "info",
        eventType: kind === "launch" ? "native.process_start_requested" : "item.updated",
        ...(kind === "provider-event" ? { sourceEventId: "provider-event-1" } : {}),
      });
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([
        { kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" },
      ]);
    },
  );

  // RC-29: a restart while a Daytona runner was connecting. The executor had
  // claimed the run and launched the sandbox runner, which authenticated, but
  // session.open never completed. The controller's Postgres checkpoint is the
  // only record of what the runner received.
  async function seedClaimedRemoteBootstrap(label: string, options: {
    attempt?: number;
    mutate?: (core: DurablePrpControlPlane) => void;
    checkpoint?: boolean;
    /** False: the controller saved its checkpoint, but no remote runner was launched yet. */
    launched?: boolean;
  } = {}) {
    const fixture = await seedRun(`REMOTE-CLAIMED-${label}`);
    const { runId, issueId, native } = fixture;
    const remote = remotePreparedWorkspace();
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remote },
      ...(options.launched === false ? {} : { processPid: 443, processStartedAt: new Date(Date.now() - 30_000) }),
    }).where(eq(heartbeatRuns.id, runId));
    await fixture.db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 900, stream: "system", level: "info", eventType: "native.process_start_requested" },
      ...(options.launched === false ? [] : [{ companyId, runId, agentId, seq: 901, stream: "system", level: "info",
        eventType: "native.process_identity_recorded", payload: { targetKind: "remote", processPid: 443 } }]),
    ]);
    const bootId = randomUUID();
    const leaseOwner = `${bootId}:1:${randomUUID()}`;
    await fixture.db.update(nativeRunFinalizations).set({
      attempt: options.attempt ?? 1, controllerGeneration: 1, controllerBootId: bootId,
      controllerHostHash: await knownFixtureControllerHostHash(), controllerPid: 2_000_000_001,
      controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(nativeRunFinalizations.runId, runId));
    if (options.checkpoint !== false) {
      const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: runId, runId,
        normalizedSessionId: native.normalizedSessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
      const core = new DurablePrpControlPlane({ stateDirectory: resolve(runtimeRoot, runId, "control-plane"), identity,
        expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      try {
        const template = { provider: { provider: "acpx", command: "fixture" }, authorizedTools: {} };
        core.persistRunAttachTemplate(template);
        core.queueCommand("run.prepare", template);
        core.queueCommand("session.open", { reuse: "same_session" });
        core.issueBootstrapTicket();
        // The runner authenticated once and received run.prepare.
        core.store.state.connectionCount = 1;
        core.store.state.freshBootstraps = 1;
        core.store.state.commandDeliveryCounts = { [core.store.state.commands[0]!.commandId]: 1 };
        options.mutate?.(core);
        core.setCheckpointPersistence(nativeRunnerCheckpointWriter(fixture.db, {
          companyId, issueId, runId, authorityRunId: runId, bootId, leaseOwner, generation: 1,
        }));
        await core.flushCheckpoint();
      } finally {
        await core.stop();
      }
    }
    // The killed controller can no longer renew its lease.
    await fixture.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, runId));
    return fixture;
  }

  it("restarts a claimed remote bootstrap whose durable checkpoint proves no provider work", async () => {
    const fixture = await seedClaimedRemoteBootstrap("PROVEN");
    const dispositions = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    expect(dispositions).toEqual([expect.objectContaining({ kind: "bootstrap_incomplete", runId: fixture.runId,
      providerAttempt: 1, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "observed", recoveryState: "bootstrap_incomplete", failureCode: null });
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
      reason: "remote_bootstrap_proven_incomplete" });
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", errorCode: null, processPid: null });
    expect(await fixture.db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
  });

  it("lets the executor prove the remote bootstrap from its Postgres checkpoint, not the local marker", async () => {
    const fixture = await seedClaimedRemoteBootstrap("EXECUTOR");
    const execution = buildNativeExecutionInput({
      companyId, agentId, runId: fixture.runId,
      issue: { id: fixture.issueId, identifier: null, title: "Restart bootstrap", description: null, workMode: "standard" },
      taskPrompt: "Restart bootstrap", provider: "codex",
      workspace: { id: randomUUID(), cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: fixture.native.normalizedSessionId,
      runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Restart bootstrap", criteria: [{ id: "result", requirement: "Complete work" }] } },
    });
    const root = resolve(runtimeRoot, `marker-${fixture.runId}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const writeMarker = (runId: string) => writeFile(resolve(root, "control-plane", "control-plane-state.json"), JSON.stringify({
      schema: "paperclip.runner.external-control-plane-state.v1",
      identity: { runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.runId, runId,
        normalizedSessionId: fixture.native.normalizedSessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` },
    }));
    const claim = { kind: "bootstrap_incomplete" as const, runId: fixture.runId, leaseOwner: "successor",
      controllerGeneration: 2, providerAttempt: 1, restartKind: "hard" as const, recoveryRequestId: null };
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } as AdapterExecutionTarget;
    try {
      // RC-29b: preparation may leave an empty session root before any
      // controller state exists. It carries no evidence and must not block.
      await restoreRemoteBootstrapCheckpointForRecovery({ db: fixture.db, execution, root,
        restartRecovery: undefined, runnerExecutionTarget: target });
      expect(existsSync(root)).toBe(true);
      await restoreRemoteBootstrapCheckpointForRecovery({ db: fixture.db, execution, root,
        restartRecovery: claim, runnerExecutionTarget: target });
      expect(existsSync(root)).toBe(false);
      await mkdir(resolve(root, "control-plane"), { recursive: true, mode: 0o700 });
      await writeMarker(fixture.runId);
      expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(false);
      // Only a bootstrap recovery on a classic sandbox restores the checkpoint.
      for (const other of [{ restartRecovery: undefined, runnerExecutionTarget: target },
        { restartRecovery: claim, runnerExecutionTarget: { ...target, runnerTask: vi.fn() } as AdapterExecutionTarget }]) {
        await restoreRemoteBootstrapCheckpointForRecovery({ db: fixture.db, execution, root, ...other });
        expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(false);
      }
      // A marker for another run never receives this run's checkpoint.
      await writeMarker(randomUUID());
      await restoreRemoteBootstrapCheckpointForRecovery({ db: fixture.db, execution, root,
        restartRecovery: claim, runnerExecutionTarget: target });
      expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(false);
      await writeMarker(fixture.runId);
      await restoreRemoteBootstrapCheckpointForRecovery({ db: fixture.db, execution, root,
        restartRecovery: claim, runnerExecutionTarget: target });
      expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<[string, Parameters<typeof seedClaimedRemoteBootstrap>[1], string]>([
    ["a turn was issued", { mutate: core => { core.queueCommand("turn.start", { prompt: "Prior work must stay held." }); } },
      "ambiguous_remote_recovery_evidence"],
    ["an event was acknowledged", { mutate: core => { core.store.state.ackedSourceSeq = 1; } },
      "ambiguous_remote_recovery_evidence"],
    ["the state was adopted", { mutate: core => { core.store.state.bootstrapHistory!.adopted = true; } },
      "ambiguous_remote_recovery_evidence"],
    ["no checkpoint exists", { checkpoint: false }, "ambiguous_remote_recovery_evidence"],
  ])("keeps a claimed remote bootstrap held when %s", async (label, options, reason) => {
    const fixture = await seedClaimedRemoteBootstrap(label.replace(/\W+/g, "-"), options);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([{ kind: "blocked", runId: fixture.runId, reason }]);
  });

  // RC-29d: a graceful drain suspended the run just after its sandbox runner
  // opened the provider session. The controller record holds a completed
  // session.open and session-open events, but no turn was ever sent.
  const openSession = (core: DurablePrpControlPlane, eventTypes = ["session.started", "session.capabilities.updated",
    "session.goal.snapshot"]) => {
    const [prepare, open] = core.store.state.commands;
    prepare!.status = "completed";
    prepare!.result = { status: "prepared" } as never;
    open!.status = "completed";
    open!.result = { status: "started", processId: 608, providerSessionId: "provider-session" } as never;
    core.store.state.commandDeliveryCounts = { [prepare!.commandId]: 1, [open!.commandId]: 1 };
    const { runId, normalizedSessionId, runnerInstanceId, turnId, itemId } = core.store.state.identity;
    core.store.state.committedEvents = eventTypes.map((eventType, index) => ({ sourceSeq: index + 1,
      sourceEventId: `runner-session-event-${index + 1}`, eventType, priority: 1, deliveryCount: 1, logicalEffectCount: 1,
      envelope: { kind: "event", payload: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner",
        sourceInstanceId: runnerInstanceId, sourceEventId: `runner-session-event-${index + 1}`, sourceSeq: index + 1, runId,
        normalizedSessionId, turnId, itemId, eventType, priority: 1, emittedAt: "2026-11-07T00:49:52.000Z", payload: {} } },
    })) as never;
    core.store.state.ackedSourceSeq = eventTypes.length;
  };

  it("restarts a drained remote bootstrap whose runner opened its session but never got a turn", async () => {
    const fixture = await seedClaimedRemoteBootstrap("SESSION-OPENED", { mutate: core => openSession(core) });
    // The dying controller may already have projected the session-open event.
    await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 902,
      stream: "system", level: "info", eventType: "session.started" });
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
      reason: "remote_session_opened_without_turn" });
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", errorCode: null });
  });

  it("restarts a drained remote session whose controller only read its goal after opening it", async () => {
    const readGoal = (core: DurablePrpControlPlane) => {
      openSession(core, ["session.started", "session.capabilities.updated", "session.goal.snapshot", "session.goal.snapshot"]);
      core.queueCommand("session.goal.get", {});
      const goal = core.store.state.commands.at(-1)!;
      goal.status = "completed";
      goal.result = { goal: null } as never;
    };
    const fixture = await seedClaimedRemoteBootstrap("SESSION-GOAL-READ", { mutate: readGoal });
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
      reason: "remote_session_opened_without_turn" });
    const executor = await seedClaimedRemoteBootstrap("SESSION-GOAL-READ-EXECUTOR", { mutate: readGoal });
    const root = resolve(runtimeRoot, `goal-read-${executor.runId}`);
    try {
      expect(await restoreNativeRunnerCheckpoint(executor.db, { companyId, issueId: executor.issueId, runId: executor.runId },
        root)).not.toBeNull();
      expect(runnerdStateProvesNoRemoteProviderTurn(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<[string, string[], string]>([
    ["harness diagnostics", ["session.started", "session.capabilities.updated", "session.goal.snapshot", "harness.diagnostic",
      "harness.diagnostic", "session.goal.snapshot"], "bootstrap_incomplete"],
    ["a turn event", ["session.started", "harness.diagnostic", "turn.started"], "blocked"],
  ])("classifies a drained remote session that read its goal and committed %s", async (label, eventTypes, kind) => {
    const fixture = await seedClaimedRemoteBootstrap(`SESSION-${label.replace(/\W+/g, "-")}`, { mutate: core => {
      openSession(core, eventTypes);
      core.queueCommand("session.goal.get", {});
      const goal = core.store.state.commands.at(-1)!;
      goal.status = "completed";
      goal.result = { goal: null } as never;
    } });
    const claims = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    if (kind === "blocked") {
      expect(claims).toEqual([{ kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" }]);
      return;
    }
    expect(claims).toEqual([expect.objectContaining({ kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
      reason: "remote_session_opened_without_turn" });
    const root = resolve(runtimeRoot, `diagnostics-${fixture.runId}`);
    try {
      const executor = await seedClaimedRemoteBootstrap(`SESSION-${label.replace(/\W+/g, "-")}-EXECUTOR`, { mutate: core => {
        openSession(core, eventTypes);
      } });
      expect(await restoreNativeRunnerCheckpoint(executor.db, { companyId, issueId: executor.issueId, runId: executor.runId },
        root)).not.toBeNull();
      expect(runnerdStateProvesNoRemoteProviderTurn(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets the executor prove a drained remote session had no turn from its restored checkpoint", async () => {
    const fixture = await seedClaimedRemoteBootstrap("SESSION-OPENED-EXECUTOR", { mutate: core => openSession(core) });
    const root = resolve(runtimeRoot, `opened-${fixture.runId}`);
    try {
      expect(await restoreNativeRunnerCheckpoint(fixture.db, { companyId, issueId: fixture.issueId, runId: fixture.runId },
        root)).not.toBeNull();
      // The local proof cannot see a sandbox provider process; the remote proof
      // relies on the complete controller record instead.
      expect(runnerdStateProvesIncompleteBootstrap(root)).toBe(false);
      expect(runnerdStateProvesNoRemoteProviderTurn(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<[string, Parameters<typeof seedClaimedRemoteBootstrap>[1], { eventType: string } | null]>([
    ["a turn was issued", { mutate: core => { openSession(core);
      core.queueCommand("turn.start", { prompt: "Prior work must stay held." }); } }, null],
    ["a goal was set after a read", { mutate: core => { openSession(core); core.queueCommand("session.goal.get", {});
      core.queueCommand("session.goal.set", { objective: "Prior work must stay held." }); } }, null],
    ["a turn event was committed", { mutate: core => openSession(core, ["session.started", "turn.started"]) }, null],
    ["an acknowledged event is missing", { mutate: core => { openSession(core); core.store.state.ackedSourceSeq = 4; } }, null],
    ["a provider turn event was projected", { mutate: core => openSession(core) }, { eventType: "turn.started" }],
  ])("keeps a drained remote session held when %s", async (label, options, projected) => {
    const fixture = await seedClaimedRemoteBootstrap(`OPENED-${label.replace(/\W+/g, "-")}`, options);
    if (projected) await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 902,
      stream: "system", level: "info", ...projected });
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({ kind: "blocked", runId: fixture.runId })]);
  });

  // RC-29b: a restart while the executor was still preparing a claimed Daytona
  // run, before it asked for a runner process. The executor records
  // native.process_start_requested (and only then may a backend spawn or a
  // controller checkpoint exist), so its absence proves nothing reached a runner.
  async function seedUnlaunchedRemoteClaim(label: string, options: {
    attempt?: number; leaseExpired?: boolean; liveController?: boolean;
    event?: { eventType: string; sourceEventId?: string };
    run?: Partial<typeof heartbeatRuns.$inferInsert>;
    /** RC-29c: the executor settled a same-run bootstrap retry before the restart. */
    bootstrapRetry?: boolean;
  } = {}) {
    const fixture = await seedRun(`REMOTE-UNLAUNCHED-${label}`);
    await fixture.db.update(heartbeatRuns).set({
      runnerProfileJson: { ...fixture.preparedProfile, nativeWorkspaceSync: remotePreparedWorkspace() },
      ...options.run,
    }).where(eq(heartbeatRuns.id, fixture.runId));
    if (options.event) await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId,
      seq: 900, stream: "system", level: "info", ...options.event });
    const current = await currentNativeControllerIdentity();
    await fixture.db.update(nativeRunFinalizations).set({
      attempt: options.attempt ?? 1, controllerGeneration: 1,
      controllerBootId: options.liveController ? current.bootId : randomUUID(),
      controllerHostHash: await knownFixtureControllerHostHash(),
      controllerPid: options.liveController ? current.pid : 2_000_000_001,
      controllerProcessStartedAt: options.liveController ? current.processStartedAt : new Date(Date.now() - 60_000),
      leaseOwner: `previous:${randomUUID()}`,
      leaseExpiresAt: new Date(Date.now() + (options.leaseExpired ? -1_000 : 20 * 60_000)),
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    if (options.bootstrapRetry) {
      // Shape persisted by the executor when shutdown closed the local runtime
      // listener during remote startup (local_runtime_api_listener_unavailable).
      await fixture.db.update(nativeRunFinalizations).set({
        phase: "retryable_failure", leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() - 1_000), failureCode: "local_runtime_api_listener_unavailable",
        failureDetail: { message: "local_runtime_api_listener_unavailable", recoverable: true,
          recoveryMode: "bootstrap_retry", checkpointExists: false, providerEventsExist: false,
          providerSessionEstablished: false, originalFailureCode: "local_runtime_api_listener_unavailable" },
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      await fixture.db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        errorCode: "local_runtime_api_listener_unavailable" }).where(eq(heartbeatRuns.id, fixture.runId));
    }
    return fixture;
  }

  it.each([
    { label: "restarts a remote follow-up", identityRecorded: false, inherited: true },
    { label: "restarts a first remote run", identityRecorded: false, inherited: false },
    { label: "keeps a recorded runner process held instead of restarting", identityRecorded: true, inherited: true },
  ])("$label whose controller never sent its runner a command", async ({ identityRecorded, inherited }) => {
    const fixture = await seedUnlaunchedRemoteClaim(`NEVER-COMMANDED-${identityRecorded}-${inherited}`,
      { event: { eventType: "native.process_start_requested" } });
    const [seeded] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    if (inherited) await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...seeded.runnerProfileJson, sessionCheckpoint: {
      driverKind: "codex_app_server", backendKind: "runner", sessionId: "inherited-thread", cursor: null,
      identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
      providerSessionId: "inherited-thread", activeTurnId: null, terminal: null, terminalTurns: [], semanticResult: null,
      pendingRuntimeRequests: [], lineage: [],
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    if (identityRecorded) await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 901,
      stream: "system", level: "info", eventType: "native.process_identity_recorded" });
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    if (identityRecorded) {
      expect(claim).not.toMatchObject({ kind: "bootstrap_incomplete" });
      return;
    }
    expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 });
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_never_received_commands" });
  });

  // Daytona waves s9202 t02 (B1) and s9205 t04 (B2): a follow-up run on a
  // continued session was killed after native.process_start_requested but
  // before its remote runner launched. Admission rebinds the previous turn's
  // checkpoint to the new run: its identity names this run and it keeps the
  // provider session ID, but it records no cursor, turn, result or request.
  // That carried session is not this run's provider work.
  async function reboundFollowUpCheckpoint(fixture: Awaited<ReturnType<typeof seedRun>>, extra: Record<string, unknown> = {},
    predecessor = true) {
    const [seeded] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    // The settled previous turn of the same session saved the provider session.
    if (predecessor) await fixture.db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: fixture.issueId, nativeSessionId: seeded.nativeSessionId, runnerInstanceId: seeded.runnerInstanceId,
      createdAt: new Date(seeded.createdAt.getTime() - 120_000), finishedAt: new Date(seeded.createdAt.getTime() - 10_000),
      contextSnapshot: { issueId: fixture.issueId }, runnerProfileJson: { sessionCheckpoint: { providerSessionId: "inherited-thread" } } });
    await fixture.db.update(heartbeatRuns).set({ sessionIdBefore: "inherited-thread", runnerProfileJson: {
      ...seeded.runnerProfileJson, sessionCheckpoint: {
        driverKind: "codex_app_server", backendKind: "runner", sessionId: "inherited-thread", cursor: null,
        identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
        providerSessionId: "inherited-thread", activeTurnId: null, terminal: null, terminalTurns: [], semanticResult: null,
        pendingRuntimeRequests: [], lineage: [], ...extra,
      } } }).where(eq(heartbeatRuns.id, fixture.runId));
  }

  it.each([
    { label: "restarts", mode: "unlaunched" },
    { label: "restarts with its predecessor's remote runner identity", mode: "inherited_process" },
    { label: "keeps its own recorded runner held", mode: "identity_recorded" },
    { label: "keeps a carried active turn held", mode: "active_turn" },
  ] as const)("$label a follow-up whose controller never saved a checkpoint (s9205 t04)", async ({ mode }) => {
    const fixture = await seedUnlaunchedRemoteClaim(`FOLLOW-UP-UNCOMMANDED-${mode}`,
      { event: { eventType: "native.process_start_requested" } });
    await reboundFollowUpCheckpoint(fixture, mode === "active_turn" ? { activeTurnId: "turn-in-flight" } : {});
    if (mode === "inherited_process") {
      const processStartedAt = new Date(Date.now() - 120_000);
      const [current] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      await fixture.db.update(heartbeatRuns).set({ processPid: 596, processGroupId: null, processStartedAt, processHostHash: "remote" })
        .where(eq(heartbeatRuns.id, fixture.runId));
      await fixture.db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
        nativeIssueId: fixture.issueId, nativeSessionId: current.nativeSessionId, runnerInstanceId: current.runnerInstanceId,
        createdAt: new Date(current.createdAt.getTime() - 60_000), finishedAt: new Date(current.createdAt.getTime() - 5_000),
        processPid: 596, processGroupId: null, processStartedAt, processHostHash: "remote",
        contextSnapshot: { issueId: fixture.issueId } });
    }
    if (mode === "identity_recorded") await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId,
      seq: 901, stream: "system", level: "info", eventType: "native.process_identity_recorded" });
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    if (mode === "identity_recorded" || mode === "active_turn") {
      expect(claim).not.toMatchObject({ kind: "bootstrap_incomplete" });
      return;
    }
    expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 });
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_never_received_commands" });
  });

  it.each([
    { label: "restarts", mode: "bootstrap" },
    { label: "keeps a provider session no settled earlier run saved held in", mode: "no_predecessor" },
    { label: "keeps a turn command held", mode: "turn_command" },
    { label: "keeps a projected provider turn event held", mode: "turn_event" },
  ] as const)("$label a follow-up whose saved controller checkpoint proves no provider turn (s9202 t02)", async ({ mode }) => {
    const fixture = await seedClaimedRemoteBootstrap(`FOLLOW-UP-CLAIMED-${mode}`, {
      launched: false,
      mutate: mode === "turn_command" ? core => { openSession(core);
        core.queueCommand("turn.start", { prompt: "Prior work must stay held." }); } : undefined,
    });
    await reboundFollowUpCheckpoint(fixture, {}, mode !== "no_predecessor");
    if (mode === "turn_event") await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId,
      seq: 902, stream: "system", level: "info", eventType: "turn.started" });
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    if (mode !== "bootstrap") {
      expect(claim).not.toMatchObject({ kind: "bootstrap_incomplete" });
      return;
    }
    expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 1, controllerGeneration: 2 });
  });

  it.each([
    { label: "restarts", providerEvent: false, process: "none" },
    { label: "restarts with its predecessor's runner identity", providerEvent: false, process: "inherited" },
    { label: "keeps its own runner identity held instead of restarting", providerEvent: false, process: "own" },
    { label: "keeps a projected provider event held instead of restarting", providerEvent: true, process: "none" },
    { label: "keeps a pending runtime request held instead of restarting", providerEvent: false, process: "none", pendingRequest: true },
  ])("$label an unclaimed remote follow-up that carries only its inherited checkpoint", async ({ providerEvent, process, pendingRequest }) => {
    const fixture = await seedUnlaunchedRemoteClaim(`UNCLAIMED-INHERITED-${providerEvent}-${process}-${Boolean(pendingRequest)}`);
    if (process !== "none") {
      const processStartedAt = new Date(Date.now() - 120_000);
      await fixture.db.update(heartbeatRuns).set({ processPid: 596, processGroupId: null, processStartedAt, processHostHash: "remote" })
        .where(eq(heartbeatRuns.id, fixture.runId));
      if (process === "inherited") {
        const [current] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
          nativeIssueId: fixture.issueId, nativeSessionId: current.nativeSessionId, runnerInstanceId: current.runnerInstanceId,
          createdAt: new Date(current.createdAt.getTime() - 60_000), finishedAt: new Date(current.createdAt.getTime() - 5_000),
          processPid: 596, processGroupId: null, processStartedAt, processHostHash: "remote",
          contextSnapshot: { issueId: fixture.issueId } });
      }
    }
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 0, controllerGeneration: 0, controllerBootId: null,
      controllerPid: null, controllerProcessStartedAt: null, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const [seeded] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...seeded.runnerProfileJson, sessionCheckpoint: {
      driverKind: "codex_app_server", backendKind: "runner", sessionId: "inherited-thread", cursor: null,
      identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
      providerSessionId: "inherited-thread", activeTurnId: null, terminal: null, terminalTurns: [], semanticResult: null,
      pendingRuntimeRequests: pendingRequest ? [{ requestId: "input-1", kind: "user_input" }] : [], lineage: [],
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    if (providerEvent) await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 901,
      stream: "system", level: "info", eventType: "session.started" });
    const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    if (providerEvent || process === "own" || pendingRequest) {
      expect(claim).not.toMatchObject({ kind: "bootstrap_incomplete" });
      return;
    }
    expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId });
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_execution_never_claimed" });
  });

  it("restarts a remote bootstrap retry that shutdown cut before any runner was requested", async () => {
    const fixture = await seedUnlaunchedRemoteClaim("BOOTSTRAP-RETRY", { bootstrapRetry: true });
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 1, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "observed", recoveryState: "bootstrap_incomplete", failureCode: null,
      nextAttemptAt: null });
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_never_launched" });
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", errorCode: null, finishedAt: null });
    expect(await fixture.db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
  });

  /** Daytona wave s9301: the relaunched remote runner exited before run.prepare. */
  async function seedExitedRemoteRunner(label: string, failure: Record<string, unknown> = {}, attempt = 2) {
    const fixture = await seedUnlaunchedRemoteClaim(label, { bootstrapRetry: true, attempt,
      event: { eventType: "native.process_start_requested" }, run: { processPid: 955, processStartedAt: new Date(Date.now() - 30_000) } });
    await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 901, stream: "system",
      level: "info", eventType: "native.process_identity_recorded" });
    await fixture.db.update(nativeRunFinalizations).set({ failureCode: "native_runner_process_exited",
      failureDetail: { message: "runnerd exited while waiting for run.prepare", recoverable: true, recoveryMode: "bootstrap_retry",
        checkpointExists: false, providerEventsExist: false, providerSessionEstablished: false,
        originalFailureCode: "native_runner_process_exited", ...failure } })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.update(heartbeatRuns).set({ errorCode: "native_runner_process_exited" }).where(eq(heartbeatRuns.id, fixture.runId));
    return fixture;
  }

  it("bootstraps again when the relaunched remote runner exited before any provider work", async () => {
    // The runner's own exit, observed and recorded by the controller with no
    // provider session, events or checkpoint, proves the remote runner gone.
    const fixture = await seedExitedRemoteRunner("EXITED-RUNNER");
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "observed", recoveryState: "bootstrap_incomplete", failureCode: null });
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_exited_before_provider_work" });
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", errorCode: null });
  });

  it("bootstraps an exited remote runner at its last attempt without charging it (no provider work)", async () => {
    // #19948: only a turn the provider accepted is charged; a runner that
    // exited before provider work keeps the attempt.
    const fixture = await seedExitedRemoteRunner("EXITED-LAST-ATTEMPT", {}, 3);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 3, chargesProviderAttempt: false })]);
  });

  it.each([
    { recorded: null, expected: { kind: "bootstrap_incomplete", chargesProviderAttempt: false } },
    { recorded: NATIVE_NO_PROGRESS_RESTART_LIMIT - 2, expected: { kind: "bootstrap_incomplete", chargesProviderAttempt: false } },
    { recorded: NATIVE_NO_PROGRESS_RESTART_LIMIT - 1, expected: { kind: "blocked", reason: "execution_recovery_budget_exhausted" } },
  ])("bounds an exited remote runner at its last attempt past the generation cap by consecutive no-progress restarts ($recorded)",
    async ({ recorded, expected }) => {
      const fixture = await seedExitedRemoteRunner(`EXITED-GEN-CAP-${recorded}`, {}, 3);
      await fixture.db.update(nativeRunFinalizations).set({ controllerGeneration: NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (recorded !== null) await recordUnstartedClaim(fixture, recorded);
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({ runId: fixture.runId, ...expected })]);
    });

  it.each(["a provider event committed after the failure", "a session checkpoint saved after the failure"])(
    "keeps an exited remote runner's retry held when %s contradicts the saved failure", async (label) => {
      // The saved failure still says no provider work; fresh evidence wins.
      const fixture = await seedExitedRemoteRunner(`EXITED-FRESH-${label.split(" ")[1]}`);
      if (label.includes("event")) {
        await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 902,
          stream: "system", level: "info", eventType: "item.updated", sourceEventId: "runner-event-after-failure" });
      } else {
        const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, sessionCheckpoint: {} } })
          .where(eq(heartbeatRuns.id, fixture.runId));
      }
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
        kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" })]);
    });

  it.each<[string, Record<string, unknown>, number, string]>([
    ["the failure was not a runner exit", { originalFailureCode: "local_runtime_api_listener_unavailable" }, 2, "ambiguous_remote_recovery_evidence"],
    ["the provider session was established", { providerSessionEstablished: true }, 2, "ambiguous_remote_recovery_evidence"],
    ["provider events exist", { providerEventsExist: true }, 2, "ambiguous_remote_recovery_evidence"],
    ["a checkpoint exists", { checkpointExists: true }, 2, "ambiguous_remote_recovery_evidence"],
  ])("keeps an exited remote runner's retry held when %s", async (label, failure, attempt, reason) => {
    const fixture = await seedExitedRemoteRunner(`EXITED-${label.replace(/\W+/g, "-")}`, failure, attempt);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "blocked", runId: fixture.runId, reason })]);
  });

  it("bootstraps again after a remote session.open rejection whose runner exit the controller proved", async () => {
    // Staging run 61d2e06e with the new proof: the runner answered session.open
    // with a definite startup failure, then the controller's close settled it
    // and observed its exit. No provider session, event or checkpoint exists.
    const fixture = await seedExitedRemoteRunner("STARTUP-REJECTED-EXIT-PROVEN", {
      originalFailureCode: "provider_session_open_rejected", runnerExitConfirmed: true }, 1);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_exited_before_provider_work" });
  });

  it("keeps an older release's remote session.open rejection held without the runner exit proof", async () => {
    const fixture = await seedExitedRemoteRunner("STARTUP-REJECTED-NO-PROOF", {
      originalFailureCode: "provider_session_open_rejected" }, 1);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" })]);
  });

  it("records that a held same-run retry was not a server restart", async () => {
    // Staging run 61d2e06e: a remote session.open rejection saved by an older
    // release, held when its due retry re-entered restart recovery. No server
    // restarted, so the hold must not say one did.
    const fixture = await seedExitedRemoteRunner("SAME-RUN-RETRY-HOLD", {
      originalFailureCode: "provider_session_open_rejected" }, 1);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard",
      runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" })]);
    const [action] = await fixture.db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
    expect(action).toMatchObject({ cause: "native_restart_recovery_blocked",
      evidence: expect.objectContaining({ trigger: "same_run_retry" }) });
    const note = executionRecoverySettlementNote({ current: true, cause: action.cause,
      workspaceRestoreFailed: false, trigger: action.evidence.trigger });
    expect(note).not.toContain("server restart");
    expect(note).toContain("Automatic retry of this run stopped");
  });

  it.each<[string, Parameters<typeof seedUnlaunchedRemoteClaim>[1], { kind: string; reason: string }]>([
    ["a runner process start was requested", { bootstrapRetry: true, event: { eventType: "native.process_start_requested" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["a runner event was committed", { bootstrapRetry: true, event: { eventType: "item.updated", sourceEventId: "runner-event-1" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
  ])("keeps a remote bootstrap retry held when %s", async (label, options, expected) => {
    const fixture = await seedUnlaunchedRemoteClaim(`RETRY-${label.replace(/\W+/g, "-")}`, options);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({ runId: fixture.runId, ...expected })]);
  });

  // RC-22 / section F: a bootstrap whose provider never accepted a turn spent
  // no provider work, so a restart does not charge it, even at the last
  // attempt. The controller-generation cap still bounds a crash loop.
  it.each([
    ["claimed remote bootstrap", () => seedClaimedRemoteBootstrap("UNCHARGED-CLAIMED", { attempt: 3 })],
    ["remote bootstrap retry", () => seedUnlaunchedRemoteClaim("UNCHARGED-RETRY", { bootstrapRetry: true, attempt: 3 })],
    ["claimed unlaunched remote run", () => seedUnlaunchedRemoteClaim("UNCHARGED-UNLAUNCHED", { attempt: 3 })],
  ] as const)("does not charge a %s at its last attempt when no provider turn was accepted", async (_label, seed) => {
    const fixture = await seed();
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 3, chargesProviderAttempt: false })]);
  });

  it.each([
    ["claimed remote bootstrap", (label: string) => seedClaimedRemoteBootstrap(label, { attempt: 3 })],
    ["remote bootstrap retry", (label: string) => seedUnlaunchedRemoteClaim(label, { bootstrapRetry: true, attempt: 3 })],
  ] as const)("bounds a %s at its last attempt past the generation cap by consecutive no-progress restarts", async (label, seed) => {
    const uncapped = await seed(`GEN-CAP-OPEN-${label.replace(/\W+/g, "-")}`);
    await uncapped.db.update(nativeRunFinalizations).set({ controllerGeneration: NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT })
      .where(eq(nativeRunFinalizations.runId, uncapped.runId));
    expect(await claimNativeRestartRecoveries({ db: uncapped.db, controller: successor,
      restartKind: "hard", runIds: [uncapped.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: uncapped.runId, providerAttempt: 3, chargesProviderAttempt: false })]);
    const capped = await seed(`GEN-CAP-${label.replace(/\W+/g, "-")}`);
    await capped.db.update(nativeRunFinalizations).set({ controllerGeneration: NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT })
      .where(eq(nativeRunFinalizations.runId, capped.runId));
    await recordUnstartedClaim(capped, NATIVE_NO_PROGRESS_RESTART_LIMIT - 1);
    expect(await claimNativeRestartRecoveries({ db: capped.db, controller: successor,
      restartKind: "hard", runIds: [capped.runId] })).toEqual([expect.objectContaining({
      kind: "blocked", runId: capped.runId, reason: "execution_recovery_budget_exhausted" })]);
  });

  it("keeps a paused agent's remote bootstrap retry waiting instead of starting it", async () => {
    const fixture = await seedUnlaunchedRemoteClaim("PAUSED-RETRY", { bootstrapRetry: true });
    await fixture.db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    try {
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
        kind: "blocked", runId: fixture.runId, reason: "native_retry_admission_ineligible" })]);
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run.status).toBe("failed");
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(coordinator).toMatchObject({ phase: "retryable_failure", leaseOwner: null });
      expect(coordinator.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await fixture.db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    }
  });

  it("leaves a remote exact-checkpoint retry to its own admission path", async () => {
    const fixture = await seedUnlaunchedRemoteClaim("EXACT-RETRY", { bootstrapRetry: true });
    await fixture.db.update(nativeRunFinalizations).set({ failureDetail: { recoveryMode: "exact_checkpoint_resume" } })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const [disposition] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] });
    expect(disposition.kind).not.toBe("bootstrap_incomplete");
  });

  it.each([
    { label: "restarts", startRequested: false, pendingRequest: false, providerEvent: false },
    { label: "keeps a requested runner start held instead of restarting", startRequested: true, pendingRequest: false,
      providerEvent: false },
    { label: "keeps a pending runtime request held instead of restarting", startRequested: false, pendingRequest: true,
      providerEvent: false },
    { label: "keeps a projected provider event held instead of restarting", startRequested: false, pendingRequest: false,
      providerEvent: true },
  ])("$label a claimed remote follow-up that never requested a runner and carries its predecessor's session",
    async ({ startRequested, pendingRequest, providerEvent }) => {
      const fixture = await seedUnlaunchedRemoteClaim(`PROVEN-CONTINUED-${startRequested}-${pendingRequest}-${providerEvent}`,
        startRequested ? { event: { eventType: "native.process_start_requested" } } : {});
      const [seeded] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      await fixture.db.update(heartbeatRuns).set({ sessionIdBefore: "previous-thread",
        runnerProfileJson: { ...seeded.runnerProfileJson, sessionCheckpoint: {
          driverKind: "codex_app_server", backendKind: "runner", sessionId: "previous-thread", cursor: "37",
          identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
          providerSessionId: "previous-thread", activeTurnId: null, terminal: null,
          terminalTurns: [{ turnId: "previous-turn", fingerprint: "{}" }], semanticResult: null,
          pendingRuntimeRequests: pendingRequest ? [{ requestId: "input-1", kind: "user_input" }] : [], lineage: [],
        } } }).where(eq(heartbeatRuns.id, fixture.runId));
      if (providerEvent) await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq: 901,
        stream: "system", level: "info", eventType: "session.started" });
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
        restartKind: "hard", runIds: [fixture.runId] });
      if (startRequested || pendingRequest || providerEvent) {
        expect(claim).not.toMatchObject({ kind: "bootstrap_incomplete" });
        return;
      }
      expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 });
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
        reason: "remote_runner_never_launched" });
    });

  it.each([false, true])("restarts a claimed remote run that never requested a runner (lease expired=%s)", async (leaseExpired) => {
    const fixture = await seedUnlaunchedRemoteClaim(`PROVEN-${leaseExpired}`, { leaseExpired });
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({
      kind: "bootstrap_incomplete", runId: fixture.runId, providerAttempt: 1, controllerGeneration: 2 })]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(coordinator).toMatchObject({ phase: "observed", recoveryState: "bootstrap_incomplete", failureCode: null });
    expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ disposition: "bootstrap_incomplete",
      reason: "remote_runner_never_launched" });
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", errorCode: null });
    expect(await fixture.db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(0);
  });

  it.each<[string, Parameters<typeof seedUnlaunchedRemoteClaim>[1], { kind: string; reason: string }]>([
    ["a runner process identity was recorded", { event: { eventType: "native.process_identity_recorded" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["the adapter was invoked", { event: { eventType: "adapter.invoke" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["a runner event was committed", { event: { eventType: "item.updated", sourceEventId: "runner-event-1" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["a process pid is recorded", { run: { processPid: 443 } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["a provider session is recorded", { run: { sessionIdAfter: "provider-session" } },
      { kind: "blocked", reason: "ambiguous_remote_recovery_evidence" }],
    ["the claiming controller is still alive", { liveController: true },
      { kind: "awaiting_evidence", reason: "controller_still_alive" }],
  ])("keeps a claimed unlaunched remote run held when %s", async (label, options, expected) => {
    const fixture = await seedUnlaunchedRemoteClaim(label.replace(/\W+/g, "-"), options);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor,
      restartKind: "hard", runIds: [fixture.runId] })).toEqual([expect.objectContaining({ runId: fixture.runId, ...expected })]);
  });

  // Daytona wave s9330 t02 (TM1): SIGSTOP held this same server past its
  // execution lease while the executor was starting the native process. On
  // SIGCONT the lease renewal found the lease lapsed, the executor detached for
  // "the next controller" and exited, and every recovery scan then waited on
  // the recorded controller: this same live PID and boot. Nothing else can hold
  // a lease that names this process, and nothing in it drives the run any more.
  describe("same-boot controller whose own lease lapsed", () => {
    it("restarts the bootstrap instead of waiting on itself when no turn reached the runner", async () => {
      const fixture = await seedUnlaunchedRemoteClaim("SELF-LAPSED-UNCOMMANDED",
        { liveController: true, leaseExpired: true, event: { eventType: "native.process_start_requested" } });
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
        restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set() });
      expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: fixture.runId, controllerGeneration: 2 });
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(coordinator.recoveryHistory.at(-1)).toMatchObject({ reason: "remote_runner_never_received_commands" });
    });

    it("fails with a Retry instead of waiting on itself when the runner may have started", async () => {
      const fixture = await seedUnlaunchedRemoteClaim("SELF-LAPSED-IDENTITY",
        { liveController: true, leaseExpired: true, event: { eventType: "native.process_identity_recorded" } });
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
        restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set() }))
        .toEqual([expect.objectContaining({ kind: "blocked", runId: fixture.runId, reason: "ambiguous_remote_recovery_evidence" })]);
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", leaseOwner: null, failureCode: "native_restart_recovery_blocked" });
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      expect(run.status).toBe("failed");
      const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      expect(await taskInterruptionPresentation(fixture.db, issue)).toMatchObject({
        state: "failed", canRetry: true, observedRunId: fixture.runId });
      const personId = randomUUID();
      await fixture.db.insert(authUsers).values({ id: personId, name: "Retry person", email: `${personId}@fixture.invalid`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await fixture.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: personId,
        status: "active", membershipRole: "member" });
      expect(await requestTaskRetry({ db: fixture.db, companyId, issueId: fixture.issueId, actorId: personId,
        actorSource: "session", idempotencyKey: `self-lapsed-${fixture.runId}`, observedRunId: fixture.runId }))
        .toMatchObject({ accepted: true });
    });

    it("leaves the run to this process's executor while it still drives the run", async () => {
      const fixture = await seedUnlaunchedRemoteClaim("SELF-LAPSED-EXECUTING",
        { liveController: true, leaseExpired: true, event: { eventType: "native.process_start_requested" } });
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
        restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set([fixture.runId]) }))
        .toEqual([expect.objectContaining({ kind: "awaiting_evidence", reason: "current_controller_preparing" })]);
      setNativeExecutionActive(fixture.runId, true);
      try {
        expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
          restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set() }))
          .toEqual([expect.objectContaining({ kind: "awaiting_evidence", reason: "current_controller_preparing" })]);
      } finally {
        setNativeExecutionActive(fixture.runId, false);
      }
    });

    it("leaves a run this process handed to the next server for that server", async () => {
      const fixture = await seedUnlaunchedRemoteClaim("SELF-LAPSED-HANDED-OFF",
        { liveController: true, leaseExpired: true, event: { eventType: "native.process_start_requested" } });
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
        restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set(),
        handedOffForShutdown: runId => runId === fixture.runId }))
        .toEqual([expect.objectContaining({ kind: "awaiting_evidence", reason: "controller_still_alive" })]);
    });

    it("keeps waiting for a different live controller in this process space", async () => {
      const fixture = await seedUnlaunchedRemoteClaim("OTHER-LIVE-LAPSED",
        { leaseExpired: true, event: { eventType: "native.process_start_requested" } });
      // Another live process (the test runner's parent) recorded as controller.
      const parentStartedAt = new Date((await readProcessStartedAt(process.ppid))!);
      await fixture.db.update(nativeRunFinalizations).set({ controllerPid: process.ppid,
        controllerProcessStartedAt: parentStartedAt }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: await currentNativeControllerIdentity(),
        restartKind: "hard", runIds: [fixture.runId], liveRunExecutions: new Set() }))
        .toEqual([expect.objectContaining({ kind: "awaiting_evidence", reason: "controller_still_alive" })]);
    });
  });

  it.each([
    { attempt: 2, driverKind: "codex_app_server" },
    { attempt: 3, driverKind: "codex_app_server" },
    { attempt: 2, driverKind: "acpx_runtime" },
    { attempt: 2, driverKind: "opencode_server" },
    // A second restart that loses the first restart's continuation turn.
    { attempt: 2, driverKind: "codex_app_server", lostContinuation: true },
    { attempt: 2, driverKind: "codex_app_server", lostContinuation: true, staleTerminal: true },
    { attempt: 2, driverKind: "acpx_runtime", lostContinuation: true, staleTerminal: true, heldResult: true },
  ])("recovers a checkpointed $driverKind restart interruption within provider budget $attempt", async ({ attempt, driverKind, lostContinuation, staleTerminal, heldResult }) => {
    const fixture = await seedRun(`INTERRUPTED-${driverKind}-${attempt}${lostContinuation ? "-CONTINUATION" : ""}${staleTerminal ? "-STALE" : ""}${heldResult ? "-RESULT" : ""}`);
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      driverKind,
      sessionId: fixture.native.normalizedSessionId,
      identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
      providerSessionId: "interrupted-provider",
      activeTurnId: null,
      semanticResult: null,
      terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
      terminalTurns: [{ turnId: "interrupted-turn", fingerprint: JSON.stringify({
        terminalState: "failed", result: null,
        error: { code: "provider_turn_lost_on_restore", recoverable: true },
      }) }],
      // A restart during the first continuation: its turn is still the
      // checkpointed active turn and the consumed marker names it.
      ...(heldResult ? { semanticResult: { schema: "paperclip.run_result.v1", summary: "Saved before the restart." } } : {}),
      ...(lostContinuation ? { activeTurnId: "continuation-turn", ...(staleTerminal ? {} : { terminal: null }),
        dispositionOnlyRecoveryConsumed: true, dispositionOnlyRecoveryTurnId: "continuation-turn" } : {}),
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    // The interrupted attempt's provider accepted a turn and completed no work.
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
      { eventType: "turn.accepted", turnId: lostContinuation ? "continuation-turn" : "interrupted-turn" }]);
    const dispositions = await claimNativeRestartRecoveries({
      db: fixture.db, controller: successor, restartKind: "hot", runIds: [fixture.runId],
    });
    expect(dispositions).toEqual([expect.objectContaining(attempt < 3
      ? { kind: "resume_dead_runner", runId: fixture.runId, providerAttempt: attempt }
      : { kind: "blocked", runId: fixture.runId, reason: "execution_recovery_budget_exhausted" })]);
  });

  it("keeps a run whose active turn follows a real provider failure blocked as permanently failed", async () => {
    const fixture = await seedRun("ACTIVE-AFTER-PROVIDER-FAILURE");
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      driverKind: "codex_app_server",
      sessionId: fixture.native.normalizedSessionId,
      identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
      providerSessionId: "failed-provider",
      activeTurnId: "later-turn",
      semanticResult: null,
      terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
      terminalTurns: [{ turnId: "failed-turn", fingerprint: JSON.stringify({
        terminalState: "failed", result: null, error: { code: "model_not_found", recoverable: false },
      }) }],
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" }, { eventType: "turn.accepted", turnId: "later-turn" }]);
    expect(await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hot", runIds: [fixture.runId] }))
      .toEqual([expect.objectContaining({ kind: "blocked", runId: fixture.runId, reason: "provider_checkpoint_permanently_failed" })]);
  });

  // RC-22b: controller crashes (no drain record) that each interrupted a resume
  // which had already done work exhausted the three-attempt budget.
  async function seedInterruptedCheckpoint(label: string) {
    const fixture = await seedRun(label);
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      driverKind: "opencode_server",
      sessionId: fixture.native.normalizedSessionId,
      identity: { companyId, issueId: fixture.issueId, runId: fixture.runId, agentId, sessionId: fixture.native.normalizedSessionId },
      providerSessionId: "interrupted-provider",
      activeTurnId: null,
      semanticResult: null,
      terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
      terminalTurns: [{ turnId: "interrupted-turn", fingerprint: JSON.stringify({
        terminalState: "failed", result: null,
        error: { code: "provider_turn_lost_on_restore", recoverable: true },
      }) }],
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    // The original execution claimed attempt 1, and its provider accepted the
    // turn that the restart then interrupted before it completed any work.
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 1, controllerGeneration: 1 })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
      { eventType: "turn.accepted", turnId: "interrupted-turn" }]);
    return fixture;
  }

  async function appendRunEvents(fixture: Awaited<ReturnType<typeof seedRun>>, events: Array<{
    eventType: string; turnId?: string; kind?: string; payload?: Record<string, unknown>;
  }>) {
    const [last] = await fixture.db.select({ seq: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)::int` })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, fixture.runId));
    let seq = last?.seq ?? 0;
    for (const event of events) {
      seq += 1;
      await fixture.db.insert(heartbeatRunEvents).values({ companyId, runId: fixture.runId, agentId, seq,
        eventType: event.eventType, stream: "system", level: "info",
        payload: event.payload ?? { prpEvent: { runId: fixture.runId, eventType: event.eventType, sourceKind: "runner",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          payload: event.kind ? { kind: event.kind } : {} } } });
    }
  }

  // The new controller resumes, the executor applies the claim's charge to the
  // attempt, and then the controller dies (a crash leaves no drain record).
  async function resumeThenCrash(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const [disposition] = await claimNativeRestartRecoveries({
      db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId],
    });
    if (disposition?.kind !== "resume_dead_runner") return { disposition };
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    const attempt = nextNativeProviderAttempt(coordinator.attempt, disposition.kind, disposition.chargesProviderAttempt !== false);
    await fixture.db.update(nativeRunFinalizations).set({
      attempt, controllerBootId: randomUUID(), controllerPid: 2_000_000_001,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    return { disposition, attempt };
  }

  // What a resumed turn records on restore before it does any new work.
  const restoreNoise = (round: number) => [
    { eventType: "native.process_start_requested" },
    { eventType: "item.completed", kind: "thread_lineage" },
    { eventType: "turn.failed", turnId: "interrupted-turn" },
    { eventType: "tool.execution.completed", turnId: "interrupted-turn" },
    { eventType: "turn.submitted" },
    { eventType: "turn.accepted", turnId: `continuation-${round}` },
    { eventType: "item.completed", turnId: `continuation-${round}`, kind: "usage" },
  ];

  it("keeps recovering a run whose restart resumes each completed work before the next crash", async () => {
    const fixture = await seedInterruptedCheckpoint("PROGRESS-BETWEEN-CRASHES");
    const attempts: number[] = [];
    const charges: boolean[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const { disposition, attempt } = await resumeThenCrash(fixture);
      expect(disposition).toMatchObject({ kind: "resume_dead_runner", runId: fixture.runId });
      charges.push((disposition as { chargesProviderAttempt?: boolean }).chargesProviderAttempt !== false);
      attempts.push(attempt!);
      await appendRunEvents(fixture, [...restoreNoise(round),
        { eventType: "tool.execution.completed", turnId: `continuation-${round}` }]);
    }
    // The first restart interrupted the original execution, not a resume.
    expect(charges).toEqual([true, false, false, false, false]);
    expect(attempts).toEqual([2, 2, 2, 2, 2]);
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect((coordinator.recoveryHistory as Array<Record<string, unknown>>).filter(entry => entry.attemptKeptForProgress))
      .toHaveLength(4);
  });

  it("does not credit a resume's work to a later provider attempt started by a normal retry", async () => {
    const fixture = await seedInterruptedCheckpoint("PROGRESS-THEN-RETRY");
    await resumeThenCrash(fixture);
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
      { eventType: "turn.accepted", turnId: "resumed" }, { eventType: "tool.execution.completed", turnId: "resumed" }]);
    // The resume (attempt 2) did work. A transport failure then started a
    // normal local retry at attempt 3, which crashed before doing any work.
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" }]);
    // That retry spawned but its provider never accepted a turn: not charged.
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 3 });
    // The next resume's provider accepts a turn and does no work. The first
    // resume's work belongs to an earlier attempt, so this one is charged.
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
      { eventType: "turn.accepted", turnId: "retry" }]);
    const { disposition } = await resumeThenCrash(fixture);
    expect(disposition).toMatchObject({ kind: "blocked", reason: "execution_recovery_budget_exhausted" });
  });

  // Section F: the not-charged outcomes, judged on the attempt a crash
  // interrupted. Each starts at the last attempt, so a charge would block.
  it.each([
    { label: "the runner was never requested", events: [] },
    { label: "the runner spawned but was never admitted", events: [{ eventType: "native.process_start_requested" },
      { eventType: "native.process_identity_recorded" }, { eventType: "session.resumed" }] },
    { label: "the provider did not accept turn.start", events: [{ eventType: "native.process_start_requested" },
      { eventType: "turn.submitted" }, { eventType: "turn.failed", turnId: "never-accepted" }] },
  ])("does not charge a resume whose provider never accepted a turn ($label)", async ({ label, events }) => {
    const fixture = await seedInterruptedCheckpoint(`NOT-CHARGED-${label.replace(/\W+/g, "-")}`);
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    // The previous resume is recorded to run as attempt 3.
    await fixture.db.update(nativeRunFinalizations).set({
      recoveryHistory: sql`jsonb_set(${nativeRunFinalizations.recoveryHistory},
        array[(jsonb_array_length(${nativeRunFinalizations.recoveryHistory}) - 1)::text, 'progressAttempt'], '3'::jsonb)`,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, events);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 3 });
  });

  it.each([
    { label: "turn.accepted", eventType: "turn.accepted" },
    { label: "the provider's turn.started", eventType: "turn.started" },
  ])("charges a resume whose provider accepted a turn and made no progress ($label)", async ({ eventType }) => {
    const fixture = await seedInterruptedCheckpoint(`CHARGED-${eventType}`);
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" }, { eventType, turnId: "accepted" },
      { eventType: "item.completed", turnId: "accepted", kind: "usage" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: true }, attempt: 3 });
  });

  it("does not charge the first restart when the original attempt already made progress", async () => {
    const fixture = await seedInterruptedCheckpoint("ORIGINAL-PROGRESS");
    await appendRunEvents(fixture, [{ eventType: "tool.execution.completed", turnId: "interrupted-turn" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 1 });
  });

  it("still exhausts the budget when restart resumes complete no work between crashes", async () => {
    const fixture = await seedInterruptedCheckpoint("NO-PROGRESS-BETWEEN-CRASHES");
    const outcomes: Array<{ kind?: string; attempt?: number; reason?: string }> = [];
    for (let round = 1; round <= 3; round += 1) {
      const { disposition, attempt } = await resumeThenCrash(fixture);
      outcomes.push({ kind: disposition?.kind, attempt, reason: (disposition as { reason?: string }).reason });
      // Restore activity and an accepted turn that fails before any work.
      await appendRunEvents(fixture, [...restoreNoise(round), { eventType: "turn.failed", turnId: `continuation-${round}` }]);
    }
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "resume_dead_runner", attempt: 2 }),
      expect.objectContaining({ kind: "resume_dead_runner", attempt: 3 }),
      expect.objectContaining({ kind: "blocked", reason: "execution_recovery_budget_exhausted" }),
    ]);
  });

  // RC-22c: in a K6 crash loop the controller died again before the resumed
  // execution requested a runner, and the next claim charged that resume.
  it.each([
    { label: "after the executor took its lease", leaseTaken: true },
    { label: "before the executor took its lease", leaseTaken: false },
  ])("does not charge for a resume killed before it started the provider ($label)", async ({ leaseTaken }) => {
    const fixture = await seedInterruptedCheckpoint(`UNSTARTED-RESUME-${leaseTaken ? "LEASE" : "NO-LEASE"}`);
    // The first restart resume runs and makes progress.
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await appendRunEvents(fixture, [...restoreNoise(1), { eventType: "tool.execution.completed", turnId: "continuation-1" }]);
    const outcomes: Array<{ kind?: string; attempt?: number }> = [];
    // Four crash restarts in a row, each before the resumed execution started.
    for (let round = 0; round < 4; round += 1) {
      if (leaseTaken) {
        const { disposition, attempt } = await resumeThenCrash(fixture);
        outcomes.push({ kind: disposition?.kind, attempt });
        continue;
      }
      const [disposition] = await claimNativeRestartRecoveries({
        db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId],
      });
      await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerPid: 2_000_000_001 })
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, fixture.runId));
      outcomes.push({ kind: disposition?.kind, attempt: coordinator.attempt });
    }
    expect(outcomes).toEqual(Array(4).fill({ kind: "resume_dead_runner", attempt: 2 }));
    // A resume that starts and then fails before any work is charged again.
    await appendRunEvents(fixture, [...restoreNoise(2), { eventType: "turn.failed", turnId: "continuation-2" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({ disposition: { kind: "resume_dead_runner" }, attempt: 3 });
  });

  it("does not treat a reattachment with no later events as an unstarted resume", async () => {
    const fixture = await seedInterruptedCheckpoint("REATTACH-NO-EVENTS");
    await resumeThenCrash(fixture);
    await appendRunEvents(fixture, [...restoreNoise(1), { eventType: "turn.failed", turnId: "continuation-1" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 3 });
    // That claim was a reattachment to a runner whose provider had already
    // started. The controller then died before recording anything else, and the
    // adopted runner died too.
    await fixture.db.update(nativeRunFinalizations).set({
      recoveryHistory: sql`jsonb_set(${nativeRunFinalizations.recoveryHistory},
        array[(jsonb_array_length(${nativeRunFinalizations.recoveryHistory}) - 1)::text, 'disposition'],
        '"reattach_existing_runner"'::jsonb)`,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const { disposition } = await resumeThenCrash(fixture);
    expect(disposition).toMatchObject({ kind: "blocked", reason: "execution_recovery_budget_exhausted" });
  });

  // The executor records each attempt's provider attempt on its start.
  const processStart = (providerAttempt: number) =>
    ({ eventType: "native.process_start_requested", payload: { hostname: "host", providerAttempt } });

  it("charges an adopted reattachment whose runner died without progress, even after it recorded a start", async () => {
    const fixture = await seedInterruptedCheckpoint("REATTACH-START-NO-PROGRESS");
    await resumeThenCrash(fixture);
    await appendRunEvents(fixture, [...restoreNoise(1), { eventType: "turn.failed", turnId: "continuation-1" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 3 });
    await fixture.db.update(nativeRunFinalizations).set({
      recoveryHistory: sql`jsonb_set(${nativeRunFinalizations.recoveryHistory},
        array[(jsonb_array_length(${nativeRunFinalizations.recoveryHistory}) - 1)::text, 'disposition'],
        '"reattach_existing_runner"'::jsonb)`,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    // The reattachment's own admission records a start for the same attempt.
    await appendRunEvents(fixture, [processStart(3)]);
    const { disposition } = await resumeThenCrash(fixture);
    expect(disposition).toMatchObject({ kind: "blocked", reason: "execution_recovery_budget_exhausted" });
  });

  it("does not charge a normal retry whose executor died after saving its attempt but before its start", async () => {
    const fixture = await seedInterruptedCheckpoint("RETRY-SAVED-UNSTARTED");
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    // The resume (attempt 2) starts, its provider accepts a turn, and it
    // makes no progress. A normal retry then saves attempt 3 and the
    // controller dies before that retry records its start.
    await appendRunEvents(fixture, [processStart(2), { eventType: "turn.accepted", turnId: "resumed" }]);
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 3 });
  });

  it("charges the owed attempt once when an unstarted first resume is replaced", async () => {
    const fixture = await seedInterruptedCheckpoint("UNSTARTED-FIRST-RESUME");
    // The first restart charges, but the controller dies before the executor
    // takes its lease, so the charge was never applied.
    await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId] });
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerPid: 2_000_000_001 })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    // The replacement carries that charge, once.
    const { disposition, attempt } = await resumeThenCrash(fixture);
    expect(disposition).toMatchObject({ kind: "resume_dead_runner", chargesProviderAttempt: true });
    expect(attempt).toBe(2);
  });

  it("bounds a crash loop that never starts the provider", async () => {
    const fixture = await seedInterruptedCheckpoint("UNSTARTED-CRASH-LOOP");
    const outcomes: Array<{ kind?: string; attempt?: number }> = [];
    for (let round = 1; round <= NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT + 3; round += 1) {
      const { disposition, attempt } = await resumeThenCrash(fixture);
      outcomes.push({ kind: disposition?.kind, attempt });
      if (disposition?.kind !== "resume_dead_runner") break;
    }
    expect(outcomes.at(-1)).toEqual({ kind: "blocked", attempt: undefined });
    expect(outcomes.slice(0, -1).map(outcome => outcome.attempt))
      .toEqual([2, ...Array(NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT - 2).fill(2), 3]);
  });

  it("bounds a crash loop that makes progress before every crash", async () => {
    const fixture = await seedInterruptedCheckpoint("PROGRESS-CRASH-LOOP");
    const outcomes: Array<{ kind?: string; attempt?: number }> = [];
    for (let round = 1; round <= NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT + 3; round += 1) {
      const { disposition, attempt } = await resumeThenCrash(fixture);
      outcomes.push({ kind: disposition?.kind, attempt });
      if (disposition?.kind !== "resume_dead_runner") break;
      await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
        { eventType: "turn.accepted", turnId: `loop-${round}` },
        { eventType: "item.completed", turnId: `loop-${round}`, kind: "assistant_message" }]);
    }
    // Generations 2..12 are claimed; credit stops at the generation limit and
    // the remaining attempt is spent before recovery blocks.
    expect(outcomes.at(-1)).toEqual({ kind: "blocked", attempt: undefined });
    expect(outcomes.slice(0, -1).map(outcome => outcome.attempt))
      .toEqual([2, ...Array(NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT - 2).fill(2), 3]);
  });

  async function recordUnstartedClaim(fixture: Awaited<ReturnType<typeof seedRun>>, noProgressRestarts: number) {
    const [last] = await fixture.db.select({ seq: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)::int` })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, fixture.runId));
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ recoveryHistory: [...coordinator.recoveryHistory, {
      disposition: "bootstrap_incomplete", progressWatermarkSeq: last?.seq ?? 0, progressAttempt: coordinator.attempt,
      noProgressRestarts,
    }] }).where(eq(nativeRunFinalizations.runId, fixture.runId));
  }

  async function seedPastGenerationLimit(label: string) {
    const fixture = await seedInterruptedCheckpoint(label);
    await fixture.db.update(nativeRunFinalizations).set({ controllerGeneration: NATIVE_PROGRESS_CREDIT_GENERATION_LIMIT })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, [{ eventType: "tool.execution.completed", turnId: "interrupted-turn" }]);
    return fixture;
  }

  async function lastClaimEntry(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const [coordinator] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    return (coordinator.recoveryHistory as Array<Record<string, unknown>>).at(-1)!;
  }

  const providerNeverStarted = [{ eventType: "native.process_start_requested" },
    { eventType: "native.process_identity_recorded" }, { eventType: "session.resumed" }];
  const providerProgressed = (round: number) => [{ eventType: "native.process_start_requested" },
    { eventType: "turn.accepted", turnId: `past-limit-${round}` },
    { eventType: "tool.execution.completed", turnId: `past-limit-${round}` }];

  it("does not charge a restart past the generation limit whose resume never started the provider", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-UNSTARTED");
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: true }, attempt: 2 });
    await appendRunEvents(fixture, providerProgressed(1));
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: true }, attempt: 3 });
    await appendRunEvents(fixture, providerNeverStarted);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 3 });
    expect(await lastClaimEntry(fixture)).toMatchObject({ noProgressRestarts: 1 });
  });

  it("stops after consecutive restarts with no provider progress and leaves a working Retry", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-NO-PROGRESS-LOOP");
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    const outcomes: Array<{ kind?: string; attempt?: number }> = [];
    for (let round = 1; round <= NATIVE_NO_PROGRESS_RESTART_LIMIT + 2; round += 1) {
      await appendRunEvents(fixture, providerNeverStarted);
      const { disposition, attempt } = await resumeThenCrash(fixture);
      outcomes.push({ kind: disposition?.kind, attempt });
      if (disposition?.kind !== "resume_dead_runner") break;
    }
    expect(outcomes).toEqual([
      ...Array(NATIVE_NO_PROGRESS_RESTART_LIMIT - 1).fill({ kind: "resume_dead_runner", attempt: 2 }),
      { kind: "resume_dead_runner", attempt: 3 },
      { kind: "blocked", attempt: undefined },
    ]);
    const [blocked] = await fixture.db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(blocked).toMatchObject({ phase: "terminal_failure", failureCode: "native_restart_recovery_blocked",
      leaseOwner: null, nextAttemptAt: null });
    const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(await taskInterruptionPresentation(fixture.db, issue)).toMatchObject({
      state: "failed", canRetry: true, observedRunId: fixture.runId });
    const personId = randomUUID();
    await fixture.db.insert(authUsers).values({ id: personId, name: "Retry person", email: `${personId}@fixture.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await fixture.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: personId,
      status: "active", membershipRole: "member" });
    expect(await requestTaskRetry({ db: fixture.db, companyId, issueId: fixture.issueId, actorId: personId,
      actorSource: "session", idempotencyKey: `no-progress-loop-${fixture.runId}`, observedRunId: fixture.runId }))
      .toMatchObject({ accepted: true });
  });

  it("resets the consecutive no-progress count when a restart proves provider progress", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-PROGRESS-RESETS");
    const counts: unknown[] = [];
    const attempts: Array<number | undefined> = [];
    const round = async (events: Parameters<typeof appendRunEvents>[1]) => {
      await appendRunEvents(fixture, events);
      attempts.push((await resumeThenCrash(fixture)).attempt);
      counts.push((await lastClaimEntry(fixture)).noProgressRestarts);
    };
    await round([]);
    for (let index = 0; index < 3; index += 1) await round(providerNeverStarted);
    await round(providerProgressed(1));
    await round(providerNeverStarted);
    expect(counts).toEqual([0, 1, 2, 3, 0, 1]);
    expect(attempts).toEqual([2, 2, 2, 2, 3, 3]);
  });

  it("still charges a restart past the generation limit whose provider accepted a turn without progress", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-ACCEPTED-NO-PROGRESS");
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await appendRunEvents(fixture, [{ eventType: "native.process_start_requested" },
      { eventType: "turn.accepted", turnId: "accepted" }, { eventType: "item.completed", turnId: "accepted", kind: "usage" }]);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: true }, attempt: 3 });
    expect(await lastClaimEntry(fixture)).toMatchObject({ noProgressRestarts: 1 });
  });

  it("still charges a restart past the generation limit when the previous claim did not record its position", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-UNRECORDED");
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await fixture.db.update(nativeRunFinalizations).set({
      recoveryHistory: sql`jsonb_set(${nativeRunFinalizations.recoveryHistory},
        array[(jsonb_array_length(${nativeRunFinalizations.recoveryHistory}) - 1)::text],
        (${nativeRunFinalizations.recoveryHistory} -> -1) - 'progressWatermarkSeq' - 'noProgressRestarts')`,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, providerNeverStarted);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: true }, attempt: 3 });
  });

  it("counts from zero for a claim saved before restarts recorded the count", async () => {
    const fixture = await seedPastGenerationLimit("PAST-LIMIT-OLD-ROW");
    expect(await resumeThenCrash(fixture)).toMatchObject({ attempt: 2 });
    await appendRunEvents(fixture, providerNeverStarted);
    await resumeThenCrash(fixture);
    await fixture.db.update(nativeRunFinalizations).set({
      recoveryHistory: sql`jsonb_set(${nativeRunFinalizations.recoveryHistory},
        array[(jsonb_array_length(${nativeRunFinalizations.recoveryHistory}) - 1)::text],
        (${nativeRunFinalizations.recoveryHistory} -> -1) - 'noProgressRestarts')`,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await appendRunEvents(fixture, providerNeverStarted);
    expect(await resumeThenCrash(fixture)).toMatchObject({
      disposition: { kind: "resume_dead_runner", chargesProviderAttempt: false }, attempt: 2 });
    expect(await lastClaimEntry(fixture)).toMatchObject({ noProgressRestarts: 1 });
  });

  it("terminalizes the recorded failed-checkpoint incident atomically instead of resuming it on upgrade", async () => {
    const fixture = await seedRun("FAILED-CHECKPOINT");
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
      providerSessionId: "unusable-provider-session",
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const input = { db: fixture.db, controller: successor, restartKind: "hard" as const, runIds: [fixture.runId] };
    const captureCallsBeforeFirstClaim = mockCaptureRunFailure.mock.calls.length;
    expect(await claimNativeRestartRecoveries(input)).toEqual([{ kind: "blocked", runId: fixture.runId, reason: "provider_checkpoint_permanently_failed" }]);
    // The report fires without being awaited, so wait for it before asserting.
    await vi.waitFor(() => {
      expect(mockCaptureRunFailure.mock.calls.length).toBeGreaterThan(captureCallsBeforeFirstClaim);
    });
    const firstClaimCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBeforeFirstClaim);
    expect(firstClaimCaptures).toHaveLength(1);
    expect(firstClaimCaptures[0]?.[0]).toMatchObject({
      runId: fixture.runId,
      runStatus: "failed",
      errorCode: "native_restart_recovery_blocked",
    });

    const captureCallsBeforeReplay = mockCaptureRunFailure.mock.calls.length;
    expect(await claimNativeRestartRecoveries(input)).toEqual([]);
    // A replay that finds no eligible candidate must not report a second event.
    expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBeforeReplay)).toHaveLength(0);

    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_restart_recovery_blocked" });
    expect(issue).toMatchObject({ assigneeAgentId: agentId, executionRunId: null });
    expect(await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(1);
  });

  it("reports one event when it blocks a failed run that was an unreported pending retry", async () => {
    const fixture = await seedRun("PENDING-RETRY-BLOCKED");
    // The executor stores a scheduled same-run retry as failed + retryable_failure,
    // and reportRunFailure skips that write. The blocked write reports it.
    await fixture.db.update(heartbeatRuns).set({
      status: "failed",
      nativePhase: "retryable_failure",
      runnerProfileJson: { sessionCheckpoint: {
        terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
        providerSessionId: "unusable-provider-session",
      } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    expect(await claimNativeRestartRecoveries({
      db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId],
    })).toEqual([{ kind: "blocked", runId: fixture.runId, reason: "provider_checkpoint_permanently_failed" }]);
    await waitForPendingRunFailureReports();

    expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toEqual([
      [expect.objectContaining({ runId: fixture.runId, runStatus: "failed", errorCode: "native_restart_recovery_blocked" })],
    ]);
  });

  it("recovers a valid runner beyond a full batch of persistently blocked expired owners", async () => {
    const fixtures: Array<Awaited<ReturnType<typeof seedRun>>> = [];
    const db = createDb(temporary.connectionString);
    for (let index = 0; index < 101; index++) {
      const fixture = await seedRun(`EXPIRED-INVENTORY-${index}`, db);
      fixtures.push(fixture);
      const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
      const root = resolve(runtimeRoot, fixture.runId);
      await db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
        controllerGeneration: 1, leaseOwner: "inventory-owner", leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      const authority = new DurablePrpControlPlane({ stateDirectory: resolve(root, "control-plane"),
        identity: transportOptions(fixture, root).prpIdentity,
        expectedRunnerVersion: "inventory-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      try { await registerNativeRunnerCheckpoint({ db, binding, bootId: successor.bootId, authority }); }
      finally { await authority.stop(); }
    }
    const eligible = fixtures.at(-1)!;
    const ids = fixtures.map(fixture => fixture.runId);
    // This test controls the predecessor's abandoned lease, never the claim's new deadline.
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(inArray(nativeRunFinalizations.runId, ids));
    await db.update(issues).set({ executionRunId: null })
      .where(inArray(issues.id, fixtures.slice(0, -1).map(fixture => fixture.issueId)));
    await db.update(heartbeatRuns).set({ runnerProfileJson: {
      nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId: "workspace",
        leaseId: "lease", providerLeaseId: "sandbox", remoteCwd: "/workspace" },
      sessionCheckpoint: { identity: { companyId, agentId, issueId: eligible.issueId, runId: eligible.runId,
        sessionId: eligible.native.normalizedSessionId }, providerSessionId: "surviving-inventory-provider" },
    } }).where(eq(heartbeatRuns.id, eligible.runId));
    const expired = await listExpiredNativeRunnerAuthorities(db, new Date(), ids);
    expect(new Set(expired)).toEqual(new Set(ids));
    const dispositions = await claimNativeRestartRecoveries({ db, runIds: expired,
      controller: { ...successor, bootId: randomUUID() }, restartKind: "hard" });
    expect(dispositions.filter(value => value.kind === "blocked" && value.reason === "issue_execution_lock_changed")).toHaveLength(100);
    expect(dispositions.find(value => value.runId === eligible.runId)).toMatchObject({ kind: "reattach_remote_runner" });
    expect(await listExpiredNativeRunnerAuthorities(db, new Date(), ids)).not.toContain(eligible.runId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, eligible.runId));
    expect(run).toMatchObject({ status: "running", nativeSessionId: eligible.native.normalizedSessionId });
  }, 30_000);

  it("classifies every requested recovery candidate without an implicit 100-run cap", async () => {
    const db = createDb(temporary.connectionString);
    const fixtures: Array<Awaited<ReturnType<typeof seedRun>>> = [];
    for (let index = 0; index < 101; index += 1) {
      fixtures.push(
        await seedRun(`BULK-${String(index).padStart(3, "0")}`, db),
      );
    }

    const dispositions = await claimNativeRestartRecoveries({
      db,
      controller: { ...successor, bootId: randomUUID() },
      restartKind: "hard",
      now: new Date(),
      runIds: fixtures.map((fixture) => fixture.runId),
    });

    expect(dispositions).toHaveLength(101);
    expect(
      dispositions.every(
        (disposition) => disposition.kind === "bootstrap_incomplete",
      ),
    ).toBe(true);
  }, 30_000);
});

enableRunFailureReporting();

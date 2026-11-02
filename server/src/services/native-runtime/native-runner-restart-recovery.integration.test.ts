import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { renewNativeSessionExecutionLease, startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal } from "./native-execution-lease.js";
import { enableRunFailureReporting } from "../../__tests__/helpers/run-failure-reporting.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { randomUUID } from "node:crypto";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { heartbeatService } from "../heartbeat.js";

import {
  canonicalNativeRuntimeContextDigest,
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
  parseNativeExecutionInput,
  DurablePrpControlPlane,
  decodeDurablePrpCheckpoint,
  readRunnerdArtifactBinding,
  type RunnerProcessHandle,
  type RunnerProcessLaunchSpec,
} from "../../vendor/paperclip-runner/index.js";
import {
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  registerRunnerPrpAuthority,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, findNativeSessionResumeRun, nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { materializeAsset } from "./runtime-context.js";
import { createRunnerTestTlsTunnel, dockerCommandRunner } from "../../__tests__/helpers/docker-command-runner.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { waitForPendingRunFailureReports } from "../run-failure-report.js";
import { closeIdleWarmNativeSessionsForRestart, detachNativeSessionsForRestart, executePaperclipNativeSession, NativeControllerDetachedForRestartError } from "./native-session-executor.js";
import { listExpiredNativeRunnerAuthorities, loadNativeRunnerCheckpoint, nativeRunnerCheckpointRegistration, nativeRunnerCheckpointWriter, registerNativeRunnerCheckpoint, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "./native-runner-recovery-contract.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { RUNNER_BRIDGE_READ_OPERATIONS, RUNNER_BRIDGE_SCHEMAS } from "./runner-bridge-tools.js";
import { HttpError } from "../../errors.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../../sentry.js")>("../../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});

import {
  claimNativeRestartRecoveries,
  currentNativeControllerIdentity,
  type NativeControllerIdentity,
} from "./native-restart-recovery.js";

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

// An explicitly supplied disposable database also permits qualification on hosts
// where native Postgres cannot allocate semaphores. Never fall back silently.
const describeEmbeddedPostgres = recoveryPostgresSupport.supported ? describe : describe.skip;

const fakeCodexAppServer = resolve(
  import.meta.dirname,
  "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server",
);
const binariesAvailable =
  existsSync(defaultCapabilityRunnerdBinary()) && existsSync(fakeCodexAppServer);
const realProcessIt = binariesAvailable ? it : it.skip;

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function stopOwnedProcessGroup(
  pid: number | null,
  expectedStateRoot: string,
): Promise<void> {
  if (!pid || !processAlive(pid)) return;
  const command = await import("node:child_process").then(
    ({ execFileSync }) =>
      execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim(),
  );
  if (!command.includes(expectedStateRoot)) {
    throw new Error(`Refusing to signal process ${pid}; ownership changed`);
  }
  if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
  else process.kill(pid, "SIGKILL");
  await waitForCondition(`owned process ${pid} to exit`, () => !processAlive(pid));
}

describeEmbeddedPostgres("native runner restart recovery with real processes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let runtimeRoot: string;
  let paperclipHome: string;
  let server: Server | null = null;
  let apiUrl: string;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;

  const companyId = randomUUID();
  const agentId = randomUUID();
  let successor: NativeControllerIdentity;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("native-runner-restart-recovery-");
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "native-restart-runtime-"));
    isolatedHome = createIsolatedTestHome();
    paperclipHome = isolatedHome.home;
    process.env.PAPERCLIP_HOME = paperclipHome;
    const controllerStartedAt = await readProcessStartedAt(process.pid);
    successor = {
      bootId: randomUUID(),
      pid: process.pid,
      processStartedAt: controllerStartedAt
        ? new Date(controllerStartedAt)
        : new Date(),
    };
    server = createServer();
    await new Promise<void>((resolveListen) =>
      server!.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected restart recovery TCP listener");
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
    setupRunnerPrpWebSocketServer(server, { apiUrl });

    const db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Native restart recovery",
      issuePrefix: "NRR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native restart runner",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await closeServer(server);
    await temporary?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    isolatedHome?.cleanup();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  });

  async function seedRun(
    label: string,
    existingDb?: ReturnType<typeof createDb>,
  ) {
    const db = existingDb ?? createDb(temporary.connectionString);
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `NRR-${label}`,
      title: `Recover ${label}`,
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: { issueId },
      })
      .returning();
    if (!run) throw new Error("Failed to seed native restart run");
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue: {
        id: issueId,
        title: `Recover ${label}`,
        description: null,
        reviewPolicy: null,
      },
      environmentLeaseId: `lease-${label}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "observed",
    });
    const [preparedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return { db, issueId, runId, native, preparedProfile: preparedRun.runnerProfileJson };
  }

  function transportOptions(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    stateDirectory: string,
  ) {
    return {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodexAppServer,
      codexArgs: [
        "--state-file",
        resolve(stateDirectory, "fake-codex-state.json"),
        "--call-log",
        resolve(stateDirectory, "fake-codex-calls.log"),
      ],
      stateDirectory,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      prpIdentity: {
        runnerInstanceId: fixture.native.runnerInstanceId,
        environmentLeaseId: fixture.native.environmentLeaseId,
        runId: fixture.runId,
        normalizedSessionId: fixture.native.normalizedSessionId,
        turnId: fixture.native.turnId,
        itemId: fixture.native.itemId,
      },
      controlPlaneRegistration: (authority: Parameters<typeof registerRunnerPrpAuthority>[0]["authority"]) =>
        registerRunnerPrpAuthority({
          companyId,
          runId: fixture.runId,
          authority,
        }),
    };
  }

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

  it.skipIf(!process.env.PAPERCLIP_TEST_RUNNER_CONTAINER).each(["warm", "hard", "legacy", "changed", "same-server", "diskless", "diskless-per-turn", "diskless-per-turn-read-retry", "diskless-warm-suspended", "diskless-warm-suspended-read-retry", "diskless-live-inspection"])("preserves remote warm continuity across completed turns: %s", async (scenario) => {
    const hardRestart = !["warm", "same-server"].includes(scenario);
    const diskless = scenario.startsWith("diskless");
    const perTurn = scenario.startsWith("diskless-per-turn");
    const warmSuspended = scenario.startsWith("diskless-warm-suspended");
    const resumedAfterSuspension = perTurn || warmSuspended;
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
              // Completion has released the coordinator, but the startup still
              // owns its session. A leftover preparation timer would detach it.
              const [settled] = await fixture.db.select().from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, fixture.runId));
              expect(settled.leaseOwner).toBeNull();
              await new Promise(resolve => setTimeout(resolve, 21_000));
              return false;
            },
            collectStopped: async () => undefined,
          },
        }).finally(() => preparation?.stop().catch(() => undefined));
        expect(logs.filter(line => line.includes("controller authority detached for restart"))).toHaveLength(1);
        const recoveredCalls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
        expect(recoveredCalls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(1);
        const nextProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
        expect(nextProcess.stdout).toBe(priorProcess.stdout);
        return result;
      };
      const first = hardRestart ? await executeInController(firstOptions) : await executeFirst();
      expect(first.exitCode).toBe(0);
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
        if (!resumedAfterSuspension) await expect(executePaperclipNativeSession({ ...nextOptions,
          runnerExecutionTarget: { ...nextOptions.runnerExecutionTarget,
            sandboxLeaseAcquisition: { outcome: "replacement", providerLeaseId: "unrelated-sandbox" } },
        })).rejects.toThrow("prior_owner_terminal_state_indeterminate");
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
      const second = diskless ? await executeInController(nextOptions) : await executePaperclipNativeSession(nextOptions);
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
      expect(finalCalls.stdout.split("\n").filter(line => line === "process-start")).toHaveLength(providerStarts + (resumedAfterSuspension ? 1 : 0));
      const finalProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      if (resumedAfterSuspension) expect(finalProcess.stdout).not.toBe(processAfter.stdout);
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
    await expect(recover({ ...call, input: { ...call.input, body: "changed" } }))
      .resolves.toBeNull();
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

  it("retains remote ownership through two delayed successful liveness-pool renewals", async () => {
    const fixture = await seedRun("DELAYED-RENEWAL-SUCCESS");
    const owner = createDb(temporary.connectionString);
    const pool = livenessDb(owner);
    const input = { db: owner, runId: fixture.runId, companyId, issueId: fixture.issueId,
      controller: successor, leaseOwner: "delayed-renewal-owner", attempt: 1, remote: true,
      onLost: vi.fn(async () => undefined) };
    const initialExpiry = new Date(Date.now() + 60_000);
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt,
      leaseOwner: input.leaseOwner, attempt: 1, leaseExpiresAt: initialExpiry })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    let release: (() => void) | undefined;
    let occupied: Promise<unknown> | undefined;
    let guard: NativeExecutionLeaseRenewal | undefined;
    const occupyPool = async () => {
      let entered = 0;
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      occupied = Promise.all([0, 1].map(() => pool.transaction(async () => {
        if (++entered === 2) ready();
        await barrier;
      })));
      await acquired;
    };
    const savedExpiry = async () => {
      const [saved] = await fixture.db.select({ expires: nativeRunFinalizations.leaseExpiresAt })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      return saved.expires!.getTime();
    };
    try {
      await occupyPool();
      guard = startNativeSessionExecutionLeaseRenewal(input);
      await new Promise(resolve => setTimeout(resolve, 50_000));
      release!(); await occupied;
      await vi.waitFor(async () => expect(await savedExpiry()).toBeGreaterThan(initialExpiry.getTime() + 40_000));
      const firstExpiry = await savedExpiry();
      await occupyPool();
      await new Promise(resolve => setTimeout(resolve, 40_000));
      release!(); await occupied;
      await vi.waitFor(async () => expect(await savedExpiry()).toBeGreaterThan(firstExpiry + 30_000));
      expect(input.onLost).not.toHaveBeenCalled();
      await guard.stop();
    } finally {
      release?.(); await occupied; await guard?.stop().catch(() => undefined);
      await closeLivenessDb(owner, 1); await owner.$client.end({ timeout: 1 });
    }
  }, 120_000);

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

  it("gives a recovery claim its full lease after an old batch observation", async () => {
    const fixture = await seedRun("LATE-BATCH-CLAIM");
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
      const controller = { ...successor, bootId: randomUUID() };
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller,
        restartKind: "hard", now: observedAt, runIds: [fixture.runId] });
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

  realProcessIt("keeps checkpoint SQL independent of streamed output volume with a real Postgres writer", async () => {
    const samples: Array<{ chunks: number; checkpointWrites: number; transactions: number;
      changedRows: number; checkpointBytes: number; walBytes: number; elapsedMs: number; idleSql: number;
      streamSql: number; streamTransactions: number; streamChangedRows: number; renewalSql: number }> = [];
    for (const chunks of [8, 512, 8192]) {
      const fixture = await seedRun(`CHECKPOINT-COST-${chunks}`);
      const root = resolve(runtimeRoot, fixture.runId);
      const releaseOutput = resolve(root, "release-output");
      const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
      const owner = { ...binding, authorityRunId: fixture.runId, bootId: successor.bootId,
        generation: 1, leaseOwner: "cost-controller" };
      await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: owner.bootId,
        controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt,
        controllerGeneration: 1, leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      let authority!: DurablePrpControlPlane;
      let measuring = false;
      let transactions = 0, changedRows = 0, checkpointBytes = 0;
      const statements: string[] = [];
      const renewalStatements: string[] = [];
      let leaseLost = false;
      const renewal = startNativeSessionExecutionLeaseRenewal({ db: fixture.db, ...binding, leaseOwner: owner.leaseOwner,
        attempt: 0, controller: successor, remote: true, onLost: async () => { leaseLost = true; } });
      const capturedClients = [fixture.db.$client, checkpointDb(fixture.db).$client, livenessDb(fixture.db).$client];
      const priorDebug = capturedClients.map(client => client.options.debug);
      // Capture statements only, never SQL parameters (encrypted state or secrets).
      capturedClients.forEach((client, index) => {
        client.options.debug = (_connection, query) => {
          if (!measuring) return;
          // Renewals are existing liveness traffic, reported separately. A
          // checkpoint query on any pool still counts against the zero oracle.
          if (index === 2 && !query.includes("native_runner_checkpoints")) renewalStatements.push(query);
          else statements.push(query);
        };
      });
      const write = nativeRunnerCheckpointWriter(fixture.db, owner);
      let costFailure: unknown;
      const transport = createRunnerdCodexTransport({ ...transportOptions(fixture, root),
        codexArgs: ["--state-file", resolve(root, "provider.json"), "--linger-after-turn-start",
          "--held-output", "--held-output-count", String(chunks), "--held-output-release-file", releaseOutput],
        controlPlaneRegistration: async core => {
          authority = core;
          core.setCheckpointPersistence(async checkpoint => {
            if (measuring) {
              transactions++;
              changedRows += checkpoint.changedRecords.size;
              checkpointBytes += [...checkpoint.changedRecords.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
              expect([...checkpoint.changedRecords.values()].join("\n")).not.toContain("still computing");
            }
            await write(checkpoint);
          });
          return registerRunnerPrpAuthority({ ...binding, authority: core });
        },
      });
      try {
        await transport.transport.request("thread/start", { cwd: root, dynamicTools: [] });
        await authority.flushCheckpoint();
        const [walStart] = await fixture.db.execute(sql`select pg_current_wal_insert_lsn()::text as lsn`);
        const started = performance.now();
        measuring = true;
        await transport.transport.request("turn/start", { input: [{ type: "text", text: "Produce the scripted stream." }] });
        await waitForCondition("settled control setup before releasing text", () =>
          authority.store.state.commands.every(command => command.status === "completed")
          && authority.store.state.committedEvents.some(event => event.eventType === "turn.started"));
        await authority.flushCheckpoint();
        const beforeStream = { sql: statements.length, transactions, changedRows };
        await writeFile(releaseOutput, "release\n", { flag: "wx" });
        await waitForCondition(`the final scripted text chunk of ${chunks}`, () => authority.store.state.committedEvents
          .some(event => event.eventType === "item.delta" && JSON.stringify(event.envelope).includes(`still computing ${chunks - 1} `)), chunks > 4096 ? 480_000 : 60_000)
          .catch(error => { console.info("checkpoint-cost-stream-diagnostic", JSON.stringify({ chunks,
            cursor: authority.store.state.ackedSourceSeq,
            receivedTextEvents: authority.store.state.committedEvents.filter(event => event.eventType === "item.delta").length })); throw error; });
        await authority.flushCheckpoint();
        measuring = false;
        const elapsedMs = performance.now() - started;
        const [walEnd] = await fixture.db.execute(sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${String(walStart.lsn)}::pg_lsn)::text as bytes`);
        const checkpointWrites = statements.filter(query => /^\s*(insert|update|delete)\b/i.test(query)
          && query.includes("native_runner_checkpoints")).length;
        expect(checkpointWrites).toBeGreaterThan(0); // The collector must see real control writes.
        const snapshot = { chunks, checkpointWrites, transactions, changedRows, checkpointBytes,
          walBytes: Number(walEnd.bytes), elapsedMs, idleSql: 0, renewalSql: renewalStatements.length,
          streamSql: statements.length - beforeStream.sql,
          streamTransactions: transactions - beforeStream.transactions,
          streamChangedRows: changedRows - beforeStream.changedRows };
        // Setup control messages may coalesce differently. The released text-only
        // interval must add exactly zero work, independent of that scheduling.
        expect(snapshot).toMatchObject({ streamSql: 0, streamTransactions: 0, streamChangedRows: 0 });
        expect(leaseLost).toBe(false);
        statements.length = 0;
        measuring = true;
        await new Promise(done => setTimeout(done, 100));
        await authority.flushCheckpoint();
        snapshot.idleSql = statements.length;
        expect(statements).toEqual([]);
        // Positive calibration: an actual new control operation must trip the zero-write oracle.
        authority.queueCommand("session.snapshot", {}, `cost-positive-control-${chunks}`);
        await authority.flushCheckpoint();
        expect(statements.some(query => /insert into "native_runner_checkpoints"/i.test(query))).toBe(true);
        measuring = false;
        samples.push(snapshot);
        console.info("native-checkpoint-cost-sample", JSON.stringify(snapshot));
      } catch (error) {
        costFailure = error;
        throw error;
      } finally {
        measuring = false;
        capturedClients.forEach((client, index) => { client.options.debug = priorDebug[index]; });
        try { await transport.transport.close(); }
        catch (error) {
          if (costFailure) throw new AggregateError([costFailure, error], "Checkpoint cost measurement and cleanup failed");
          throw error;
        }
        finally {
          await renewal.stop().catch(error => {
            if (costFailure) throw new AggregateError([costFailure, error], "Checkpoint cost measurement and lease renewal failed");
            throw error;
          });
        }
      }
    }
    const report = { schema: "paperclip.checkpoint-cost/v1", samples,
      scope: "isolated Postgres; control operations included; WAL is diagnostic; no production capacity claim" };
    if (process.env.PAPERCLIP_TEST_CHECKPOINT_COST_REPORT) await writeFile(process.env.PAPERCLIP_TEST_CHECKPOINT_COST_REPORT,
      `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Each stream size was checked independently; total setup counts remain
    // diagnostic because control-message batching is scheduling-dependent.
    console.info("native-checkpoint-cost", JSON.stringify(report));
  }, 540_000);

  realProcessIt.each([false, true])("adopts the same runner from Postgres after losing the controller filesystem (prepared task: %s)", async preparedTask => {
    const fixture = await seedRun(`EMPTY-CONTROLLER-DISK-${preparedTask}`);
    const controllerRoot = resolve(runtimeRoot, `${fixture.runId}-controller`);
    const sandboxRoot = resolve(runtimeRoot, `${fixture.runId}-sandbox`);
    const binding = { companyId, issueId: fixture.issueId, runId: fixture.runId };
    const outageMs = Number(process.env.PAPERCLIP_TEST_CONTROLLER_OUTAGE_MS ?? 1000);
    if (!Number.isFinite(outageMs) || outageMs < 0 || outageMs > 300_000) throw new Error("Invalid controller outage duration");
    await mkdir(sandboxRoot, { recursive: true });
    await mkdir(resolve(sandboxRoot, "filesystem/codex-home"), { recursive: true });
    let bootId = randomUUID();
    const taskLeaseId = randomUUID();
    if (preparedTask) {
      const [environment] = await fixture.db.insert(environments).values({ name: "Surviving plugin task", driver: "plugin", status: "active", config: {} }).returning();
      await fixture.db.insert(environmentLeases).values({ id: taskLeaseId, companyId, environmentId: environment.id,
        heartbeatRunId: fixture.runId, issueId: fixture.issueId, status: "active", leasePolicy: "ephemeral",
        provider: "plugin", providerLeaseId: "saved-task", metadata: { agentId, runnerTaskLease: true, runnerTaskDispatched: true } });
    }
    const originalLeaseExpiresAt = new Date(Date.now() + 60_000);
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: bootId,
      controllerGeneration: 1, controllerPid: process.pid, controllerProcessStartedAt: new Date(),
      leaseOwner: "original-controller", leaseExpiresAt: originalLeaseExpiresAt,
    }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const options = {
      ...transportOptions(fixture, controllerRoot),
      ...(preparedTask ? { prpIdentity: { ...transportOptions(fixture, controllerRoot).prpIdentity, environmentLeaseId: taskLeaseId } } : {}),
      runnerStateDirectory: resolve(sandboxRoot, "runner"),
      runnerFilesystemRoot: resolve(sandboxRoot, "filesystem"),
      runnerReconnectGraceMs: REMOTE_RUNNER_RECONNECT_GRACE_MS,
      codexArgs: ["--state-file", resolve(sandboxRoot, "provider.json"),
        "--call-log", resolve(sandboxRoot, "calls.log"), "--linger-after-turn-start", "--held-output"],
      controlPlaneRegistration: async (authority: DurablePrpControlPlane) => {
        await registerNativeRunnerCheckpoint({ db: fixture.db, binding, bootId, authority });
        return registerRunnerPrpAuthority({ ...binding, authority });
      },
    };
    const prepareLaunch = vi.fn(async (requirements: RunnerProviderLaunchRequirements) => ({
      configurationId: "provider-owned-configuration", requirementsDigest: runnerLaunchRequirementsDigest(requirements),
      provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: options.codexArgs },
        root: sandboxRoot, cwd: sandboxRoot, codexHome: resolve(sandboxRoot, "filesystem/codex-home"),
        codexCommand: fakeCodexAppServer, providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "" }),
    }));
    const first = createRunnerdCodexTransport({ ...options, ...(preparedTask ? {
      prepareLaunch, runnerArtifact: readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary()),
      runnerProcessLauncher: (spec: RunnerProcessLaunchSpec): RunnerProcessHandle => {
        const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...process.env, ...spec.environment },
          detached: process.platform !== "win32", stdio: "ignore" });
        return { child, processGroupId: child.pid ?? null, completion: new Promise((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
        }) };
      },
    } : {}) });
    let adopted: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let runnerPid: number | null = null;
    try {
      const thread = (await first.transport.request("thread/start", { cwd: sandboxRoot, dynamicTools: [] })).thread as Record<string, unknown>;
      const turn = (await first.transport.request("turn/start", { input: [{ type: "text", text: "Keep computing while the controller is offline." }] })).turn as Record<string, unknown>;
      runnerPid = first.evidence().runnerPid;
      const providerPid = first.evidence().providerPid;
      if (!runnerPid || !providerPid) throw new Error("Runner/provider process identity missing");
      const startedAt = await readProcessStartedAt(runnerPid);
      if (!startedAt) throw new Error("Runner start identity missing");
      await waitForCondition("streaming ACK advances without a recovery checkpoint", async () => {
        const runner = JSON.parse(await readFile(resolve(sandboxRoot, "runner/runner-state.json"), "utf8"));
        const checkpoint = await loadNativeRunnerCheckpoint(fixture.db, binding);
        const cursor = checkpoint && JSON.parse(checkpoint.records.get("cursor")!);
        return cursor && runner.ackedSourceSeq >= cursor.ackedSourceSeq + 64;
      });
      const beforeRestart = (await loadNativeRunnerCheckpoint(fixture.db, binding))!;
      expect([...beforeRestart.records.entries()].filter(([key]) => key.startsWith("event:"))
        .some(([, value]) => JSON.parse(value).eventType === "item.delta")).toBe(false);
      await fixture.db.update(heartbeatRuns).set({ processPid: runnerPid, processStartedAt: new Date(startedAt),
        runnerProfileJson: { ...fixture.preparedProfile,
          ...(!preparedTask ? { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
            descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
            workspaceId: "workspace", leaseId: "lease", providerLeaseId: "sandbox", remoteCwd: sandboxRoot } } : {}),
          sessionCheckpoint: { identity: { ...binding, agentId, sessionId: fixture.native.normalizedSessionId },
            providerSessionId: thread.id, process: { providerPid } },
        },
      }).where(eq(heartbeatRuns.id, fixture.runId));
      await first.detachControllerForRestart();
      await rm(controllerRoot, { recursive: true, force: true });
      expect(existsSync(controllerRoot)).toBe(false);
      await new Promise(resolveOutage => setTimeout(resolveOutage, outageMs));
      expect(processAlive(runnerPid)).toBe(true);
      expect(processAlive(providerPid)).toBe(true);
      bootId = randomUUID();
      if (originalLeaseExpiresAt.getTime() > Date.now()) {
        const [waiting] = await claimNativeRestartRecoveries({ db: fixture.db, controller: { ...successor, bootId },
          restartKind: "hard", runIds: [fixture.runId] });
        expect(waiting).toMatchObject({ kind: "awaiting_evidence", reason: "remote_controller_lease_live", retryAt: originalLeaseExpiresAt });
        await new Promise(resolveExpiry => setTimeout(resolveExpiry, Math.max(0, originalLeaseExpiresAt.getTime() - Date.now()) + 20));
      }
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: { ...successor, bootId },
        restartKind: "hard", runIds: [fixture.runId] });
      expect(claim).toMatchObject({ kind: "reattach_remote_runner", providerAttempt: 0, controllerGeneration: 2 });
      if (preparedTask) expect(claim).toMatchObject({ remote: { kind: "plugin_task", leaseId: taskLeaseId } });
      const checkpoint = await restoreNativeRunnerCheckpoint(fixture.db, binding, controllerRoot);
      if (!checkpoint) throw new Error("Missing durable authority");
      const duplicateLauncher = vi.fn(() => { throw new Error("duplicate runner spawn attempted"); });
      prepareLaunch.mockClear();
      const authorizeRunnerAdoption = vi.fn(async () => {});
      adopted = createRunnerdCodexTransport({ ...options,
        ...(preparedTask ? { prepareLaunch, authorizeRunnerAdoption } : {}),
        runnerBinary: resolve(controllerRoot, "new-release-does-not-contain-old-runner"),
        runnerArtifact: { version: checkpoint.runnerVersion, digest: checkpoint.runnerDigest },
        resumeDynamicTools: [], runnerProcessLauncher: duplicateLauncher,
        adoptExistingRunner: { pid: preparedTask ? null : runnerPid, processGroupId: preparedTask ? null : first.evidence().runnerProcessGroupId,
          startedAt: preparedTask ? null : startedAt, isAlive: () => processAlive(runnerPid) },
      });
      await expect(adopted.transport.request("thread/read", {})).resolves.toMatchObject({
        thread: { id: thread.id, turns: [{ id: turn.id, status: "inProgress" }] },
      });
      await adopted.transport.request("turn/steer", { input: [{ type: "text", text: "Continue the same turn." }],
        expectedTurnId: turn.id, correlationId: "after-empty-disk-restart" });
      expect(adopted.evidence().runnerPid).toBe(preparedTask ? null : runnerPid);
      expect(adopted.evidence().providerPid).toBe(providerPid);
      expect(await readProcessStartedAt(runnerPid)).toBe(startedAt);
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(prepareLaunch).not.toHaveBeenCalled();
      if (preparedTask) expect(authorizeRunnerAdoption).toHaveBeenCalledExactlyOnceWith("provider-owned-configuration", options.prpIdentity);
      const calls = await readFile(resolve(sandboxRoot, "calls.log"), "utf8");
      expect(calls.match(/^turn\/start$/gm)).toHaveLength(1);
      expect(calls.match(/^turn\/steer$/gm)).toHaveLength(1);
    } finally {
      await adopted?.transport.close().catch(() => undefined);
      await first.transport.close().catch(() => undefined);
      await stopOwnedProcessGroup(runnerPid, sandboxRoot).catch(() => undefined);
    }
  }, 345_000);

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
        if (event.payload?.span === "heartbeat.prepare_after_environment") {
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

  function remotePreparedWorkspace() {
    return { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
      workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: randomUUID(),
      remoteCwd: "/workspace", resourceDisposition: "destroy" };
  }

  it.each(["claimed", "generation", "process", "launch", "provider-event", "checkpoint", "invalid-workspace", "unfenced"])(
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

  it.each([2, 3])("recovers a checkpointed restart interruption within provider budget %s", async (attempt) => {
    const fixture = await seedRun(`INTERRUPTED-${attempt}`);
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      driverKind: "codex_app_server",
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
    await fixture.db.update(nativeRunFinalizations).set({ attempt }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const dispositions = await claimNativeRestartRecoveries({
      db: fixture.db, controller: successor, restartKind: "hot", runIds: [fixture.runId],
    });
    expect(dispositions).toEqual([expect.objectContaining(attempt < 3
      ? { kind: "resume_dead_runner", runId: fixture.runId, providerAttempt: attempt }
      : { kind: "blocked", runId: fixture.runId, reason: "execution_recovery_budget_exhausted" })]);
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

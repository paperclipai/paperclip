import { enableRunFailureReporting } from "../../__tests__/helpers/run-failure-reporting.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  environmentLeases,
  environments,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  canonicalNativeRuntimeContextDigest,
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
  parseNativeExecutionInput,
} from "../../vendor/paperclip-runner/index.js";
import {
  getEmbeddedPostgresTestSupport,
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
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { materializeAsset } from "./runtime-context.js";
import { createRunnerTestTlsTunnel, dockerCommandRunner } from "../../__tests__/helpers/docker-command-runner.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { waitForPendingRunFailureReports } from "../run-failure-report.js";
import { closeIdleWarmNativeSessionsForRestart, executePaperclipNativeSession, NativeControllerDetachedForRestartError } from "./native-session-executor.js";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

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
  let originalPaperclipHome: string | undefined;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;

  const companyId = randomUUID();
  const agentId = randomUUID();
  let successor: NativeControllerIdentity;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "native-runner-restart-recovery-",
    );
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "native-restart-runtime-"));
    isolatedHome = createIsolatedTestHome();
    paperclipHome = isolatedHome.home;
    originalPaperclipHome = process.env.PAPERCLIP_HOME;
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
  });

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await closeServer(server);
    await temporary.cleanup();
    await rm(runtimeRoot, { recursive: true, force: true });
    isolatedHome.cleanup();
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

  it.skipIf(!process.env.PAPERCLIP_TEST_RUNNER_CONTAINER).each(["warm", "hard", "legacy", "changed"])("preserves remote warm continuity across completed turns: %s", async (scenario) => {
    const hardRestart = scenario !== "warm";
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
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runtimeContext: context,
      completionContract: await boundContract(fixture.runId),
    });
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...fixture.preparedProfile, nativeExecutionInput: execution,
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
    try {
      const firstOptions = { ...options, execution, runnerExecutionTarget: target };
      const first = hardRestart ? await new Promise<{ exitCode: number | null }>((resolveResult, reject) => {
        controller = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), resolve("server/src/__tests__/helpers/remote-warm-controller.test-worker.ts")],
          { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
        const timer = setTimeout(() => { controller?.kill("SIGKILL"); reject(new Error("Warm controller startup exceeded 60 seconds")); }, 60_000);
        controller.stdout?.on("data", data => logs.push(String(data)));
        controller.stderr?.on("data", data => logs.push(String(data)));
        controller.on("error", error => { clearTimeout(timer); reject(error); });
        controller.on("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Warm controller exited: ${code}/${signal}: ${logs.join("").slice(-3_000)}`)); });
        controller.on("message", (message: { log?: { text: string }; result?: { exitCode: number | null }; error?: string }) => {
          if (message.log) logs.push(message.log.text);
          if (message.error) { clearTimeout(timer); reject(new Error(message.error)); }
          if (message.result) { clearTimeout(timer); resolveResult(message.result); }
        });
        controller.send?.({ connectionString: temporary.connectionString, container, ingressUrl: `wss://127.0.0.1:${tunnel.port}`,
          options: { ...firstOptions, db: undefined, onLog: undefined, runnerExecutionTarget: { ...target, runner: undefined } } });
      }) : await executePaperclipNativeSession(firstOptions);
      expect(first.exitCode).toBe(0);
      await finalizeNativeRun({ db: fixture.db, runId: fixture.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const snapshot = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-state.json`] });
      expect(snapshot.exitCode).toBe(0);
      const saved = JSON.parse(snapshot.stdout);
      expect(saved.lifecycle).toBe("ready");
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
        await expect(executePaperclipNativeSession(nextOptions)).rejects.toThrow("prior_owner_terminal_state_indeterminate");
        const exited = new Promise<void>(resolveExit => controller!.once("exit", () => resolveExit()));
        controller.kill("SIGKILL");
        await exited;
        controller = undefined;
        await expect(executePaperclipNativeSession({ ...nextOptions,
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
      const [nextPrepared] = await fixture.db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, nextRunId));
      await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { ...nextPrepared.profile,
        nativeExecutionInput: nextOptions.execution } }).where(eq(heartbeatRuns.id, nextRunId));
      const second = await executePaperclipNativeSession(nextOptions);
      expect(second.exitCode).toBe(0);
      const historyAfter = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/filesystem/codex-home/fake-codex-state.json`] });
      const providerAfter = JSON.parse(historyAfter.stdout);
      expect(providerAfter.threadId).toBe(providerBefore.threadId);
      expect(providerAfter.nextTurn).toBe(2);
      const calls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
      expect(calls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(2);
      expect(calls.stdout.split("\n").filter(line => line === "thread/start")).toHaveLength(1);
      const providerStarts = calls.stdout.split("\n").filter(line => line === "process-start").length;
      expect(providerStarts).toBeGreaterThanOrEqual(1);
      expect(providerStarts).toBeLessThanOrEqual(["legacy", "changed"].includes(scenario) ? 3 : hardRestart ? 2 : 1);
      const processAfter = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      expect(processAfter.exitCode).toBe(0);
      if (["legacy", "changed"].includes(scenario)) expect(processAfter.stdout).not.toBe(processBefore.stdout);
      else expect(processAfter.stdout).toBe(processBefore.stdout);
      await finalizeNativeRun({ db: fixture.db, runId: nextRunId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
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
      const third = await executePaperclipNativeSession({ ...nextOptions, runnerInstanceId: thirdNative.runnerInstanceId,
        execution: { ...nextOptions.execution, completionContract: await boundContract(thirdRunId),
          binding: { ...execution.binding, runId: thirdRunId }, task: { ...execution.task, prompt: "Complete the third conversation turn." } },
        runnerExecutionTarget: { ...nextOptions.runnerExecutionTarget, leaseId: thirdLeaseId },
      });
      expect(third.exitCode).toBe(0);
      const finalHistory = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/filesystem/codex-home/fake-codex-state.json`] });
      expect(JSON.parse(finalHistory.stdout)).toMatchObject({ threadId: providerBefore.threadId, nextTurn: 3 });
      const finalCalls = await runner.execute({ command: "cat", args: [`${remoteCwd}/provider-calls.log`] });
      expect(finalCalls.stdout.split("\n").filter(line => line === "turn/start")).toHaveLength(3);
      expect(finalCalls.stdout.split("\n").filter(line => line === "thread/start")).toHaveLength(1);
      expect(finalCalls.stdout.split("\n").filter(line => line === "process-start")).toHaveLength(providerStarts);
      const finalProcess = await runner.execute({ command: "sh", args: ["-c", `cat '${remoteCwd}'/.paperclip-runtime/paperclip-runner/sessions/*/runner/runner-process.identity`] });
      expect(finalProcess.stdout).toBe(processAfter.stdout);
      expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 1, busy: 0, failed: 0 });
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
  }, 180_000);

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

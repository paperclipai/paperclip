import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  closeRegisteredClients,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
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
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { operateRemoteRunProcess, remoteRunnerRecoveryProcess, type RemoteRunProcessControlInput } from "./remote-runner-recovery.js";
import { createRemoteRunnerRecoveryControls } from "./remote-runner-recovery-controls.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import {
  claimNativeRestartRecoveries,
  type NativeControllerIdentity,
} from "./native-restart-recovery.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
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

  const companyId = randomUUID();
  const agentId = randomUUID();
  let successor: NativeControllerIdentity;

  beforeAll(async () => {
    temporary = externalTestDatabaseUrl
      ? { connectionString: externalTestDatabaseUrl, cleanup: () => closeRegisteredClients(externalTestDatabaseUrl) }
      : await startEmbeddedPostgresTestDatabase("native-runner-restart-recovery-");
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "native-restart-runtime-"));
    paperclipHome = await mkdtemp(resolve(tmpdir(), "native-restart-home-"));
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
    await Promise.all([
      rm(runtimeRoot, { recursive: true, force: true }),
      rm(paperclipHome, { recursive: true, force: true }),
    ]);
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
    return { db, issueId, runId, native };
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

  realProcessIt.each(["local", "remote"] as const)("adopts one active runner across hot and hard controller restarts without duplicating steering (%s)", async location => {
    const remote = location === "remote" ? await seedOwnedRemoteRun("PRP") : null;
    const fixture = remote ?? await seedRun("LIVE");
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
      if (remote) {
        // The real runner and PRP socket are local test fixtures. Only the
        // provider boundary is simulated; production claim/control code must
        // treat its persisted PID exclusively as a remote identifier.
        await fixture.db.update(heartbeatRuns).set({ processGroupId: null }).where(eq(heartbeatRuns.id, fixture.runId));
        await fixture.db.update(environmentLeases).set({ metadata: { ...remote.lease.metadata,
          runtimeServiceProcessOwner: { ...(remote.lease.metadata?.runtimeServiceProcessOwner as Record<string, unknown>),
            process: { ...remote.processReference.remoteProcessIdentity, pid: runnerPid, processGroupId: runnerPid } },
        } }).where(eq(environmentLeases.id, remote.lease.id));
        remote.provider.mockImplementation(async (_lease, request) => {
          if (request.operation.action !== "inspect") throw new Error("Unexpected provider mutation during reattachment");
          return { state: processAlive(runnerPid) ? "running" : "exited", workspaceConnection: remote.connection };
        });
      }

      await first.detachControllerForRestart();
      const [claim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hot",
        recoveryRequestId: "hot-restart-request",
        now: new Date(),
        runIds: [fixture.runId],
        inspectRemoteRunner: remote?.input.inspectRemoteRunner,
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
      if (remote) expect(claim.process).toMatchObject({ environmentLeaseId: fixture.native.environmentLeaseId });
      const recoveryControlsFor = (next: typeof claim) => {
        if (next.process.processLocation !== "remote" || !remote) return null;
        const controls = createRemoteRunnerRecoveryControls({ companyId, runId: fixture.runId, process: next.process, runtime: {
          controlRunProcess: remote.input.inspectRemoteRunner,
          recoverRunner: async () => { throw new Error("This local PRP fixture does not use provider ingress"); },
          executeRecoveringRunner: async () => { throw new Error("This local PRP fixture does not execute recovery commands"); },
        } }).nativeRunnerRecovery;
        controls.bindController({ leaseOwner: next.leaseOwner, controllerGeneration: next.controllerGeneration });
        return controls;
      };
      const remoteControls = recoveryControlsFor(claim);

      const duplicateLauncher = vi.fn(() => {
        throw new Error("duplicate runner spawn attempted");
      });
      adopted = createRunnerdCodexTransport({
        ...options,
        resumeDynamicTools: [],
        runnerProcessLauncher: duplicateLauncher,
        adoptExistingRunner: {
          ...claim.process,
          isAlive: remoteControls?.isAlive ?? (() => processAlive(runnerPid)),
        },
      });
      const restored = await adopted.transport.request("thread/read", {});
      expect(restored.thread).toMatchObject({
        id: thread.id,
        turns: [{ id: providerTurnId, status: "inProgress" }],
      });
      expect(adopted.evidence().runnerPid).toBe(runnerPid);
      if (remote) expect(adopted.transport.processInfo?.()).toMatchObject({ processLocation: "remote", remoteProcessIdentity: claim.process.processLocation === "remote" ? claim.process.remoteProcessIdentity : undefined });
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
        inspectRemoteRunner: remote?.input.inspectRemoteRunner,
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
      if (remote) expect(hardClaim.process).toEqual(claim.process);
      if (remoteControls) {
        await expect(remoteControls.isAlive()).rejects.toThrow("native_remote_runner_recovery_unverified");
        expect(() => remoteControls.bindController({ leaseOwner: hardClaim.leaseOwner,
          controllerGeneration: hardClaim.controllerGeneration })).toThrow("native_remote_runner_recovery_unverified");
      }
      const hardRestartControls = recoveryControlsFor(hardClaim);
      const secondDuplicateLauncher = vi.fn(() => {
        throw new Error("duplicate runner spawn attempted after hard restart");
      });
      adoptedAfterHardRestart = createRunnerdCodexTransport({
        ...options,
        resumeDynamicTools: [],
        runnerProcessLauncher: secondDuplicateLauncher,
        adoptExistingRunner: {
          ...hardClaim.process,
          isAlive: hardRestartControls?.isAlive ?? (() => processAlive(runnerPid)),
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

  realProcessIt("hard-restarts a dead runner on the same run and provider session", async () => {
    const fixture = await seedRun("DEAD");
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

      await first.detachControllerForRestart();
      await stopOwnedProcessGroup(firstRunnerPid, stateDirectory);
      await waitForCondition(
        "provider process to observe runner pipe closure",
        () => !processAlive(providerPid),
      );

      const [claim] = await claimNativeRestartRecoveries({
        db: fixture.db,
        controller: successor,
        restartKind: "hard",
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
          processLocation: "local",
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

  it("terminalizes the recorded failed-checkpoint incident atomically instead of resuming it on upgrade", async () => {
    const fixture = await seedRun("FAILED-CHECKPOINT");
    await fixture.db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: {
      terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
      providerSessionId: "unusable-provider-session",
    } } }).where(eq(heartbeatRuns.id, fixture.runId));
    await fixture.db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    const input = { db: fixture.db, controller: successor, restartKind: "hard" as const, runIds: [fixture.runId] };
    expect(await claimNativeRestartRecoveries(input)).toEqual([{ kind: "blocked", runId: fixture.runId, reason: "provider_checkpoint_permanently_failed" }]);
    expect(await claimNativeRestartRecoveries(input)).toEqual([]);
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_restart_recovery_blocked" });
    expect(issue).toMatchObject({ assigneeAgentId: agentId, executionRunId: null });
    expect(await fixture.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toHaveLength(1);
  });

  it.each(["explicit", "legacy", "missing_lease", "invalid_termination"] as const)(
    "preserves remote recovery authority without probing colliding host PIDs (%s)", async (scenario) => {
      const fixture = await seedRun(`REMOTE-${scenario}`);
      const birth = await readProcessStartedAt(process.pid);
      await fixture.db.update(heartbeatRuns).set({ processPid: process.pid, processGroupId: process.pid,
        processLocation: scenario === "legacy" ? null : "remote", processStartedAt: new Date(birth!) })
        .where(eq(heartbeatRuns.id, fixture.runId));
      if (scenario !== "missing_lease") {
        const [environment] = await fixture.db.insert(environments).values({ name: randomUUID(), driver: "sandbox", config: { provider: "daytona" } }).returning();
        await fixture.db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
          heartbeatRunId: fixture.runId, provider: "daytona", providerLeaseId: randomUUID(),
          status: scenario === "invalid_termination" ? "released" : "active",
          releasedAt: scenario === "invalid_termination" ? new Date() : null,
          cleanupStatus: scenario === "invalid_termination" ? "success" : null,
          metadata: scenario === "invalid_termination" ? { remoteExecutionTermination: { state: "stopped", providerLeaseId: randomUUID() } } : {},
        });
      }
      const kill = vi.spyOn(process, "kill");
      try {
        const input = { db: fixture.db, controller: successor, restartKind: "hard" as const, runIds: [fixture.runId] };
        expect(await claimNativeRestartRecoveries(input)).toEqual([{ kind: "awaiting_evidence", runId: fixture.runId, reason: "remote_runner_verification_required" }]);
        expect(await claimNativeRestartRecoveries(input)).toEqual([{ kind: "awaiting_evidence", runId: fixture.runId, reason: "remote_runner_verification_required" }]);
        expect(kill.mock.calls.filter(([pid]) => pid === process.pid || pid === -process.pid)).toEqual([]);
      } finally { kill.mockRestore(); }
      const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const [coordinator] = await fixture.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      expect(run).toMatchObject({ status: "running", processPid: process.pid });
      expect(issue?.executionRunId).toBe(fixture.runId);
      expect(coordinator).toMatchObject({ phase: "observed", recoveryState: "awaiting_evidence", attempt: 0, controllerGeneration: 0 });
    });

  async function seedOwnedRemoteRun(label: string) {
    const fixture = await seedRun(`OWNED-REMOTE-${label}`);
    const sessionId = fixture.native.normalizedSessionId;
    const [run] = await fixture.db.update(heartbeatRuns).set({ processPid: process.pid, processGroupId: null,
      processLocation: "remote", processStartedAt: new Date(), nativeSessionId: sessionId,
    }).where(eq(heartbeatRuns.id, fixture.runId)).returning();
    const [environment] = await fixture.db.insert(environments).values({ name: randomUUID(), driver: "sandbox", config: { provider: "daytona" } }).returning();
    const leaseId = randomUUID(), providerLeaseId = randomUUID(), pluginId = randomUUID();
    const owner = { version: 1, pid: process.pid, processGroupId: process.pid, uid: 1000, bootId: randomUUID(), startTicks: "100" };
    const connection = { scopeId: randomUUID(), fingerprint: "a".repeat(64) };
    const [lease] = await fixture.db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment!.id,
      issueId: fixture.issueId, heartbeatRunId: fixture.runId, provider: "daytona", providerLeaseId, status: "active",
      metadata: { pluginId,
        runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: "/workspace/app" },
        runtimeServiceProcessOwner: { version: 1, provider: "daytona", runId: fixture.runId, environmentLeaseId: leaseId, providerLeaseId, workspaceRoot: "/workspace/app", process: owner },
        runtimeServiceRunScope: { version: 1, companyId, environmentId: environment!.id, executionWorkspaceId: randomUUID(), pluginId,
          configurationDigest: "b".repeat(64), connection },
      },
    }).returning();
    const processReference = remoteRunnerRecoveryProcess(lease!, run!);
    if (!processReference) throw new Error("Remote fixture has no valid owner");
    const provider = vi.fn<Parameters<typeof operateRemoteRunProcess>[2]>(async (_lease, request) => ({ state: "running", workspaceConnection: request.workspaceConnection }));
    const inspectRemoteRunner = vi.fn((request: RemoteRunProcessControlInput) => operateRemoteRunProcess(fixture.db, request, provider));
    const input = { db: fixture.db, controller: successor, restartKind: "hard" as const, runIds: [fixture.runId], inspectRemoteRunner };
    return { ...fixture, native: { ...fixture.native, environmentLeaseId: leaseId }, lease: lease!, run: run!, processReference, connection, provider, input };
  }

  it("claims the original remote runner without probing its colliding host PID or changing its provider attempt", async () => {
    const f = await seedOwnedRemoteRun("LIVE");
    const kill = vi.spyOn(process, "kill");
    try {
      const [claim] = await claimNativeRestartRecoveries(f.input);
      expect(claim).toMatchObject({ kind: "reattach_existing_runner", runId: f.runId, providerAttempt: 0, controllerGeneration: 1, process: f.processReference });
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
    expect(f.input.inspectRemoteRunner).toHaveBeenCalledOnce();
    expect(f.provider).toHaveBeenCalledOnce();
    expect(await f.db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id))).toEqual([f.lease]);
    const [issue] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.executionRunId).toBe(f.runId);
  });

  it("finishes the provider probe before taking task/run row locks", async () => {
    const f = await seedOwnedRemoteRun("LOCK-ORDER");
    f.provider.mockImplementationOnce(async () => {
      await f.db.transaction(async tx => {
        await tx.execute(sql`select set_config('lock_timeout', '300', true)`);
        await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      });
      return { state: "running", workspaceConnection: f.connection };
    });
    expect((await claimNativeRestartRecoveries(f.input))[0]?.kind).toBe("reattach_existing_runner");
    expect(f.provider).toHaveBeenCalledOnce();
  });

  it.each(["exited", "mismatch", "unverified", "throw"] as const)("keeps remote authority when the provider result is %s", async state => {
    const f = await seedOwnedRemoteRun(state);
    f.input.inspectRemoteRunner.mockImplementationOnce(() => {
      if (state === "throw") throw new Error("provider unavailable");
      return Promise.resolve({ state, process: f.processReference });
    });
    expect(await claimNativeRestartRecoveries(f.input)).toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "remote_runner_verification_required" }]);
    const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "observed", controllerGeneration: 0, attempt: 0, leaseOwner: null });
    const [issue] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.executionRunId).toBe(f.runId);
  });

  it.each(["lease", "session", "kernel", "deletion", "task_status", "task_owner"] as const)("rechecks %s after a successful provider probe", async change => {
    const f = await seedOwnedRemoteRun(change);
    f.input.inspectRemoteRunner.mockImplementationOnce(async request => {
      const observation = await operateRemoteRunProcess(f.db, request, f.provider);
      if (change === "lease") await f.db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
      if (change === "session") await f.db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (change === "kernel") await f.db.update(heartbeatRuns).set({ processStartedAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
      if (change === "deletion") await f.db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceDataDeletionId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
      if (change === "task_status") await f.db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      if (change === "task_owner") await f.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
      return observation;
    });
    expect(await claimNativeRestartRecoveries(f.input)).toEqual([{ kind: "awaiting_evidence", runId: f.runId, reason: "remote_runner_verification_required" }]);
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [issue] = await f.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(run).toMatchObject({ status: "running", processPid: process.pid });
    expect(issue?.executionRunId).toBe(f.runId);
  });

  it("admits only one successor controller for a verified remote runner", async () => {
    const f = await seedOwnedRemoteRun("CONCURRENT");
    const results = (await Promise.all([
      claimNativeRestartRecoveries(f.input),
      claimNativeRestartRecoveries({ ...f.input, controller: { ...successor, bootId: randomUUID() } }),
    ])).flat();
    expect(results.filter(result => result.kind === "reattach_existing_runner")).toHaveLength(1);
    expect(results.filter(result => result.kind === "awaiting_evidence")).toHaveLength(1);
    const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ controllerGeneration: 1, attempt: 0, recoveryState: "awaiting_evidence" });
  });

  it("does not select one of multiple eligible original leases", async () => {
    const f = await seedOwnedRemoteRun("AMBIGUOUS");
    const duplicateId = randomUUID();
    await f.db.insert(environmentLeases).values({ ...f.lease, id: duplicateId, metadata: { ...f.lease.metadata,
      runtimeServiceProcessOwner: { ...(f.lease.metadata?.runtimeServiceProcessOwner as Record<string, unknown>), environmentLeaseId: duplicateId },
    } });
    expect((await claimNativeRestartRecoveries(f.input))[0]?.kind).toBe("awaiting_evidence");
    expect(f.input.inspectRemoteRunner).not.toHaveBeenCalled();
  });

  it("does not contact the sandbox while the original controller still owns the run", async () => {
    const f = await seedOwnedRemoteRun("LIVE-CONTROLLER");
    await f.db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
      controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt, controllerBootId: successor.bootId,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect((await claimNativeRestartRecoveries(f.input))[0]?.kind).toBe("awaiting_evidence");
    expect(f.input.inspectRemoteRunner).not.toHaveBeenCalled();
  });

  it("uses an exact provider termination receipt instead of host runner or provider PID observations", async () => {
    const fixture = await seedRun("REMOTE-TERMINATED");
    const sessionId = randomUUID();
    const birth = await readProcessStartedAt(process.pid);
    const providerBirth = await readProcessStartedAt(process.ppid);
    await fixture.db.update(heartbeatRuns).set({ processPid: process.pid, processGroupId: process.pid,
      processLocation: "remote", processStartedAt: new Date(birth!), nativeSessionId: sessionId,
      runnerProfileJson: { sessionCheckpoint: {
        identity: { runId: fixture.runId, companyId, issueId: fixture.issueId, agentId, sessionId },
        providerSessionId: "remote-provider-checkpoint",
        process: { providerPid: process.ppid, providerProcessStartedAt: providerBirth },
      } },
    }).where(eq(heartbeatRuns.id, fixture.runId));
    const [environment] = await fixture.db.insert(environments).values({ name: randomUUID(), driver: "sandbox", config: { provider: "daytona" } }).returning();
    const [lease] = await fixture.db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: fixture.runId, provider: "daytona", providerLeaseId: randomUUID(),
      status: "released", releasedAt: new Date(), cleanupStatus: "success",
    }).returning();
    await fixture.db.update(environmentLeases).set({ metadata: { remoteExecutionTermination:
      remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, lease!.id));
    const kill = vi.spyOn(process, "kill");
    try {
      const [claim] = await claimNativeRestartRecoveries({ db: fixture.db, controller: successor, restartKind: "hard", runIds: [fixture.runId] });
      expect(claim).toMatchObject({ kind: "resume_dead_runner", runId: fixture.runId });
      expect(kill.mock.calls.filter(([pid]) => [process.pid, -process.pid, process.ppid].includes(pid))).toEqual([]);
    } finally { kill.mockRestore(); }
    const [run] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(run).toMatchObject({ status: "running", processPid: null, processGroupId: null, processStartedAt: null });
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

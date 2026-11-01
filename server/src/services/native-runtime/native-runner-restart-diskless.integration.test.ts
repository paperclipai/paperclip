import { randomUUID } from "node:crypto";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { beforeAll, expect, vi } from "vitest";
import {
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
  DurablePrpControlPlane,
  readRunnerdArtifactBinding,
  type RunnerProcessHandle,
  type RunnerProcessLaunchSpec,
} from "../../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { loadNativeRunnerCheckpoint, registerNativeRunnerCheckpoint, restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "./native-runner-recovery-contract.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import {
  nativeRestartFixture,
  describeEmbeddedPostgres,
  realProcessIt,
  fakeCodexAppServer,
  processAlive,
  waitForCondition,
  stopOwnedProcessGroup,
} from "./native-restart.test-fixture.js";

describeEmbeddedPostgres("native runner restart recovery: diskless", () => {
  const environment = nativeRestartFixture();
  const { seedRun, transportOptions } = environment;
  let runtimeRoot: typeof environment.current.runtimeRoot;
  let companyId: typeof environment.current.companyId;
  let agentId: typeof environment.current.agentId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ runtimeRoot, companyId, agentId, successor } = environment.current); });

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

});

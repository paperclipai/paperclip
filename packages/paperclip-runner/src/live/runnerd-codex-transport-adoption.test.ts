import {
  createRunnerProviderLaunch,
  runnerLaunchRequirementsDigest,
  type RunnerProviderLaunchRequirements,
} from "./runner-provider-launch.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

async function verifyLiveRunnerAdoption(
  mismatchedCheckpoint: boolean,
  mismatchedArtifact = false,
  goalMidTurn = false,
  detachBeforeCleanup = false,
  startWithoutCheckpoint = false,
  preparedTask = false,
  adoptionAuthorization: "allow" | "deny" | "legacy" | "legacy-missing" | "missing-binding" = "allow",
  toolHandlerOrder?: "before" | "after" | "completion-before" | "completion-after",
  uncertainAtClose = false,
  semanticRecoveryMode?: "denied-before-cancel" | "cleanup-only",
  stopExitProofFault?: "missing" | "false",
  livenessUnverifiedWhileConnected?: "within-grace" | "past-grace" | "reset-by-success",
) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-live-adopt-"));
  const pendingCompletion = toolHandlerOrder?.startsWith("completion-") === true;
  const completionPath = join(stateDirectory, "pending-completion.json");
  if (pendingCompletion) await writeFile(completionPath, JSON.stringify({
    schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed the synthetic work",
    completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] },
    evidence: [], verification: [], attentionRequests: [], artifacts: [],
  }));
  const server = createServer();
  let authority = null as DurablePrpControlPlane | null;
  const checkpoint = vi.fn(async () => undefined);
  server.on("upgrade", (request, socket, head) => {
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected adoption test listener");
  const registration = vi.fn(async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      ...(mismatchedArtifact || uncertainAtClose || semanticRecoveryMode === "cleanup-only" ? { checkpoint } : {}),
      release: async () => {
        if (authority === next) authority = null;
      },
    };
  });
  const identity = {
    runnerInstanceId: "runner-live-adopt",
    environmentLeaseId: "lease-live-adopt",
    runId: "run-live-adopt",
    normalizedSessionId: "session-live-adopt",
    turnId: "turn-live-adopt",
    itemId: "item-live-adopt",
  };
  const sharedOptions = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, ...(pendingCompletion ? ["--terminal-result-file", completionPath] : toolHandlerOrder ? ["--emit-tool-call"] : []), ...(goalMidTurn ? ["--goal-autostart", "--goal-item-trigger", join(stateDirectory, "emit-goal-item")] : [])),
    stateDirectory,
    prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const prepareLaunch = vi.fn(async (requirements: RunnerProviderLaunchRequirements) => ({
    configurationId: "adopted-preparation", requirementsDigest: runnerLaunchRequirementsDigest(requirements),
    provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: sharedOptions.codexArgs },
      root: stateDirectory, cwd: tmpdir(), codexHome: join(stateDirectory, "codex-home"),
      codexCommand: fakeCodex, providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "" }),
  }));
  const options = { ...sharedOptions, ...(preparedTask ? {
    prepareLaunch, runnerArtifact: readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary()),
    runnerProcessLauncher: (spec: durableControlPlane.RunnerProcessLaunchSpec) => {
      const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...process.env, ...spec.environment },
        detached: process.platform !== "win32", stdio: "ignore" });
      return { child, processGroupId: child.pid ?? null, completion: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal, stdout: "", stderr: "" }));
      }) };
    },
  } : {}) };
  const first = createCapabilityRunnerdCodexTransport(options);
  const pendingTool = vi.fn(() => new Promise<Record<string, unknown>>(() => undefined));
  if (toolHandlerOrder) first.transport.setServerRequestHandler(pendingTool);
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
  const recoveryDenied = new Error("execution authority revoked after Stop");
  const recoveredTool = vi.fn(async () => {
    if (semanticRecoveryMode) {
      // Model server authority denying replay after Stop cleared the task lock.
      // The gate holds that denial until reattachment has returned its session,
      // before the caller invokes the eventual onSession cancellation callback.
      await recoveryGate;
      throw recoveryDenied;
    }
    return { result: { receipt: "known-outcome" }, isError: false };
  });
  const redispatchedTool = vi.fn(async () => ({ success: true, contentItems: [] }));
  let runnerPid: number | null = null;
  let runnerStartedAt: string | null = null;
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | null =
    null;
  let restoreIntervalSpies: () => void = () => undefined;
  try {
    let opened: Record<string, unknown>;
    try {
      opened = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: toolHandlerOrder && !pendingCompletion ? [{ name: "get_task_context", description: "Read current task", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : codexSemanticToolSpecs(),
      });
    } catch (error) {
      const stderr = await readFile(
        join(stateDirectory, "diagnostics", "runnerd.stderr.log"),
        "utf8",
      ).catch(() => "");
      throw new Error(
        `${String(error)}\n${JSON.stringify(first.evidence())}${stderr ? `\n${stderr}` : ""}`,
      );
    }
    runnerPid = first.evidence().runnerPid;
    runnerStartedAt = first.transport.processInfo!().startedAt;
    expect(runnerPid).toEqual(expect.any(Number));

    if (goalMidTurn) {
      await first.transport.request("thread/goal/set", { objective: "Recover a live goal", status: "active" });
      for await (const event of first.transport.notifications()) {
        if (event.method === "turn/started") break;
      }
    }

    if (toolHandlerOrder) {
      await first.transport.request("turn/start", { input: [{ type: "text", text: "Read current task" }] });
      await vi.waitFor(() => expect(pendingTool).toHaveBeenCalledOnce(), { timeout: 5_000 });
    }
    await first.detachControllerForRestart();
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    if (goalMidTurn) {
      await writeFile(join(stateDirectory, "emit-goal-item"), "emit");
      // runnerd need not poll the provider into its PRP outbox while disconnected.
      // Wait for flushed provider output, not a platform-dependent final poll
      // racing the disconnect. Adoption must still bind that buffered item.
      await vi.waitFor(async () => {
        expect(await readFile(join(stateDirectory, "emit-goal-item.sent"), "utf8")).toBe("sent");
      }, { timeout: 5_000 });
    }

    const controlPlaneStatePath = join(
      stateDirectory,
      "control-plane",
      "control-plane-state.json",
    );
    const compactProviderIdentityEvents = async () => {
      const controlPlaneState = JSON.parse(
        await readFile(controlPlaneStatePath, "utf8"),
      ) as { committedEvents: Array<{ eventType: string }> };
      controlPlaneState.committedEvents =
        controlPlaneState.committedEvents.filter(
          (event) =>
            event.eventType !== "harness.ready" &&
            event.eventType !== "session.started" &&
            event.eventType !== "session.resumed",
        );
      await writeFile(
        controlPlaneStatePath,
        `${JSON.stringify(controlPlaneState, null, 2)}\n`,
        { mode: 0o600 },
      );
    };
    if (!startWithoutCheckpoint) await compactProviderIdentityEvents();

    if (preparedTask) {
      if (adoptionAuthorization !== "legacy") await rm(join(stateDirectory, "launch-preparation.json"));
      prepareLaunch.mockClear();
      registration.mockClear();
      if (adoptionAuthorization === "missing-binding") {
        const retained = JSON.parse(await readFile(controlPlaneStatePath, "utf8"));
        delete retained.preparedLaunchConfigurations;
        await writeFile(controlPlaneStatePath, JSON.stringify(retained), { mode: 0o600 });
      }
    }
    const authorizeRunnerAdoption = vi.fn(async () => {
      expect(registration).not.toHaveBeenCalled();
      if (adoptionAuthorization === "deny") throw new Error("project grant revoked");
    });
    const duplicateLauncher = vi.fn(() => {
      throw new Error("duplicate runner spawn attempted");
    });
    const openedThread = opened.thread as Record<string, unknown>;
    const signal = vi.fn(() => true);
    const probeError = new Error("fixture remote process identity is unavailable");
    let rejectLiveness = false;
    const intervals = uncertainAtClose ? vi.spyOn(globalThis, "setInterval") : null;
    const clearedIntervals = uncertainAtClose ? vi.spyOn(globalThis, "clearInterval") : null;
    restoreIntervalSpies = () => { intervals?.mockRestore(); clearedIntervals?.mockRestore(); };
    adopted = createCapabilityRunnerdCodexTransport({
      ...options,
      ...(preparedTask && !adoptionAuthorization.startsWith("legacy") ? { authorizeRunnerAdoption } : {}),
      ...(uncertainAtClose ? { closeGraceMs: 2_000 } : {}),
      ...(livenessUnverifiedWhileConnected ? { runnerReconnectGraceMs: livenessUnverifiedWhileConnected === "within-grace" ? 60_000 : 2_000 } : {}),
      ...(semanticRecoveryMode === "cleanup-only" ? { recoveryPurpose: "stop_cleanup" as const } : {}),
      // Hash different stable bytes without replacing the real runner artifact
      // used by concurrent tests. Adoption must never execute this path.
      ...(mismatchedArtifact
        ? {
            runnerBinary: resolve(import.meta.dirname, "../../package.json"),
            runnerReconnectGraceMs: 150,
          }
        : {}),
      ...(toolHandlerOrder && !pendingCompletion ? { recoverSemanticToolInput: recoveredTool } : {}),
      resumeDynamicTools: pendingCompletion ? codexSemanticToolSpecs() : toolHandlerOrder ? [{ name: "get_task_context", description: "Read current task", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] : [],
      resumeProviderSession: startWithoutCheckpoint ? undefined : {
        driverSessionId: String(openedThread.id),
        providerSessionId: mismatchedCheckpoint
          ? "wrong-provider-session"
          : String(openedThread.sessionId),
      },
      runnerProcessLauncher: duplicateLauncher,
      adoptExistingRunner: {
        pid: runnerPid!,
        processGroupId: runnerPid,
        startedAt: runnerStartedAt,
        signal,
        isAlive: () => {
          if (rejectLiveness) return Promise.reject(probeError);
          try {
            process.kill(runnerPid!, 0);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    if (preparedTask && ["deny", "legacy-missing", "missing-binding"].includes(adoptionAuthorization)) {
      await expect(adopted.transport.request("thread/read", {})).rejects.toThrow(
        adoptionAuthorization === "deny" ? "project grant revoked" : adoptionAuthorization === "legacy-missing"
          ? "runner_launch_recovery_requirements_unavailable" : "runner_launch_recovery_configuration_unavailable");
      expect(registration).not.toHaveBeenCalled();
      expect(prepareLaunch).not.toHaveBeenCalled();
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      expect(authorizeRunnerAdoption).toHaveBeenCalledTimes(adoptionAuthorization === "deny" ? 1 : 0);
      return;
    }
    if (mismatchedArtifact) {
      await expect(
        adopted.transport.request("thread/read", {}),
      ).rejects.toThrow("native_adopted_runner_authentication_timeout");
      expect(authority?.activeRunnerConnectionCount()).toBe(0);
      await expect(
        adopted.transport.request("turn/start", {
          input: [{ type: "text", text: "must not be dispatched" }],
        }),
      ).rejects.toThrow("native_adopted_runner_authentication_timeout");
      await adopted.transport.close();
      expect(signal).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      const retained = JSON.parse(
        await readFile(controlPlaneStatePath, "utf8"),
      ) as {
        identity: unknown;
        commands: Array<{ type: string; status: string }>;
      };
      expect(retained.identity).toEqual(identity);
      expect(
        retained.commands.some(
          (command) =>
            command.type === "runner.drain" && command.status === "pending",
        ),
      ).toBe(true);
      expect(retained.commands.map((command) => command.type)).not.toEqual(
        expect.arrayContaining(["runner.suspend"]),
      );
      expect(retained.commands.map((command) => command.type)).not.toEqual(
        expect.arrayContaining(["turn.stop"]),
      );
      return;
    }
    if (mismatchedCheckpoint) {
      await expect(
        adopted.transport.request("thread/read", {}),
      ).rejects.toThrow("native_adopted_provider_identity_mismatch");
      expect(duplicateLauncher).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      return;
    }
    if (toolHandlerOrder?.endsWith("before")) adopted.transport.setServerRequestHandler(redispatchedTool);
    await expect(adopted.transport.request(startWithoutCheckpoint ? "thread/start" : "thread/read", {})).resolves.toEqual(
      expect.objectContaining({
        thread: expect.objectContaining({ id: "codex-thread-1" }),
      }),
    );
    if (toolHandlerOrder?.endsWith("after")) adopted.transport.setServerRequestHandler(redispatchedTool);
    if (livenessUnverifiedWhileConnected) {
      const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
      expect(authority?.activeRunnerConnectionCount()).toBe(1);
      rejectLiveness = true;
      if (livenessUnverifiedWhileConnected === "reset-by-success") {
        await pause(1_400);
        rejectLiveness = false;
        await pause(500);
        rejectLiveness = true;
        await pause(1_400);
      } else {
        await pause(livenessUnverifiedWhileConnected === "within-grace" ? 1_500 : 3_000);
      }
      rejectLiveness = false;
      if (livenessUnverifiedWhileConnected === "past-grace") {
        await expect(adopted.transport.request("thread/read", {})).rejects.toThrow("native_adopted_runner_identity_unverifiable");
      } else {
        await expect(adopted.transport.request("thread/read", {})).resolves.toEqual(
          expect.objectContaining({ thread: expect.objectContaining({ id: "codex-thread-1" }) }));
        expect(adopted.evidence().diagnostics.join("\n")).not.toContain("native_adopted_runner_identity_unverifiable");
      }
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      expect(signal).not.toHaveBeenCalled();
      if (livenessUnverifiedWhileConnected === "past-grace") return;
    }
    if (semanticRecoveryMode) {
      const retained = authority as DurablePrpControlPlane | null;
      expect(retained).not.toBeNull();
      expect(retained!.store.state.committedEvents.some(event => event.eventType === "semantic_tool.input")).toBe(true);
      expect(retained!.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);
      expect(retained!.store.state.commands.some(command => command.type === "turn.interrupt")).toBe(false);
      if (semanticRecoveryMode === "denied-before-cancel") {
        await vi.waitFor(() => expect(recoveredTool).toHaveBeenCalledOnce());
        // This is a real Core replay callback, not an artificial transport error.
        // Deliver its denial before giving the caller its cancellation turn.
        releaseRecovery();
        await vi.waitFor(async () => {
          await expect(adopted!.transport.request("thread/read", {})).rejects.toBe(recoveryDenied);
        });
        await expect(adopted.transport.request("turn/interrupt", {})).rejects.toBe(recoveryDenied);
        expect(retained!.store.state.commands.some(command => command.type === "turn.interrupt")).toBe(false);
      } else {
        // Let all startup/handler microtasks and a real reconciliation read run.
        // Cleanup must not enter replay even while its authority would deny it.
        await adopted.transport.request("thread/read", {});
        expect(recoveredTool).not.toHaveBeenCalled();
        expect(redispatchedTool).not.toHaveBeenCalled();
        releaseRecovery();
        await expect(adopted.transport.request("turn/interrupt", {})).resolves.toEqual({});
        expect(retained!.store.state.commands.filter(command => command.type === "turn.interrupt")).toMatchObject([{ status: "completed" }]);
      }
      expect(redispatchedTool).not.toHaveBeenCalled();
      expect(retained!.store.state.commands.some(command => command.type === "semantic_tool.result")).toBe(false);
      expect(retained!.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);
      expect(duplicateLauncher).not.toHaveBeenCalled();
      if (semanticRecoveryMode === "cleanup-only") {
        const faultedStopProof = vi.fn();
        if (stopExitProofFault) {
          const queue = retained!.queueCommand.bind(retained!);
          vi.spyOn(retained!, "queueCommand").mockImplementation((type, ...args) => {
            const command = queue(type, ...args);
            if (type === "turn.stop") {
              let result = command.result;
              Object.defineProperty(command, "result", {
                enumerable: true,
                configurable: true,
                get: () => result,
                set: value => {
                  const receipt = value as { result?: Record<string, unknown> } | null;
                  if (receipt?.result && typeof receipt.result === "object") {
                    faultedStopProof(receipt.result.providerExitConfirmed);
                    const stopped = { ...receipt.result };
                    if (stopExitProofFault === "missing") delete stopped.providerExitConfirmed;
                    else stopped.providerExitConfirmed = false;
                    result = { ...receipt, result: stopped };
                  } else result = value;
                },
              });
            }
            return command;
          });
          await expect(adopted.transport.close()).rejects.toBeInstanceOf(NativeSessionCloseUnrecoverableError);
          expect(faultedStopProof).toHaveBeenCalledWith(true);
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith("unsettled");
        } else {
          await expect(adopted.transport.close()).resolves.toBeUndefined();
          expect(checkpoint).toHaveBeenCalledExactlyOnceWith("settled");
          expect(retained!.store.state.commands.filter(command => command.type === "turn.stop")).toMatchObject([{
            status: "completed", result: { result: { providerExitConfirmed: true } },
          }]);
        }
        expect(retained!.semanticToolResultsSettled()).toBe(false);
        expect(retained!.store.state.commands.some(command => command.type === "semantic_tool.result")).toBe(false);
        expect(retained!.store.state.committedEvents.some(event => event.eventType === "semantic_tool.input")).toBe(true);
        if (!stopExitProofFault) {
          expect(retained!.store.state.commands.filter(command => command.type === "runner.suspend")).toMatchObject([{ status: "completed" }]);
          const runnerState = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8"));
          expect(runnerState).toMatchObject({ ...identity, lifecycle: "suspended" });
        }
        const providerState = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
        expect(providerState).toMatchObject({ activeProviderTurnId: null, pendingEvents: [], queuedEvents: [] });
        expect(recoveredTool).not.toHaveBeenCalled();
        expect(redispatchedTool).not.toHaveBeenCalled();
      }
      return;
    }
    if (toolHandlerOrder) {
      await vi.waitFor(() => {
        expect(pendingCompletion ? redispatchedTool : recoveredTool).toHaveBeenCalledOnce();
        const result = authority!.store.state.commands.find(command => command.type === "semantic_tool.result");
        expect(result?.status).toBe("completed");
      }, { timeout: 5_000 });
      if (pendingCompletion) {
        expect(recoveredTool).not.toHaveBeenCalled();
        expect(redispatchedTool).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ tool: "paperclip_finish" }) }));
      } else expect(redispatchedTool).not.toHaveBeenCalled();
    }
    expect(adopted.evidence().runnerPid).toBe(runnerPid);
    expect(adopted.transport.processInfo!().startedAt).toBe(runnerStartedAt);
    if (startWithoutCheckpoint) {
      const retained = JSON.parse(await readFile(controlPlaneStatePath, "utf8"));
      for (const type of ["run.prepare", "session.open"]) {
        expect(retained.commands.filter((command: { type: string }) => command.type === type)).toHaveLength(1);
      }
    }
    if (goalMidTurn) {
      const observed = await Promise.race([
        (async () => {
          for await (const notification of adopted!.transport.notifications()) {
            if (notification.method === "item/started") return notification;
          }
          throw new Error("recovered goal item was lost");
        })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recovered item timed out")), 5_000)),
      ]);
      expect(observed.params).toMatchObject({ threadId: "codex-thread-1", turnId: "provider-goal-turn-1" });
    }
    expect(duplicateLauncher).not.toHaveBeenCalled();
    if (preparedTask) {
      if (adoptionAuthorization === "legacy") {
        expect(prepareLaunch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ identity }), expect.objectContaining({ configurationId: "adopted-preparation" }));
        expect(authorizeRunnerAdoption).not.toHaveBeenCalled();
      } else {
        expect(prepareLaunch).not.toHaveBeenCalled();
        expect(authorizeRunnerAdoption).toHaveBeenCalledExactlyOnceWith("adopted-preparation", identity);
      }
      expect((await adopted.transport.request("thread/read", {})).thread).toMatchObject({ cwd: tmpdir() });
    }
    if (uncertainAtClose) {
      const before = JSON.parse(await readFile(controlPlaneStatePath, "utf8"));
      const retainedAuthority = authority as DurablePrpControlPlane | null;
      rejectLiveness = true;
      await expect(adopted.transport.close()).rejects.toBe(probeError);
      expect(retainedAuthority?.activeRunnerConnectionCount()).toBe(0);
      expect(intervals!.mock.results.length).toBeGreaterThan(0);
      for (const interval of intervals!.mock.results) if (interval.type === "return") expect(clearedIntervals).toHaveBeenCalledWith(interval.value);
      const notificationsClosed = (async () => { for await (const _event of adopted!.transport.notifications()) {} return true; })();
      let queueDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(await Promise.race([notificationsClosed, new Promise<boolean>(resolve => { queueDeadline = setTimeout(() => resolve(false), 250); })])).toBe(true);
      } finally { clearTimeout(queueDeadline); }
      await expect(adopted.transport.close()).rejects.toBe(probeError);
      expect(adopted.transport.processInfo!()).toMatchObject({ exited: false });
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      expect(signal).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(duplicateLauncher).not.toHaveBeenCalled();
      const retained = JSON.parse(await readFile(controlPlaneStatePath, "utf8"));
      expect(retained.identity).toEqual(before.identity);
      expect(retained.commands).toEqual(before.commands);
      return;
    }
    expect(adopted.evidence().diagnostics).toContain(
      `adopted runner ${runnerPid} authenticated to its durable PRP authority`,
    );
    if (!startWithoutCheckpoint) {
      expect(adopted.evidence().diagnostics).toContain(
        "restored adopted provider identity from the exact durable checkpoint after PRP event compaction; awaiting live confirmation",
      );
      expect(adopted.evidence().diagnostics).toContain(
        "confirmed adopted provider identity against authenticated recovery session.snapshot",
      );
    }
    if (detachBeforeCleanup) {
      await adopted.detachControllerForRestart();
      await adopted.transport.close("old controller finalizer");
      expect(signal).not.toHaveBeenCalled();
      expect(() => process.kill(runnerPid!, 0)).not.toThrow();
      const retained = JSON.parse(await readFile(controlPlaneStatePath, "utf8"));
      const commandTypes = retained.commands.map((command: { type: string }) => command.type);
      expect(commandTypes).not.toContain("turn.stop");
      expect(commandTypes).not.toContain("runner.suspend");
    }
  } finally {
    releaseRecovery();
    await adopted?.transport.close().catch(() => undefined);
    if (uncertainAtClose) {
      const providerPid = adopted?.evidence().codexPid;
      if (providerPid) {
        try { process.kill(providerPid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await (authority as DurablePrpControlPlane | null)?.stop();
    }
    restoreIntervalSpies();
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // The adopted runner normally exits after its durable suspend command.
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

it(
  "adopts a live runner on the same durable authority without spawning a duplicate",
  () => verifyLiveRunnerAdoption(false),
  30_000,
);

it("adopts a prepared runner after losing its controller launch cache without preparing resources again",
  () => verifyLiveRunnerAdoption(false, false, false, false, false, true), 30_000);

it.each(["deny", "legacy", "legacy-missing", "missing-binding"] as const)("preserves adoption authorization with %s",
  mode => verifyLiveRunnerAdoption(false, false, false, false, false, true, mode), 30_000);

it.each(["within-grace", "past-grace", "reset-by-success"] as const)(
  "bounds a rejected liveness probe of a connected adopted runner by the reconnect grace (%s)",
  mode => verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", undefined, false, undefined, undefined, mode), 30_000);

it("retains authenticated adopted-runner ownership when a close probe rejects", () => verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", undefined, true), 30_000);

it(
  "blocks adopted runner artifact drift without duplicate launch, checkpoint replacement, or process signals",
  () => verifyLiveRunnerAdoption(false, true),
  15_000,
);

it(
  "rejects a live runner whose provider identity mismatches the compacted checkpoint",
  () => verifyLiveRunnerAdoption(true),
  30_000,
);

it("binds buffered mid-goal items only after the authenticated recovery snapshot", () => verifyLiveRunnerAdoption(false, false, true), 30_000);

it("keeps an adopted runner alive when the detached controller finalizer closes", () => verifyLiveRunnerAdoption(false, false, true, true), 30_000);

it("adopts an opening session without a checkpoint instead of bootstrapping a duplicate provider", () => verifyLiveRunnerAdoption(false, false, false, false, true), 30_000);

it.each(["before", "after"] as const)("settles a saved tool outcome with the handler installed %s recovery startup", order =>
  verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", order), 30_000);

it.each(["completion-before", "completion-after"] as const)("recovers a pending finish without an ordinary-tool lookup (%s)", order =>
  verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", order), 30_000);

it("exposes semantic recovery before cancellation when the authority has been revoked", () =>
  verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", "before", false, "denied-before-cancel"), 30_000);

it.each(["before", "after", "completion-before", "completion-after"] as const)("allows cleanup-only adoption to cancel without replaying a pending semantic input (%s)", order =>
  verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", order, false, "cleanup-only"), 30_000);

it.each(["missing", "false"] as const)("refuses cleanup settlement when the exact stop receipt has %s provider exit proof", fault =>
  verifyLiveRunnerAdoption(false, false, false, false, false, false, "allow", "before", false, "cleanup-only", fault), 30_000);

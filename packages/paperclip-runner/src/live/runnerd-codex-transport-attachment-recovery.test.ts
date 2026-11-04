import {
  createRunnerProviderLaunch,
  runnerLaunchRequirementsDigest,
  type PreparedRunnerProviderLaunch,
  type RunnerProviderLaunchRequirements,
} from "./runner-provider-launch.js";
import { cp, lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

it.each([
  ...[
    "before-result",
    "after-result",
    "after-activation",
    "before-confirmation",
    "after-confirmation",
  ].flatMap((lossPoint) =>
    [false, true].map((routed) => ({
      lossPoint,
      routed,
      recoveryFault: "none",
    })),
  ),
  ...["endpoint", "missing-capability", "listen", "malformed-core"].map(
    (recoveryFault) => ({
      lossPoint: "after-result",
      routed: true,
      recoveryFault,
    }),
  ),
  ...["before_bootstrap", "before_spawn", "before_authentication"].map(
    (stage) => ({
      lossPoint: "after-result",
      routed: true,
      recoveryFault: `authorize_${stage}`,
    }),
  ),
  ...[
    "attach-wait",
    ...(process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER
      ? ["attach-capability"]
      : []),
  ].map((recoveryFault) => ({
    lossPoint: "before-result",
    routed: true,
    recoveryFault,
  })),
  ...(process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER
    ? [
        {
          lossPoint: "after-result",
          routed: false,
          recoveryFault: "legacy-parser",
        },
      ]
    : []),
  ...["before-result", "after-result", "after-activation", "after-confirmation"].map(lossPoint => ({
    lossPoint, routed: true, recoveryFault: "none", executionPrepared: true,
  })),
  {
    lossPoint: "after-result",
    routed: true,
    recoveryFault: "none",
    externalArtifact: true,
  },
  {
    lossPoint: "after-confirmation",
    routed: true,
    recoveryFault: "none",
    ordinaryFollowup: true,
  },
  ...[
    "missing_snapshot",
    "rejected_snapshot",
    "wrong_thread",
    "callback_failure",
    "callback_async_failure",
  ].map((ordinaryFollowup) => ({
    lossPoint: "after-confirmation",
    routed: true,
    recoveryFault: "none",
    ordinaryFollowup,
  })),
])(
  "recovers a warm attachment with a fresh controller and runner ($lossPoint, routed=$routed, fault=$recoveryFault, followup=$ordinaryFollowup, external=$externalArtifact, prepared=$executionPrepared)",
  async (testCase) => {
    const { lossPoint, routed, recoveryFault } = testCase;
    const externalArtifact = "externalArtifact" in testCase && testCase.externalArtifact;
    const executionPrepared = "executionPrepared" in testCase && testCase.executionPrepared;
    const configurations = new Map<string, { requirements: RunnerProviderLaunchRequirements; prepared: PreparedRunnerProviderLaunch }>();
    const ordinaryFollowup =
      "ordinaryFollowup" in testCase && testCase.ordinaryFollowup;
    const snapshotFault =
      typeof ordinaryFollowup === "string" &&
      !ordinaryFollowup.startsWith("callback_");
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-attach-restart-"),
    );
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    const routes = new Map<
      string,
      { core: DurablePrpControlPlane; generation: symbol }
    >();
    const routeCalls: string[] = [];
    let recovering = false;
    let recoveryClaimCurrent = true;
    let recoveryFenceActive = true;
    const completionSnapshotIds: string[] = [];
    let rejectHeldCompletion: ((error: Error) => void) | undefined;
    let markHeldCompletionEntered!: () => void;
    const heldCompletionEntered = new Promise<void>((resolve) => {
      markHeldCompletionEntered = resolve;
    });
    let snapshotObserverSpy: ReturnType<typeof vi.spyOn> | undefined;
    const routeServer = createServer((_request, response) =>
      response.writeHead(404).end(),
    );
    routeServer.on("upgrade", (request, socket, head) => {
      const entry = routes.get(request.url ?? "");
      if (!entry) {
        socket.destroy();
        return;
      }
      entry.core.handleUpgrade(request, socket, request.url!, head);
    });
    if (routed)
      await new Promise<void>((resolveListen) =>
        routeServer.listen(0, "127.0.0.1", resolveListen),
      );
    const routeAddress = routeServer.address();
    const routePort =
      routeAddress && typeof routeAddress === "object" ? routeAddress.port : 0;
    const registration = async (
      core: DurablePrpControlPlane,
      identity = core.store.state.identity,
    ) => {
      if (
        recovering &&
        ordinaryFollowup &&
        recoveryFenceActive &&
        !recoveryClaimCurrent
      ) {
        throw new Error("fixture old recovery claim is no longer current");
      }
      const path = `/api/runner/v1/connect/${identity.runId}`;
      const generation = Symbol();
      routes.set(path, { core, generation });
      routeCalls.push(identity.runId);
      return {
        connection:
          recovering && recoveryFault === "listen"
            ? {
                mode: "listen" as const,
                listenAddress: "0.0.0.0" as const,
                listenPort: routePort,
                listenPath: path,
              }
            : {
                mode: "connect" as const,
                connectUrl: `ws://127.0.0.1:${routePort}${path}${recovering && recoveryFault === "endpoint" ? "/changed" : ""}`,
              },
        release: () => {
          if (routes.get(path)?.generation === generation) routes.delete(path);
        },
      };
    };
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore(options);
        cores.push(core);
        if (recovering && snapshotFault) {
          const getCommand = core.getCommand.bind(core);
          snapshotObserverSpy = vi
            .spyOn(core, "getCommand")
            .mockImplementation((id) => {
              const command = getCommand(id);
              if (
                command?.type !== "session.snapshot" ||
                command.status !== "completed"
              )
                return command;
              const observed = structuredClone(command);
              if (ordinaryFollowup === "rejected_snapshot") {
                observed.status = "failed";
                observed.result = {
                  result: { message: "fixture snapshot observation rejected" },
                };
              } else if (ordinaryFollowup === "wrong_thread") {
                observed.result = {
                  ...observed.result,
                  result: {
                    ...(observed.result?.result as Record<string, unknown>),
                    driverSessionId: "foreign-thread",
                    providerSessionId: "foreign-thread",
                  },
                };
              } else observed.result = { result: { status: "session_open" } };
              return observed;
            });
        }
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch({ ...options,
          ...(executionPrepared ? { processLauncher: undefined } : {}),
          ...(externalArtifact && recovering ? { runnerBinaryPath: defaultCapabilityRunnerdBinary() } : {}),
        });
        handles.push(handle);
        return handle;
      });
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const stopOwnedProvider = async (pid: number) => {
      // Exact runner completion can race the OS reaping its already-signalled
      // provider. Absence, not the outcome of a redundant signal, is required.
      try {
        await vi.waitFor(() => expect(dead(-pid)).toBe(true), {
          timeout: 500,
          interval: 10,
        });
      } catch {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (
            !["ESRCH", "EPERM"].includes(
              String((error as NodeJS.ErrnoException).code),
            )
          )
            throw error;
        }
        await vi.waitFor(() => expect(dead(-pid)).toBe(true), {
          timeout: 2_000,
          interval: 10,
        });
      }
      expect(dead(pid)).toBe(true);
    };
    const fingerprintTree = async (root: string): Promise<unknown[]> => {
      const rows: unknown[] = [];
      const visit = async (path: string, relative: string) => {
        const metadata = await lstat(path);
        rows.push({
          path: relative,
          inode: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          digest: metadata.isFile()
            ? createHash("sha256")
                .update(await readFile(path))
                .digest("hex")
            : metadata.isSymbolicLink()
              ? createHash("sha256")
                  .update(await readlink(path))
                  .digest("hex")
              : null,
        });
        if (metadata.isDirectory())
          for (const child of (await readdir(path)).sort())
            await visit(join(path, child), `${relative}/${child}`);
      };
      await visit(root, ".");
      return rows;
    };
    const within = async <T>(promise: Promise<T>, timeout = 5_000) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("warm restart fixture timed out")),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const options = {
      runnerBinary:
        recoveryFault === "attach-capability"
          ? process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER!
          : (process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
            defaultCapabilityRunnerdBinary()),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
      prpIdentity: (() => {
        const runId = randomUUID();
        return {
          runnerInstanceId: randomUUID(),
          environmentLeaseId:
            process.env.PAPERCLIP_ATTACH_TRANSITION_FIXTURE_SCOPE ===
            "transient"
              ? runId
              : randomUUID(),
          runId,
          normalizedSessionId: randomUUID(),
          turnId: `turn-${runId}`,
          itemId: `item-${runId}`,
        };
      })(),
      ...(routed
        ? {
            controlPlaneRegistration: registration,
            warmTransitionRegistrationMode: "routed_connect" as const,
          }
        : {}),
      ...(executionPrepared ? {
        runnerArtifact: readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary()),
        readRunnerState: async () => JSON.parse(await readFile(join(stateDirectory, "runner/runner-state.json"), "utf8")),
        // The fixture's spawn spy supplies the real local process owner.
        runnerProcessLauncher: () => { throw new Error("fixture process owner was bypassed"); },
        prepareLaunch: async (requirements: RunnerProviderLaunchRequirements, recovery?: PreparedRunnerProviderLaunch) => {
          const existing = configurations.get(requirements.identity.runId);
          if (existing) {
            expect(requirements).toEqual(existing.requirements);
            if (recovering) expect(recovery).toEqual(existing.prepared);
            return existing.prepared;
          }
          const prepared = { configurationId: `prepared-${requirements.identity.runId}`,
            requirementsDigest: runnerLaunchRequirementsDigest(requirements),
            provider: createRunnerProviderLaunch(requirements, {
              options: { codexArgs: fakeCodexArgs(stateDirectory, "--call-log", callsPath, "--record-process-start") },
              root: stateDirectory, cwd: tmpdir(), codexHome: join(stateDirectory, "codex-home"),
              codexCommand: fakeCodex, providerNodeCommand: process.execPath, opencodeProxyPath: "", acpxSidecarPath: "",
            }),
          };
          configurations.set(requirements.identity.runId, { requirements: structuredClone(requirements), prepared });
          return prepared;
        },
      } : {}),
    };
    const first = createCapabilityRunnerdCodexTransport(options);
    let resumed:
      ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    const providerPids = new Set<number>();
    let commitSpy: ReturnType<typeof vi.spyOn> | undefined;
    let commandObserverSpy: ReturnType<typeof vi.spyOn> | undefined;
    let detached: Promise<void> | undefined;
    let cleanupProven = false;
    const legacyProbeDirectories: string[] = [];
    try {
      const opened = await within(
        first.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      );
      const openedThread = opened.thread as { id: string; sessionId: string };
      const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
      const firstThreadSnapshot = await within(
        first.transport.request("thread/read", {}),
      );
      const firstEvidence = first.evidence();
      const cleanRunnerStateBytes = await readFile(
        join(stateDirectory, "runner/runner-state.json"),
      );
      const runnerProcessStartedAt =
        process.platform === "darwin"
          ? new Date(
              execFileSync(
                "ps",
                ["-o", "lstart=", "-p", String(handles[0]!.child.pid)],
                { encoding: "utf8", timeout: 1_500 },
              ).trim(),
            ).toISOString()
          : null;
      if ((first.evidence().codexPid ?? 0) > 0)
        providerPids.add(first.evidence().codexPid!);
      const core = cores[0]!;
      const oldIdentity = structuredClone(core.store.state.identity);
      const nextRunId = randomUUID();
      const desired = {
        ...oldIdentity,
        runId: nextRunId,
        turnId: `turn-${nextRunId}`,
        itemId: `item-${nextRunId}`,
      };
      if (
        recoveryFault === "attach-capability" ||
        recoveryFault === "attach-wait"
      ) {
        if (recoveryFault === "attach-wait") {
          const getCommand = core.getCommand.bind(core);
          commandObserverSpy = vi
            .spyOn(core, "getCommand")
            .mockImplementation((id) => {
              if (
                core.store.state.commands.find(
                  (entry) => entry.commandId === id,
                )?.type === "run.attach"
              ) {
                throw new Error("fixture result observer unavailable");
              }
              return getCommand(id);
            });
        }
        const bootstrapCount = core.store.state.freshBootstraps;
        await expect(
          first.transport.attachRun!({
            runId: desired.runId,
            turnId: desired.turnId,
            itemId: desired.itemId,
          }),
        ).rejects.toThrow(
          recoveryFault === "attach-capability"
            ? "capability is required"
            : "result observer unavailable",
        );
        expect(routeCalls).toEqual([oldIdentity.runId, desired.runId]);
        expect([...routes.keys()]).toEqual([
          `/api/runner/v1/connect/${oldIdentity.runId}`,
        ]);
        expect(core.store.state.freshBootstraps).toBe(bootstrapCount);
        expect(handles).toHaveLength(1);
        if (recoveryFault === "attach-capability")
          expect(
            core.store.state.commands.some(
              (entry) => entry.type === "run.attach",
            ),
          ).toBe(false);
        return;
      }
      const commit = core.store.commit.bind(core.store);
      let lossObserved = false;
      let signalLoss!: () => void;
      const loss = new Promise<void>((resolveLoss) => {
        signalLoss = resolveLoss;
      });
      commitSpy = vi
        .spyOn(core.store, "commit")
        .mockImplementation((candidate) => {
          // The selected process-crash boundary stays unavailable until the
          // exact owned runner is joined. A later replay must not silently
          // settle this fixture before its retained pair is exported.
          if (lossObserved)
            throw new Error(
              "fixture controller persistence unavailable after loss",
            );
          const phase = candidate.warmTransition?.phase;
          const target =
            lossPoint === "after-activation" ? "activated" : "prepared";
          const atBoundary = lossPoint.includes("confirmation")
            ? candidate.completedWarmTransition !== undefined &&
              candidate.warmTransition === undefined
            : phase === target;
          if (!lossObserved && atBoundary) {
            lossObserved = true;
            if (
              lossPoint !== "before-result" &&
              lossPoint !== "before-confirmation"
            )
              commit(candidate);
            // A dead controller cannot accept a reconnect through the second
            // route installed for the in-flight authority rotation. Detaching
            // only the current route leaves that overlapping fixture listener
            // alive; completed-receipt replay needs no further store commit.
            for (const [path, entry] of routes) {
              if (entry.core === core) routes.delete(path);
            }
            core.disconnectActiveRunner();
            detached = first.transport.detachControllerForRestart!();
            signalLoss();
            // A committed confirmation is still before its ACK. Returning from
            // this hook lets the current frame handler send that ACK even after
            // close begins, collapsing the intended crash window on fast peers.
            throw new Error("fixture interrupted exact result commit");
          }
          commit(candidate);
        });
      const attachment = first.transport.attachRun!({
        runId: desired.runId,
        turnId: desired.turnId,
        itemId: desired.itemId,
      });
      void attachment.catch(() => undefined);
      await within(loss);
      await within(detached!);
      expect(lossObserved).toBe(true);
      const runnerPath = join(stateDirectory, "runner/runner-state.json");
      const runner = JSON.parse(await readFile(runnerPath, "utf8"));
      expect(runner.warmTransition.phase).toBe(
        lossPoint === "after-activation" || lossPoint.includes("confirmation")
          ? "activating"
          : "prepared",
      );
      const persisted = JSON.parse(await readFile(core.store.path, "utf8"));
      expect(
        persisted.commands.find(
          (entry: { type: string }) => entry.type === "run.attach",
        )?.status,
      ).toBe(
        lossPoint === "before-result"
          ? "pending"
          : lossPoint === "after-result"
            ? "completed"
            : undefined,
      );
      // Stop only this fixture's exact owned process handles. No stored receipt
      // or PID absence is used as authority to terminate an unknown owner.
      await durableControlPlane
        .waitForProcess(handles[0]!, 100)
        .catch(() => undefined);
      await within(handles[0]!.completion);
      for (const pid of providerPids) {
        await stopOwnedProvider(pid);
      }
      await within(attachment.catch(() => undefined));
      const joinedRunner = JSON.parse(await readFile(runnerPath, "utf8"));
      const joinedCore = JSON.parse(await readFile(core.store.path, "utf8"));
      expect(joinedRunner.warmTransition).toEqual(runner.warmTransition);
      expect(joinedCore.schema).toBe(persisted.schema);
      expect(joinedCore.warmTransition).toEqual(persisted.warmTransition);
      expect(joinedCore.completedWarmTransition).toEqual(
        persisted.completedWarmTransition,
      );
      commitSpy.mockRestore();
      const fixtureOutput =
        process.env.PAPERCLIP_ATTACH_TRANSITION_FIXTURE_DIRECTORY;
      if (fixtureOutput && recoveryFault === "none") {
        const retainedArtifact = join(fixtureOutput, "paperclip-runnerd");
        await cp(options.runnerBinary, retainedArtifact, { force: false });
        expect(
          createHash("sha256")
            .update(await readFile(retainedArtifact))
            .digest("hex"),
        ).toBe(
          createHash("sha256")
            .update(await readFile(options.runnerBinary))
            .digest("hex"),
        );
        const retained = join(
          fixtureOutput,
          `${lossPoint}-${routed ? "routed" : "local"}`,
        );
        await cp(stateDirectory, retained, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await writeFile(
          join(retained, "transition-fixture-metadata.json"),
          JSON.stringify(
            {
              schema: "paperclip.test.warm-transition-fixture.v1",
              oldIdentity,
              newIdentity: desired,
              lossPoint,
              routed,
              runner: {
                pid: handles[0]!.child.pid,
                processGroupId: handles[0]!.processGroupId,
                startedAt: runnerProcessStartedAt,
                spawnObservedAt: handles[0]!.startedAt,
                completion: await handles[0]!.completion,
                processAbsent: dead(handles[0]!.child.pid!),
                groupAbsent: dead(-handles[0]!.processGroupId!),
              },
              providers: [...providerPids].map((pid) => ({
                pid,
                processGroupId: pid,
                startedAt: firstEvidence.providerProcessStartedAt,
                processAbsent: dead(pid),
                groupAbsent: dead(-pid),
              })),
              artifact: {
                path: retainedArtifact,
                version: runner.warmTransition.receipt.runnerVersion,
                digest: runner.warmTransition.receipt.runnerDigest,
              },
              thread,
              firstThreadSnapshot,
              firstEvidence,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
      routes.clear();
      const routeCallCount = routeCalls.length;
      const beforeCalls = (await readFile(callsPath, "utf8"))
        .trim()
        .split(/\r?\n/);
      expect(
        beforeCalls.filter((call) => call === "process-start"),
      ).toHaveLength(1);
      if (recoveryFault === "legacy-parser") {
        const legacyBinary =
          process.env.PAPERCLIP_ATTACH_TRANSITION_LEGACY_RUNNER!;
        const legacyDigest = `sha256:${createHash("sha256")
          .update(await readFile(legacyBinary))
          .digest("hex")}`;
        for (const [mode, bytes] of [
          ["pending", await readFile(runnerPath)],
          ["clean", cleanRunnerStateBytes],
        ] as const) {
          const probe = await mkdtemp(
            join(tmpdir(), "runnerd-legacy-schema-probe-"),
          );
          legacyProbeDirectories.push(probe);
          await writeFile(join(probe, "runner-state.json"), bytes, {
            mode: 0o600,
          });
          const handle = durableControlPlane.spawnRunner({
            connection: runner.warmTransition.receipt.connection,
            stateDirectory: probe,
            identity: oldIdentity,
            runnerBinaryPath: legacyBinary,
            runnerVersion: "0.3.0",
            runnerDigest: legacyDigest,
            ticket: "bootstrap_legacy_parser_probe",
            maxOutboxBytes: runner.maxOutboxBytes,
            p0ReserveBytes: runner.p0ReserveBytes,
            maxRuntimeMs: 200,
            reconnectGraceMs: 200,
          });
          const result = await within(handle.completion, 5_000);
          expect(result.code).not.toBe(0);
          if (mode === "pending") {
            expect(result.stderr).toContain(
              "durable state binding does not match",
            );
            expect(await readFile(join(probe, "runner-state.json"))).toEqual(
              bytes,
            );
          } else {
            expect(result.stderr).not.toContain(
              "durable state binding does not match",
            );
            expect(
              JSON.parse(
                await readFile(join(probe, "runner-state.json"), "utf8"),
              ).nextSourceSeq,
            ).toBeGreaterThan(JSON.parse(bytes.toString("utf8")).nextSourceSeq);
          }
        }
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual(beforeCalls);
        return;
      }
      recovering = true;
      if (recoveryFault === "malformed-core")
        await writeFile(core.store.path, "{", { mode: 0o600 });
      const beforeRecoveryBytes = await Promise.all(
        [core.store.path, runnerPath].map((path) => readFile(path)),
      );
      const beforeRecoveryTree =
        recoveryFault === "none" ? null : await fingerprintTree(stateDirectory);
      const authorizationStages: string[] = [];
      let releaseHeldAuthorization: (() => void) | undefined;
      let markHeldAuthorizationEntered!: () => void;
      const heldAuthorizationEntered = new Promise<void>((resolve) => {
        markHeldAuthorizationEntered = resolve;
      });
      const authorizationFault = recoveryFault.startsWith("authorize_");
      const failedAuthorizationStage = recoveryFault.slice("authorize_".length);
      const beforeProviderBytes = await readFile(
        join(stateDirectory, "runner", "codex-provider-state.json"),
      );
      resumed = createCapabilityRunnerdCodexTransport({
        ...options,
        ...(externalArtifact ? {
          runnerBinary: "/controller-missing-runner",
          runnerArtifact: readRunnerdArtifactBinding(options.runnerBinary),
        } : {}),
        ...(ordinaryFollowup
          ? {
              authorizeWarmTransitionRecovery: async () => {
                if (!recoveryClaimCurrent)
                  throw new Error(
                    "fixture old recovery claim is no longer current",
                  );
              },
              onWarmTransitionRecoveryCompleted: (completion: {
                transitionId: string;
              }) => {
                expect(completion.transitionId).toBe(
                  runner.warmTransition.receipt.transitionId,
                );
                const completedSnapshot = cores[1]!.store.state.commands
                  .filter((command) => command.type === "session.snapshot")
                  .at(-1)!;
                expect(completedSnapshot.status).toBe("completed");
                expect(cores[1]!.store.state.identity).toEqual(desired);
                expect(cores[1]!.store.state.warmTransition).toBeUndefined();
                completionSnapshotIds.push(completedSnapshot.commandId);
                if (
                  ordinaryFollowup === "callback_failure" &&
                  completionSnapshotIds.length === 1
                ) {
                  throw new Error(
                    "fixture recovery completion callback failed",
                  );
                }
                if (
                  ordinaryFollowup === "callback_async_failure" &&
                  completionSnapshotIds.length === 1
                ) {
                  return new Promise<void>((_resolve, reject) => {
                    rejectHeldCompletion = reject;
                    markHeldCompletionEntered();
                  });
                }
                recoveryFenceActive = false;
              },
            }
          : {}),
        ...(authorizationFault
          ? {
              authorizeWarmTransitionRecovery: async (stage: string) => {
                authorizationStages.push(stage);
                if (
                  stage === "before_bootstrap" &&
                  failedAuthorizationStage === "before_bootstrap"
                ) {
                  await new Promise<void>((resolveGate) => {
                    releaseHeldAuthorization = resolveGate;
                    markHeldAuthorizationEntered();
                  });
                }
                if (stage === failedAuthorizationStage)
                  throw new Error("fixture recovery authority revoked");
              },
            }
          : {}),
        ...(recoveryFault === "missing-capability"
          ? { warmTransitionRegistrationMode: undefined }
          : {}),
        ...(recoveryFault !== "none"
          ? {
              environment: {
                CODEX_API_KEY: "synthetic-refused-route-credential",
              },
            }
          : {}),
        prpIdentity: desired,
        resumeProviderSession: {
          driverSessionId: thread.id,
          providerSessionId: thread.sessionId,
        },
      });
      if (recoveryFault !== "none") {
        const recoveryRequest = within(
          resumed.transport.request("thread/read", {}),
        );
        void recoveryRequest.catch(() => undefined);
        if (
          authorizationFault &&
          failedAuthorizationStage === "before_bootstrap"
        ) {
          await within(Promise.race([
            heldAuthorizationEntered,
            recoveryRequest.then(() => {
              throw new Error("warm restart authorization callback was not entered");
            }),
          ]));
          expect(releaseHeldAuthorization).toBeTypeOf("function");
          const queuedBefore = cores[1]!.store.state.commands.map(
            (command) => command.commandId,
          );
          try {
            await expect(
              resumed.transport.request("turn/start", {
                input: [{ text: "must not queue before bootstrap" }],
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.attachRun!({
                runId: "must-not-attach",
                turnId: "must-not-attach",
                itemId: "must-not-attach",
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.resolveRuntimeRequest!({
                requestId: "must-not-resolve",
                turnId: desired.turnId,
                resolution: { action: "cancel" },
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            expect(
              cores[1]!.store.state.commands.map(
                (command) => command.commandId,
              ),
            ).toEqual(queuedBefore);
            expect(handles).toHaveLength(1);
          } finally {
            releaseHeldAuthorization!();
          }
        }
        const failedRecovery = expect(recoveryRequest).rejects;
        if (authorizationFault) {
          await failedRecovery.toThrow(
            failedAuthorizationStage === "before_authentication"
              ? "native_runner_warm_transition_recovery_pending"
              : "fixture recovery authority revoked",
          );
          const expectedStages = [
            "before_bootstrap",
            "before_spawn",
            "before_authentication",
          ];
          expect([...new Set(authorizationStages)]).toEqual(
            expectedStages.slice(
              0,
              expectedStages.indexOf(failedAuthorizationStage) + 1,
            ),
          );
          expect(handles).toHaveLength(
            failedAuthorizationStage === "before_authentication" ? 2 : 1,
          );
          expect(
            await readFile(
              join(stateDirectory, "runner", "codex-provider-state.json"),
            ),
          ).toEqual(beforeProviderBytes);
          const refusedRunner = JSON.parse(await readFile(runnerPath, "utf8"));
          expect(refusedRunner.warmTransition).toEqual(runner.warmTransition);
          expect(
            (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
          ).toEqual(beforeCalls);
          if (failedAuthorizationStage !== "before_authentication")
            expect(await readFile(runnerPath)).toEqual(beforeRecoveryBytes[1]);
          if (failedAuthorizationStage === "before_bootstrap")
            expect(await readFile(core.store.path)).toEqual(
              beforeRecoveryBytes[0],
            );
          await within(resumed.transport.close()).catch(() => undefined);
          expect([...routes.keys()]).toEqual([]);
          return;
        }
        if (recoveryFault === "malformed-core") await failedRecovery.toThrow();
        else
          await failedRecovery.toThrow(
            recoveryFault === "missing-capability"
              ? "requires_exact_owned_endpoint"
              : "registered_endpoint_mismatch",
          );
        expect(handles).toHaveLength(1);
        expect(
          await Promise.all(
            [core.store.path, runnerPath].map((path) => readFile(path)),
          ),
        ).toEqual(beforeRecoveryBytes);
        expect(await fingerprintTree(stateDirectory)).toEqual(
          beforeRecoveryTree,
        );
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual(beforeCalls);
        expect([...routes.keys()]).toEqual([]);
        return;
      }
      if (
        snapshotFault ||
        ordinaryFollowup === "callback_failure" ||
        ordinaryFollowup === "callback_async_failure"
      ) {
        const firstRead = within(resumed.transport.request("thread/read", {}));
        void firstRead.catch(() => undefined);
        if (ordinaryFollowup === "callback_async_failure") {
          await within(Promise.race([
            heldCompletionEntered,
            firstRead.then(() => {
              throw new Error("warm restart completion callback was not entered");
            }),
          ]));
          expect(rejectHeldCompletion).toBeTypeOf("function");
          try {
            expect(recoveryFenceActive).toBe(true);
            const queuedBefore = cores[1]!.store.state.commands.map(
              (command) => command.commandId,
            );
            await expect(
              resumed.transport.request("turn/start", {
                input: [{ text: "must not pass held completion" }],
              }),
            ).rejects.toThrow("warm_transition_completion_pending");
            await expect(
              resumed.transport.request("thread/resume", {}),
            ).rejects.toThrow("warm_transition_completion_pending");
            expect(
              cores[1]!.store.state.commands.map(
                (command) => command.commandId,
              ),
            ).toEqual(queuedBefore);
          } finally {
            rejectHeldCompletion!(
              new Error("fixture recovery completion callback failed"),
            );
          }
        }
        await expect(firstRead).rejects.toThrow(
          snapshotFault
            ? ordinaryFollowup === "rejected_snapshot"
              ? "snapshot observation rejected"
              : "completion_unproven"
            : "recovery completion callback failed",
        );
        expect(recoveryFenceActive).toBe(true);
        expect(completionSnapshotIds).toHaveLength(snapshotFault ? 0 : 1);
        const beforeDeniedWork = cores[1]!.store.state.commands.map(
          (command) => command.commandId,
        );
        const beforeDeniedProviderCalls = await readFile(callsPath, "utf8");
        await expect(
          resumed.transport.request("turn/start", {
            input: [{ text: "must remain fenced" }],
          }),
        ).rejects.toThrow("warm_transition_completion_pending");
        await expect(
          resumed.transport.request("thread/resume", {}),
        ).rejects.toThrow("warm_transition_completion_pending");
        await expect(
          resumed.transport.attachRun!({
            runId: "must-not-attach",
            turnId: "must-not-attach",
            itemId: "must-not-attach",
          }),
        ).rejects.toThrow("warm_transition_completion_pending");
        expect(
          cores[1]!.store.state.commands.map((command) => command.commandId),
        ).toEqual(beforeDeniedWork);
        expect(await readFile(callsPath, "utf8")).toBe(
          beforeDeniedProviderCalls,
        );
        snapshotObserverSpy?.mockRestore();
        const providerCallsBeforeRetry = await readFile(callsPath, "utf8");
        expect(
          (await within(resumed.transport.request("thread/read", {}))).thread,
        ).toMatchObject(thread);
        expect(recoveryFenceActive).toBe(false);
        expect(completionSnapshotIds).toHaveLength(snapshotFault ? 1 : 2);
        expect(new Set(completionSnapshotIds).size).toBe(
          completionSnapshotIds.length,
        );
        expect(await readFile(callsPath, "utf8")).toBe(
          providerCallsBeforeRetry,
        );
        return;
      }
      const read = await within(
        resumed.transport.request("thread/read", {}),
        10_000,
      );
      if ((resumed.evidence().codexPid ?? 0) > 0)
        providerPids.add(resumed.evidence().codexPid!);
      expect(read.thread).toMatchObject(thread);
      expect(cores).toHaveLength(2);
      expect(cores[1]!.store.state.identity).toEqual(desired);
      expect(cores[1]!.store.state.warmTransition).toBeUndefined();
      expect(
        cores[1]!.store.state.completedWarmTransition?.receipt.transitionId,
      ).toBe(runner.warmTransition.receipt.transitionId);
      if (routed) {
        expect(routeCalls.slice(routeCallCount)).toEqual([
          oldIdentity.runId,
          desired.runId,
        ]);
        expect([...routes.keys()]).toEqual([
          `/api/runner/v1/connect/${desired.runId}`,
        ]);
      }
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(2);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/resume")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
      if (ordinaryFollowup) {
        recoveryClaimCurrent = false;
        const resumedCore = cores[1]!;
        resumedCore.disconnectActiveRunner();
        await vi.waitFor(
          () => expect(resumedCore.activeRunnerConnectionCount()).toBe(1),
          { timeout: 2_000 },
        );
        expect(recoveryFenceActive).toBe(false);
        expect(
          (await within(resumed.transport.request("thread/read", {}))).thread,
        ).toMatchObject(thread);
        const thirdRunId = randomUUID();
        await within(
          resumed.transport.attachRun!({
            runId: thirdRunId,
            turnId: `turn-${thirdRunId}`,
            itemId: `item-${thirdRunId}`,
          }),
        );
        expect(resumedCore.store.state.identity.runId).toBe(thirdRunId);
        expect(
          (await readFile(callsPath, "utf8")).trim().split(/\r?\n/),
        ).toEqual([...calls, "thread/goal/get"]);
      }
    } finally {
      snapshotObserverSpy?.mockRestore();
      commitSpy?.mockRestore();
      commandObserverSpy?.mockRestore();
      try {
        await within(resumed?.transport.close() ?? Promise.resolve()).catch(
          () => undefined,
        );
        await within(first.transport.detachControllerForRestart!()).catch(
          () => undefined,
        );
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within(handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        for (const pid of providerPids) {
          await stopOwnedProvider(pid);
        }
        cleanupProven = true;
      } finally {
        for (const core of cores) await core.stop().catch(() => undefined);
        if (routed)
          await new Promise<void>((resolveClose) =>
            routeServer.close(() => resolveClose()),
          );
        coreSpy.mockRestore();
        launchSpy.mockRestore();
        if (cleanupProven)
          await rm(stateDirectory, { recursive: true, force: true });
        if (cleanupProven)
          for (const directory of legacyProbeDirectories)
            await rm(directory, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

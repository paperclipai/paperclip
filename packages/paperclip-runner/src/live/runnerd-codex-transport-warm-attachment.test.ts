import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { releaseMaterializedNativeRuntimeSkills } from "../drivers/runtime-context-materializer.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding } from "./runnerd-codex-transport.js";
import {
  defaultCapabilityRunnerdBinary,
  fakeCodex,
  fakeCodexArgs,
  assignedRuntimeContext,
} from "../../test/support/runnerd-transport.js";

it.each([
  ["held-ack", "normal"],
  ["lost-ack", "normal"],
  ["rejected-attach", "normal"],
  ["lost-ack", "after-activation"],
] as const)(
  "preserves old warm-attach authority and event ownership across %s (%s observer)",
  async (mode, observer) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-warm-ack-"));
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const effects = new Map<string, { event: PrpEvent; deliveries: number }>();
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    let armed = false;
    let heldEvent: PrpEvent | null = null;
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const commitGate = new Promise<void>((resolveCommit) => {
      releaseCommit = resolveCommit;
    });
    const commitEntered = new Promise<void>((resolveEntered) => {
      enteredCommit = resolveEntered;
    });
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore({
          ...options,
          onCommittedEvent: async (event) => {
            await options.onCommittedEvent?.(event);
            const prior = effects.get(event.sourceEventId);
            if (prior) {
              expect(event).toEqual(prior.event);
              prior.deliveries += 1;
            } else {
              effects.set(event.sourceEventId, {
                event: structuredClone(event),
                deliveries: 1,
              });
            }
            if (
              armed &&
              mode !== "rejected-attach" &&
              heldEvent === null &&
              event.eventType === "run.attached"
            ) {
              heldEvent = structuredClone(event);
              enteredCommit();
              await commitGate;
              if (mode === "lost-ack") {
                // The external durable effect exists, but this connection
                // disappears before its local cursor/ACK can be published.
                throw new Error(
                  "fixture lost the old authority ACK after commit",
                );
              }
            }
          },
        });
        cores.push(core);
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch(options);
        handles.push(handle);
        return handle;
      });
    const within = async <T>(
      label: string,
      promise: Promise<T>,
      timeout = 5_000,
    ) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolveWait, rejectWait) => {
            timer = setTimeout(
              () => rejectWait(new Error(`${label} timeout`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 5_000,
    });
    const readRunner = async () =>
      JSON.parse(
        await readFile(
          join(stateDirectory, "runner/runner-state.json"),
          "utf8",
        ),
      ) as {
        runId: string;
        ackedSourceSeq: number;
        processedCommands: Record<string, { commandType: string; status: string }>;
        outbox: { envelope: { payload: PrpEvent } }[];
      };
    let providerPid: number | null = null;
    let primaryError: unknown;
    let cleanupProven = false;
    try {
      const opened = await within(
        "initial thread",
        bundle.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      ) as { thread: { id: string } };
      const core = cores[0]!;
      expect(cores).toHaveLength(1);
      const oldIdentity = structuredClone(core.store.state.identity);
      const runnerPid = bundle.evidence().runnerPid;
      providerPid = bundle.evidence().codexPid;
      const rotations: (typeof core.store.state)[] = [];
      const preparedStates: (typeof core.store.state)[] = [];
      const commit = core.store.commit.bind(core.store);
      vi.spyOn(core.store, "commit").mockImplementation((candidate) => {
        commit(candidate);
        // Capture the durable old epoch at publication. The authenticated
        // successor may activate before attachRun observes the completed command.
        if (
          candidate.identity.runId === oldIdentity.runId &&
          candidate.warmTransition?.phase === "prepared"
        ) {
          preparedStates.push(structuredClone(core.store.state));
        }
      });
      if (observer === "after-activation") {
        const getCommand = core.getCommand.bind(core);
        vi.spyOn(core, "getCommand").mockImplementation((commandId) => {
          const command = getCommand(commandId);
          if (
            command?.type === "run.attach" &&
            command.status === "completed" &&
            core.store.state.completedWarmTransition === undefined
          ) {
            // Deterministically exercise an observer that misses the old epoch.
            return { ...command, status: "pending", result: null };
          }
          return command;
        });
      }
      const rotate = core.rotateRunIdentity.bind(core);
      vi.spyOn(core, "rotateRunIdentity").mockImplementation(
        (identity, template) => {
          rotations.push(structuredClone(core.store.state));
          return rotate(identity, template);
        },
      );
      if (mode === "rejected-attach") {
        const queue = core.queueCommand.bind(core);
        vi.spyOn(core, "queueCommand").mockImplementation(
          (type, payload = {}, id, immediate) =>
            queue(
              type,
              type === "run.attach"
                ? {
                    ...payload,
                    provider: {
                      ...(payload.provider as Record<string, unknown>),
                      model: "foreign-profile",
                    },
                  }
                : payload,
              id,
              immediate,
            ),
        );
      }
      armed = true;
      const attachment = bundle.transport.attachRun!({
        runId: "run-warm-ack-next",
        turnId: "turn-warm-ack-next",
        itemId: "item-warm-ack-next",
      });
      void attachment.catch(() => undefined);
      if (mode === "rejected-attach") {
        await expect(within("rejected attach", attachment)).rejects.toThrow(
          "run.attach cannot change the durable Codex provider profile",
        );
        expect(rotations).toHaveLength(0);
        expect(core.store.state.identity).toEqual(oldIdentity);
        expect((await readRunner()).runId).toBe(oldIdentity.runId);
        const read = await within(
          "read under unchanged authority",
          bundle.transport.request("thread/read", {}),
        );
        expect((read.thread as { id: string }).id).toBe(opened.thread.id);
        expect(
          core.store.state.commands.find((entry) => entry.type === "run.attach")
            ?.status,
        ).toBe("failed");
      } else {
        await within("old authority commit barrier", commitEntered);
        const retained = await readRunner();
        expect(retained.runId).toBe(oldIdentity.runId);
        expect(
          Object.values(retained.processedCommands).find((entry) => entry.commandType === "run.attach")
            ?.status,
        ).toBe("completed");
        expect(
          retained.outbox.some(
            (entry) =>
              entry.envelope.payload.sourceEventId === heldEvent!.sourceEventId,
          ),
        ).toBe(true);
        expect(
          core.store.state.commands.find((entry) => entry.type === "run.attach")
            ?.status,
        ).toBe("pending");
        expect(rotations).toHaveLength(0);
        if (mode === "lost-ack") core.disconnectActiveRunner();
        releaseCommit();
        await within("warm attach after old ACK", attachment, 10_000);
        expect(rotations).toHaveLength(1);
        expect(preparedStates.length).toBeGreaterThan(0);
        const retired = preparedStates[0]!;
        if (observer === "after-activation") {
          expect(rotations[0]!.identity.runId).toBe("run-warm-ack-next");
          expect(
            rotations[0]!.committedEvents.some(
              (entry) => entry.sourceEventId === heldEvent!.sourceEventId,
            ),
          ).toBe(false);
        }
        const attachedEvent = retired.committedEvents.find(
          (entry) => entry.sourceEventId === heldEvent!.sourceEventId,
        )!;
        expect(attachedEvent.logicalEffectCount).toBe(1);
        expect(retired.ackedSourceSeq).toBeGreaterThanOrEqual(
          attachedEvent.sourceSeq,
        );
        expect(
          retired.committedEvents.slice(-4).map((entry) => entry.eventType),
        ).toEqual([
          "session.resumed",
          "session.capabilities.updated",
          "session.goal.snapshot",
          "run.attached",
        ]);
        expect(
          retired.committedEvents.every(
            (entry) => entry.envelope.runId === oldIdentity.runId,
          ),
        ).toBe(true);
        if (mode === "lost-ack") {
          expect(retired.connectionCount).toBeGreaterThanOrEqual(2);
          expect(effects.get(heldEvent!.sourceEventId)?.deliveries).toBe(2);
        } else {
          expect(effects.get(heldEvent!.sourceEventId)?.deliveries).toBe(1);
        }
        await vi.waitFor(async () =>
          expect((await readRunner()).runId).toBe("run-warm-ack-next"),
        );
        const read = await within(
          "read under new authority",
          bundle.transport.request("thread/read", {}),
        );
        expect((read.thread as { id: string }).id).toBe(opened.thread.id);
      }
      expect(bundle.evidence()).toMatchObject({
        runnerPid,
        codexPid: providerPid,
        runnerExited: false,
      });
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      releaseCommit();
      try {
        await within(
          "warm fixture close",
          bundle.transport.close(),
          10_000,
        ).catch(() => undefined);
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within("exact warm fixture runner exit", handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        if (providerPid && !dead(-providerPid))
          process.kill(-providerPid, "SIGKILL");
        if (providerPid)
          await vi.waitFor(() => expect(dead(-providerPid!)).toBe(true));
        cleanupProven = true;
      } catch (error) {
        if (primaryError === undefined) throw error;
        console.error(
          "Warm ACK fixture cleanup unproven; retaining its private state directory.",
        );
      } finally {
        try {
          for (const core of cores) await core.stop().catch(() => undefined);
        } finally {
          launchSpy.mockRestore();
          coreSpy.mockRestore();
          if (cleanupProven)
            await rm(stateDirectory, { recursive: true, force: true });
        }
      }
    }
  },
  30_000,
);

it.each([false, true])(
  "retains warm attach authority when its result is lost before controller persistence (held observer=%s)",
  async (holdObserver) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-attach-result-loss-"),
    );
    const callsPath = join(stateDirectory, "calls.log");
    const cores: DurablePrpControlPlane[] = [];
    const handles: ReturnType<typeof durableControlPlane.spawnRunner>[] = [];
    const OriginalCore = durableControlPlane.DurablePrpControlPlane;
    const coreSpy = vi
      .spyOn(durableControlPlane, "DurablePrpControlPlane")
      .mockImplementation(function (
        options: ConstructorParameters<typeof OriginalCore>[0],
      ) {
        const core = new OriginalCore(options);
        cores.push(core);
        return core;
      } as unknown as typeof OriginalCore);
    const launch = durableControlPlane.spawnRunner;
    const launchSpy = vi
      .spyOn(durableControlPlane, "spawnRunner")
      .mockImplementation((options) => {
        const handle = launch(options);
        handles.push(handle);
        return handle;
      });
    const within = async <T>(
      label: string,
      promise: Promise<T>,
      timeout = 5_000,
    ) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} timeout`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const dead = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary:
        process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
        defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--call-log",
        callsPath,
        "--record-process-start",
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
    });
    let providerPid: number | null = null;
    let cleanupProven = false;
    let saveSpy: ReturnType<typeof vi.spyOn> | undefined;
    let observerSpy: { mockRestore(): void } | undefined;
    let attachment: Promise<void> | undefined;
    try {
      await within(
        "initial thread",
        bundle.transport.request("thread/start", {
          cwd: tmpdir(),
          dynamicTools: [],
        }),
      );
      expect(cores).toHaveLength(1);
      const core = cores[0]!;
      const oldIdentity = structuredClone(core.store.state.identity);
      if (holdObserver) {
        const getCommand = core.getCommand.bind(core);
        observerSpy = vi
          .spyOn(core, "getCommand")
          .mockImplementation((commandId) => {
            const command = getCommand(commandId);
            if (
              command?.type === "run.attach" &&
              core.store.state.completedWarmTransition?.command.commandId !==
                commandId
            ) {
              return { ...command, status: "pending", result: null };
            }
            return command;
          });
      }
      providerPid = bundle.evidence().codexPid;
      const store = core.store as typeof core.store & {
        commit(candidate: typeof core.store.state): void;
      };
      const commit = store.commit.bind(store);
      let lostResult = false;
      let observeLoss!: () => void;
      const loss = new Promise<void>((resolveLoss) => {
        observeLoss = resolveLoss;
      });
      saveSpy = vi.spyOn(store, "commit").mockImplementation((candidate) => {
        const attach = candidate.commands.find(
          (entry) => entry.type === "run.attach",
        );
        if (!lostResult && attach?.status === "completed") {
          lostResult = true;
          // The authenticated result reached the receiver, but the durable write
          // did not. The clone has not been exposed in memory or on disk.
          const persisted = JSON.parse(readFileSync(core.store.path, "utf8"));
          expect(persisted.identity).toEqual(oldIdentity);
          expect(
            persisted.commands.find(
              (entry: { type: string }) => entry.type === "run.attach",
            ).status,
          ).toBe("pending");
          core.disconnectActiveRunner();
          observeLoss();
          throw new Error(
            "fixture lost attach result before durable controller commit",
          );
        }
        commit(candidate);
      });
      attachment = bundle.transport.attachRun!({
        runId: "run-result-loss-next",
        turnId: "turn-result-loss-next",
        itemId: "item-result-loss-next",
      });
      void attachment.catch(() => undefined);
      await within("lost attach result", loss);
      expect(lostResult).toBe(true);
      expect(core.store.state.identity).toEqual(oldIdentity);
      expect(
        core.store.state.commands.find((entry) => entry.type === "run.attach")
          ?.status,
      ).toBe("pending");
      const outcome = await within(
        "exact result replay after reconnect",
        attachment.then(
          () => ({ status: "completed" as const }),
          (error: unknown) => ({
            status: "failed" as const,
            message: String(error),
          }),
        ),
        10_000,
      );
      const runner = JSON.parse(
        await readFile(
          join(stateDirectory, "runner/runner-state.json"),
          "utf8",
        ),
      );
      const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
      expect(calls.filter((call) => call === "process-start")).toHaveLength(1);
      expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
      expect(calls.filter((call) => call === "turn/start")).toHaveLength(0);
      expect(
        {
          outcome,
          runnerRunId: runner.runId,
          controllerRunId: core.store.state.identity.runId,
        },
        "lost attach result must replay without leaving the two durable authorities split",
      ).toEqual({
        outcome: { status: "completed" },
        runnerRunId: "run-result-loss-next",
        controllerRunId: "run-result-loss-next",
      });
      if (holdObserver)
        expect(
          core.store.state.completedWarmTransition?.receipt.newIdentity.runId,
        ).toBe("run-result-loss-next");
    } finally {
      saveSpy?.mockRestore();
      observerSpy?.mockRestore();
      try {
        await within(
          "result-loss fixture close",
          bundle.transport.close(),
          5_000,
        ).catch(() => undefined);
        for (const handle of handles) {
          await durableControlPlane
            .waitForProcess(handle, 250)
            .catch(() => undefined);
          await within("exact result-loss runner exit", handle.completion);
          if (handle.processGroupId && !dead(-handle.processGroupId))
            process.kill(-handle.processGroupId, "SIGKILL");
          await vi.waitFor(() => {
            expect(handle.child.pid && dead(handle.child.pid)).toBe(true);
            expect(handle.processGroupId && dead(-handle.processGroupId)).toBe(
              true,
            );
          });
        }
        if (providerPid && !dead(-providerPid))
          process.kill(-providerPid, "SIGKILL");
        if (providerPid)
          await vi.waitFor(() => expect(dead(-providerPid!)).toBe(true));
        cleanupProven = true;
      } finally {
        for (const core of cores) await core.stop().catch(() => undefined);
        launchSpy.mockRestore();
        coreSpy.mockRestore();
        if (cleanupProven)
          await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  },
  30_000,
);

it("rotates PRP authority in place for a warm cross-run attachment", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-warm-attach-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  const within = async <T>(label: string, promise: Promise<T>) =>
    await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout`)), 5_000),
      ),
    ]);
  try {
    await within("initialize", bundle.transport.request("initialize", {}));
    await within(
      "thread start",
      bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the active task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        completionContract: {
          revision: "sha256:warm-three-turn-contract",
          criterionIds: ["objective"],
        },
      }),
    );
    const runnerPid = bundle.evidence().runnerPid;
    const providerPid = bundle.evidence().codexPid;
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const waitForCompletion = async (label: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          notifications.next(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${label} notification timeout`)),
              1_000,
            ),
          ),
        ]);
        if (next.value?.method === "turn/completed") return;
      }
      throw new Error(`${label} completion timeout`);
    };
    await within(
      "first turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "first run" }],
      }),
    );
    await waitForCompletion("first run");

    await within(
      "warm attach",
      bundle.transport.attachRun!({
        runId: "run-warm-second",
        turnId: "turn-warm-second",
        itemId: "item-warm-second",
      }),
    );
    await within(
      "second turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "second run" }],
      }),
    );
    await waitForCompletion("second run");

    await within(
      "second warm attach",
      bundle.transport.attachRun!({
        runId: "run-warm-third",
        turnId: "turn-warm-third",
        itemId: "item-warm-third",
      }),
    );
    await within(
      "third turn start",
      bundle.transport.request("turn/start", {
        input: [{ type: "text", text: "third run" }],
      }),
    );
    await waitForCompletion("third run");

    expect(bundle.evidence()).toMatchObject({
      runnerPid,
      codexPid: providerPid,
      runnerExited: false,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("recovers an active second warm business run after deleting its controller context assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-warm-second-active-"));
  const firstRoot = join(root, "first-controller"), nextRoot = join(root, "next-controller");
  const assetRoot = join(root, "retired-controller-assets");
  const skillRoot = join(assetRoot, "skill"), instructionRoot = join(assetRoot, "instructions");
  await mkdir(skillRoot, { recursive: true }); await mkdir(instructionRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "# Pinned skill\n");
  await writeFile(join(instructionRoot, "AGENTS.md"), "Pinned instructions\n");
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null, generation = 0;
  let checkpoint: durableControlPlane.DurablePrpCheckpoint | undefined;
  const registered = new WeakSet<DurablePrpControlPlane>();
  server.on("upgrade", (request, socket, head) => authority
    ? authority.handleUpgrade(request, socket, "/runner", head) : socket.destroy());
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned Runner route");
  const registration = async (core: DurablePrpControlPlane) => {
    if (!registered.has(core)) {
      core.setCheckpointPersistence(async value => { checkpoint = value; });
      registered.add(core);
    }
    authority = core; const current = ++generation;
    return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: async () => { if (generation === current) authority = null; } };
  };
  const initialIdentity = { runnerInstanceId: "runner-warm-second-active", environmentLeaseId: "lease-warm-second-active",
    runId: "run-warm-first-healthy", normalizedSessionId: "session-warm-second-active", turnId: "turn-first", itemId: "item-first" };
  const options = { runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--emit-tool-call", "--durable-tool-ids"), stateDirectory: firstRoot,
    runtimeContext: assignedRuntimeContext(skillRoot, instructionRoot),
    prpIdentity: initialIdentity, lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 }, controlPlaneRegistration: registration };
  const first = createCapabilityRunnerdCodexTransport(options);
  const within = async <T>(label: string, promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`warm active recovery stage timed out: ${label}`)), 5_000); })]); }
    finally { clearTimeout(timer); }
  };
  const waitComplete = async (transport: typeof first.transport) => {
    for await (const notification of transport.notifications()) if (notification.method === "turn/completed") return;
  };
  let calls = 0, runnerPid: number | null = null, providerPid: number | null = null;
  let recovered: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  const result = { ok: true, task: { id: "task-1" } };
  first.transport.setServerRequestHandler(async () => ++calls === 1
    ? { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] }
    : new Promise<Record<string, unknown>>(() => undefined));
  try {
    const opened = await within("first thread/start", first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [{ name: "get_task_context", description: "Read current task",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
    runnerPid = first.evidence().runnerPid;
    providerPid = first.evidence().codexPid;
    expect(providerPid).toEqual(expect.any(Number));
    const providerStart = execFileSync("ps", ["-p", String(providerPid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const startedAt = first.transport.processInfo().startedAt;
    const firstCompleted = waitComplete(first.transport);
    await within("first turn/start", first.transport.request("turn/start", { input: [{ type: "text", text: "first healthy business run" }] }));
    await within("healthy first turn completion", firstCompleted);
    const attachment = { runId: "run-warm-second-active", turnId: `turn_attachment_${randomUUID()}`, itemId: `item_attachment_${randomUUID()}` };
    await within("warm second business attachment", first.transport.attachRun!(attachment));
    const active = await within("second active turn/start", first.transport.request("turn/start", { input: [{ type: "text", text: "second business run held at tool" }] }));
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 5_000 });
    const activeCore = authority!;
    const savedIdentity = { ...activeCore.store.state.identity };
    expect(savedIdentity).toEqual({ ...initialIdentity, ...attachment });
    await activeCore.flushCheckpoint();
    await within("controller detach", first.detachControllerForRestart());
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    await rm(assetRoot, { recursive: true, force: true });
    expect(existsSync(assetRoot)).toBe(false);
    checkpoint!.restoreSessionDirectory(nextRoot);
    const noSpawn = vi.fn(() => { throw new Error("Duplicate Runner launch"); });
    const openedThread = opened.thread as Record<string, unknown>;
    const activeTurn = active.turn as Record<string, unknown>;
    expect(openedThread.id).toEqual(expect.any(String));
    expect(activeTurn.id).toEqual(expect.any(String));
    const shared = { ...options, stateDirectory: nextRoot,
      resumeProviderSession: { driverSessionId: String(openedThread.id), providerSessionId: String(openedThread.sessionId) },
      resumeActiveTurnId: String(activeTurn.id), runnerArtifact: readRunnerdArtifactBinding(options.runnerBinary),
      runnerStateDirectory: join(firstRoot, "runner"), readRunnerState: async () => JSON.parse(await readFile(join(firstRoot, "runner/runner-state.json"), "utf8")),
      prepareExternalRunnerState: async () => {}, archiveExternalRunnerState: async () => { throw new Error("Active authority must not rotate"); },
      runnerProcessLauncher: noSpawn, adoptExistingRunner: { pid: runnerPid!, processGroupId: runnerPid, startedAt,
        isAlive: () => { try { process.kill(runnerPid!, 0); return true; } catch { return false; } },
        signal: (signal: NodeJS.Signals) => { try { process.kill(runnerPid!, signal); return true; } catch { return false; } } } };
    // The old server's synthetic pair must continue failing the strict Runner guard.
    const wrong = createCapabilityRunnerdCodexTransport({ ...shared, prpIdentity: { ...savedIdentity,
      turnId: `turn-${attachment.runId}`, itemId: `item-${attachment.runId}` } });
    await expect(wrong.transport.request("thread/read", {})).rejects.toThrow("PRP recovery identity does not match the durable session binding");
    await wrong.detachControllerForRestart();
    // Leave the pending tool outcome unknown. Reattachment must authenticate
    // and preserve it without fabricating a receipt or redispatching its handler.
    recovered = createCapabilityRunnerdCodexTransport({ ...shared, prpIdentity: savedIdentity });
    await within("replacement thread/read", recovered.transport.request("thread/read", {}));
    expect(recovered.evidence()).toMatchObject({ runnerPid, runnerExited: false });
    expect(authority!.activeRunnerConnectionCount()).toBe(1);
    expect(() => process.kill(providerPid!, 0)).not.toThrow();
    expect(execFileSync("ps", ["-p", String(providerPid), "-o", "lstart="], { encoding: "utf8" }).trim()).toBe(providerStart);
    expect(calls).toBe(2);
    expect(authority!.store.state.commands.filter(command => command.type === "semantic_tool.result")).toHaveLength(0);
    expect(recovered.transport.processInfo().startedAt).toBe(startedAt);
    expect(authority!.store.state.identity).toEqual(savedIdentity);
    expect(authority!.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);
    expect(noSpawn).not.toHaveBeenCalled();
  } catch (error) {
    const saved = JSON.parse(await readFile(join(firstRoot, "runner/runner-state.json"), "utf8").catch(() => "{}"));
    const stderr = await readFile(join(firstRoot, "diagnostics/runnerd.stderr.log"), "utf8").catch(() => "");
    throw new Error(`${String(error)}; owned protocol evidence ${JSON.stringify({
      transport: recovered?.evidence(), connections: authority?.activeRunnerConnectionCount(),
      identity: authority?.store.state.identity, commands: authority?.store.state.commands.map(c => ({type:c.type,status:c.status})),
      events: authority?.store.state.committedEvents.map(e => e.eventType).slice(-8),
      runner: { lifecycle:saved.lifecycle, runId:saved.runId, turnId:saved.turnId, itemId:saved.itemId,
        outbox:saved.outbox?.length }, stderr:stderr.slice(-1500),
    })}`);
  } finally {
    await (recovered ? within("recovered cleanup", recovered.transport.close()).catch(() => undefined) : undefined);
    await within("first cleanup", first.transport.close()).catch(() => undefined);
    if (providerPid) { try { process.kill(providerPid, "SIGKILL"); } catch {} }
    await (authority as DurablePrpControlPlane | null)?.stop();
    if (runnerPid) { try { process.kill(-runnerPid, "SIGKILL"); } catch {} }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    for (const controller of [firstRoot, nextRoot]) await releaseMaterializedNativeRuntimeSkills(join(controller, "codex-home", "skills"));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("waits for a warm runner to re-authenticate before probing attachment readiness", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-warm-reattach-before-probe-"),
  );
  const server = createServer();
  const authorities = new Map<string, DurablePrpControlPlane>();
  let blockFirstAuthorityReconnect = false;
  let resolveRejectedReconnect!: () => void;
  const rejectedReconnect = new Promise<void>((resolvePromise) => {
    resolveRejectedReconnect = resolvePromise;
  });
  server.on("upgrade", (request, socket, head) => {
    const route = request.url ?? "";
    if (route === "/runner-1" && blockFirstAuthorityReconnect) {
      resolveRejectedReconnect();
      socket.destroy();
      return;
    }
    const authority = authorities.get(route);
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, route, head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected warm reconnect test listener");
  }
  let registrationCount = 0;
  const diagnostics: string[] = [];
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    runnerReconnectGraceMs: 5_000,
    onDiagnostic: (message) => diagnostics.push(message),
    controlPlaneRegistration: async (authority) => {
      registrationCount += 1;
      const route = `/runner-${registrationCount}`;
      authorities.set(route, authority);
      return {
        connectUrl: `ws://127.0.0.1:${address.port}${route}`,
        release: () => {
          if (authorities.get(route) === authority) authorities.delete(route);
        },
      };
    },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: codexSemanticToolSpecs(),
    });
    runnerPid = bundle.evidence().runnerPid;
    const firstAuthority = authorities.get("/runner-1");
    if (!firstAuthority) throw new Error("Missing first warm authority");
    const priorSnapshotCount = firstAuthority.store.state.commands.filter(
      (command) => command.type === "session.snapshot",
    ).length;

    blockFirstAuthorityReconnect = true;
    firstAuthority.disconnectActiveRunner();
    const attachment = bundle.transport.attachRun!({
      runId: "run-warm-after-reconnect",
      turnId: "turn-warm-after-reconnect",
      itemId: "item-warm-after-reconnect",
    });
    await Promise.race([
      rejectedReconnect,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("runner did not attempt to reconnect")),
          5_000,
        ),
      ),
    ]);

    // No command may be queued while its sole authenticated consumer is
    // absent. The generic 30-second command timeout used to turn this state
    // into same-run recovery and replace the healthy warm runner process.
    expect(
      firstAuthority.store.state.commands.filter(
        (command) => command.type === "session.snapshot",
      ),
    ).toHaveLength(priorSnapshotCount);

    blockFirstAuthorityReconnect = false;
    await Promise.race([
      attachment,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("warm attachment timeout")), 10_000),
      ),
    ]);
    expect(bundle.evidence()).toMatchObject({
      runnerPid,
      runnerExited: false,
    });
    expect(diagnostics).toContain(
      "warm runner connection interrupted; waiting for re-authentication before authority rotation",
    );
    expect(diagnostics).toContain(
      "warm runner re-authenticated before authority rotation",
    );
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // A successful durable close already stopped the runner process group.
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
}, 30_000);

it("releases both PRP authorities when warm rotation activation fails", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-warm-attach-activation-failure-"),
  );
  const server = createServer();
  const authorities = new Map<string, DurablePrpControlPlane>();
  const released: string[] = [];
  server.on("upgrade", (request, socket, head) => {
    const route = request.url ?? "";
    const authority = authorities.get(route);
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, route, head);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected warm activation failure test listener");
  }
  let registrationCount = 0;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    controlPlaneRegistration: async (authority) => {
      registrationCount += 1;
      const route = `/runner-${registrationCount}`;
      authorities.set(route, authority);
      return {
        connectUrl: `ws://127.0.0.1:${address.port}${route}`,
        ...(registrationCount === 1
          ? {}
          : {
              activate: () => {
                throw new Error("rotation activation failed");
              },
            }),
        release: () => {
          released.push(route);
          if (authorities.get(route) === authority) authorities.delete(route);
        },
      };
    },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: codexSemanticToolSpecs(),
    });
    runnerPid = bundle.evidence().runnerPid;

    await expect(
      bundle.transport.attachRun!({
        runId: "run-warm-activation-failure",
        turnId: "turn-warm-activation-failure",
        itemId: "item-warm-activation-failure",
      }),
    ).rejects.toThrow("rotation activation failed");
    expect(new Set(released)).toEqual(new Set(["/runner-1", "/runner-2"]));
    expect(authorities.size).toBe(0);
    await expect(bundle.transport.request("thread/read", {})).rejects.toThrow(
      "rotation activation failed",
    );
  } finally {
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid) {
      try {
        process.kill(-runnerPid, "SIGKILL");
      } catch {
        // A successful durable close already stopped the runner process group.
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
}, 30_000);

it.each([
  {
    binding: "runner instance",
    priorRunnerInstanceId: "runner-other",
    priorEnvironmentLeaseId: "lease-current",
  },
  {
    binding: "environment lease",
    priorRunnerInstanceId: "runner-current",
    priorEnvironmentLeaseId: "lease-other",
  },
])(
  "quarantines a mismatched $binding instead of reusing its provider session",
  async ({ priorRunnerInstanceId, priorEnvironmentLeaseId }) => {
    const container = await mkdtemp(
      join(tmpdir(), "runnerd-mismatched-authority-"),
    );
    const stateDirectory = join(container, "state");
    await mkdir(join(stateDirectory, "control-plane"), { recursive: true });
    await writeFile(
      join(stateDirectory, "control-plane", "control-plane-state.json"),
      JSON.stringify({
        identity: {
          runnerInstanceId: priorRunnerInstanceId,
          environmentLeaseId: priorEnvironmentLeaseId,
          runId: "run-old",
          normalizedSessionId: "session-current",
          turnId: "turn-old",
          itemId: "item-old",
        },
      }),
      { mode: 0o600 },
    );
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: {
        runnerInstanceId: "runner-current",
        environmentLeaseId: "lease-current",
        runId: "run-new",
        normalizedSessionId: "session-current",
        turnId: "turn-new",
        itemId: "item-new",
      },
    });
    try {
      await expect(bundle.transport.request("thread/read", {})).rejects.toThrow(
        "native_runner_state_quarantined",
      );
      expect(await readdir(stateDirectory)).toEqual([]);
      expect(
        (await readdir(container)).some((entry) =>
          entry.startsWith("state.quarantine-"),
        ),
      ).toBe(true);
    } finally {
      await bundle.transport.close();
      await rm(container, { recursive: true, force: true });
    }
  },
);

it.each([false, true, "restart-before-bootstrap", "unknown-semantic", "accounting-rejected", "credentials-cleaned"] as const)("cold-restores a suspended provider session under its durable run binding (pending tail: %s)", async (pendingTail) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-cold-attach-"));
  const tracePath = join(stateDirectory, "provider-trace.ndjson");
  const skillRoot = join(stateDirectory, "runtime-skill");
  const instructionRoot = join(stateDirectory, "runtime-instructions");
  await Promise.all([mkdir(skillRoot), mkdir(instructionRoot)]);
  await writeFile(join(skillRoot, "SKILL.md"), "# Assigned runtime skill\n");
  await writeFile(join(instructionRoot, "AGENTS.md"), "Runtime instructions\n");
  const credentialsCleaned = pendingTail === "credentials-cleaned";
  const sourceCodexHome = join(stateDirectory, "selected-account-first");
  if (credentialsCleaned) {
    await mkdir(sourceCodexHome);
    await writeFile(join(sourceCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "selected-account-fixture" }), { mode: 0o600 });
  }
  const baseIdentity = {
    runnerInstanceId: "runner-cold-attach",
    environmentLeaseId: "lease-cold-attach",
    runId: "run-cold-first",
    normalizedSessionId: "session-cold-attach",
    turnId: "turn-cold-first",
    itemId: "item-cold-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(
      stateDirectory,
      "--include-skill-instructions",
      "--durable-turn-ids",
      ...(credentialsCleaned ? ["--require-codex-home-auth"] : []),
      "-c",
      'shell_environment_policy.set={PATH="/run/A"}',
    ),
    stateDirectory,
    ...(credentialsCleaned ? { sourceCodexHome } : {}),
    environment: {
      PAPERCLIP_GITHUB_BROKER_TOKEN: "test-run-A-capability",
      PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
      PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(64 * 1024 * 1024),
      ...(credentialsCleaned ? {
        PAPERCLIP_NATIVE_MCP_NAME: "assigned",
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp/first",
        PAPERCLIP_NATIVE_MCP_TOKEN: "first-assigned-gateway-credential",
      } : {}),
    },
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
    runtimeContext: assignedRuntimeContext(skillRoot, instructionRoot),
  };
  const dynamicTools = [
    {
      name: "get_task_context",
      description: "Read the active task.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const first = createCapabilityRunnerdCodexTransport({
    ...options,
    prpIdentity: baseIdentity,
  });
  first.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  let firstProviderThread: { id: string; sessionId: string } | null = null;
  try {
    const started = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [...dynamicTools, ...codexSemanticToolSpecs()],
      completionContract: {
        revision: "contract-first",
        criterionIds: ["criterion-first"],
      },
    });
    const startedThread = started.thread as Record<string, unknown>;
    firstProviderThread = {
      id: String(startedThread.id),
      sessionId: String(startedThread.sessionId),
    };
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    await first.transport.request("turn/start", {
      input: [{ type: "text", text: "$assigned first process" }, { type: "skill", name: "assigned", path: join(skillRoot, "SKILL.md") }],
    });
    for await (const event of first.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
  } finally {
    await first.transport.close();
  }
  if (!firstProviderThread) {
    throw new Error("cold attach fixture did not return a provider thread");
  }
  const successorCodexHome = join(stateDirectory, "selected-account-next");
  if (credentialsCleaned) {
    await rm(join(stateDirectory, "codex-home", "auth.json"));
    await rm(sourceCodexHome, { recursive: true });
    await mkdir(successorCodexHome);
    await writeFile(join(successorCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "selected-account-fixture" }), { mode: 0o600 });
  }

  // Model a retained provider-owned suffix: rotation must deliver and durably
  // accept it before attempting run.attach, rather than dropping or ACKing it.
  const retainedDelta = "cold-recovery-retained-tail";
  if (pendingTail) {
    const providerFile = join(stateDirectory, "runner", "codex-provider-state.json");
    const provider = JSON.parse(await readFile(providerFile, "utf8"));
    expect(provider.pendingEvents).toEqual([]);
    provider.pendingEvents.push({
      executorEventId: `codex_provider_${String(provider.nextProviderEventSeq++).padStart(16, "0")}`,
      eventType: pendingTail === "unknown-semantic" ? "semantic_tool.input" : "usage.reported",
      priority: "p0",
      payload: pendingTail === "unknown-semantic" ? { semantic_tool: {
        schema: "paperclip.prp.semantic_tool.v1", schemaVersion: 1, phase: "input",
        callId: "unknown-source-call", operationId: "get_task_context", input: {}, idempotencyKey: null,
        correlation: { runId: baseIdentity.runId, normalizedSessionId: baseIdentity.normalizedSessionId,
          turnId: baseIdentity.turnId, itemId: baseIdentity.itemId },
        content: { digest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, redactionDisposition: "digest_only", references: [] },
      } } : { provider: "codex", kind: "usage", delta: retainedDelta,
        providerTurnId: provider.completed_provider_turn_id, runDelta: { inputTokens: 20, outputTokens: 2 },
        runDeltaAvailable: true, runDeltaBasis: "run" },
    });
    await writeFile(providerFile, JSON.stringify(provider));
  }
  const retainedEvents: PrpEvent[] = [];
  let releaseRetained!: () => void, retainedEntered!: () => void;
  const retainedAccepted = new Promise<void>(done => { releaseRetained = done; });
  const retainedAdmission = new Promise<void>(done => { retainedEntered = done; });
  const secondIdentity = {
    ...baseIdentity,
    runId: "run-cold-second",
    turnId: "turn-cold-second",
    itemId: "item-cold-second",
  };
  let stagedCheckpoint: durableControlPlane.DurablePrpCheckpoint | undefined;
  let rejectStagedCommit = pendingTail === "restart-before-bootstrap";
  const rotatedOptions = {
    ...options,
    ...(credentialsCleaned ? { sourceCodexHome: successorCodexHome } : {}),
    onStagedRunAttachment: pendingTail === "restart-before-bootstrap" ? async (authority: DurablePrpControlPlane) => {
      authority.setCheckpointPersistence(async checkpoint => {
        stagedCheckpoint = checkpoint;
        if (rejectStagedCommit) throw new Error("fixture lost controller after durable intent");
      });
    } : undefined,
    onRecoveryAccountingEvent: pendingTail ? async (event: PrpEvent) => {
      if (event.payload.delta === retainedDelta) {
        retainedEvents.push(structuredClone(event));
        retainedEntered();
        if (pendingTail === "accounting-rejected") throw new Error("source accounting receipt unavailable");
        await retainedAccepted;
      }
    } : undefined,
    environment: { ...options.environment, PAPERCLIP_GITHUB_BROKER_TOKEN: "test-run-B-capability",
      ...(credentialsCleaned ? {
        PAPERCLIP_NATIVE_MCP_URL: "https://paperclip.example/mcp/current",
        PAPERCLIP_NATIVE_MCP_TOKEN: "current-assigned-gateway-credential",
      } : {}),
    },
    codexArgs: options.codexArgs.map((arg) => arg.replace('/run/A', '/run/B')),
    resumeDynamicTools: dynamicTools,
    resumeCompletionContract: {
      revision: "contract-second",
      criterionIds: ["criterion-second"],
    },
    prpIdentity: secondIdentity,
  };
  let rotated = createCapabilityRunnerdCodexTransport(rotatedOptions);
  if (pendingTail === "restart-before-bootstrap") {
    await expect(rotated.transport.request("thread/read", {})).rejects.toThrow("fixture lost controller after durable intent");
    expect(rotated.evidence().runnerPid).toBeNull();
    expect(stagedCheckpoint?.runId).toBe(secondIdentity.runId);
    expect([...stagedCheckpoint!.records].filter(([key]) => key.startsWith("command:")).map(([, value]) => JSON.parse(value).type)).not.toContain("run.attach");
    await rotated.detachControllerForRestart().catch(() => undefined);
    rejectStagedCommit = false;
    await rm(join(stateDirectory, "control-plane"), { recursive: true, force: true });
    stagedCheckpoint!.restoreSessionDirectory(stateDirectory);
    rotated = createCapabilityRunnerdCodexTransport(rotatedOptions);
  }
  const currentHandler = vi.fn(async () => ({ success: true, contentItems: [] }));
  rotated.transport.setServerRequestHandler(currentHandler);
  if (pendingTail === "accounting-rejected") {
    const reading = rotated.transport.request("thread/read", {});
    void reading.catch(() => undefined);
    try {
      await Promise.race([retainedAdmission, reading]);
      const source = JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
      expect(source.identity).toEqual(baseIdentity);
      expect(source.stagedRunAttachment.targetIdentity).toEqual(secondIdentity);
      expect(source.commands.some((command: { type: string }) => command.type === "run.attach")).toBe(false);
      const retainedRunner = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8"));
      expect(retainedRunner.outbox.some((entry: { envelope: { payload: PrpEvent } }) =>
        entry.envelope.payload.sourceEventId === retainedEvents[0]!.sourceEventId)).toBe(true);
      expect(currentHandler).not.toHaveBeenCalled();
    } finally {
      await expect(rotated.transport.close()).rejects.toMatchObject({ code: "native_session_close_unrecoverable" });
      await expect(reading).rejects.toThrow();
      await releaseMaterializedNativeRuntimeSkills(join(stateDirectory, "codex-home", "skills"));
      await rm(stateDirectory, { recursive: true, force: true });
    }
    return;
  }
  if (pendingTail === "unknown-semantic") {
    try {
      await expect(rotated.transport.request("thread/read", {})).rejects.toThrow("native_runner_source_semantic_reconciliation_required");
      expect(currentHandler).not.toHaveBeenCalled();
      const retained = JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
      expect(retained.identity).toEqual(baseIdentity);
      expect(retained.stagedRunAttachment.targetIdentity).toEqual(secondIdentity);
      expect(retained.commands.some((command: { type: string }) => ["run.attach", "semantic_tool.result"].includes(command.type))).toBe(false);
      expect(retained.committedEvents.some((event: PrpEvent) => event.eventType === "semantic_tool.input")).toBe(true);
    } finally {
      await expect(rotated.transport.close()).rejects.toMatchObject({ code: "native_session_close_unrecoverable" });
      await releaseMaterializedNativeRuntimeSkills(join(stateDirectory, "codex-home", "skills"));
      await rm(stateDirectory, { recursive: true, force: true });
    }
    return;
  }
  let recoveryError: unknown;
  try {
    const reading = rotated.transport.request("thread/read", {});
    void reading.catch(() => undefined);
    if (pendingTail) {
      await Promise.race([retainedAdmission, reading]);
      const retainedRunner = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8"));
      expect(retainedRunner.outbox.some((entry: { envelope: { payload: PrpEvent } }) =>
        entry.envelope.payload.sourceEventId === retainedEvents[0]!.sourceEventId)).toBe(true);
      const retainedCore = stagedCheckpoint ? {
        identity: JSON.parse(stagedCheckpoint.records.get("header")!).state.identity,
        commands: [...stagedCheckpoint.records].filter(([key]) => key.startsWith("command:")).map(([, value]) => JSON.parse(value)),
      } : JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
      expect(retainedCore.identity).toEqual(baseIdentity);
      expect(retainedCore.commands.some((command: { type: string }) => command.type === "run.attach")).toBe(false);
      if (credentialsCleaned) {
        const config = await readFile(join(stateDirectory, "codex-home", "config.toml"), "utf8");
        expect(config).toContain("https://paperclip.example/mcp/current");
        expect(config).toContain("current-assigned-gateway-credential");
        expect(config).not.toContain("first-assigned-gateway-credential");
        expect(currentHandler).not.toHaveBeenCalled();
      }
    }
    releaseRetained();
    const read = await reading;
    expect(retainedEvents).toHaveLength(pendingTail ? 1 : 0);
    if (pendingTail) expect(retainedEvents[0]).toMatchObject({
      runId: baseIdentity.runId, turnId: baseIdentity.turnId, itemId: baseIdentity.itemId,
    });
    const persistedProvider = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
    expect(persistedProvider.pendingEvents).toEqual([]);
    expect(persistedProvider.config.args.join("\n")).toContain('/run/B');
    expect(JSON.stringify(persistedProvider)).not.toContain("test-run-B-capability");
    expect(read.thread).toMatchObject({
      id: firstProviderThread.id,
      sessionId: firstProviderThread.sessionId,
      cwd: tmpdir(),
    });
    await rotated.transport.request("turn/start", {
      input: [{ type: "text", text: "$assigned second authority epoch" }, { type: "skill", name: "assigned", path: join(skillRoot, "SKILL.md") }],
    });
    for await (const event of rotated.transport.notifications()) {
      if (event.method === "paperclip/runResult") break;
    }
    expect(rotated.evidence().diagnostics).toContain(
      "runnerd attached the durable provider session to a fresh PRP run authority",
    );
    if (pendingTail) {
      const target = stagedCheckpoint ? JSON.parse(stagedCheckpoint.records.get("header")!).state
        : JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
      expect(target.stagedRunAttachment).toBeUndefined();
      expect(target.completedWarmTransition.receipt).toMatchObject({ oldIdentity: baseIdentity, newIdentity: secondIdentity });
    } else expect(await stat(join(stateDirectory, "authority-epochs"))).toBeDefined();
  } catch (error) {
    recoveryError = error;
    throw error;
  } finally {
    releaseRetained();
    await rotated.transport.close().catch(error => {
      if (recoveryError) throw new AggregateError([recoveryError, error], "Provider recovery and cleanup failed");
      throw error;
    });
  }
  const requestFrames = (await readFile(tracePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) =>
        entry.kind === "frame" && entry.direction === "client_to_provider",
    )
    .map(
      (entry) =>
        JSON.parse(
          Buffer.from(String(entry.rawBase64), "base64").toString("utf8"),
        ) as Record<string, unknown>,
    )
    ;
  const resumeFrames = requestFrames.filter((frame) => frame.method === "thread/resume");
  for (const frame of requestFrames.filter((f) => ["thread/start", "thread/resume"].includes(String(f.method)))) {
    expect(frame.params).toMatchObject({ config: { "skills.include_instructions": true } });
  }
  const turnFrames = requestFrames.filter((f) => f.method === "turn/start");
  expect(turnFrames).toHaveLength(2);
  for (const frame of turnFrames) {
    expect(frame.params).toMatchObject({ input: expect.arrayContaining([{ type: "skill", name: "assigned", path: join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md") }]) });
  }
  expect(resumeFrames.length).toBeGreaterThanOrEqual(1);
  for (const frame of resumeFrames) {
    expect(frame).toEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: firstProviderThread.id }),
      }),
    );
  }

  if (pendingTail) {
    await releaseMaterializedNativeRuntimeSkills(join(stateDirectory, "codex-home", "skills"));
    await rm(stateDirectory, { recursive: true, force: true });
    return;
  }

  // A remote process owner keeps runner-state outside the controller's local
  // session root. Resume must defer to its explicit state reader instead of
  // rejecting recovery before the remote checkpoint can be made available.
  const externallyOwnedRunnerStateDirectory = join(
    stateDirectory,
    "externally-owned-runner",
  );
  await rename(
    join(stateDirectory, "runner"),
    externallyOwnedRunnerStateDirectory,
  );
  const readRunnerState = async () =>
    JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "runner-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
  const mismatched = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: {
      ...secondIdentity,
      runId: "run-cold-other",
      turnId: "turn-cold-other",
      itemId: "item-cold-other",
    },
  });
  await expect(mismatched.transport.request("thread/read", {})).rejects.toThrow(
    "native_runner_prp_run_rotation_unavailable",
  );
  await mismatched.transport.close();

  const externalIdentity = {
    ...secondIdentity,
    runId: "run-cold-external",
    turnId: "turn-cold-external",
    itemId: "item-cold-external",
  };
  const rejectedExternalRotationSteps: string[] = [];
  let externalArchiveDirectory: string | null = null;
  const rejectedExternalRotation = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    prepareExternalRunnerState: async () => {
      rejectedExternalRotationSteps.push("prepared");
    },
    archiveExternalRunnerState: async ({ archiveKey }) => {
      await expect(
        stat(join(stateDirectory, "control-plane")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await stat(
          join(
            stateDirectory,
            "authority-epochs",
            `epoch-${archiveKey}`,
            "control-plane",
          ),
        ),
      ).toBeDefined();
      externalArchiveDirectory = join(
        stateDirectory,
        "external-authority-epochs",
        archiveKey,
      );
      await mkdir(externalArchiveDirectory, { recursive: true });
      await rename(
        join(externallyOwnedRunnerStateDirectory, "runner-state.json"),
        join(externalArchiveDirectory, "runner-state.json"),
      );
      rejectedExternalRotationSteps.push("remote-archived");
      throw new Error("controller crashed after external archive");
    },
    resumeDynamicTools: dynamicTools,
    prpIdentity: externalIdentity,
  });
  await expect(
    rejectedExternalRotation.transport.request("thread/read", {}),
  ).rejects.toThrow("controller crashed after external archive");
  await rejectedExternalRotation.transport.close();
  expect(rejectedExternalRotationSteps).toEqual([
    "prepared",
    "remote-archived",
  ]);
  await expect(stat(join(stateDirectory, "control-plane"))).rejects.toThrow();
  await expect(
    stat(join(externallyOwnedRunnerStateDirectory, "runner-state.json")),
  ).rejects.toThrow();

  const externalRotationSteps: string[] = [];
  const externallyRotated = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    prepareExternalRunnerState: async () => {
      throw new Error("retry must not prepare a new external runner");
    },
    archiveExternalRunnerState: async ({ archiveKey }) => {
      expect(externalArchiveDirectory).toBe(
        join(stateDirectory, "external-authority-epochs", archiveKey),
      );
      externalRotationSteps.push("archived");
      return JSON.parse(
        await readFile(
          join(externalArchiveDirectory!, "runner-state.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
    },
    resumeDynamicTools: dynamicTools,
    resumeCompletionContract: {
      revision: "contract-external",
      criterionIds: ["criterion-external"],
    },
    prpIdentity: externalIdentity,
  });
  externallyRotated.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await externallyRotated.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: firstProviderThread.id,
      sessionId: firstProviderThread.sessionId,
      cwd: tmpdir(),
    });
    expect(externalRotationSteps).toEqual(["archived"]);
  } finally {
    await externallyRotated.transport.close();
  }

  const restored = createCapabilityRunnerdCodexTransport({
    ...options,
    runnerStateDirectory: externallyOwnedRunnerStateDirectory,
    readRunnerState,
    resumeDynamicTools: dynamicTools,
    prpIdentity: externalIdentity,
  });
  restored.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    const read = await restored.transport.request("thread/read", {});
    expect(read.thread).toMatchObject({
      id: "codex-thread-1",
      cwd: tmpdir(),
    });
    expect(
      (await stat(join(stateDirectory, "codex-home", "skills", "assigned")))
        .mode & 0o222,
    ).toBe(0);
    expect(
      (
        await stat(
          join(stateDirectory, "codex-home", "skills", "assigned", "SKILL.md"),
        )
      ).mode & 0o222,
    ).toBe(0);
    const providerState = JSON.parse(
      await readFile(
        join(externallyOwnedRunnerStateDirectory, "codex-provider-state.json"),
        "utf8",
      ),
    ) as { toolBridge?: { authorized?: Record<string, unknown> } };
    expect(Object.keys(providerState.toolBridge?.authorized ?? {})).toEqual([
      "get_task_context",
      "paperclip_block",
      "paperclip_finish",
    ]);
    await restored.transport.request("turn/start", {
      input: [{ type: "text", text: "restored process" }],
    });
    for await (const event of restored.transport.notifications()) {
      if (event.method === "turn/completed") break;
    }
    expect(restored.evidence()).toMatchObject({
      runnerExited: false,
      codexPid: expect.any(Number),
    });
  } finally {
    await restored.transport.close();
    await releaseMaterializedNativeRuntimeSkills(
      join(stateDirectory, "codex-home", "skills"),
    );
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

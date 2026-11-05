import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { ControlPlanePort } from "../contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { NativeSession, NativeSessionBackend } from "../contracts/native-session-backend.js";
import type { PrpEvent, PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, expectTurnStarted, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

it("rejects active work and buffered tools from a resumed stopped checkpoint", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-stopped-resume-active-"),
  );
  const identity = {
    runnerInstanceId: "runner-stopped-active",
    environmentLeaseId: "lease-stopped-active",
    runId: "run-stopped-first",
    normalizedSessionId: "session-stopped-active",
    turnId: "turn-stopped-first",
    itemId: "item-stopped-first",
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(
      stateDirectory,
      "--linger-after-turn-start",
      "--resume-unowned-turn-when-marked",
      "--emit-tool-call-on-resume",
    ),
    stateDirectory,
    lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
  };
  const first = createCapabilityRunnerdCodexTransport({
    ...options,
    prpIdentity: identity,
  });
  let second:
    ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  const semanticHandler = vi.fn(async () => ({
    success: true,
    contentItems: [],
  }));
  first.transport.setServerRequestHandler(semanticHandler);
  try {
    const opened = await first.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the current task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await first.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    await expectTurnStarted(
      first.transport.notifications()[Symbol.asyncIterator](),
    );
    await first.transport.close();
    const providerPath = join(
      stateDirectory,
      "runner",
      "codex-provider-state.json",
    );
    expect(JSON.parse(await readFile(providerPath, "utf8"))).toMatchObject({
      lifecycle: "prepared",
      activeProviderTurnId: null,
    });
    await writeFile(join(stateDirectory, "resume-unowned-turn"), "armed");
    const secondIdentity = {
      ...identity,
      runId: "run-stopped-second",
      turnId: "turn-stopped-second",
      itemId: "item-stopped-second",
    };
    second = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: secondIdentity,
    });
    second.transport.setServerRequestHandler(semanticHandler);
    await expect(second.transport.request("thread/read", {})).rejects.toThrow(
      "prepared provider checkpoint resumed unexpected active work",
    );
    // Exercise the normal durable transfer before inspecting the rejection:
    // provider pendingEvents is an acknowledged queue, not an event journal.
    await vi.waitFor(
      async () => {
        const provider = JSON.parse(await readFile(providerPath, "utf8"));
        expect(provider.pendingEvents).toEqual([]);
        const control = JSON.parse(
          await readFile(
            join(stateDirectory, "control-plane", "control-plane-state.json"),
            "utf8",
          ),
        ) as {
          committedEvents: Array<{
            eventType: string;
            envelope: { payload: { payload: { code?: string } } };
          }>;
        };
        const rejections = control.committedEvents.filter(
          (event) =>
            event.eventType === "harness.diagnostic" &&
            event.envelope.payload.payload.code ===
              "prepared_provider_checkpoint_has_active_work",
        );
        expect(rejections).toEqual([
          expect.objectContaining({
            logicalEffectCount: 1,
            envelope: expect.objectContaining({
              ...secondIdentity,
              payload: expect.objectContaining({
                payload: expect.objectContaining({
                  code: "prepared_provider_checkpoint_has_active_work",
                  paperclipAccepted: false,
                  providerReportedActive: true,
                }),
              }),
            }),
          }),
        ]);
      },
      { timeout: 5_000 },
    );
    const closed = JSON.parse(await readFile(providerPath, "utf8"));
    expect(closed).toMatchObject({
      lifecycle: "closed",
      threadId: (opened.thread as Record<string, unknown>).id,
      activeProviderTurnId: null,
    });
    expect(semanticHandler).not.toHaveBeenCalled();
    expect(closed.pendingEvents).toEqual([]);
  } finally {
    await Promise.allSettled([
      first.transport.close(),
      second?.transport.close(),
    ]);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("does not retry a real memoized transport close whose suspension proof is unavailable", async () => {
  const identity = {
    runId: "run-recovery",
    sessionId: "session-recovery",
    companyId: "company-recovery",
    issueId: "issue-recovery",
    agentId: "agent-recovery",
  };

  const result: PrpStructuredRunResult = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: "Recovered native work completed.",
    completionClaim: {
      contractRevision: "1",
      objectiveSatisfied: true,
      criteria: [
        { criterionId: "objective", status: "satisfied", evidenceRefs: [] },
      ],
      remainingWork: [],
    },
    evidence: [],
    verification: [{ commandOrCheck: "recovery", status: "passed" }],
    attentionRequests: [],
    artifacts: [],
  };

  const terminal: PrpTerminalState = {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "done",
  };

  const input: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: identity.companyId,
      runId: identity.runId,
      issueId: identity.issueId,
      agentId: identity.agentId,
      executionWorkspaceId: "workspace-recovery",
    },
    task: {
      identifier: "PAP-RECOVERY",
      title: "Recover native work",
      description: null,
      prompt: "# PAP-RECOVERY: Recover native work",
      workMode: "standard",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: identity.sessionId,
      driverKind: "codex_app_server",
      protocolVersion: 1,
    },
    provider: { kind: "codex", model: null },
    completionContract: {
      id: "contract-recovery",
      sha256: "contract-recovery-sha",
      schemaVersion: "paperclip.completion-contract.v1",
      contract: {
        revision: "1",
        objective: "Recover native work",
        criteria: [{ id: "objective", requirement: "Complete after recovery" }],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };

  function runnerEvent(
    sourceSeq: number,
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown> = {},
  ): PrpEvent {
    return {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `runner-recovery:${identity.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "runner-recovery",
      sourceKind: "runner",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-recovery",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload,
    };
  }
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "native-close-quarantine-"),
  );
  const readRunnerState = vi.fn(async () => ({
    schema: "paperclip.runner.durable.state.v1",
    runnerInstanceId: "runner-close-quarantine",
    environmentLeaseId: "lease-close-quarantine",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-close-quarantine",
    itemId: "item-close-quarantine",
    lifecycle: "ready",
  }));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(
      import.meta.dirname,
      "../../runner/target/debug/fake-codex-app-server",
    ),
    codexArgs: ["--state-file", join(stateDirectory, "fake-codex-state.json")],
    stateDirectory,
    closeGraceMs: 400,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: await readRunnerState(),
    readRunnerState,
    // A checkpoint owner requires durable suspension proof. A local transport
    // without a checkpoint can simply terminate its process on close.
    controlPlaneRegistration: async (authority) => {
      await authority.start();
      return {
        connectUrl: authority.connectUrl,
        checkpoint: async () => {},
        release: async () => {},
      };
    },
  });
  try {
    await bundle.transport.request("thread/start", {
      cwd: stateDirectory,
      dynamicTools: [],
    });
    const failedClose = bundle.transport.close();
    const failure = await failedClose.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "native_session_close_unrecoverable",
    });
    expect(bundle.transport.close()).toBe(failedClose);

    vi.useFakeTimers();
    const close = vi.fn(({ reason }: { reason: string }) =>
      bundle.transport.close(reason),
    );
    const capabilities = {
      resume: true,
      typedEvents: true,
      steering: false,
      interruption: true,
      structuredResult: true,
    };
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return capabilities;
      },
      async *events() {
        yield runnerEvent(1, "turn.completed");
      },
      async startTurn() {
        return { turnId: "turn-recovery" };
      },
      async result() {
        return { result, terminal, turnId: "turn-recovery" };
      },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const openSession = vi.fn(async () => session);
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "real-memoized-close-quarantine",
          version: "1",
          capabilities,
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() {
        return {
          cursor: 1,
          highestContiguousSourceSeq: 1,
          disposition: "committed",
        };
      },
      async replayEvents() {
        return { events: [], highestContiguousSourceSeq: 0 };
      },
      async completeRun() {},
    };
    const execute = () =>
      executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
        requireSessionCloseBeforeReturn: true,
      });
    await expect(execute()).rejects.toBe(failure);
    const readsAfterClose = readRunnerState.mock.calls.length;
    await expect(execute()).rejects.toMatchObject({
      code: "native_session_cleanup_quarantined",
      recovery: "operator_required",
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(execute()).rejects.toMatchObject({
      code: "native_session_cleanup_quarantined",
    });
    expect(openSession).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(readRunnerState).toHaveBeenCalledTimes(readsAfterClose);
  } finally {
    vi.useRealTimers();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 10_000);

it.each(["not_suspended", "wrong_identity"] as const)(
  "does not report local runner close healthy with %s durable evidence",
  async (mode) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-local-close-unproven-"),
    );
    const identity = {
      runnerInstanceId: "runner-close-unproven",
      environmentLeaseId: "lease-close-unproven",
      runId: "run-close-unproven",
      normalizedSessionId: "session-close-unproven",
      turnId: "turn-close-unproven",
      itemId: "item-close-unproven",
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(stateDirectory),
      stateDirectory,
      closeGraceMs: 400,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: identity,
      readRunnerState: async () => ({
        schema: "paperclip.runner.durable.state.v1",
        ...identity,
        ...(mode === "wrong_identity" ? { runId: "some-other-run" } : {}),
        lifecycle: mode === "not_suspended" ? "ready" : "suspended",
      }),
    });
    bundle.transport.setServerRequestHandler(async () => ({
      success: true,
      contentItems: [],
    }));
    try {
      await bundle.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      });
      await expect(bundle.transport.close()).rejects.toThrow(
        "runner did not durably suspend before checkpoint",
      );
      const control = JSON.parse(
        await readFile(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      );
      expect(control.identity).toEqual(identity);
      expect(await readdir(stateDirectory)).toContain("runner");
    } finally {
      await bundle.transport.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  10_000,
);

it.each([
  {
    label: "interrupted",
    args: ["--hold-turn"],
    terminal: "turn.interrupted",
    disposition: "needs_review",
  },
  {
    label: "failed",
    args: ["--fail-turn-immediately"],
    terminal: "turn.failed",
    disposition: "needs_review",
  },
  {
    label: "completed",
    args: [],
    terminal: "turn.completed",
    disposition: "done",
  },
])("retains a $label runner's result before closing its provider turn", async ({
  label, args, terminal, disposition,
}) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-stop-result-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, ...args),
    stateDirectory,
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: createCodexTaskEnvelope({
      objective: "Stop and retain unfinished work.",
    }),
    environment: {
      PATH: process.env.PATH,
      HOME: join(tmpdir(), "runnerd-stop-host-home"),
      PAPERCLIP_WORKSPACE_CWD: stateDirectory,
    },
    approvalPolicy: "never",
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({
    runId: "run-stop-result",
    normalizedSessionId: "session-stop-result",
    workingDirectory: stateDirectory,
  });
  try {
    const turn = await session.startTurn({
      message: { role: "user", text: "Keep working until interrupted." },
    });
    if (label === "interrupted") {
      await session.interrupt({
        turnId: turn.turnId,
        reason: "Stopped by the user",
      });
    }
    const events: PrpEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.eventType === "session.failed" || event.eventType === terminal) {
        break;
      }
    }
    // Let already committed durable suffix events reach the facade as well.
    await bundle.transport.request("thread/read", {});
    const snapshot = await session.snapshot();
    expect(events.some((event) => event.eventType === "session.failed")).toBe(false);
    expect(events.map((event) => event.eventType)).toContain("run.result.proposed");
    expect(events.at(-1)?.eventType).toBe(terminal);
    expect(snapshot).toMatchObject({
      activeTurnId: null,
      semanticResult: {
        turnId: turn.turnId,
        result: { reportedWorkDisposition: disposition },
      },
    });
  } finally {
    await session.close().catch(() => undefined);
    await rm(stateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
}, 30_000);

it.each([0, 193 * 1024 * 1024])(
  "probes an exact-authority resume with %i extra journal bytes and confirms its live provider identity",
  async (extraJournalBytes) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-exact-authority-resume-"),
    );
    const identity = {
      runnerInstanceId: "runner-exact-resume",
      environmentLeaseId: "lease-exact-resume",
      runId: "run-exact-resume",
      normalizedSessionId: "session-exact-resume",
      turnId: "turn-exact-resume",
      itemId: "item-exact-resume",
    };
    const options = {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(stateDirectory, "--durable-turn-ids"),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
      prpIdentity: identity,
    };
    const first = createCapabilityRunnerdCodexTransport(options);
    first.transport.setServerRequestHandler(async () => ({
      success: true,
      contentItems: [],
    }));
    let providerThread: { id: string; sessionId: string } | null = null;
    try {
      const opened = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [],
      });
      const thread = opened.thread as Record<string, unknown>;
      providerThread = {
        id: String(thread.id),
        sessionId: String(thread.sessionId),
      };
    } finally {
      await first.transport.close();
    }
    if (providerThread === null) {
      throw new Error(
        "exact-authority fixture did not return a provider thread",
      );
    }

    const statePath = join(
      stateDirectory,
      "control-plane",
      "control-plane-state.json",
    );
    if (extraJournalBytes > 0) {
      const padding = Buffer.alloc(1024 * 1024, 0x20);
      const stateHandle = await open(statePath, "a");
      try {
        for (let remaining = extraJournalBytes; remaining > 0;) {
          const bytesToWrite = Math.min(remaining, padding.length);
          await stateHandle.write(padding, 0, bytesToWrite);
          remaining -= bytesToWrite;
        }
      } finally {
        await stateHandle.close();
      }
      expect((await stat(statePath)).size).toBeGreaterThan(
        64 * 1024 * 1024,
      );
    }
    const beforeResume = JSON.parse(await readFile(statePath, "utf8")) as {
      commands: Array<{ type: string }>;
      committedEvents: Array<{ eventType: string }>;
    };
    expect(
      beforeResume.commands.some((command) => command.type === "run.attach"),
    ).toBe(false);
    const priorResumeEvents = beforeResume.committedEvents.filter(
      (event) => event.eventType === "session.resumed",
    ).length;
    const priorSnapshots = beforeResume.commands.filter(
      (command) => command.type === "session.snapshot",
    ).length;

    const resumed = createCapabilityRunnerdCodexTransport({
      ...options,
      resumeProviderSession: {
        driverSessionId: providerThread.id,
        providerSessionId: providerThread.sessionId,
      },
    });
    resumed.transport.setServerRequestHandler(async () => ({
      success: true,
      contentItems: [],
    }));
    try {
      const read = await resumed.transport.request("thread/read", {});
      expect(read.thread).toMatchObject(providerThread);
      const afterResume = JSON.parse(await readFile(statePath, "utf8")) as {
        commands: Array<{ commandId: string; type: string; status: string }>;
        committedEvents: Array<{ eventType: string }>;
      };
      expect(afterResume.commands).toContainEqual(
        expect.objectContaining({
          commandId: expect.stringMatching(/^command_resume_probe_/),
          type: "runner.drain",
          status: "completed",
        }),
      );
      expect(afterResume.commands).toContainEqual(
        expect.objectContaining({
          type: "session.snapshot",
          status: "completed",
        }),
      );
      expect(
        afterResume.commands.filter(
          (command) => command.type === "session.snapshot",
        ),
      ).toHaveLength(priorSnapshots + 2);
      // The authenticated snapshot above proves the live provider identity.
      // Control-first dispatch may deliver that command before the independent
      // session event is ingested. Still require exactly one durable event;
      // don't mistake an immediate file read for an event-delivery barrier.
      await vi.waitFor(
        async () => {
          const delivered = JSON.parse(await readFile(statePath, "utf8")) as {
            committedEvents: Array<{ eventType: string }>;
          };
          expect(
            delivered.committedEvents.filter(
              (event) => event.eventType === "session.resumed",
            ),
          ).toHaveLength(priorResumeEvents + 1);
        },
        { timeout: 3_000, interval: 25 },
      );
    } finally {
      await resumed.transport.close();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  30_000,
);

it("still fails closed when a real close grace period cannot fit a durable suspension round trip", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-close-grace-too-small-"),
  );
  const identity = {
    runnerInstanceId: "runner-close-grace-too-small",
    environmentLeaseId: "lease-close-grace-too-small",
    runId: "run-close-grace-too-small",
    normalizedSessionId: "session-close-grace-too-small",
    turnId: "turn-close-grace-too-small",
    itemId: "item-close-grace-too-small",
  };
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    // No real durable command round trip can complete this fast. A wider
    // budget for the provider-drain proof must not turn this barrier into
    // one that always passes; it still needs the actual proof to arrive.
    closeGraceMs: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: identity,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [],
    });
    const closed = bundle.transport.close();
    await expect(closed).rejects.toMatchObject({
      code: "native_session_close_unrecoverable",
      semanticToolsSettled: true,
    });
    // Retirement preserves the original rejected promise and its proof.
    expect(bundle.transport.close()).toBe(closed);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it("persists an active provider as settled before bounded suspension", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-active-suspension-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--linger-after-turn-start"),
    stateDirectory,
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Wait for another instruction." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    await expectTurnStarted(notifications);
    await bundle.transport.close();

    const providerState = JSON.parse(
      await readFile(
        join(stateDirectory, "runner", "codex-provider-state.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(providerState).toMatchObject({
      lifecycle: "prepared",
      activeProviderTurnId: null,
    });
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

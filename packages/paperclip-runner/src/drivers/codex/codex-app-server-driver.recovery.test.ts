import {
  CODEX_BLOCK_RESULT_OUTPUT_SCHEMA,
  CODEX_INVALID_REQUEST,
  CODEX_METHOD_NOT_FOUND,
  CODEX_RESULT_OUTPUT_SCHEMA,
  CodexAppServerDriver,
  CodexRpcError,
  FakeCodexTransport,
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  WORKSPACE,
  applyPrpEvent,
  collectUntilTerminal,
  createCodexTaskEnvelope,
  createIsolatedCodexAppServerArgs,
  createSessionSnapshotFromMetadata,
  describe,
  envelope,
  expect,
  isSkilllessCodexContext,
  it,
  liveConsoleFixturePath,
  loadLiveConsoleConformanceFixture,
  makeDriver,
  replayPersistedCodexEvents,
  result,
  reverseObjectKeys,
  runCodexCodexTracer,
  traceCompletedProposal,
  validateCodexResultProposal,
  validatePrpEvent,
  vi,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
  type CodexServerRequestHandler,
  type CodexTraceInterpretation,
  type HarnessRuntimeRequestResolution,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "./codex-app-server-driver.test-support.js";

describe("Codex app-server Codex driver", () => {
  it("resumes and reconciles the exact provider thread after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-recover",
      normalizedSessionId: "normalized-recover",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Work." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });
    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    expect(recovery?.session?.ids()).toEqual(original.ids());
    expect(await recovery?.session?.reconcile?.()).toMatchObject({
      thread: { id: "thread-1" },
    });
    expect(second.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/read",
      "thread/resume",
      "thread/goal/get",
      "thread/read",
    ]);
    expect((await recovery?.session?.snapshot())?.activeTurnId).toBe("turn-1");
  });

  it("ignores an old terminal turn when the persisted active turn is still running", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          { id: "turn-old", status: "completed", items: [] },
          { id: "turn-1", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-history",
      normalizedSessionId: "normalized-history",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({
      message: { role: "user", text: "Keep working." },
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    expect(await recovered!.snapshot()).toMatchObject({
      activeTurnId: "turn-1",
    });
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(
      false,
    );
  });

  it("preserves proposal idempotency and rejects a changed result after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-proposal-loss",
      normalizedSessionId: "normalized-proposal-loss",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "call-before-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-before-loss",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    const snapshot = await original.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "call-before-loss",
      turnId: "turn-1",
      result,
    });
    await original.close({ reason: "transport lost after proposal" });
    const originalEvents: PrpEvent[] = [];
    for await (const event of original.events()) originalEvents.push(event);
    expect(
      originalEvents.filter(
        (event) => event.eventType === "run.result.proposed",
      ),
    ).toHaveLength(1);

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    expect(
      await second.invoke({
        id: "call-after-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-after-loss",
          tool: "paperclip_finish",
          arguments: reverseObjectKeys(result),
        },
      }),
    ).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Changed after transport loss.";
    expect(
      await second.invoke({
        id: "changed-after-loss",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "changed-after-loss",
          tool: "paperclip_finish",
          arguments: changed,
        },
      }),
    ).toMatchObject({ success: false });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collecting;
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
  });

  it("rejects changed terminal result content discovered during recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const changed = structuredClone(result);
    changed.summary = "Conflicting recovered terminal result.";
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "terminal-result",
                type: "agentMessage",
                text: JSON.stringify(changed),
              },
            ],
          },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-recovered-result-conflict",
      normalizedSessionId: "normalized-recovered-result-conflict",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "tool-result",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "tool-result",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    await expect(
      recovery!.session!.reconcile!(),
    ).rejects.toMatchObject<HarnessReconciliationError>({
      name: "HarnessReconciliationError",
      recoverable: true,
      message: expect.stringContaining(
        "contains a conflicting semantic result",
      ),
    });
    expect(
      (await recovery!.session!.snapshot()).semanticResult?.result,
    ).toEqual(result);
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("does not re-emit an already observed terminal after recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-terminal-loss",
      normalizedSessionId: "normalized-terminal-loss",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(
      await first.invoke({
        id: "terminal-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "terminal-call",
          tool: "paperclip_finish",
          arguments: result,
        },
      }),
    ).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType.startsWith("turn."))).toBe(
      false,
    );
    expect(
      events.some((event) => event.eventType === "run.result.proposed"),
    ).toBe(false);
  });

  it("clears a checkpointed active turn that already has a durable terminal", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    second.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-terminal-checkpoint-race",
      normalizedSessionId: "normalized-terminal-checkpoint-race",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({
      message: { role: "user", text: "Complete without a result." },
    });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot).toMatchObject({
      activeTurnId: null,
      semanticResult: null,
      terminalTurns: [{ turnId: "turn-1" }],
    });
    // Model the crash window after the terminal fingerprint was checkpointed
    // but before the subsequent active-turn clear was durable.
    snapshot.activeTurnId = "turn-1";
    await original.close({ reason: "transport lost during terminal checkpoint" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await expect(recovered!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: null,
      terminalTurns: [{ turnId: "turn-1" }],
    });
    await expect(recovered!.startTurn({
      message: {
        role: "user",
        text: "Recover only the missing disposition.",
      },
    })).resolves.toMatchObject({ turnId: "turn-2" });
    expect(
      second.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(1);
    await recovered!.close({ reason: "test complete" });
  });

  it("permits one recovery turn for a result-less terminal task", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const third = new FakeCodexTransport();
    const fourth = new FakeCodexTransport();
    third.turnStartResponse = Promise.reject(
      new CodexRpcError('{"code":-32602,"message":"invalid params"}', -32_602),
    );
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    third.readResponse = structuredClone(second.readResponse);
    fourth.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "completed", items: [] },
        ],
      },
    };
    fourth.turnStartResponse = Promise.resolve({
      turn: { id: "turn-3", status: "inProgress", items: [] },
    });
    const driver = makeDriver([first, second, third, fourth]);
    const original = await driver.openSession({
      runId: "run-result-less-terminal",
      normalizedSessionId: "normalized-result-less-terminal",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot).toMatchObject({
      activeTurnId: null,
      semanticResult: null,
      terminalTurns: [{ turnId: "turn-1" }],
    });
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    await expect(recovered!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: false,
      terminalTurns: [{ turnId: "turn-1" }],
    });
    const preStartSnapshot = await recovered!.snapshot();
    await recovered!.close({ reason: "crash before disposition turn submission" });

    const retry = await driver.recoverSession?.(preStartSnapshot);
    const retried = retry?.session;
    expect(retried).toBeDefined();
    await retried!.reconcile?.();
    await expect(retried!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: false,
    });
    const recoveryMessage = "Do not execute twice; report disposition only.";
    const recoveryTerminal = collectUntilTerminal(retried!.events());
    await expect(retried!.startTurn({
      message: { role: "user", text: recoveryMessage },
    })).rejects.toThrow("invalid params");
    await expect(retried!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: false,
    });
    third.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    await expect(retried!.startTurn({
      message: { role: "user", text: recoveryMessage },
    })).resolves.toMatchObject({ turnId: "turn-2" });
    await expect(retried!.snapshot()).resolves.toMatchObject({
      activeTurnId: "turn-2",
      dispositionOnlyRecoveryConsumed: true,
    });
    await expect(retried!.startTurn({
      message: { role: "user", text: "Do not start concurrently." },
    })).rejects.toThrow("session cannot start another turn");
    const recoveryStarts = third.calls.filter(
      (call) => call.method === "turn/start",
    );
    expect(recoveryStarts).toHaveLength(2);
    expect(recoveryStarts[0]!.params.input).toEqual([
      { type: "text", text: recoveryMessage, text_elements: [] },
    ]);
    expect(JSON.stringify(recoveryStarts[0]!.params.input)).not.toContain(
      "Complete.",
    );
    third.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", items: [] },
    });
    await recoveryTerminal;
    const spentSnapshot = await retried!.snapshot();
    expect(spentSnapshot).toMatchObject({
      activeTurnId: null,
      semanticResult: null,
      dispositionOnlyRecoveryConsumed: true,
      terminalTurns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });
    await retried!.close({ reason: "simulate another restart" });

    const repeatedRecovery = await driver.recoverSession?.(spentSnapshot);
    expect(repeatedRecovery?.session).toBeDefined();
    await repeatedRecovery!.session!.reconcile?.();
    await expect(repeatedRecovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: null,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-2",
      terminalTurns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });
    await expect(repeatedRecovery!.session!.startTurn({
      message: { role: "user", text: "Do not retry the completed disposition." },
    })).rejects.toThrow("session cannot start another turn");
    expect(
      fourth.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(0);
    await repeatedRecovery!.session!.close({ reason: "test complete" });
  });

  it("adopts a checkpointed disposition turn before its terminal is durable", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-uncheckpointed-disposition",
      normalizedSessionId: "normalized-uncheckpointed-disposition",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const preDispositionSnapshot = await original.snapshot();
    await original.close({ reason: "simulate crash after provider acceptance" });

    const recovery = await driver.recoverSession?.({
      ...preDispositionSnapshot,
      dispositionOnlyRecoveryConsumed: true,
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: "turn-2",
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-2",
    });
    await expect(recovery!.session!.startTurn({
      message: {
        role: "user",
        text: "Do not duplicate the adopted disposition turn.",
      },
    })).rejects.toThrow("session cannot start another turn");
    expect(
      second.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(0);
    await recovery!.session!.close({ reason: "test complete" });
  });

  for (const testCase of [
    {
      history: "omitted",
      turns: undefined,
      dispositionOnlyRecoveryTurnId: null,
    },
    {
      history: "not an array",
      turns: { unavailable: true },
      dispositionOnlyRecoveryTurnId: "turn-2",
    },
  ]) {
    it(
      `preserves disposition recovery ownership when provider history is ${testCase.history}`,
      async () => {
        const first = new FakeCodexTransport();
        const second = new FakeCodexTransport();
        const thread: Record<string, unknown> = {
          id: "thread-1",
          sessionId: "provider-session-1",
          cwd: WORKSPACE,
        };
        if (testCase.turns !== undefined) thread.turns = testCase.turns;
        second.readResponse = { thread };
        const driver = makeDriver([first, second]);
        const original = await driver.openSession({
          runId: `run-unknown-history-${testCase.history.replaceAll(" ", "-")}`,
          normalizedSessionId:
            `normalized-unknown-history-${testCase.history.replaceAll(" ", "-")}`,
          workingDirectory: WORKSPACE,
        });
        await original.startTurn({
          message: { role: "user", text: "Complete." },
        });
        first.push("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        });
        await collectUntilTerminal(original.events());
        const checkpoint = await original.snapshot();
        await original.close({
          reason: "simulate unavailable provider history",
        });

        const recovery = await driver.recoverSession?.({
          ...checkpoint,
          dispositionOnlyRecoveryConsumed: true,
          dispositionOnlyRecoveryTurnId:
            testCase.dispositionOnlyRecoveryTurnId,
        });
        expect(recovery).toMatchObject({ recovered: true });
        await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
          activeTurnId: null,
          dispositionOnlyRecoveryConsumed: true,
          dispositionOnlyRecoveryTurnId:
            testCase.dispositionOnlyRecoveryTurnId,
        });
        await expect(recovery!.session!.startTurn({
          message: {
            role: "user",
            text: "Do not repeat the task while provider history is unknown.",
          },
        })).rejects.toThrow("session cannot start another turn");
        expect(
          second.calls.filter((call) => call.method === "turn/start"),
        ).toHaveLength(0);
        await recovery!.session!.close({ reason: "test complete" });
      },
    );
  }

  it("preserves disposition recovery ownership when provider history omits the checkpoint terminal", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-2", status: "inProgress", items: [] }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-unanchored-history",
      normalizedSessionId: "normalized-unanchored-history",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({
      message: { role: "user", text: "Complete." },
    });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const checkpoint = await original.snapshot();
    await original.close({ reason: "simulate truncated provider history" });

    const recovery = await driver.recoverSession?.({
      ...checkpoint,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: null,
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: null,
    });
    await expect(recovery!.session!.startTurn({
      message: {
        role: "user",
        text: "Do not duplicate the accepted disposition turn.",
      },
    })).rejects.toThrow("session cannot start another turn");
    expect(
      second.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(0);
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("releases a legacy disposition marker when provider history has no accepted turn", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    second.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-missing-disposition",
      normalizedSessionId: "normalized-missing-disposition",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const checkpoint = await original.snapshot();
    await original.close({ reason: "simulate pre-acceptance checkpoint" });

    const recovery = await driver.recoverSession?.({
      ...checkpoint,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: null,
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: false,
      dispositionOnlyRecoveryTurnId: null,
    });
    await expect(recovery!.session!.startTurn({
      message: { role: "user", text: "Recover disposition only." },
    })).resolves.toMatchObject({ turnId: "turn-2" });
    expect(
      second.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(1);
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("releases a missing bound disposition turn without restoring the task envelope", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    second.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-missing-bound-disposition",
      normalizedSessionId: "normalized-missing-bound-disposition",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const checkpoint = await original.snapshot();
    await original.close({ reason: "simulate missing provider acceptance" });

    const recovery = await driver.recoverSession?.({
      ...checkpoint,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-missing-disposition",
    });
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      dispositionOnlyRecoveryConsumed: false,
      dispositionOnlyRecoveryTurnId: null,
    });
    const recoveryMessage = "Recover disposition only; do not repeat work.";
    await expect(recovery!.session!.startTurn({
      message: { role: "user", text: recoveryMessage },
    })).resolves.toMatchObject({ turnId: "turn-2" });
    const recoveryStarts = second.calls.filter(
      (call) => call.method === "turn/start",
    );
    expect(recoveryStarts).toHaveLength(1);
    expect(recoveryStarts[0]!.params.input).toEqual([
      { type: "text", text: recoveryMessage, text_elements: [] },
    ]);
    expect(JSON.stringify(recoveryStarts[0]!.params.input)).not.toContain(
      "Complete.",
    );
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("fails closed when provider history substitutes a different disposition turn", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-unrelated", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-conflicting-bound-disposition",
      normalizedSessionId: "normalized-conflicting-bound-disposition",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const checkpoint = await original.snapshot();
    await original.close({ reason: "simulate conflicting provider history" });

    await expect(driver.recoverSession?.({
      ...checkpoint,
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-missing-disposition",
    })).resolves.toEqual({
      recovered: false,
      reason: "provider changed the bound disposition recovery turn",
    });
    expect(
      second.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(0);
  });

  it("keeps a newer result-bearing recovery turn active beside an older result-less terminal", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [
          { id: "turn-1", status: "completed", items: [] },
          { id: "turn-2", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-result-recovery-loss",
      normalizedSessionId: "normalized-result-recovery-loss",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await first.invoke({
      id: "result-before-loss",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "result-before-loss",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    if (snapshot.semanticResult === null || snapshot.semanticResult === undefined) {
      throw new Error("expected persisted semantic result");
    }
    snapshot.activeTurnId = "turn-2";
    snapshot.semanticResult = {
      ...snapshot.semanticResult,
      turnId: "turn-2",
    };
    snapshot.terminalTurns![0]!.fingerprint =
      '{"error":null,"result":null,"terminalState":"completed"}';
    await original.close({ reason: "transport lost during recovery turn" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", items: [] },
    });
    const events = await collecting;
    expect(events.at(-1)).toMatchObject({
      eventType: "turn.completed",
      turnId: "turn-2",
    });
    await recovered!.close({ reason: "test complete" });
  });

  it("fails recovery explicitly when the persisted active turn is missing or replaced", async () => {
    for (const testCase of [
      {
        label: "missing",
        turns: [{ id: "turn-old", status: "completed", items: [] }],
        message: "persisted active turn turn-1 is missing",
      },
      {
        label: "replaced",
        turns: [{ id: "turn-2", status: "inProgress", items: [] }],
        message: "active turn turn-2 instead of persisted active turn turn-1",
      },
    ]) {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      second.readResponse = {
        thread: {
          id: "thread-1",
          sessionId: "provider-session-1",
          cwd: WORKSPACE,
          turns: testCase.turns,
        },
      };
      const driver = makeDriver([first, second]);
      const original = await driver.openSession({
        runId: `run-${testCase.label}-turn`,
        normalizedSessionId: `normalized-${testCase.label}-turn`,
        workingDirectory: WORKSPACE,
      });
      await original.startTurn({ message: { role: "user", text: "Work." } });
      const snapshot = await original.snapshot();
      await original.close({ reason: "transport lost" });
      const recovery = await driver.recoverSession?.(snapshot);
      expect(recovery?.session).toBeDefined();
      await expect(
        recovery!.session!.reconcile!(),
      ).rejects.toMatchObject<HarnessReconciliationError>({
        name: "HarnessReconciliationError",
        recoverable: true,
        message: expect.stringContaining(testCase.message),
      });
      await recovery!.session!.close({ reason: "test complete" });
    }
  });

  it("reconciles a turn completed during transport loss without replacing either session identity", async () => {
    const first = new FakeCodexTransport(
      "driver-thread-loss",
      "provider-session-loss",
    );
    const second = new FakeCodexTransport(
      "driver-thread-loss",
      "provider-session-loss",
    );
    second.readResponse = {
      thread: {
        id: "driver-thread-loss",
        sessionId: "provider-session-loss",
        cwd: WORKSPACE,
        tokenUsage: { total: { inputTokens: 21, outputTokens: 8 } },
        turns: [
          {
            id: "turn-1",
            status: "completed",
            items: [
              {
                id: "answer-loss",
                type: "agentMessage",
                text: JSON.stringify(result),
              },
            ],
          },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      workingDirectory: WORKSPACE,
    });
    await original.startTurn({
      message: { role: "user", text: "Work through loss." },
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost before terminal delivery" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    const events = await collecting;

    expect(recovered!.ids()).toEqual({
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
      displayId: "driver-thread-loss",
    });
    expect(await recovered!.snapshot()).toMatchObject({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
    });
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.every(
        (event, index) =>
          event.sourceSeq === snapshot.lastSourceSequence! + index + 1,
      ),
    ).toBe(true);
    expect(await recovered!.usage?.()).toEqual({
      total: { inputTokens: 21, outputTokens: 8 },
    });
  });

});

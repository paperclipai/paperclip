import {
  FakeCodexTransport,
  WORKSPACE,
  collectUntilTerminal,
  describe,
  expect,
  it,
  makeDriver,
  vi,
  type PrpEvent,
} from "./codex-app-server-driver.test-support.js";

describe("Codex driver terminal-turn history replay", () => {
  it.each(["before", "during"] as const)("ignores replayed history for a checkpointed terminal turn %s disposition submission", async (order) => {
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
    let acceptTurnStart!: (value: Record<string, unknown>) => void;
    second.turnStartResponse = new Promise((resolve) => { acceptTurnStart = resolve; });
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-terminal-history-replay",
      normalizedSessionId: "normalized-terminal-history-replay",
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
    await original.close({ reason: "sandbox replaced after result-less terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    const events: PrpEvent[] = [];
    const consume = (async () => {
      for await (const event of recovered!.events()) events.push(event);
    })();
    // A replacement runner can re-deliver the checkpointed turn's committed
    // history before or while the disposition turn is submitted.
    const started = order === "during"
      ? recovered!.startTurn({ message: { role: "user", text: "Report disposition only." } })
      : null;
    if (started) await vi.waitFor(() => expect(second.calls.some((call) => call.method === "turn/start")).toBe(true));
    second.push("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    second.push("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "msg-1", type: "agentMessage", text: "" },
    });
    second.push("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "msg-1",
      delta: "Working",
    });
    second.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "msg-1", type: "agentMessage", text: "Working on it." },
    });
    const command = { id: "cmd-1", type: "commandExecution", command: "ls", status: "completed" };
    second.push("item/started", { threadId: "thread-1", turnId: "turn-1", item: command });
    second.push("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      delta: "file.txt",
    });
    second.push("item/completed", { threadId: "thread-1", turnId: "turn-1", item: command });
    second.push("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [{ step: "Inspect", status: "completed" }],
    });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await vi.waitFor(() => expect(second.queue.values).toHaveLength(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const submission = started
      ?? recovered!.startTurn({ message: { role: "user", text: "Report disposition only." } });
    await vi.waitFor(() => expect(second.calls.some((call) => call.method === "turn/start")).toBe(true));
    acceptTurnStart({ turn: { id: "turn-2", status: "inProgress", items: [] } });
    await expect(submission).resolves.toMatchObject({ turnId: "turn-2" });
    second.push("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", items: [] },
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.eventType === "turn.completed")).toBe(true),
    );
    await recovered!.close({ reason: "test complete" });
    await consume;
    expect(events.some((event) => event.eventType === "session.failed")).toBe(false);
    expect(events.filter((event) => event.turnId === "turn-1")).toEqual([]);
    expect(
      events.filter((event) => event.eventType.startsWith("tool.execution.") || event.eventType === "plan.updated"),
    ).toEqual([]);
    expect(
      events.filter((event) =>
        event.eventType === "harness.diagnostic"
        && event.payload.classification === "restored_terminal_replay"
        && event.payload.receivedTurnId === "turn-1").length,
    ).toBeGreaterThan(0);
    expect(
      events
        .filter((event) => ["turn.started", "turn.completed", "turn.failed"].includes(event.eventType))
        .map((event) => [event.eventType, event.turnId]),
    ).toEqual([["turn.started", "turn-2"], ["turn.completed", "turn-2"]]);
    expect(second.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("still rejects history for a turn that became terminal in the live session", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-live-terminal-replay",
      normalizedSessionId: "normalized-live-terminal-replay",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({ code: "turn_binding_mismatch" });
  });

  it("records a restore-lost turn this session never bound without failing its own turn", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-unbound-restore-loss",
      normalizedSessionId: "normalized-unbound-restore-loss",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Continue." } });
    const lost = {
      threadId: "thread-1",
      turn: { id: "turn-uncheckpointed", status: "failed", items: [],
        error: { code: "provider_turn_lost_on_restore", message: "lost", recoverable: true } },
    };
    transport.push("turn/completed", lost);
    // A replay of the same report stays ignored.
    transport.push("turn/completed", lost);
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(events.find((event) => event.eventType === "session.failed")).toBeUndefined();
    expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(0);
    expect(events.find((event) => event.eventType === "turn.completed")?.turnId).toBe("turn-1");
    expect(events.find((event) => event.eventType === "harness.diagnostic"
      && event.payload.classification === "unbound_restored_turn_lost")?.payload)
      .toMatchObject({ receivedTurnId: "turn-uncheckpointed", expectedTurnId: "turn-1" });
  });

  it.each([
    ["an ordinary failure", { status: "failed", error: { code: "provider_failed", recoverable: false } }],
    ["a completion", { status: "completed" }],
  ])("still rejects %s for a turn this session never bound", async (_label, terminal) => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-unbound-terminal",
      normalizedSessionId: "normalized-unbound-terminal",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Continue." } });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-unknown", items: [], ...terminal },
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(
      events.find((event) => event.eventType === "session.failed")?.payload,
    ).toMatchObject({ code: "turn_binding_mismatch" });
  });
});

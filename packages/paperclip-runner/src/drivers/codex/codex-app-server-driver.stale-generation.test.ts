import {
  FakeCodexTransport,
  WORKSPACE,
  describe,
  expect,
  it,
  makeDriver,
  vi,
  type PrpEvent,
} from "./codex-app-server-driver.test-support.js";

// Section G of the durable-ownership plan: an event that names a turn which
// is not the active turn, and which an earlier session generation accepted or
// this generation already settled, is history. It is recorded and never fails
// the current turn. Runnerd drives Codex, OpenCode and ACPX providers through
// this driver, so the rule covers all three. A turn the session never saw
// still fails closed (codex-app-server-driver.terminal-replay.test.ts).

async function settledThenActive(runId: string, options: { betweenTurns?: boolean } = {}) {
  const transport = new FakeCodexTransport();
  const session = await makeDriver([transport], { conversationMode: "direct" }).openSession({
    runId,
    normalizedSessionId: `normalized-${runId}`,
    workingDirectory: WORKSPACE,
  });
  const events: PrpEvent[] = [];
  const consume = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  await session.startTurn({ message: { role: "user", text: "First." } });
  transport.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } });
  transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
  await vi.waitFor(() => expect(events.some((event) =>
    event.eventType === "turn.completed" && event.turnId === "turn-1")).toBe(true));
  // A late event can arrive before the next turn starts.
  const pushHistory = (method: string, params: Record<string, unknown>) => transport.push(method, { threadId: "thread-1", ...params });
  if (options.betweenTurns) return { transport, session, events, consume, pushHistory };
  transport.turnStartResponse = Promise.resolve({ turn: { id: "turn-2", status: "inProgress", items: [] } });
  await session.startTurn({ message: { role: "user", text: "Second." } });
  transport.push("turn/started", { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } });
  await vi.waitFor(() => expect(events.some((event) =>
    event.eventType === "turn.started" && event.turnId === "turn-2")).toBe(true));
  return { transport, session, events, consume, pushHistory };
}

describe("Codex driver stale-generation events", () => {
  it.each([
    ["an item start", "item/started", { turnId: "turn-1", item: { id: "late-1", type: "agentMessage", text: "" } }],
    ["an item completion", "item/completed", { turnId: "turn-1", item: { id: "late-1", type: "agentMessage", text: "late" } }],
    ["an item update", "item/agentMessage/delta", { turnId: "turn-1", itemId: "late-1", delta: "late" }],
    ["a repeated terminal", "turn/completed", { turn: { id: "turn-1", status: "failed", items: [],
      error: { code: "provider_failed", message: "late", recoverable: false } } }],
    ["a workspace change", "paperclip/workspaceChange/updated", { turnId: "turn-1", changes: [] }],
  ] as const)("records %s for a settled turn as history while the next turn runs", async (_label, method, params) => {
    const { transport, session, events, consume } = await settledThenActive(`stale-${method.replace(/\W+/g, "-")}`);
    transport.push(method, { threadId: "thread-1", ...params });
    transport.push("item/completed", { threadId: "thread-1", turnId: "turn-2",
      item: { id: "current-1", type: "agentMessage", text: "Current work." } });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } });
    await vi.waitFor(() => expect(events.some((event) =>
      event.eventType === "turn.completed" && event.turnId === "turn-2")).toBe(true));
    await session.close({ reason: "test complete" });
    await consume;
    expect(events.find((event) => event.eventType === "session.failed")).toBeUndefined();
    expect(events.filter((event) => event.eventType === "turn.failed")).toEqual([]);
    expect(events.filter((event) => event.turnId === "turn-1" && event.eventType !== "harness.diagnostic")
      .map((event) => event.eventType)).toEqual(["turn.accepted", "turn.started", "turn.completed"]);
    expect(events.find((event) => event.eventType === "harness.diagnostic"
      && event.payload.classification === "stale_generation_event")?.payload)
      .toMatchObject({ receivedTurnId: "turn-1", expectedTurnId: "turn-2" });
  });

  it.each([
    ["an item completion", "item/completed", { turnId: "turn-1", item: { id: "late-1", type: "agentMessage", text: "late" } }],
    ["an item update", "item/agentMessage/delta", { turnId: "turn-1", itemId: "late-1", delta: "late" }],
  ] as const)("records %s for a settled turn as history before the next turn starts", async (_label, method, params) => {
    const { transport, session, events, consume, pushHistory } = await settledThenActive(
      `between-${method.replace(/\W+/g, "-")}`, { betweenTurns: true });
    pushHistory(method, params);
    await vi.waitFor(() => expect(events.some((event) => event.eventType === "harness.diagnostic"
      && event.payload.classification === "stale_generation_event")).toBe(true));
    transport.turnStartResponse = Promise.resolve({ turn: { id: "turn-2", status: "inProgress", items: [] } });
    await session.startTurn({ message: { role: "user", text: "Second." } });
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } });
    await vi.waitFor(() => expect(events.some((event) =>
      event.eventType === "turn.completed" && event.turnId === "turn-2")).toBe(true));
    await session.close({ reason: "test complete" });
    await consume;
    expect(events.find((event) => event.eventType === "session.failed")).toBeUndefined();
    expect(events.find((event) => event.eventType === "harness.diagnostic"
      && event.payload.classification === "stale_generation_event")?.payload)
      .toMatchObject({ receivedTurnId: "turn-1", expectedTurnId: null });
  });

  // A recovered session's checkpointed turns belong to an earlier
  // generation. Their late reports, including a terminal that disagrees with
  // the checkpoint, are history. (A terminal that contradicts a turn this
  // generation settled is still a conflict: semantic-results tests.)
  it("records an earlier generation's late reports as history after recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE,
      turns: [{ id: "turn-1", status: "completed", items: [] }] } };
    const driver = makeDriver([first, second], { conversationMode: "direct" });
    const original = await driver.openSession({ runId: "run-prior-generation",
      normalizedSessionId: "normalized-prior-generation", workingDirectory: WORKSPACE });
    const originalEvents = (async () => { for await (const _event of original.events()) { /* drain */ } })();
    await original.startTurn({ message: { role: "user", text: "First." } });
    first.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    await vi.waitFor(async () => expect((await original.snapshot()).terminalTurns).toEqual([
      expect.objectContaining({ turnId: "turn-1" })]));
    const snapshot = await original.snapshot();
    await original.close({ reason: "controller restarted" });
    await originalEvents;

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    if (!recovered) throw new Error("recovery did not return a session");
    await recovered.reconcile?.();
    const events: PrpEvent[] = [];
    const consume = (async () => { for await (const event of recovered.events()) events.push(event); })();
    second.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "failed", items: [],
      error: { code: "provider_turn_lost_on_restore", message: "lost", recoverable: false } } });
    second.push("item/completed", { threadId: "thread-1", turnId: "turn-1",
      item: { id: "late-1", type: "agentMessage", text: "late" } });
    second.turnStartResponse = Promise.resolve({ turn: { id: "turn-2", status: "inProgress", items: [] } });
    await recovered.startTurn({ message: { role: "user", text: "Second." } });
    second.push("turn/started", { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", items: [] } });
    second.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } });
    await vi.waitFor(() => expect(events.some((event) =>
      event.eventType === "turn.completed" && event.turnId === "turn-2")).toBe(true));
    await recovered.close({ reason: "test complete" });
    await consume;
    expect(events.find((event) => event.eventType === "session.failed")).toBeUndefined();
    expect(events.filter((event) => event.eventType === "turn.failed")).toEqual([]);
    expect(events.some((event) => event.eventType === "harness.diagnostic"
      && ["stale_generation_event", "restored_terminal_replay"].includes(String(event.payload.classification))
      && event.payload.receivedTurnId === "turn-1")).toBe(true);
  });

  // A restore-loss report for a turn this session never bound records that
  // turn as an earlier generation's. Its later activity is history too.
  it("records late activity for a turn reported lost on restore as history", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-restore-lost-activity",
      normalizedSessionId: "normalized-restore-lost-activity",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Continue." } });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-uncheckpointed", status: "failed",
      items: [], error: { code: "provider_turn_lost_on_restore", message: "lost", recoverable: true } } });
    transport.push("item/completed", { threadId: "thread-1", turnId: "turn-uncheckpointed",
      item: { id: "late-1", type: "agentMessage", text: "late" } });
    transport.push("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-uncheckpointed",
      itemId: "late-1", delta: "late" });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.eventType === "turn.completed" || event.eventType === "session.failed") break;
    }
    expect(events.find((event) => event.eventType === "session.failed")).toBeUndefined();
    expect(events.find((event) => event.eventType === "turn.completed")?.turnId).toBe("turn-1");
    expect(events.filter((event) => event.eventType === "harness.diagnostic"
      && event.payload.classification === "stale_generation_event"
      && event.payload.receivedTurnId === "turn-uncheckpointed").length).toBeGreaterThan(0);
  });

  it("still fails closed on a turn the session never saw", async () => {
    const { transport, session, events, consume } = await settledThenActive("stale-unknown");
    transport.push("item/completed", { threadId: "thread-1", turnId: "turn-foreign",
      item: { id: "foreign-1", type: "agentMessage", text: "foreign" } });
    await consume;
    await session.close({ reason: "test complete" }).catch(() => undefined);
    expect(events.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "turn_binding_mismatch" });
  });
});

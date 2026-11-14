import {
  FakeCodexTransport,
  HarnessOperationAlreadyTerminalError,
  HarnessStaleTurnError,
  WORKSPACE,
  collectUntilTerminal,
  describe,
  expect,
  it,
  makeDriver,
  result,
} from "./codex-app-server-driver.test-support.js";
import { RUNNERD_RUN_TERMINAL } from "./codex-driver-values.js";

async function completedFirstTurn(awaiting: boolean) {
  const transport = new FakeCodexTransport();
  const session = await makeDriver([transport]).openSession({
    runId: "provider-turn", normalizedSessionId: "provider-turn-session", workingDirectory: WORKSPACE,
  });
  await session.startTurn({ message: { role: "user", text: "Start a background install." } });
  transport.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
  transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] },
    ...(awaiting ? { awaitingProviderTurn: true } : {}) });
  const events = session.events()[Symbol.asyncIterator]();
  const first = await collectUntilTerminal({ [Symbol.asyncIterator]: () => events });
  return { transport, session, events, first };
}

async function restoredAfterFirstTurn(awaiting: boolean) {
  const first = new FakeCodexTransport();
  const second = new FakeCodexTransport();
  const driver = makeDriver([first, second]);
  const original = await driver.openSession({
    runId: "provider-turn", normalizedSessionId: "provider-turn-session", workingDirectory: WORKSPACE,
  });
  await original.startTurn({ message: { role: "user", text: "Start a background install." } });
  first.push("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
  first.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] },
    ...(awaiting ? { awaitingProviderTurn: true } : {}) });
  await collectUntilTerminal(original.events());
  const checkpoint = await original.snapshot();
  await original.close({ reason: "controller restarted" });
  second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE,
    turns: [{ id: "turn-1", status: "completed", items: [] }] } };
  const recovery = await driver.recoverSession!(checkpoint);
  expect(recovery).toMatchObject({ recovered: true });
  const session = recovery.session!;
  return { transport: second, session, checkpoint, events: session.events()[Symbol.asyncIterator]() };
}

async function reconciledActiveTurn(awaiting: boolean) {
  const first = new FakeCodexTransport();
  const second = new FakeCodexTransport();
  const driver = makeDriver([first, second]);
  const original = await driver.openSession({
    runId: "provider-turn", normalizedSessionId: "provider-turn-session", workingDirectory: WORKSPACE,
  });
  await original.startTurn({ message: { role: "user", text: "Start a background install." } });
  const checkpoint = await original.snapshot();
  expect(checkpoint.activeTurnId).toBe("turn-1");
  await original.close({ reason: "controller restarted" });
  second.readResponse = { thread: { id: "thread-1", sessionId: "provider-session-1", cwd: WORKSPACE,
    turns: [{ id: "turn-1", status: "completed", items: [], ...(awaiting ? { awaitingProviderTurn: true } : {}) }] } };
  const recovery = await driver.recoverSession!(checkpoint);
  expect(recovery).toMatchObject({ recovered: true });
  const session = recovery.session!;
  return { transport: second, session, events: session.events()[Symbol.asyncIterator]() };
}

async function nextUntil(events: AsyncIterator<{ eventType: string; payload: Record<string, unknown> }>, done: (eventType: string) => boolean) {
  const collected: Array<{ eventType: string; payload: Record<string, unknown>; turnId?: string }> = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return collected;
    collected.push(next.value);
    if (done(next.value.eventType)) return collected;
  }
}

describe("Codex app-server driver with provider-started turns", () => {
  it("marks an awaited terminal and adopts the provider's own next turn with its result", async () => {
    const { transport, session, events, first } = await completedFirstTurn(true);
    expect(first.at(-1)).toMatchObject({ eventType: "turn.completed", payload: { status: "completed", awaitingProviderTurn: true } });
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    transport.push("paperclip/runResult", { threadId: "thread-1", turnId: "provider-1", result });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "provider-1", status: "completed", items: [] } });
    const second = await nextUntil(events, eventType => eventType === "turn.completed");
    expect(second.some(event => event.eventType === "session.failed")).toBe(false);
    expect(second.find(event => event.eventType === "turn.started")).toMatchObject({ turnId: "provider-1", payload: { origin: "provider" } });
    expect(second.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: "provider-1" });
    expect(second.at(-1)!.payload).not.toHaveProperty("awaitingProviderTurn");
    expect((await session.snapshot()).semanticResult).toMatchObject({ result, turnId: "provider-1" });
    await session.close({ reason: "fixture complete" });
  });

  it("still fails closed on a provider-started turn the Runner did not await", async () => {
    const { transport, session, events, first } = await completedFirstTurn(false);
    expect(first.at(-1)!.payload).not.toHaveProperty("awaitingProviderTurn");
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const failed = await nextUntil(events, eventType => eventType === "session.failed");
    expect(failed.at(-1)).toMatchObject({ eventType: "session.failed", payload: { code: "turn_binding_mismatch" } });
    await session.close({ reason: "fixture complete" }).catch(() => undefined);
  });

  it("acknowledges an interrupt during the wait without sending one to the provider", async () => {
    const { transport, session, events } = await completedFirstTurn(true);
    await session.interrupt!({ reason: "Stop" });
    const acknowledged = await nextUntil(events, eventType => eventType === "item.completed");
    expect(acknowledged.at(-1)).toMatchObject({ payload: { kind: "interrupt_acknowledgement", status: "provider_turn_wait_ended" } });
    expect(transport.calls.some(request => request.method === "turn/interrupt")).toBe(false);
    await session.close({ reason: "fixture complete" });
  });

  it("never interrupts a running provider-started turn for the wait's own end", async () => {
    const { transport, session, events } = await completedFirstTurn(true);
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    await nextUntil(events, eventType => eventType === "turn.started");
    await expect(session.interrupt!({ turnId: "turn-1", reason: "cap" })).rejects.toBeInstanceOf(HarnessStaleTurnError);
    expect(transport.calls.some(request => request.method === "turn/interrupt")).toBe(false);
    await session.close({ reason: "fixture complete" });
  });

  it("ends the wait on the Runner's run.terminal only while awaiting with no turn, and ignores a forged one", async () => {
    const forged = await completedFirstTurn(true);
    forged.transport.push("paperclip/runTerminal", { threadId: "thread-1" });
    forged.transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const untouched = await nextUntil(forged.events, eventType => eventType === "turn.started");
    expect(untouched.some(event => event.payload.kind === "interrupt_acknowledgement")).toBe(false);
    await forged.session.close({ reason: "fixture complete" });

    const awaiting = await completedFirstTurn(true);
    awaiting.transport.push("paperclip/runTerminal", { [RUNNERD_RUN_TERMINAL]: true, threadId: "thread-1" });
    const ended = await nextUntil(awaiting.events, eventType => eventType === "item.completed");
    expect(ended.filter(event => event.payload.kind === "interrupt_acknowledgement")).toHaveLength(1);
    expect(ended.at(-1)).toMatchObject({ payload: { kind: "interrupt_acknowledgement", status: "provider_turn_wait_ended", cause: "run_terminal" } });
    expect(await awaiting.session.snapshot()).not.toHaveProperty("awaitingProviderTurn");
    awaiting.transport.push("paperclip/runTerminal", { [RUNNERD_RUN_TERMINAL]: true, threadId: "thread-1" });
    awaiting.transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const afterSecond = await nextUntil(awaiting.events, eventType => eventType === "session.failed");
    expect(afterSecond.some(event => event.payload.kind === "interrupt_acknowledgement")).toBe(false);
    await awaiting.session.close({ reason: "fixture complete" }).catch(() => undefined);

    const ordinary = await completedFirstTurn(false);
    ordinary.transport.push("paperclip/runTerminal", { [RUNNERD_RUN_TERMINAL]: true, threadId: "thread-1" });
    ordinary.transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const after = await nextUntil(ordinary.events, eventType => eventType === "session.failed");
    expect(after.some(event => event.payload.kind === "interrupt_acknowledgement")).toBe(false);
    await ordinary.session.close({ reason: "fixture complete" }).catch(() => undefined);
  });

  it("keeps the wait across a controller restart and adopts the provider's own next turn", async () => {
    const { transport, session, checkpoint, events } = await restoredAfterFirstTurn(true);
    expect(checkpoint).toMatchObject({ activeTurnId: null, semanticResult: null, awaitingProviderTurn: true });
    expect(await session.snapshot()).toMatchObject({ awaitingProviderTurn: true });
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    transport.push("paperclip/runResult", { threadId: "thread-1", turnId: "provider-1", result });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "provider-1", status: "completed", items: [] } });
    const adopted = await nextUntil(events, eventType => eventType === "turn.completed" || eventType === "session.failed");
    expect(adopted.some(event => event.eventType === "session.failed")).toBe(false);
    expect(adopted.find(event => event.eventType === "turn.started")).toMatchObject({ turnId: "provider-1", payload: { origin: "provider" } });
    expect(adopted.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: "provider-1" });
    const settled = await session.snapshot();
    expect(settled.semanticResult).toMatchObject({ result, turnId: "provider-1" });
    expect(settled).not.toHaveProperty("awaitingProviderTurn");
    await session.close({ reason: "fixture complete" });
  });

  it("marks a persisted active turn that a restart reconciles as awaiting, then adopts the provider's own next turn", async () => {
    const { transport, session, events } = await reconciledActiveTurn(true);
    const reconciled = await nextUntil(events, eventType => eventType === "turn.completed");
    expect(reconciled.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: "turn-1",
      payload: { status: "completed", awaitingProviderTurn: true } });
    expect(await session.snapshot()).toMatchObject({ activeTurnId: null, semanticResult: null, awaitingProviderTurn: true });
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    transport.push("paperclip/runResult", { threadId: "thread-1", turnId: "provider-1", result });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "provider-1", status: "completed", items: [] } });
    const adopted = await nextUntil(events, eventType => eventType === "turn.completed" || eventType === "session.failed");
    expect(adopted.some(event => event.eventType === "session.failed")).toBe(false);
    expect(adopted.find(event => event.eventType === "turn.started")).toMatchObject({ turnId: "provider-1", payload: { origin: "provider" } });
    expect(adopted.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: "provider-1" });
    expect((await session.snapshot()).semanticResult).toMatchObject({ result, turnId: "provider-1" });
    await session.close({ reason: "fixture complete" });
  });

  it("reconciles an unmarked persisted active turn as an ordinary terminal", async () => {
    const { transport, session, events } = await reconciledActiveTurn(false);
    const reconciled = await nextUntil(events, eventType => eventType === "turn.completed");
    expect(reconciled.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: "turn-1" });
    expect(reconciled.at(-1)!.payload).not.toHaveProperty("awaitingProviderTurn");
    expect(await session.snapshot()).not.toHaveProperty("awaitingProviderTurn");
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const failed = await nextUntil(events, eventType => eventType === "session.failed");
    expect(failed.at(-1)).toMatchObject({ eventType: "session.failed", payload: { code: "turn_binding_mismatch" } });
    await session.close({ reason: "fixture complete" }).catch(() => undefined);
  });

  it("writes no wait marker in a snapshot taken outside a wait", async () => {
    const ordinary = await completedFirstTurn(false);
    expect(await ordinary.session.snapshot()).not.toHaveProperty("awaitingProviderTurn");
    await ordinary.session.close({ reason: "fixture complete" });
    const opened = await makeDriver([new FakeCodexTransport()]).openSession({
      runId: "provider-turn", normalizedSessionId: "provider-turn-session", workingDirectory: WORKSPACE,
    });
    expect(await opened.snapshot()).not.toHaveProperty("awaitingProviderTurn");
    await opened.close({ reason: "fixture complete" });
  });

  it("still fails closed on a provider-started turn after a restore with no wait", async () => {
    const { transport, session, checkpoint, events } = await restoredAfterFirstTurn(false);
    expect(checkpoint).not.toHaveProperty("awaitingProviderTurn");
    transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const failed = await nextUntil(events, eventType => eventType === "session.failed");
    expect(failed.at(-1)).toMatchObject({ eventType: "session.failed", payload: { code: "turn_binding_mismatch" } });
    await session.close({ reason: "fixture complete" }).catch(() => undefined);
  });

  it("acknowledges an interrupt during a restored wait without sending one to the provider", async () => {
    const { transport, session, events } = await restoredAfterFirstTurn(true);
    await session.interrupt!({ reason: "Stop" });
    let acknowledged = await events.next();
    while (!acknowledged.done && acknowledged.value.payload.kind !== "interrupt_acknowledgement") acknowledged = await events.next();
    expect(acknowledged.value).toMatchObject({ payload: { kind: "interrupt_acknowledgement", status: "provider_turn_wait_ended" } });
    expect(transport.calls.some(request => request.method === "turn/interrupt")).toBe(false);
    await session.close({ reason: "fixture complete" });
  });

  it("keeps rejecting an interrupt after a terminal that does not await", async () => {
    const { session } = await completedFirstTurn(false);
    await expect(session.interrupt!({ reason: "Stop" })).rejects.toBeInstanceOf(HarnessOperationAlreadyTerminalError);
    await session.close({ reason: "fixture complete" });
  });
});

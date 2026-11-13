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
    await awaiting.session.close({ reason: "fixture complete" });

    const ordinary = await completedFirstTurn(false);
    ordinary.transport.push("paperclip/runTerminal", { [RUNNERD_RUN_TERMINAL]: true, threadId: "thread-1" });
    ordinary.transport.push("turn/started", { threadId: "thread-1", turn: { id: "provider-1", status: "inProgress" }, origin: "provider" });
    const after = await nextUntil(ordinary.events, eventType => eventType === "session.failed");
    expect(after.some(event => event.payload.kind === "interrupt_acknowledgement")).toBe(false);
    await ordinary.session.close({ reason: "fixture complete" }).catch(() => undefined);
  });

  it("keeps rejecting an interrupt after a terminal that does not await", async () => {
    const { session } = await completedFirstTurn(false);
    await expect(session.interrupt!({ reason: "Stop" })).rejects.toBeInstanceOf(HarnessOperationAlreadyTerminalError);
    await session.close({ reason: "fixture complete" });
  });
});

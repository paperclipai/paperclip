import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteAuthorityStore } from "../../control-plane/sqlite-authority-store.js";
import { applyNormalizedBatch, acknowledgeNormalizedEvent, type NormalizedDeliveryState, type NormalizedDeliveryPort } from "../../control-plane/normalized-delivery.js";
import { FakeCodexTransport, makeDriver, WORKSPACE, type PrpEvent } from "./codex-app-server-driver.test-support.js";

it.each([undefined, 4])("recovers a pending question from SQLite with normalized epoch limit %s without enumerating provider history", async limit => {
  const root = await mkdtemp(join(tmpdir(), "codex-normalizer-"));
  const config = { path: join(root, "consumer.sqlite"), binding: "test-normalized-consumer", create: true };
  let store = await SqliteAuthorityStore.open(config);
  let current: NormalizedDeliveryState | null = null;
  let generation = "0";
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action); tail = result.catch(() => undefined); return result;
  };
  const port: NormalizedDeliveryPort = {
    epoch: "run-1",
    ...(limit ? { eventEpochs: { limit } } : {}),
    load: () => structuredClone(current),
    commit: (batch) => serialize(async () => {
      const candidate = applyNormalizedBatch(current, batch);
      generation = await store.commit({ expectedGeneration: generation, state: { consumer: candidate }, records: [] });
      current = candidate;
      return structuredClone(candidate);
    }),
    acknowledge: (event) => serialize(async () => {
      const candidate = acknowledgeNormalizedEvent(current!, event);
      generation = await store.commit({ expectedGeneration: generation, state: { consumer: candidate }, records: [] });
      current = candidate;
    }),
  };
  class Transport extends FakeCodexTransport { normalizedDelivery() { return port; } }
  const first = new Transport(), second = new Transport();
  const driver = makeDriver([first, second]);
  try {
    const session = await driver.openSession({ runId: "run-1", normalizedSessionId: "session-1", workingDirectory: WORKSPACE });
    const written: PrpEvent[] = [];
    session.setEventCommitter!(async (event) => { written.push(event); });
    await session.startTurn({ message: { text: "Work" } });
    await session.flushEventDelivery!();
    const checkpointBeforeRawDelivery = await session.snapshot();
    first.queue.push({ method: "paperclip/runtimeRequest", params: { request: {
      id: "question-1", method: "item/tool/requestUserInput", params: {
        threadId: "thread-1", turnId: "turn-1", questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "Blue", description: "Blue" }, { label: "Red", description: "Red" }] }],
      },
    } }, paperclipDelivery: { epoch: "run-1", sourceSeq: 1, ordinal: 1 } });
    await vi.waitFor(() => expect(port.load()?.raw).toEqual({ epoch: "run-1", sourceSeq: 1, ordinal: 1 }));
    const pending = port.load()!.pending;
    if (limit) expect(port.load()!.producedEpoch).toBeTruthy();
    expect(pending.some((event) => event.eventType === "runtime_request.created")).toBe(true);
    // Simulate the controller disappearing after mapping but before append.
    // The fake provider remains; no close/cancellation is sent to it.
    first.queue.close();
    await tail; await store.close();
    store = await SqliteAuthorityStore.open({ ...config, create: false });
    const restored = (await store.load())!;
    generation = restored.generation;
    current = restored.state.consumer as unknown as NormalizedDeliveryState;
    const recovery = await driver.recoverSession(checkpointBeforeRawDelivery, { signal: new AbortController().signal });
    expect(recovery.recovered).toBe(true);
    const recovered = recovery.session!;
    expect(second.calls.some((call) => call.method === "thread/turns/list" || call.method === "thread/items/list")).toBe(false);
    expect(recovered.pendingRuntimeRequests!().map((request) => request.requestId)).toEqual(["question-1"]);
    const reader = recovered.events()[Symbol.asyncIterator]();
    for (const expected of pending) {
      const actual = (await reader.next()).value!;
      expect(actual).toEqual(expected);
      await recovered.acknowledgeEvent!(actual);
    }
    expect(port.load()!.pending).toEqual([]);
    recovered.setEventCommitter!(async (event) => { written.push(event); });
    await recovered.resolveRuntimeRequest!({ requestId: "question-1", turnId: "turn-1", resolution: { action: "submit", answers: { color: { answers: ["Blue"] } } } });
    await recovered.flushEventDelivery!();
    expect(recovered.pendingRuntimeRequests!()).toEqual([]);
    expect(written.filter((event) => event.eventType === "runtime_request.resolved")).toHaveLength(1);
    await recovered.close({ reason: "test complete" });
  } finally {
    first.queue.close(); second.queue.close(); await tail; await store.close(); await rm(root, { recursive: true, force: true });
  }
});

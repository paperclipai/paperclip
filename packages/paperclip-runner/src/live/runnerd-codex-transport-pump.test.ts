import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeTransportPump, type ReadableEvent, type TransportPumpProbe } from "../../test/support/transport-pump-probe.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// A live transport used to look for committed events every 5 ms for as long as
// it was open, so a dozen open sessions kept the server's main thread busy
// with nothing to deliver, and every event waited for the next tick.
const fixture = resolve(import.meta.dirname, "../../test/fixtures/fake-paced-codex-app-server.mjs");
const DELTAS = 40;

async function openTransport(
  persistence: "file" | "external",
  onReadable?: (event: ReadableEvent) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-transport-pump-"));
  let probe: TransportPumpProbe | null = null;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: process.execPath,
    codexArgs: [fixture, String(DELTAS), "15"],
    environment: {},
    stateDirectory: join(root, "session"),
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    controlPlaneRegistration: async (core) => {
      probe = probeTransportPump(core, persistence, onReadable);
      return probe.registration();
    },
  });
  try {
    await bundle.transport.request("thread/start", { cwd: root, model: "fixture-no-model", dynamicTools: [] });
  } catch (error) {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    transport: bundle.transport,
    probe: probe!,
    async close() {
      await bundle.transport.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.each(["file", "external"] as const)("runnerd transport event pump with %s persistence", (persistence) => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops looking for events while an open session has none to deliver", async () => {
    const session = await openTransport(persistence);
    try {
      const before = session.probe.stateReads();
      await new Promise((elapsed) => setTimeout(elapsed, 2_000));
      // The 5 ms poll took the state several hundred times a second. Without
      // it, only the tail of session startup reads the state in this window.
      expect(session.probe.stateReads() - before).toBeLessThan(100);

      // The quiet session still delivers the first event that arrives.
      const notifications = session.transport.notifications()[Symbol.asyncIterator]();
      await session.transport.request("turn/start", { input: [{ type: "text", text: "Stream the paced fixture." }] });
      for (;;) {
        const next = await notifications.next();
        expect(next.done).not.toBe(true);
        if (next.value.method === "turn/completed") break;
      }
    } finally {
      await session.close();
    }
  }, 30_000);

  it("delivers each committed event in the next task, without a timer tick", async () => {
    // No interval ever fires in this test, so nothing here can be delivered by
    // a periodic poll.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // The control plane wakes the transport before this probe sees the event,
    // so a task queued here runs after the transport's delivery task. That
    // order does not depend on the host's speed.
    const overtaken = new Set<number>();
    const pending = new Map<number, NodeJS.Immediate>();
    const session = await openTransport(persistence, (event) => {
      if (event.eventType !== "item.delta") return;
      pending.set(event.sourceSeq, setImmediate(() => {
        pending.delete(event.sourceSeq);
        overtaken.add(event.sourceSeq);
      }));
    });
    try {
      const notifications = session.transport.notifications()[Symbol.asyncIterator]();
      await session.transport.request("turn/start", { input: [{ type: "text", text: "Stream the paced fixture." }] });
      // Events committed before this point can wait for the start response.
      const startAnswered = performance.now();
      const deliveredInOrder: boolean[] = [];
      let completed = false;
      let stalled: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => {
          for (;;) {
            const next = await notifications.next();
            if (next.done) return;
            if (next.value.method === "item/agentMessage/delta") {
              const event = session.probe.readable.filter((candidate) => candidate.eventType === "item.delta")[deliveredInOrder.length]!;
              clearImmediate(pending.get(event.sourceSeq));
              pending.delete(event.sourceSeq);
              deliveredInOrder.push(event.at < startAnswered || !overtaken.has(event.sourceSeq));
            }
            if (next.value.method === "turn/completed") {
              completed = true;
              return;
            }
          }
        })(),
        new Promise<void>((elapsed) => { stalled = setTimeout(elapsed, 10_000); }),
      ]);
      clearTimeout(stalled);

      expect(completed, "the turn's events were delivered without a periodic poll").toBe(true);
      expect(deliveredInOrder).toHaveLength(DELTAS);
      expect(deliveredInOrder.every(Boolean), "every event was delivered in the task after it became readable").toBe(true);
      // The assertion above covers the events streamed after the start response.
      expect(session.probe.readable.some((event) => event.eventType === "item.delta" && event.at >= startAnswered)).toBe(true);
    } finally {
      for (const task of pending.values()) clearImmediate(task);
      vi.useRealTimers();
      await session.close();
    }
  }, 30_000);
});

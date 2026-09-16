import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect, it } from "vitest";
import { DurableCoreStore } from "./durable-prp-control-plane.js";
import type { DurableRecoveryCommittedEvent } from "./prp-transport-types.js";

// Opt-in local I/O measurement, without network access or a model invocation.
// Host contention affects timing; recovery assertions are not optional.
it.skipIf(process.env.PAPERCLIP_CORE_STORE_BENCHMARK !== "1")(
  "measures event persistence with a full 4096-event recovery window",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-core-store-benchmark-"));
    const identity = {
      runnerInstanceId: "benchmark-runner", environmentLeaseId: "benchmark-lease",
      runId: "benchmark-run", normalizedSessionId: "benchmark-session",
      turnId: "benchmark-turn", itemId: "benchmark-item",
    };
    const event = (seq: number): DurableRecoveryCommittedEvent => ({
      sourceSeq: seq, sourceEventId: `event-${seq}`, eventType: "item.delta", priority: 2,
      envelope: { payload: { text: "synthetic delta ".repeat(100), seq } },
      deliveryCount: 1, logicalEffectCount: 1,
    });
    const lag = monitorEventLoopDelay({ resolution: 1 });
    try {
      const store = new DurableCoreStore(root, identity);
      store.mutableState.committedEvents = Array.from({ length: 4096 }, (_, i) => event(i + 1));
      store.mutableState.ackedSourceSeq = 4096;
      await store.saveEvent();
      lag.enable();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const start = performance.now();
      const cpu = process.cpuUsage();
      for (let seq = 4097; seq <= 4216; seq++) {
        store.beginEventUpdate();
        store.mutableState.committedEvents.shift();
        store.mutableState.committedEvents.push(event(seq));
        store.mutableState.ackedSourceSeq = seq;
        await store.saveEvent();
      }
      const elapsedMs = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      lag.disable();
      const recovered = new DurableCoreStore(root, identity).state;
      expect(recovered.ackedSourceSeq).toBe(4216);
      expect(recovered.committedEvents).toHaveLength(4096);
      expect(recovered.committedEvents[0]).toEqual(event(121));
      expect(recovered.committedEvents.at(-1)).toEqual(event(4216));
      console.log(JSON.stringify({
        benchmark: "durable-core-store-full-window", events: 120, window: 4096,
        elapsedMs, cpuMs: (usage.user + usage.system) / 1000,
        eventLoopMaxMs: lag.max / 1e6, eventLoopP99Ms: lag.percentile(99) / 1e6,
        bytes: statSync(store.path).size, recoveryVerified: true,
      }));
    } finally {
      lag.disable();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000,
);

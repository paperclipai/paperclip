import { writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createLiveEventDelivery, LIVE_DELIVERY_MAX_BYTES, LIVE_DELIVERY_MAX_ITEMS } from "./live-event-delivery.js";

it("bounds presentation cost for the same output with zero, one, multiple and congested viewers", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const source = Array.from({ length: 1_024 }, (_, index): LiveEvent => Object.freeze({
    id: index + 1, companyId: "company", type: "heartbeat.run.log", createdAt: "2026-10-24T00:00:00Z",
    payload: Object.freeze({ runId: "run", agentId: "agent", seq: index + 1, chunk: "x".repeat(2_048) }),
  }));
  const reports = [];
  try {
    for (const scenario of [{ name: "zero-interests", viewers: 1, interested: false, slow: false },
      { name: "one-viewer", viewers: 1, interested: true, slow: false },
      { name: "three-browsers", viewers: 3, interested: true, slow: false },
      { name: "slow-viewer", viewers: 1, interested: true, slow: true }]) {
      let bytes = 0, transcripts = 0, authorizationReads = 0, peakItems = 0, peakBytes = 0;
      const latencies: number[] = [];
      const enqueued = new Map<number, number>();
      const deliveries = Array.from({ length: scenario.viewers }, () => {
        const socket = { readyState: 1, bufferedAmount: 0,
          send(data: string, callback?: (error?: Error) => void) {
            bytes += Buffer.byteLength(data);
            const frame = JSON.parse(data) as LiveEvent;
            if (frame.type === "heartbeat.run.log") {
              transcripts += 1;
              latencies.push(performance.now() - enqueued.get(frame.id)!);
            }
            if (scenario.slow) socket.bufferedAmount += Buffer.byteLength(data);
            else callback?.();
          }, close() { socket.readyState = 3; },
        };
        const delivery = createLiveEventDelivery({ socket,
          authorize: async event => { authorizationReads += 1; return event; }, decorate: async event => event,
          onError: error => { throw error; },
        });
        delivery.receive(JSON.stringify({ type: "live.interests", version: 1, revision: 1, runIds: scenario.interested ? ["run"] : [] }));
        return delivery;
      });
      const cpu = process.cpuUsage(), memory = process.memoryUsage().heapUsed, started = performance.now();
      try {
        for (const event of source) {
          enqueued.set(event.id, performance.now());
          for (const delivery of deliveries) {
            delivery.enqueue(event);
            const metrics = delivery.metrics();
            peakItems = Math.max(peakItems, metrics.retainedItems);
            peakBytes = Math.max(peakBytes, metrics.retainedBytes);
          }
          if (event.id % 16 === 0) await setImmediate();
        }
        await setImmediate();
        const used = process.cpuUsage(cpu);
        latencies.sort((a, b) => a - b);
        reports.push({ scenario: scenario.name, sourceEvents: source.length, connections: scenario.viewers,
          transcripts, wireBytes: bytes, authorizationCallbacks: authorizationReads, peakRetainedItems: peakItems,
          peakRetainedBytes: peakBytes, resyncRequired: deliveries.some(delivery => delivery.metrics().needsResync),
          elapsedMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000,
          heapDeltaBytes: process.memoryUsage().heapUsed - memory,
          deliveryP95Ms: latencies[Math.floor(latencies.length * 0.95)] ?? null });
        expect(peakItems).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_ITEMS);
        expect(peakBytes).toBeLessThanOrEqual(LIVE_DELIVERY_MAX_BYTES);
        if (!scenario.interested) { expect(transcripts).toBe(0); expect(authorizationReads).toBe(1); }
        else if (!scenario.slow) expect(transcripts).toBe(source.length * scenario.viewers);
        else expect(deliveries[0].metrics().needsResync).toBe(true);
      } finally { for (const delivery of deliveries) delivery.dispose(); }
    }
    const report = { schema: "paperclip.live-delivery-cost/v1", scope: "in-process presentation boundary; simulated socket congestion",
      sqlMeasured: false, networkMeasured: false, timingAndMemoryAreDiagnostic: true, reports };
    if (process.env.PAPERCLIP_LIVE_DELIVERY_COST_REPORT) await writeFile(process.env.PAPERCLIP_LIVE_DELIVERY_COST_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    expect(source.every(event => event.payload.chunk === "x".repeat(2_048))).toBe(true);
  } finally { now.mockRestore(); }
});

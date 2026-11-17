import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { probeTransportPump, type TransportPumpProbe } from "../../test/support/transport-pump-probe.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// Opt in explicitly. Run from packages/paperclip-runner:
// PAPERCLIP_TRANSPORT_PUMP_BENCHMARK=1 pnpm exec vitest run src/live/runnerd-transport-pump.benchmark.test.ts
// PAPERCLIP_TRANSPORT_PUMP_SESSIONS (default 12) sets how many transports stay open.
// PAPERCLIP_TRANSPORT_PUMP_DELTAS (default 40) sets how many events each turn
// streams, and so how many committed events each session retains afterwards.
//
// It opens that many real transports against runnerd and a credential-free
// provider fixture, then reports two things for each persistence mode:
// - what the open transports cost the main thread while nothing arrives, and
// - how long a committed event waits before the transport delivers it.
// This is a local measurement that shares the host's background load, not a
// CPU-isolated assertion; only delivery itself is asserted.
const enabled = process.env.PAPERCLIP_TRANSPORT_PUMP_BENCHMARK === "1";
const sessions = Number(process.env.PAPERCLIP_TRANSPORT_PUMP_SESSIONS ?? "12");
const deltas = Number(process.env.PAPERCLIP_TRANSPORT_PUMP_DELTAS ?? "40");
if (enabled && (!Number.isInteger(sessions) || sessions < 1 || sessions > 32)) {
  throw new Error("transport_pump_sessions_must_be_between_1_and_32");
}
if (enabled && (!Number.isInteger(deltas) || deltas < 1 || deltas > 512)) {
  throw new Error("transport_pump_deltas_must_be_between_1_and_512");
}
const fixture = resolve(import.meta.dirname, "../../test/fixtures/fake-paced-codex-app-server.mjs");
const DELTA_INTERVAL_MS = 15;
const IDLE_SETTLE_MS = 1_500;
const IDLE_WINDOW_MS = 3_000;

const percentile = (sorted: number[], fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
const round = (value: number) => Math.round(value * 1_000) / 1_000;

it.skipIf(!enabled).each(["file", "external"] as const)(
  "measures idle pump cost and delivery wait with %s persistence",
  async (persistence) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-transport-pump-benchmark-"));
    const open: Array<{
      bundle: ReturnType<typeof createCapabilityRunnerdCodexTransport>;
      probe: () => TransportPumpProbe;
    }> = [];
    const measureIdle = async () => {
      await new Promise((settled) => setTimeout(settled, IDLE_SETTLE_MS));
      const reads = () => open.reduce((total, session) => total + session.probe().stateReads(), 0);
      const readsBefore = reads();
      const cpuBefore = process.cpuUsage();
      const loopBefore = performance.eventLoopUtilization();
      const started = performance.now();
      await new Promise((elapsed) => setTimeout(elapsed, IDLE_WINDOW_MS));
      const seconds = (performance.now() - started) / 1_000;
      const loop = performance.eventLoopUtilization(loopBefore);
      const cpu = process.cpuUsage(cpuBefore);
      return {
        seconds: round(seconds),
        stateReadsPerSessionPerSecond: round((reads() - readsBefore) / seconds / sessions),
        eventLoopUtilization: round(loop.utilization),
        cpuMsPerSecond: round((cpu.user + cpu.system) / 1_000 / seconds),
      };
    };
    try {
      for (let index = 0; index < sessions; index += 1) {
        let probe: TransportPumpProbe | null = null;
        const bundle = createCapabilityRunnerdCodexTransport({
          runnerBinary: defaultCapabilityRunnerdBinary(),
          codexCommand: process.execPath,
          codexArgs: [fixture, String(deltas), String(DELTA_INTERVAL_MS)],
          environment: {},
          stateDirectory: join(root, `session-${index}`),
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
          controlPlaneRegistration: async (core) => {
            probe = probeTransportPump(core, persistence);
            return probe.registration();
          },
        });
        open.push({ bundle, probe: () => probe! });
        await bundle.transport.request("thread/start", { cwd: root, model: "fixture-no-model", dynamicTools: [] });
      }

      // Idle: every session is open and connected, and no event arrives.
      const idleFresh = await measureIdle();

      // Streaming: every session runs one paced turn at the same time.
      const waits: number[] = [];
      const terminalWaits: number[] = [];
      await Promise.all(open.map(async ({ bundle, probe }) => {
        const delivered: number[] = [];
        let terminalAt: number | null = null;
        const notifications = bundle.transport.notifications()[Symbol.asyncIterator]();
        await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Stream the paced fixture." }] });
        for (;;) {
          const next = await notifications.next();
          if (next.done) throw new Error("transport_pump_stream_ended_without_terminal");
          if (next.value.method === "item/agentMessage/delta") delivered.push(performance.now());
          if (next.value.method === "turn/completed") {
            terminalAt = performance.now();
            break;
          }
        }
        const readable = probe().readable;
        const streamed = readable.filter((event) => event.eventType === "item.delta");
        const terminal = readable.find((event) => event.eventType === "turn.completed");
        expect(delivered).toHaveLength(deltas);
        expect(streamed).toHaveLength(deltas);
        expect(terminal).toBeDefined();
        streamed.forEach((event, index) => waits.push(delivered[index]! - event.at));
        terminalWaits.push(terminalAt! - terminal!.at);
      }));
      waits.sort((left, right) => left - right);
      terminalWaits.sort((left, right) => left - right);

      // Idle again: each session now retains the turn's committed events.
      const idleAfterTurn = await measureIdle();

      process.stdout.write(`TRANSPORT_PUMP_BENCHMARK ${JSON.stringify({
        schema: "paperclip.transport_pump_benchmark.v1",
        persistence,
        sessions,
        retainedEventsPerSession: open[0]!.probe().readable.length,
        idleFresh,
        idleAfterTurn,
        deliveryWaitMs: {
          samples: waits.length,
          mean: round(waits.reduce((total, wait) => total + wait, 0) / waits.length),
          p50: round(percentile(waits, 0.5)),
          p95: round(percentile(waits, 0.95)),
          max: round(waits.at(-1)!),
        },
        terminalDeliveryWaitMs: {
          samples: terminalWaits.length,
          p50: round(percentile(terminalWaits, 0.5)),
          max: round(terminalWaits.at(-1)!),
        },
      })}\n`);
    } finally {
      await Promise.all(open.map(({ bundle }) => bundle.transport.close().catch(() => undefined)));
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

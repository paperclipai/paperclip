import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { DurablePrpControlPlane, type DurablePrpControlPlaneStore } from "./durable-prp-control-plane.js";

// Opt in explicitly. Run from packages/paperclip-runner:
// PAPERCLIP_CHECKPOINT_FLUSH_BENCHMARK=1 pnpm exec vitest run src/control-plane/durable-prp-checkpoint.benchmark.test.ts
// Each case commits one new event and flushes the journal checkpoint with a
// no-op persistence callback, so it measures only the controller's own work.
// CPU time shares the host's background load; the serialised byte and call
// counts are exact and do not depend on load.
const enabled = process.env.PAPERCLIP_CHECKPOINT_FLUSH_BENCHMARK === "1";
const flushes = Number(process.env.PAPERCLIP_CHECKPOINT_FLUSH_COUNT ?? "200");

type State = DurablePrpControlPlaneStore["state"];
type WorkingStore = DurablePrpControlPlaneStore & { commit(candidate: State, checkpointRequired?: boolean): void };

const identity = {
  runnerInstanceId: "runner-flush-benchmark", environmentLeaseId: "environment-flush-benchmark",
  runId: "00000000-0000-4000-8000-000000000201", normalizedSessionId: "session-flush-benchmark",
  turnId: "turn-flush-benchmark", itemId: "item-flush-benchmark",
};

function command(controllerSeq: number): State["commands"][number] {
  return { schema: "paperclip.prp.command.v1", commandId: `command-${controllerSeq}`, controllerSeq, type: "session.snapshot",
    issuedAt: "2026-11-13T00:00:00.000Z", payload: { text: "c".repeat(512) }, status: "completed", result: { ok: true } };
}

function event(sourceSeq: number): State["committedEvents"][number] {
  return { sourceSeq, sourceEventId: `event-${sourceSeq}`, eventType: "item.completed", priority: 1,
    envelope: { kind: "event", payload: { sourceSeq, eventType: "item.completed", payload: { text: "e".repeat(1024) } } },
    deliveryCount: 1, logicalEffectCount: 1 };
}

it.skipIf(!enabled).each([
  { name: "10 commands", commands: 10, events: 10 },
  { name: "500 commands", commands: 500, events: 10 },
  { name: "4,096 events", commands: 10, events: 4_096 },
])("measures one checkpoint flush with $name", async ({ name, commands, events }) => {
  const root = mkdtempSync(resolve(tmpdir(), "runner-checkpoint-flush-benchmark-"));
  const core = new DurablePrpControlPlane({ stateDirectory: root, identity,
    expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  try {
    const working = core.store as WorkingStore;
    working.commit({ ...working.state, ackedSourceSeq: events,
      commands: Array.from({ length: commands }, (_, index) => command(index + 1)),
      committedEvents: Array.from({ length: events }, (_, index) => event(index + 1)) });
    let persisted = 0;
    core.setCheckpointPersistence(async () => { persisted += 1; });
    await core.flushCheckpoint();
    const stringify = JSON.stringify;
    let serialisedBytes = 0, serialisedRecords = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
      const output = stringify(...args);
      const value = args[0];
      if (value !== null && typeof value === "object" && ("controllerSeq" in value || "sourceSeq" in value)) serialisedRecords += 1;
      serialisedBytes += output?.length ?? 0;
      return output;
    }) as typeof JSON.stringify);
    let cpu = 0n;
    for (let index = 0; index < flushes; index += 1) {
      const sourceSeq = events + index + 1;
      const state = working.state;
      // One committed event, with the window kept at its configured length.
      working.commit({ ...state, ackedSourceSeq: sourceSeq, committedEvents: [...state.committedEvents.slice(1), event(sourceSeq)] });
      const started = process.cpuUsage();
      await core.flushCheckpoint();
      const used = process.cpuUsage(started);
      cpu += BigInt(used.user + used.system);
    }
    spy.mockRestore();
    expect(persisted).toBe(flushes + 1);
    console.info(JSON.stringify({ case: name, flushes,
      cpuMicrosecondsPerFlush: Number(cpu / BigInt(flushes)),
      serialisedBytesPerFlush: Math.round(serialisedBytes / flushes),
      serialisedRecordsPerFlush: serialisedRecords / flushes }));
  } finally {
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);

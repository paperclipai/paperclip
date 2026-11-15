import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  DurablePrpControlPlane,
  decodeDurablePrpCheckpoint,
  durableRecoveryInternals,
  type DurablePrpCheckpoint,
  type DurablePrpControlPlaneStore,
} from "./durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "./prp-transport-types.js";

type CoreState = DurablePrpControlPlaneStore["state"];
type CoreCommand = CoreState["commands"][number];
type CoreEvent = CoreState["committedEvents"][number];

const identity: DurableRecoveryIdentity = {
  runnerInstanceId: "runner-checkpoint-records-1",
  environmentLeaseId: "environment-checkpoint-records-1",
  runId: "00000000-0000-4000-8000-000000000101",
  normalizedSessionId: "session-checkpoint-records-1",
  turnId: "turn-checkpoint-records-1",
  itemId: "item-checkpoint-records-1",
};
const runnerVersion = "0.3.0";
const runnerDigest = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "runner-checkpoint-records-"));
  roots.push(root);
  return root;
}

function command(controllerSeq: number, status: CoreCommand["status"] = "completed"): CoreCommand {
  return {
    schema: "paperclip.prp.command.v1", commandId: `command-${controllerSeq}`, controllerSeq,
    type: "session.snapshot", issuedAt: "2026-11-13T00:00:00.000Z",
    payload: { request: controllerSeq, text: "x".repeat(64) },
    status, result: status === "pending" ? null : { snapshot: `snapshot-${controllerSeq}` },
  };
}

function event(sourceSeq: number, eventType = "item.completed"): CoreEvent {
  const streaming = eventType === "item.delta" || eventType === "usage.reported";
  return {
    sourceSeq, sourceEventId: `event-${sourceSeq}`, eventType, priority: streaming ? 2 : 1,
    envelope: { kind: "event", runId: identity.runId, payload: { sourceSeq, eventType, text: "y".repeat(128) } },
    deliveryCount: 1, logicalEffectCount: 1,
  };
}

function entries(checkpoint: DurablePrpCheckpoint): Array<[string, string]> {
  return [...checkpoint.records];
}

it("serialises only the new command when one command is added to a full journal", async () => {
  const root = temporaryRoot();
  const options = { stateDirectory: resolve(root, "control-plane"), identity,
    expectedRunnerVersion: runnerVersion, expectedRunnerDigest: runnerDigest };
  const core = new DurablePrpControlPlane(options);
  const commands = Array.from({ length: 499 }, (_, index) => command(index + 1));
  const events = Array.from({ length: 4_000 }, (_, index) => event(index + 1));
  const working = core.store.state;
  working.commands = commands;
  working.committedEvents = events;
  working.ackedSourceSeq = events.length;
  (core.store as DurablePrpControlPlaneStore & { save(): void }).save();
  const saved: DurablePrpCheckpoint[] = [];
  core.setCheckpointPersistence(async checkpoint => { saved.push(checkpoint); });
  let restored: DurablePrpControlPlane | undefined;
  try {
    await core.flushCheckpoint();
    const existing = new Set<object>([...commands, ...events]);
    const stringify = vi.spyOn(JSON, "stringify");
    core.queueCommand("session.snapshot", {}, "probe-command");
    await core.flushCheckpoint();
    const recordCalls = stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object"
      && ("controllerSeq" in value || "sourceSeq" in value));
    stringify.mockRestore();
    // The new command is serialised for its size check and once for the checkpoint.
    expect(recordCalls.filter(([value]) => existing.has(value as object))).toHaveLength(0);
    expect(recordCalls.length).toBeLessThanOrEqual(2);

    const checkpoint = saved.at(-1)!;
    expect(checkpoint.reset).toBe(false);
    expect([...checkpoint.changedRecords.keys()].filter(key => key.startsWith("command:") || key.startsWith("event:")))
      .toEqual(["command:500"]);
    expect(checkpoint.removedRecords).toEqual([]);

    await core.stop();
    rmSync(options.stateDirectory, { recursive: true });
    decodeDurablePrpCheckpoint(new Map(checkpoint.records)).restoreSessionDirectory(root);
    restored = new DurablePrpControlPlane(options);
    expect(restored.store.state.commands).toHaveLength(500);
    expect(restored.store.state.committedEvents).toHaveLength(4_000);
    expect(restored.getCommand("probe-command")).toMatchObject({ controllerSeq: 500, status: "pending" });
    // The restored journal produces byte-identical records without any cache.
    expect(entries(durableRecoveryInternals.captureCheckpoint(restored.store.state, runnerVersion, runnerDigest)))
      .toEqual(entries(checkpoint));
  } finally {
    await restored?.stop();
    await core.stop();
  }
});

/** Small deterministic generator (mulberry32), so a failure is reproducible. */
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

it.each([1, 2, 3, 4, 5])("produces the same records as a full serialisation across varied journal edits (seed %i)", seed => {
  const core = new DurablePrpControlPlane({ stateDirectory: temporaryRoot(), identity,
    expectedRunnerVersion: runnerVersion, expectedRunnerDigest: runnerDigest });
  let state: CoreState = structuredClone(core.store.state);
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T | undefined => values[Math.floor(next() * values.length)];
  let sourceSeq = 0;
  const eventTypes = ["item.completed", "item.delta", "usage.reported", "turn.started", "turn.completed", "harness.ready"];
  const operations: Array<() => void> = [
    () => { if (state.commands.length < 500) state.commands.push(command(state.commands.length + 1, "pending")); },
    () => {
      const pending = pick(state.commands.filter(candidate => candidate.status === "pending"));
      if (pending) { pending.status = pick(["completed", "failed", "rejected"] as const)!; pending.result = { value: next() }; }
    },
    () => {
      if (state.commands.length === 0) return;
      state.commands.splice(Math.floor(next() * state.commands.length), 1);
      state.commands.forEach((candidate, index) => { candidate.controllerSeq = index + 1; });
    },
    () => {
      if (state.committedEvents.length >= 64) state.committedEvents.splice(0, 1);
      state.committedEvents.push(event(++sourceSeq, pick(eventTypes)));
      state.ackedSourceSeq = sourceSeq;
    },
    () => {
      const index = Math.floor(next() * state.committedEvents.length);
      const replay = state.committedEvents[index];
      if (!replay) return;
      state = { ...state, committedEvents: state.committedEvents.map((candidate, position) =>
        position === index ? { ...replay, deliveryCount: replay.deliveryCount + 1 } : candidate),
      replayDeliveries: state.replayDeliveries + 1 };
    },
    () => { state = structuredClone(state); },
    () => { state = { ...state, commands: [...state.commands], committedEvents: [...state.committedEvents] }; },
    () => {
      state.connectionCount += 1;
      const target = pick(state.commands);
      if (target) state.commandDeliveryCounts[target.commandId] = (state.commandDeliveryCounts[target.commandId] ?? 0) + 1;
    },
    () => {
      // Same values, different key order: JSON output changes.
      const target = pick(state.commands);
      if (!target) return;
      const { payload } = target;
      delete (target as Partial<CoreCommand>).payload;
      target.payload = payload;
    },
    () => {
      const target = pick(state.commands);
      if (target) target.status = target.status; // eslint-disable-line no-self-assign
    },
    () => { state.malformedFrames += 1; },
  ];
  const cache = durableRecoveryInternals.createCheckpointRecordCache();
  for (let step = 0; step < 600; step += 1) {
    pick(operations)!();
    const cached = durableRecoveryInternals.captureCheckpoint(state, runnerVersion, runnerDigest, cache);
    const fresh = durableRecoveryInternals.captureCheckpoint(state, runnerVersion, runnerDigest);
    expect(entries(cached), `seed ${seed}, step ${step}`).toEqual(entries(fresh));
  }
  expect(state.commands.length + state.committedEvents.length).toBeGreaterThan(0);
});

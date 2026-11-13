import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { DurablePrpControlPlane } from "../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.js";

const numberOption = (name: string, fallback: number) => {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return value === undefined ? fallback : Number(value);
};
const runs = numberOption("runs", 8);
const seconds = numberOption("seconds", 30);
const eventsPerSecond = numberOption("events-per-second", 13);
const commandsPerSecond = numberOption("commands-per-second", 2);
const writeMs = numberOption("write-ms", 1000);
const eventBytes = numberOption("event-bytes", 2048);
const seedEvents = numberOption("seed-events", 300);

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const pause = (ms: number) => new Promise(resolveTimer => setTimeout(resolveTimer, ms));
const settledHeap = async () => {
  for (let index = 0; index < 6; index++) {
    gc();
    await new Promise(resolveTurn => setImmediate(resolveTurn));
  }
  return process.memoryUsage().heapUsed;
};

type WorkingStore = {
  revision: number;
  state: DurablePrpControlPlane["store"]["state"];
  commit(candidate: DurablePrpControlPlane["store"]["state"], checkpointRequired?: boolean): void;
};
const identity = (index: number) => ({
  runnerInstanceId: `runner-bench-${index}`, environmentLeaseId: `environment-bench-${index}`,
  runId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  normalizedSessionId: `session-bench-${index}`, turnId: `turn-bench-${index}`, itemId: `item-bench-${index}`,
});

const collected = { count: 0 };
const registry = new FinalizationRegistry<number>(() => { collected.count += 1; });
const roots: string[] = [];
const baseline = await settledHeap();
let writesStarted = 0, revisionsRequested = 0;

function benchEvent(index: number, sourceSeq: number) {
  return { sourceSeq, sourceEventId: `bench-${index}-${sourceSeq}`, eventType: "item.completed", priority: 1 as const,
    envelope: { kind: "event", payload: { sourceSeq, eventType: "item.completed", payload: { text: "x".repeat(eventBytes) } } },
    deliveryCount: 1, logicalEffectCount: 1 as const };
}

async function startRun(index: number) {
  const root = mkdtempSync(resolve(tmpdir(), "runner-checkpoint-backlog-"));
  roots.push(root);
  const core = new DurablePrpControlPlane({ stateDirectory: root, identity: identity(index),
    expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  const working = core.store as unknown as WorkingStore;
  const seeded = Array.from({ length: seedEvents }, (_, offset) => benchEvent(index, offset + 1));
  working.commit({ ...working.state, ackedSourceSeq: seedEvents, committedEvents: seeded });
  let lastRevision = -1;
  core.setCheckpointPersistence(async () => {
    writesStarted += 1;
    await pause(writeMs);
  });
  const flush = core.flushCheckpoint.bind(core);
  core.flushCheckpoint = () => {
    if (working.revision !== lastRevision) { lastRevision = working.revision; revisionsRequested += 1; }
    return flush();
  };
  registry.register(core, index);
  return { core, working };
}

async function driveEvents(run: Awaited<ReturnType<typeof startRun>>, until: number, index: number) {
  let sourceSeq = run.working.state.ackedSourceSeq;
  while (Date.now() < until) {
    sourceSeq += 1;
    const state = run.working.state;
    run.working.commit({ ...state, ackedSourceSeq: sourceSeq,
      committedEvents: [...state.committedEvents, benchEvent(index, sourceSeq)].slice(-4096) });
    await Promise.all([run.core.flushCheckpoint(), pause(1000 / eventsPerSecond)]);
  }
}

async function driveCommands(run: Awaited<ReturnType<typeof startRun>>, until: number, index: number) {
  const pending: Promise<void>[] = [];
  for (let count = 0; commandsPerSecond > 0 && Date.now() < until && count < 400; count++) {
    run.core.queueCommand("session.snapshot", {}, `bench-command-${index}-${count}`);
    pending.push(run.core.flushCheckpoint());
    await pause(1000 / commandsPerSecond);
  }
  await Promise.all(pending);
}

let active = await Promise.all(Array.from({ length: runs }, (_, index) => startRun(index)));
const until = Date.now() + seconds * 1000;
const driving = Promise.all(active.flatMap((run, index) => [driveEvents(run, until, index), driveCommands(run, until, index)]));
await pause(seconds * 500);
const midRun = await settledHeap();
await driving;
await Promise.all(active.map(run => run.core.flushCheckpoint()));
const live = await settledHeap();
const committedEvents = active[0]!.working.state.committedEvents.length;
await Promise.all(active.map(run => run.core.stop()));
active = [];
for (let attempt = 0; attempt < 40 && collected.count < runs; attempt++) {
  await settledHeap();
  await pause(25);
}
const finished = await settledHeap();
for (const root of roots) rmSync(root, { recursive: true, force: true });
const kilobytes = (bytes: number) => Math.round(bytes / runs / 1024);
console.log(JSON.stringify({
  settings: { runs, seconds, eventsPerSecond, commandsPerSecond, writeMs, eventBytes, seedEvents },
  newEventsCommittedPerRun: committedEvents - seedEvents, revisionsFlushed: revisionsRequested, checkpointWrites: writesStarted,
  midRunRetainedKBPerRun: kilobytes(midRun - baseline), idleLiveRetainedKBPerRun: kilobytes(live - baseline),
  finishedRetainedKBPerRun: kilobytes(finished - baseline), controlPlanesCollected: `${collected.count}/${runs}`,
}));

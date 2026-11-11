/**
 * Local proof for the run-event append lock and controller checkpoint saves.
 *
 * A native run appends every PRP event through `appendHeartbeatRunEvent`,
 * which locks the run row. The controller then saves its checkpoint: a new
 * `event:N` row plus the `cursor` row. The new row's foreign key check takes
 * FOR KEY SHARE on the same run row. This script replays that pattern with the
 * real append and the real checkpoint writer, on separate connections, and
 * times each checkpoint save. It compares a baseline append module (FOR UPDATE)
 * with the current one (FOR NO KEY UPDATE), in alternating order.
 *
 * Overlap is the normal controller order. The frame chain awaits each event's
 * append (onCommittedEvent) and local commit, but not its checkpoint save: the
 * ACK goes through #sendJson, which queues the save and does not block the
 * next frame. Only semantic inputs and command results await the save. So the
 * save for event N runs while event N+1 is appended. SERIAL=1 awaits every
 * save before the next append, as a control without overlap.
 *
 * HOLD_MS keeps each append transaction open that much longer. It stands in
 * for hosted round trips, which make the real append transaction last longer
 * than on loopback.
 *
 *   git show <base>:server/src/services/heartbeat-run-events.ts \
 *     > server/src/services/heartbeat-run-events.baseline.ts
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-run-event-checkpoint-lock.ts
 *
 * Optional: EVENTS (default 400 per pass), PASSES (4), HOLD_MS (5), EVENT_KIB (2), SERIAL (0).
 * Delete the baseline copy afterwards.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunnerCheckpoints, startEmbeddedPostgresTestDatabase } from "../packages/db/src/index.js";
import * as candidate from "../server/src/services/heartbeat-run-events.js";
import { nativeRunnerCheckpointWriter } from "../server/src/services/native-runtime/native-runner-checkpoint.js";

const { eq, sql: drizzleSql } = createRequire(new URL("../server/package.json", import.meta.url))("drizzle-orm") as typeof import("drizzle-orm");

const baselinePath = fileURLToPath(new URL("../server/src/services/heartbeat-run-events.baseline.ts", import.meta.url));
assert(existsSync(baselinePath), "Write the baseline module first (see the header)");
const baseline = await import(baselinePath) as typeof candidate;
const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const EVENTS = size("EVENTS", 400), PASSES = size("PASSES", 4), HOLD_MS = size("HOLD_MS", 5), EVENT_KIB = size("EVENT_KIB", 2);
const SERIAL = process.env.SERIAL === "1";
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");

const keepAlive = setInterval(() => {}, 1_000);
const temporary = await startEmbeddedPostgresTestDatabase("run-event-checkpoint-lock-");
const appendDb = createDb(temporary.connectionString);
const checkpointDb = createDb(temporary.connectionString);
try {
  const [company] = await appendDb.insert(companies).values({ name: "Lock", issuePrefix: "LCK" }).returning();
  const [agent] = await appendDb.insert(agents).values({ companyId: company!.id, name: "Native" }).returning();
  const [issue] = await appendDb.insert(issues).values({ companyId: company!.id, title: "Streaming task" }).returning();
  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!;
  const round = (value: number) => Number(value.toFixed(2));

  async function pass(label: "baseline" | "candidate") {
    const append = (label === "baseline" ? baseline : candidate).appendHeartbeatRunEvent;
    const runId = randomUUID(), bootId = randomUUID(), leaseOwner = randomUUID();
    await appendDb.insert(heartbeatRuns).values({ id: runId, companyId: company!.id, agentId: agent!.id, status: "running",
      runtimeMode: "native", nativeIssueId: issue!.id, issueId: issue!.id,
      runnerProfileJson: { padding: randomBytes(3 * 1024).toString("base64") } });
    await appendDb.insert(nativeRunFinalizations).values({ runId, companyId: company!.id, issueId: issue!.id, phase: "observed",
      controllerBootId: bootId, controllerGeneration: 1, leaseOwner, leaseExpiresAt: new Date(Date.now() + 3_600_000) });
    const write = nativeRunnerCheckpointWriter(checkpointDb, { companyId: company!.id, issueId: issue!.id, runId,
      authorityRunId: runId, bootId, generation: 1, leaseOwner });
    const checkpoint = (records: Map<string, string>, changed: Map<string, string>, reset: boolean) => ({
      runId, records, changedRecords: changed, removedRecords: [], reset, workCommandIds: [], predecessor: null,
      runnerVersion: "bench", runnerDigest: `sha256:${"a".repeat(64)}`,
      recoveryEvidence: { runnerInstanceId: "bench", normalizedSessionId: "bench", authenticatedConnectionCount: 1, highestRecordedSourceSeq: 0 },
      restoreSessionDirectory() {},
    }) as unknown as Parameters<typeof write>[0];
    const records = new Map([["header", JSON.stringify({ padding: randomBytes(6 * 1024).toString("base64") })],
      ["cursor", JSON.stringify({ ackedSourceSeq: 0 })]]);
    await write(checkpoint(records, new Map(records), true));
    const saves: number[] = [];
    let tail = Promise.resolve();
    const started = performance.now();
    for (let seq = 1; seq <= EVENTS; seq++) {
      const event = { sourceSeq: seq, eventType: "item.completed", text: randomBytes(EVENT_KIB * 768).toString("base64") };
      // The append commits before the controller ACKs, like onCommittedEvent.
      await appendDb.transaction(async tx => {
        await append(tx as unknown as typeof appendDb, { companyId: company!.id, agentId: agent!.id, runId,
          eventType: "item.completed", stream: "system", level: "info", payload: { prpEvent: event },
          nativeSource: { sourceInstanceId: "bench-runner", sourceEventId: `event-${seq}`, sourceSeq: seq,
            protocolSchemaVersion: 1, canonicalPayload: event } });
        if (HOLD_MS) await tx.execute(drizzleSql`select pg_sleep(${HOLD_MS / 1000})`);
      });
      const changed = new Map([[`event:${seq}`, JSON.stringify(event)], ["cursor", JSON.stringify({ ackedSourceSeq: seq })]]);
      for (const [key, value] of changed) records.set(key, value);
      // Checkpoint saves are serialized per controller and overlap the next append.
      tail = tail.then(async () => {
        const start = performance.now();
        await write(checkpoint(new Map(records), changed, false));
        saves.push(performance.now() - start);
      });
      if (SERIAL) await tail;
    }
    await tail;
    const elapsed = performance.now() - started;
    const [stored] = await checkpointDb.select({ count: drizzleSql<number>`count(*)::int` }).from(nativeRunnerCheckpoints)
      .where(eq(nativeRunnerCheckpoints.runId, runId));
    const events = await appendDb.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
    assert.equal(stored!.count, EVENTS + 2, "Every event row, the header and the cursor are stored");
    assert.deepEqual(events.map(row => row.seq), Array.from({ length: EVENTS }, (_, index) => index + 1));
    return { label, saves: saves.length, saveMedianMs: round(quantile(saves, 0.5)), saveP90Ms: round(quantile(saves, 0.9)),
      saveMaxMs: round(Math.max(...saves)), savesOver2Ms: saves.filter(value => value > 2).length,
      saveTotalMs: round(saves.reduce((sum, value) => sum + value, 0)), elapsedMs: round(elapsed) };
  }

  await pass("candidate"); // Warm caches and the prepared-statement path once.
  const results = [];
  for (let index = 0; index < PASSES; index++) results.push(await pass(index % 2 === 0 ? "baseline" : "candidate"));
  console.log(JSON.stringify({ events: EVENTS, serial: SERIAL, holdMs: HOLD_MS, eventKiB: EVENT_KIB, results }, null, 2));
} finally {
  clearInterval(keepAlive);
  await temporary.cleanup();
}

import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEventEpochs, heartbeatRunEvents, heartbeatRuns, nativeRunProcessEvidence } from "@paperclipai/db";
import { appendHeartbeatRunEvent, appendHeartbeatRunEventInTransaction } from "../services/heartbeat-run-events.js";
import { readNativeProcessEvidence } from "../services/native-process-evidence.js";
import { hasNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("current process evidence", () => {
  it("commits launch/stop authority atomically, ignores provider claims, and reads without historical events", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-process-evidence-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    const emptyRunId = "20000000-0000-4000-8000-000000000004";
    const event = { companyId, agentId, runId, eventType: "native.local_process_stopped", payload: { processPid: 4321, processGroupId: 4321 } };
    try {
      await db.insert(companies).values({ id: companyId, name: "Process fixture", issuePrefix: "PEV" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Process agent" });
      await db.insert(heartbeatRuns).values([runId, emptyRunId].map(id => ({ id, companyId, agentId, status: "running" })));
      expect(await readNativeProcessEvidence(db, companyId, emptyRunId)).toMatchObject({ seq: 0, eventType: null });
      expect(await readNativeProcessEvidence(db, "20000000-0000-4000-8000-000000000099", runId)).toBeNull();
      await appendHeartbeatRunEvent(db, event);
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
      await expect(db.transaction(async tx => {
        await appendHeartbeatRunEventInTransaction(tx, { ...event, eventType: "native.process_start_requested" });
        throw new Error("injected failure before commit");
      })).rejects.toThrow("injected failure");
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
      await appendHeartbeatRunEvent(db, { ...event, eventType: "native.process_start_requested" });
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
      await appendHeartbeatRunEvent(db, { ...event, nativeSource: { sourceInstanceId: "untrusted-provider", sourceEventId: "forged-stop", sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: { claimed: "stopped" } } });
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
      await appendHeartbeatRunEvent(db, event);
      await db.execute(sql`alter table heartbeat_run_events rename to unavailable_history`);
      // These reads still work: neither a positive nor a negative receipt
      // consults the transcript, regardless of its size or availability.
      expect(await readNativeProcessEvidence(db, companyId, runId)).toMatchObject({ seq: 4, eventType: event.eventType, processPid: 4321 });
      expect(await readNativeProcessEvidence(db, companyId, emptyRunId)).toMatchObject({ seq: 0, eventType: null });
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
    } finally { await temporary.cleanup(); }
  }, 60_000);

  it("backfills one latest server-authored receipt once for retained runs", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-process-backfill-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000011";
    const agentId = "20000000-0000-4000-8000-000000000012";
    const runId = "20000000-0000-4000-8000-000000000013";
    try {
      await db.insert(companies).values({ id: companyId, name: "Retained process fixture", issuePrefix: "OLD" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Retained process agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", nextEventSeq: 4 });
      await db.insert(heartbeatRunEvents).values([
        { companyId, runId, agentId, seq: 1, eventType: "native.process_start_requested" },
        { companyId, runId, agentId, seq: 2, eventType: "native.local_process_stopped", payload: { processPid: 5432, processGroupId: 5432 } },
        { companyId, runId, agentId, seq: 3, eventType: "native.process_start_requested", sourceEventId: "provider-claim" },
      ]);
      const results = await Promise.all(Array.from({ length: 4 }, () => readNativeProcessEvidence(db, companyId, runId)));
      expect(results.every(r => r?.seq === 2 && r.processPid === 5432)).toBe(true);
      expect(await db.select().from(nativeRunProcessEvidence)).toHaveLength(1);
      // Event retention cannot erase the independently committed stop fact.
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(true);
      await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "native.process_start_requested" });
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
    } finally { await temporary.cleanup(); }
  }, 60_000);

  it("selects latest process authority across epochs when local sequence numbers repeat", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-process-epochs-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000021";
    const agentId = "20000000-0000-4000-8000-000000000022";
    const runId = "20000000-0000-4000-8000-000000000023";
    const nextEpoch = "20000000-0000-4000-8000-000000000024";
    try {
      await db.insert(companies).values({ id: companyId, name: "Epoch process fixture", issuePrefix: "EPO" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Epoch process agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", nextEventSeq: 3 });
      await db.insert(heartbeatRunEvents).values([
        { companyId, runId, agentId, seq: 1, eventEpoch: "", eventType: "native.process_start_requested" },
        { companyId, runId, agentId, seq: 2, eventEpoch: "", eventType: "native.local_process_stopped", payload: { processPid: 5432, processGroupId: 5432 } },
      ]);
      await db.insert(heartbeatRunEventEpochs).values({ companyId, runId, epoch: "", nextEpoch, finalSeq: 2 });
      await db.update(heartbeatRuns).set({ eventEpoch: nextEpoch, nextEventSeq: 2 }).where(eq(heartbeatRuns.id, runId));
      await db.insert(heartbeatRunEvents).values({
        companyId, runId, agentId, seq: 1, eventEpoch: nextEpoch, eventType: "native.process_start_requested",
      });

      expect(await readNativeProcessEvidence(db, companyId, runId)).toMatchObject({ seq: 1, eventType: "native.process_start_requested", processPid: null });
      expect(await hasNativeLocalProcessStop(db, companyId, runId)).toBe(false);
    } finally { await temporary.cleanup(); }
  }, 60_000);
});

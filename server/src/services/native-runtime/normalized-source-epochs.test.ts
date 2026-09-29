import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, nativeOutputBodyChunks, nativeSourceCursors, nativeSourceEpochs } from "@paperclipai/db";
import { advanceSourceCursor, normalizedEventId, type PrpEvent, type SourceCursor } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { readRunOutputBody } from "../run-output-body.js";

it("commits normalized epoch boundaries, rejects forged closes, replays from old cursors and downloads a body spanning epochs", async () => {
  const objects = mkdtempSync(join(tmpdir(), "normalized-body-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", objects);
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-normalized-epochs-");
  const db = createDb(temporary.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceInstanceId = randomUUID(), sessionId = randomUUID();
  const binding = { companyId, agentId, runId, issueId: randomUUID(), sessionId, sourceInstanceId,
    controlPlaneSourceInstanceId: "control", completionContractId: randomUUID(), completionContractSha256: "test" };
  let port = new PaperclipControlPlanePort(db, binding);
  const firstEpoch = randomUUID(), secondEpoch = randomUUID();
  const make = (sourceSeq: number, sourceEpoch?: string): PrpEvent => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, priority: 1,
    runId, normalizedSessionId: sessionId, sourceKind: "runner", sourceInstanceId, sourceSeq, ...(sourceEpoch ? { sourceEpoch } : {}),
    sourceEventId: normalizedEventId(sourceInstanceId, runId, sourceSeq, sourceEpoch), eventType: "harness.diagnostic", emittedAt: "2026-09-29T00:00:00.000Z", payload: { code: "epoch-test" } });
  const cross = (fromEpoch: string | null, nextEpoch: string, finalOrdinal = 4): PrpEvent => ({ ...make(1, nextEpoch), sourceEpochTransition: {
    schema: "paperclip.prp.event-epoch.v1", runId, transitionId: randomUUID(), fromEpoch, nextEpoch, finalOrdinal } });
  const text = "body spanning source epochs ".repeat(500), hash = (v: string) => createHash("sha256").update(v).digest("hex"), bodyId = hash(text);
  const body = { schema: "paperclip.output.body.v1", bodyId, sha256: bodyId, byteLength: String(Buffer.byteLength(text)), mediaType: "text/plain; charset=utf-8" };
  const chunk = (event: PrpEvent, offset: number, end: number): PrpEvent => ({ ...event, eventType: "output.body.chunk", payload: {
    schema: "paperclip.output.body.chunk.v1", body, offset: String(offset), sha256: hash(text.slice(offset, end)), text: text.slice(offset, end) } });
  const accepted: PrpEvent[] = [];
  try {
    await db.insert(companies).values({ id: companyId, name: "Normalized epochs", issuePrefix: "NEP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Epoch agent" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    // A committed gap is not a prefix and cannot authorize a close.
    await port.appendEvent(make(1)); accepted.push(make(1));
    await port.appendEvent(make(3));
    await expect(port.appendEvent(cross(null, firstEpoch, 1))).rejects.toThrow("replay_conflict");
    await port.appendEvent(make(2)); accepted.push(make(2), make(3));
    const finalOld = chunk(make(4), 0, 8000); await port.appendEvent(finalOld); accepted.push(finalOld);
    await expect(readRunOutputBody(db, companyId, runId, bodyId)).rejects.toThrow("not complete");
    const firstNew = chunk(cross(null, firstEpoch), 8000, text.length);
    expect(await port.appendEvent(firstNew)).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1, highestContiguousSourceEpoch: firstEpoch });
    accepted.push(firstNew);
    // Lost ACK: reopen the production port and deliver identical bytes again.
    port = new PaperclipControlPlanePort(createDb(temporary.connectionString), binding);
    expect(await port.appendEvent(firstNew)).toMatchObject({ disposition: "duplicate", highestContiguousSourceEpoch: firstEpoch });
    expect(await readRunOutputBody(db, companyId, runId, bodyId)).toBe(text);
    await expect(port.appendEvent({ ...firstNew, sourceEpochTransition: { ...firstNew.sourceEpochTransition!, transitionId: randomUUID() } })).rejects.toThrow("replay_conflict");
    await expect(port.appendEvent(make(5))).rejects.toThrow("replay_conflict");
    for (let n = 2; n <= 4; n++) { const event = make(n, firstEpoch); await port.appendEvent(event); accepted.push(event); }
    const second = cross(firstEpoch, secondEpoch); await port.appendEvent(second); accepted.push(second);
    // Earlier identities remain exact after multiple rotations. Reused namespace rejected.
    expect(await port.appendEvent(make(1))).toMatchObject({ disposition: "duplicate", highestContiguousSourceSeq: 1, highestContiguousSourceEpoch: secondEpoch });
    await expect(port.appendEvent(cross(secondEpoch, firstEpoch, 1))).rejects.toThrow("replay_conflict");
    let cursor: SourceCursor = { sourceSeq: 0 }; const replayed: PrpEvent[] = [];
    for (;;) {
      const page = await port.replayEvents({ runId, sourceInstanceId, sourceEpoch: cursor.sourceEpoch, afterSourceSeq: cursor.sourceSeq, limit: 2 });
      if (!page.events.length) break;
      for (const event of page.events) { cursor = advanceSourceCursor(cursor, event); replayed.push(event); }
    }
    expect(replayed.map(event => event.sourceEventId)).toEqual(accepted.map(event => event.sourceEventId));
    expect(cursor).toEqual({ sourceEpoch: secondEpoch, sourceSeq: 1 });
    expect(await db.select().from(nativeSourceEpochs)).toHaveLength(2);
    expect(await db.select().from(nativeSourceCursors)).toMatchObject([{ sourceEpoch: secondEpoch, cursor: 1 }]);
    expect(await db.select().from(nativeOutputBodyChunks)).toHaveLength(2);
    expect(await db.select().from(heartbeatRunEvents)).toHaveLength(9);
    // Reading one body is independent of source ordinals, even at the former numeric ceiling.
    await db.update(heartbeatRunEvents).set({ sourceSeq: Number.MAX_SAFE_INTEGER }).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.sourceEventId, finalOld.sourceEventId)));
    expect(await readRunOutputBody(db, companyId, runId, bodyId)).toBe(text);
    await expect(db.execute(sql`insert into native_source_epochs(company_id,run_id,source_instance_id,from_epoch,next_epoch,transition_id,final_ordinal,transition)
      values (${randomUUID()},${runId},'other','',${randomUUID()},${randomUUID()},1,'{}')`)).rejects.toThrow();
  } finally { await temporary.cleanup(); vi.unstubAllEnvs(); rmSync(objects, { recursive: true, force: true }); }
}, 60_000);

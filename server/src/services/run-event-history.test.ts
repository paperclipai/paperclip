import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, heartbeatRunEventEpochs, heartbeatRunEventHeads, heartbeatRunEventLinks, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { allocateRunEventPosition, parseRunEventCursor, readRunEventLane, readRunEventPage, runEventCursor, runEventLane } from "./run-event-history.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

it("keeps exact cursors and semantic heads through repeated rollover, concurrency, rollback and reopen", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-public-epochs-");
  let db = createDb(temporary.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), requestId = randomUUID();
  const events: (typeof heartbeatRunEvents.$inferSelect)[] = [];
  try {
    await db.insert(companies).values({ id: companyId, name: "Public epochs", issuePrefix: "PEP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Epoch agent" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    const append = (eventType: string, payload: Record<string, unknown> = {}) => db.transaction(async tx => {
      const position = await allocateRunEventPosition(tx as unknown as Db, runId, 4);
      const [row] = await tx.insert(heartbeatRunEvents).values({ companyId, agentId, runId, ...position, eventType, payload }).returning();
      return row!;
    });
    events.push(await append("runtime_request.created", { prpEvent: { payload: { request: { requestId } } } }));
    for (let n = 0; n < 8; n++) events.push(await append(n % 2 ? "item.completed" : "output", { text: `old\0${n}` }));
    expect(new Set(events.map(row => row.id)).size).toBe(9);
    expect(events.map(row => row.seq)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1]);
    expect(events.every(row => typeof row.id === "string")).toBe(true);
    expect((await readRunEventLane(db, runId, "all", 3)).map(row => row.id)).toEqual(events.slice(-3).reverse().map(row => row.id));
    expect((await readRunEventLane(db, runId, runEventLane("type", "item.completed"), 10)).map(row => row.id)).toEqual(events.filter(row => row.eventType === "item.completed").reverse().map(row => row.id));
    expect((await readRunEventLane(db, runId, runEventLane("request", requestId), 1))[0]?.id).toBe(events[0].id);
    const tail = await readRunEventPage(db, runId, "tail", 3);
    expect(tail.map(row => row.id)).toEqual(events.slice(-3).map(row => row.id));
    expect(tail[0]).toMatchObject({ historyBefore: true });
    expect((await readRunEventPage(db, runId, runEventCursor(events[3]), 5)).map(row => row.id)).toEqual(events.slice(4).map(row => row.id));
    db = createDb(temporary.connectionString);
    let cursor: string | number = 0; const replayed: (string | number)[] = [];
    for (;;) {
      const page = await readRunEventPage(db, runId, cursor, 2);
      if (!page.length) break;
      replayed.push(...page.map(row => row.id)); cursor = page.at(-1)!.cursor;
    }
    expect(replayed).toEqual(events.map(row => row.id));
    expect((await readRunEventPage(db, runId, "0", 2))[1].payload).toEqual({ text: "old\0" + "0" });
    const before = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await expect(db.transaction(async tx => {
      await allocateRunEventPosition(tx as unknown as Db, runId, 2);
      throw new Error("storage failure");
    })).rejects.toThrow("storage failure");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toEqual(before);
    expect(await db.select().from(heartbeatRunEventEpochs)).toHaveLength(2);
    events.push(await append("runtime_request.resolved", { prpEvent: { payload: { requestId } } }));
    expect((await readRunEventLane(db, runId, runEventLane("request", requestId), 2)).map(row => row.id)).toEqual([events.at(-1)!.id, events[0].id]);
    const concurrent = await Promise.all(Array.from({ length: 20 }, (_, n) => append("output", { n })));
    const durable = await readRunEventLane(db, runId, "all", 100);
    expect(durable).toHaveLength(30);
    expect(new Set(durable.map(runEventCursor)).size).toBe(30);
    expect(new Set(concurrent.map(row => row.id)).size).toBe(20);
    expect(await db.select().from(heartbeatRunEventEpochs)).toHaveLength(7);
    await expect(db.insert(heartbeatRunEvents).values({ companyId: randomUUID(), agentId, runId, seq: 99, eventType: "wrong-company" })).rejects.toThrow();
    expect((await db.select().from(heartbeatRunEventHeads).where(and(eq(heartbeatRunEventHeads.runId, runId), eq(heartbeatRunEventHeads.lane, "all"))))[0]?.eventId).toBe(durable[0].id);
    expect(await db.select().from(heartbeatRunEventLinks).where(and(eq(heartbeatRunEventLinks.runId, runId), eq(heartbeatRunEventLinks.lane, "all")))).toHaveLength(30);
    await db.execute(sql`select setval(pg_get_serial_sequence('heartbeat_run_events', 'id'), 9223372036854775807)`);
    expect(typeof (await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "after-old-global-limit" })).row.id).toBe("string");
    const [largeStart] = await readRunEventLane(db, runId, "all", 1);
    const large = [];
    for (let n = 0; n < 3; n++) large.push(await append("output", { text: "x".repeat(2 * 1024 * 1024), n }));
    // Highly compressible values must be budgeted by their uncompressed JSON,
    // not by PostgreSQL's compact on-disk representation. Short pages still
    // advertise their successor and work through a namespace boundary.
    const largeIds: (string | number)[] = [];
    let largeCursor = runEventCursor(largeStart);
    for (let n = 0; n < 3; n++) {
      const page = await readRunEventPage(db, runId, largeCursor, 100);
      expect(page).toHaveLength(1);
      expect("historyAfter" in page[0] && page[0].historyAfter).toBe(n < 2 ? true : false);
      expect(page[0].payload).toEqual({ text: "x".repeat(2 * 1024 * 1024), n });
      largeIds.push(page[0].id); largeCursor = page[0].cursor;
    }
    expect(largeIds).toEqual(large.map(row => row.id));
    const largeTail = await readRunEventPage(db, runId, "tail", 100);
    expect(largeTail).toHaveLength(1);
    expect(largeTail[0]).toMatchObject({ id: large[2].id, historyBefore: true });
  } finally { await temporary.cleanup(); }
}, 60_000);

it("rejects lossy cursors and retains opaque namespaces", () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "NaN", "1e2", "01", "e:wrong:1", `e:${randomUUID()}:9007199254740992`]) expect(() => parseRunEventCursor(value)).toThrow("invalid_run_event_cursor");
  const epoch = randomUUID();
  expect(parseRunEventCursor(`e:${epoch}:1`)).toEqual({ eventEpoch: epoch, seq: 1 });
});

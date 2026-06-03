import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, pluginEventOutbox } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { pollOnce, resetStaleProcessing } from "../services/plugin-event-outbox.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-event-outbox tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("plugin event outbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outbox-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginEventOutbox);
  });

  function makeEvent(eventType: string): PluginEvent {
    return {
      eventId: randomUUID(),
      eventType: eventType as PluginEvent["eventType"],
      occurredAt: new Date().toISOString(),
      actorType: "system",
      entityId: randomUUID(),
      entityType: "approval",
      companyId,
      payload: { hello: "world" },
    };
  }

  async function enqueue(event: PluginEvent, createdAt?: Date) {
    await db.insert(pluginEventOutbox).values({
      eventId: event.eventId,
      companyId: event.companyId,
      eventType: event.eventType,
      payload: event as unknown as Record<string, unknown>,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  it("emits a queued event and marks it processed", async () => {
    const bus = createPluginEventBus();
    const seen: PluginEvent[] = [];
    bus.forPlugin("test").subscribe("approval.created", async (e) => {
      seen.push(e);
    });
    const event = makeEvent("approval.created");
    await enqueue(event);

    const n = await pollOnce(db, bus);

    expect(n).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.eventId).toBe(event.eventId);
    const [row] = await db.select().from(pluginEventOutbox).where(eq(pluginEventOutbox.eventId, event.eventId));
    expect(row!.status).toBe("processed");
    expect(row!.processedAt).not.toBeNull();
  });

  it("delivers events in creation order", async () => {
    const bus = createPluginEventBus();
    const order: string[] = [];
    const record = async (e: PluginEvent) => {
      order.push(e.eventType);
    };
    bus.forPlugin("test").subscribe("approval.created", record);
    bus.forPlugin("test").subscribe("approval.decided", record);
    const created = makeEvent("approval.created");
    const decided = makeEvent("approval.decided");
    await enqueue(created, new Date(Date.now() - 1000));
    await enqueue(decided, new Date());

    await pollOnce(db, bus);

    expect(order).toEqual(["approval.created", "approval.decided"]);
  });

  it("marks processed even when a handler throws (no poison loop)", async () => {
    const bus = createPluginEventBus();
    bus.forPlugin("test").subscribe("approval.created", async () => {
      throw new Error("handler boom");
    });
    const event = makeEvent("approval.created");
    await enqueue(event);

    await pollOnce(db, bus);

    const [row] = await db.select().from(pluginEventOutbox).where(eq(pluginEventOutbox.eventId, event.eventId));
    expect(row!.status).toBe("processed");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("handler boom");
    const queued = await db.select().from(pluginEventOutbox).where(eq(pluginEventOutbox.status, "queued"));
    expect(queued).toHaveLength(0);
  });

  it("requeues stale processing rows on reset", async () => {
    const event = makeEvent("approval.created");
    await enqueue(event);
    await db.update(pluginEventOutbox).set({ status: "processing" }).where(eq(pluginEventOutbox.eventId, event.eventId));

    const reset = await resetStaleProcessing(db);

    expect(reset).toBe(1);
    const [row] = await db.select().from(pluginEventOutbox).where(eq(pluginEventOutbox.eventId, event.eventId));
    expect(row!.status).toBe("queued");
  });
});

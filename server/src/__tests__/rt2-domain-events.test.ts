import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  rt2V33DomainEvents,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { rt2DomainEventService } from "../services/rt2-domain-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 domain event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 domain events", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-domain-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33ProjectorEvents);
    await db.delete(rt2V33ProjectorState);
    await db.delete(rt2V33DomainEvents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Events Corp",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("returns the existing event for duplicate idempotency keys", async () => {
    await seedCompany();
    const service = rt2DomainEventService(db);
    const event = await service.append({
      companyId,
      eventType: "rt2.task.created",
      actorType: "user",
      actorId: "user-1",
      entityType: "task",
      entityId: randomUUID(),
      idempotencyKey: "create-task-1",
      payload: { title: "Task" },
    });

    const duplicate = await service.append({
      companyId,
      eventType: "rt2.task.created",
      actorType: "user",
      actorId: "user-1",
      entityType: "task",
      entityId: randomUUID(),
      idempotencyKey: "create-task-1",
      payload: { title: "Task duplicate" },
    });

    expect(duplicate.id).toBe(event.id);

    const rows = await db.select().from(rt2V33DomainEvents);
    expect(rows).toHaveLength(1);
  });

  it("records projector processing once and skips replayed processed events", async () => {
    await seedCompany();
    const service = rt2DomainEventService(db);
    const event = await service.append({
      companyId,
      eventType: "rt2.todo.started",
      actorType: "user",
      actorId: "user-1",
      entityType: "todo",
      entityId: randomUUID(),
      payload: {},
    });

    let calls = 0;
    await service.processEvent("test.projector", event.id, async () => {
      calls += 1;
    });
    const replay = await service.processEvent("test.projector", event.id, async () => {
      calls += 1;
    });

    expect(calls).toBe(1);
    expect(replay.status).toBe("skipped");

    const processed = await db.select().from(rt2V33ProjectorEvents);
    expect(processed).toHaveLength(1);
    expect(processed[0]).toEqual(expect.objectContaining({
      projectorName: "test.projector",
      status: "processed",
    }));
  });

  it("records projection failure without deleting the source event", async () => {
    await seedCompany();
    const service = rt2DomainEventService(db);
    const event = await service.append({
      companyId,
      eventType: "rt2.execution.failed",
      actorType: "system",
      actorId: "rt2-execution",
      entityType: "execution",
      entityId: randomUUID(),
      payload: { failureReason: "runtime exited" },
    });

    await expect(
      service.processEvent("test.failing_projector", event.id, async () => {
        throw new Error("projection failed");
      }),
    ).rejects.toThrow("projection failed");

    const events = await db.select().from(rt2V33DomainEvents);
    expect(events).toHaveLength(1);

    const projectorRows = await db.select().from(rt2V33ProjectorEvents);
    expect(projectorRows[0]).toEqual(expect.objectContaining({
      status: "failed",
      error: "projection failed",
    }));
  });

  it("projects activity records with domain event provenance", async () => {
    await seedCompany();
    const service = rt2DomainEventService(db);
    const event = await service.appendAndProject({
      companyId,
      eventType: "rt2.task.created",
      actorType: "user",
      actorId: "user-1",
      entityType: "task",
      entityId: randomUUID(),
      payload: { title: "Task" },
    });

    const activityRows = await db.select().from(activityLog);
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toEqual(expect.objectContaining({
      companyId,
      action: "rt2.task.created",
      entityId: event.entityId,
    }));
    expect(activityRows[0].details).toEqual(expect.objectContaining({
      domainEventId: event.id,
    }));
  });
});


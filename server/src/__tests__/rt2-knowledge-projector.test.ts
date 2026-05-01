import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  projects,
  rt2V33DomainEvents,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33DailyWikiPages,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
  rt2V33WikiPages,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { rt2DomainEventService } from "../services/rt2-domain-events.js";
import { rt2KnowledgeProjectorService } from "../services/rt2-knowledge-projector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 knowledge projector tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 knowledge projector", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-knowledge-projector-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33GraphEdges);
    await db.delete(rt2V33GraphNodes);
    await db.delete(rt2V33DailyWikiPages);
    await db.delete(rt2V33WikiPages);
    await db.delete(rt2V33ProjectorEvents);
    await db.delete(rt2V33ProjectorState);
    await db.delete(rt2V33DomainEvents);
    await db.delete(activityLog);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Knowledge Corp",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Knowledge Project",
      status: "in_progress",
    });
  }

  it("materializes cumulative wiki pages and extracted graph edges from domain events", async () => {
    await seedCompany();
    const domainEvents = rt2DomainEventService(db);

    await domainEvents.appendAndProject({
      companyId,
      eventType: "rt2.task.created",
      eventVersion: 1,
      actorType: "user",
      actorId: "board-user",
      entityType: "task",
      entityId: "task-1",
      payload: {
        projectId,
        taskIssueId: "task-1",
      },
      metadata: {},
      idempotencyKey: "knowledge-task-1",
    });

    const wikiPages = await db.select().from(rt2V33WikiPages).where(eq(rt2V33WikiPages.companyId, companyId));
    expect(wikiPages.map((page) => page.pageKey).sort()).toEqual(
      expect.arrayContaining([
        "index.md",
        "log.md",
        `projects/${projectId}.md`,
        "schemas/task.md",
        `topics/actors/user/board-user.md`,
        `topics/projects/${projectId}.md`,
        "topics/task/task-1.md",
      ]),
    );
    expect(wikiPages.find((page) => page.pageKey === "log.md")?.markdown).toContain("rt2.task.created");
    expect(wikiPages.find((page) => page.pageKey === `projects/${projectId}.md`)).toEqual(
      expect.objectContaining({
        pageType: "project",
        metadata: expect.objectContaining({
          wikillmCompatible: true,
          contradictionStatus: "none",
          confidenceSummary: expect.objectContaining({ EXTRACTED: 1 }),
          updateEvidence: expect.objectContaining({
            reason: "domain_event_projection",
            sourceEventCount: 1,
          }),
          provenance: expect.objectContaining({
            source: "domain_event_projector",
            sourceEventTypes: ["rt2.task.created"],
          }),
        }),
      }),
    );

    const graphEdges = await db.select().from(rt2V33GraphEdges).where(eq(rt2V33GraphEdges.companyId, companyId));
    expect(graphEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: "project_task",
          confidence: "EXTRACTED",
        }),
        expect.objectContaining({
          edgeType: "event_entity",
          confidence: "EXTRACTED",
        }),
      ]),
    );
    expect(graphEdges[0]?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "domain_event" })]),
    );
  });

  it("skips duplicate projection for an already processed event", async () => {
    await seedCompany();
    const domainEvents = rt2DomainEventService(db);
    const projector = rt2KnowledgeProjectorService(db);

    const event = await domainEvents.appendAndProject({
      companyId,
      eventType: "rt2.todo.created",
      eventVersion: 1,
      actorType: "user",
      actorId: "board-user",
      entityType: "todo",
      entityId: "todo-1",
      payload: {
        projectId,
        taskIssueId: "task-1",
      },
      metadata: {},
      idempotencyKey: "knowledge-todo-1",
    });

    const replay = await projector.projectEvent(event.id);
    expect(replay.status).toBe("skipped");

    const graphEdges = await db.select().from(rt2V33GraphEdges).where(eq(rt2V33GraphEdges.companyId, companyId));
    const uniqueKeys = new Set(graphEdges.map((edge) => `${edge.sourceNodeId}:${edge.targetNodeId}:${edge.edgeType}`));
    expect(uniqueKeys.size).toBe(graphEdges.length);
  });

  it("projects idempotent date and per-user daily wiki pages from domain events", async () => {
    await seedCompany();
    const domainEvents = rt2DomainEventService(db);
    const projector = rt2KnowledgeProjectorService(db);

    await domainEvents.appendAndProject({
      companyId,
      eventType: "rt2.todo.created",
      eventVersion: 1,
      actorType: "user",
      actorId: "board-user",
      entityType: "todo",
      entityId: "todo-daily-1",
      payload: {
        projectId,
        taskIssueId: "task-daily-1",
      },
      metadata: {},
      idempotencyKey: "knowledge-daily-todo-1",
    });

    const date = new Date().toISOString().slice(0, 10);
    const dailyPage = await projector.getDailyWikiPage(companyId, date);
    expect(dailyPage).toEqual(
      expect.objectContaining({
        pageKey: `daily/${date}.md`,
        userId: "all",
        reportDate: date,
      }),
    );
    expect(dailyPage?.markdown).toContain("rt2.todo.created");
    expect(dailyPage?.sourceEventIds).toHaveLength(1);

    const userPage = await projector.getDailyWikiPage(companyId, date, "board-user");
    expect(userPage).toEqual(expect.objectContaining({ pageKey: `daily/${date}/user/board-user.md` }));

    const beforeRebuild = dailyPage?.markdown;
    await projector.projectAllDaily(companyId);
    await projector.projectAllDaily(companyId);
    const afterRebuild = await projector.getDailyWikiPage(companyId, date);
    expect(afterRebuild?.markdown).toBe(beforeRebuild);
    expect(afterRebuild?.sourceEventIds).toHaveLength(1);
  });
});

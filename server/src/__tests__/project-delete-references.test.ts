import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  costEvents,
  createDb,
  financeEvents,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("project deletion with retained references", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: randomUUID(),
      issuePrefix: `T${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [project] = await db.insert(projects).values({
      companyId: company.id,
      name: "Menu",
    }).returning();
    return { company, project };
  }

  it("keeps spend history and clears its project attribution", async () => {
    const { company, project } = await fixture();
    const [cost] = await db.insert(costEvents).values({
      companyId: company.id,
      projectId: project.id,
      usageKind: "decision",
      provider: "fixture",
      model: "fixture-model",
      costCents: 12,
      occurredAt: new Date(),
    }).returning();
    const [finance] = await db.insert(financeEvents).values({
      companyId: company.id,
      projectId: project.id,
      eventKind: "charge",
      biller: "fixture",
      amountCents: 12,
      occurredAt: new Date(),
    }).returning();

    const removed = await projectService(db).remove(project.id);

    expect(removed?.id).toBe(project.id);
    const [retainedCost] = await db.select().from(costEvents).where(eq(costEvents.id, cost.id));
    const [retainedFinance] = await db.select().from(financeEvents).where(eq(financeEvents.id, finance.id));
    expect(retainedCost?.projectId).toBeNull();
    expect(retainedFinance?.projectId).toBeNull();
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
  });

  it("refuses to delete a project that still owns tasks", async () => {
    const { company, project } = await fixture();
    await issueService(db).create(company.id, {
      title: "Retained task",
      status: "todo",
      projectId: project.id,
    });

    await expect(projectService(db).remove(project.id)).rejects.toMatchObject({
      status: 409,
      message: "This project still has tasks. Move or delete its tasks before deleting the project.",
    });
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
  });
});

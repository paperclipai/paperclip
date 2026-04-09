import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  goals,
  projects,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensureDefaultRoutinesForAgent } from "../services/default-agent-routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping default agent routine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("default agent routines", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-agent-routines-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(role: string, title = "CEO") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(goals).values({
      id: randomUUID(),
      companyId,
      title: "Grow the company",
      level: "company",
      status: "active",
    });

    const [agent] = await db
      .insert(agents)
      .values({
        id: agentId,
        companyId,
        name: title,
        role,
        title,
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    return agent!;
  }

  it("creates an executive review project, routine, and Monday morning UTC trigger for ceo agents", async () => {
    const agent = await seedAgent("ceo");

    await ensureDefaultRoutinesForAgent(db, {
      agent,
      actor: {
        actorType: "user",
        actorId: "local-board",
        userId: "local-board",
      },
    });

    await ensureDefaultRoutinesForAgent(db, {
      agent,
      actor: {
        actorType: "user",
        actorId: "local-board",
        userId: "local-board",
      },
    });

    const projectRows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, agent.companyId), eq(projects.name, "Executive Reviews")));
    expect(projectRows).toHaveLength(1);

    const routineRows = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, agent.companyId), eq(routines.assigneeAgentId, agent.id)));
    expect(routineRows).toHaveLength(1);
    expect(routineRows[0]?.title).toBe("Weekly Company Review");
    expect(routineRows[0]?.description).toContain("Run the Monday executive company review.");

    const triggerRows = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, routineRows[0]!.id));
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0]).toMatchObject({
      kind: "schedule",
      label: "Monday morning",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
      enabled: true,
    });
  });

  it("does nothing for non-ceo agents", async () => {
    const agent = await seedAgent("engineer", "Engineer");

    await ensureDefaultRoutinesForAgent(db, {
      agent,
      actor: {
        actorType: "user",
        actorId: "local-board",
        userId: "local-board",
      },
    });

    const routineRows = await db
      .select()
      .from(routines)
      .where(eq(routines.companyId, agent.companyId));
    expect(routineRows).toHaveLength(0);
  });
});

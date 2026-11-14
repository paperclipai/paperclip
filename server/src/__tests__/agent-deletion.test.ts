import { randomUUID } from "node:crypto";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("agent deletion issue references", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-deletion-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it.each(["creator", "assignee", "both", "neither"])("clears only deleted-agent references when the agent is %s", async role => {
    const [company] = await db.insert(companies).values({ name: "Deletion fixture", issuePrefix: `D${randomUUID().slice(0, 6)}` }).returning();
    const [deleted, survivor] = await db.insert(agents).values([
      { companyId: company.id, name: "Deleted", status: "terminated", lifecycleState: "terminated", adapterType: "process" },
      { companyId: company.id, name: "Survivor", adapterType: "process" },
    ]).returning();
    const createdByAgentId = role === "creator" || role === "both" ? deleted.id : survivor.id;
    const assigneeAgentId = role === "assignee" || role === "both" ? deleted.id : survivor.id;
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Retained issue", createdByAgentId, assigneeAgentId }).returning();

    await agentService(db).remove(deleted.id);

    const [retained] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(retained).toMatchObject({
      createdByAgentId: createdByAgentId === deleted.id ? null : survivor.id,
      assigneeAgentId: assigneeAgentId === deleted.id ? null : survivor.id,
    });
    expect(await db.select().from(agents).where(eq(agents.id, deleted.id))).toEqual([]);
    expect(await db.select().from(agents).where(eq(agents.id, survivor.id))).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";

describe("agent deletion with issue thread interactions", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-deletion-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["createdByAgentId", "resolvedByAgentId"] as const)("purges an agent referenced as %s and keeps the interaction", async column => {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Agent deletion", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId,
      name: "Interaction agent", status: "terminated", lifecycleState: "terminated" as const })));
    const [issue] = await db.insert(issues).values({ companyId, title: "Thread task", status: "todo" }).returning();
    const payload = { version: 1 as const, questions: [{ id: "q1", prompt: "Which option?", selectionMode: "single" as const,
      options: [{ id: "a", label: "A" }] }] };
    const [deleted, unrelated] = await db.insert(issueThreadInteractions).values([agentId, otherAgentId].map(id => ({
      companyId, issueId: issue!.id, kind: "ask_user_questions", status: "answered", payload,
      createdByAgentId: column === "createdByAgentId" ? id : null,
      resolvedByAgentId: column === "resolvedByAgentId" ? id : null,
    }))).returning();

    expect(await createAgentLifecycle(db).purgeAgent(agentId)).toMatchObject({ id: agentId });

    expect(await db.select().from(agents).where(eq(agents.id, agentId))).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, deleted!.id)))
      .toMatchObject([{ id: deleted!.id, status: "answered", [column]: null }]);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, unrelated!.id)))
      .toMatchObject([{ id: unrelated!.id, [column]: otherAgentId }]);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("agent deletion issue references", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-deletion-");
    db = createDb(temporary.connectionString);
  });

  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["assigneeAgentId", "createdByAgentId"] as const)(
    "clears only %s when purging an agent on a shared issue",
    async deletedReference => {
      const companyId = randomUUID(), deletedId = randomUUID(), survivingId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Agent deletion", issuePrefix: `D${companyId.slice(0, 6)}` });
      await db.insert(agents).values([deletedId, survivingId].map(id => ({ id, companyId,
        name: "Worker", status: "terminated", lifecycleState: "terminated" as const })));
      const survivingReference = deletedReference === "assigneeAgentId" ? "createdByAgentId" : "assigneeAgentId";
      const [shared, both, unrelated] = await db.insert(issues).values([
        { companyId, title: "Shared issue", [deletedReference]: deletedId, [survivingReference]: survivingId },
        { companyId, title: "Both references", assigneeAgentId: deletedId, createdByAgentId: deletedId },
        { companyId, title: "Unrelated issue", assigneeAgentId: survivingId, createdByAgentId: survivingId },
      ]).returning();

      expect(await createAgentLifecycle(db).purgeAgent(deletedId)).toMatchObject({ id: deletedId });

      expect(await db.select().from(issues).where(eq(issues.id, shared!.id))).toMatchObject([
        { [deletedReference]: null, [survivingReference]: survivingId },
      ]);
      expect(await db.select().from(issues).where(eq(issues.id, both!.id))).toMatchObject([
        { assigneeAgentId: null, createdByAgentId: null },
      ]);
      expect(await db.select().from(issues).where(eq(issues.id, unrelated!.id))).toEqual([unrelated]);
      expect(await db.select().from(agents).where(eq(agents.id, deletedId))).toHaveLength(0);
      expect(await db.select().from(agents).where(eq(agents.id, survivingId))).toHaveLength(1);
    },
  );
});

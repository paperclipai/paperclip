import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, heartbeatRuns, inboxDismissals } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deleteCompany } from "./company-deletion.js";

describe("company deletion with activity", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("company-deletion-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Used company", issuePrefix: `U${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "terminated",
      lifecycleState: "terminated" as const });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning();
    await db.insert(costEvents).values({ companyId, agentId, heartbeatRunId: run!.id, provider: "anthropic",
      model: "claude", costCents: 1, occurredAt: new Date() });
    const [dismissal] = await db.insert(inboxDismissals).values({ companyId, userId: "board",
      itemKey: `approval:${randomUUID()}` }).returning();
    return { companyId, dismissal: dismissal! };
  }

  it("deletes a company that has cost events and inbox dismissals", async () => {
    const f = await fixture(), other = await fixture();

    expect(await deleteCompany(db, f.companyId)).toMatchObject({ id: f.companyId });

    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
    expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.id, other.dismissal.id)))
      .toEqual([other.dismissal]);
  });
});

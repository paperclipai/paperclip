import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company reactivate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService.reactivate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-reactivate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(overrides: Partial<typeof companies.$inferInsert>) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Reactivate Test Co",
      issuePrefix: `R${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...overrides,
    });
    return id;
  }

  async function statusOf(id: string) {
    const [row] = await db
      .select({ status: companies.status, pauseReason: companies.pauseReason })
      .from(companies)
      .where(eq(companies.id, id));
    return row;
  }

  it("clears a manual pause and activates", async () => {
    const id = await seedCompany({ status: "paused", pauseReason: "manual", pausedAt: new Date() });
    const result = await companyService(db).reactivate(id);
    expect(result.outcome).toBe("reactivated");
    expect(await statusOf(id)).toEqual({ status: "active", pauseReason: null });
  });

  it("clears a system pause and activates", async () => {
    const id = await seedCompany({ status: "paused", pauseReason: "system", pausedAt: new Date() });
    const result = await companyService(db).reactivate(id);
    expect(result.outcome).toBe("reactivated");
    expect(await statusOf(id)).toEqual({ status: "active", pauseReason: null });
  });

  it("refuses a budget pause without changing state", async () => {
    const id = await seedCompany({ status: "paused", pauseReason: "budget", pausedAt: new Date() });
    const result = await companyService(db).reactivate(id);
    expect(result.outcome).toBe("budget_blocked");
    expect(await statusOf(id)).toEqual({ status: "paused", pauseReason: "budget" });
  });

  it("reactivates an archived-paused company and resumes its archived-paused agents", async () => {
    const id = await seedCompany({ status: "paused", pauseReason: "company_archived", pausedAt: new Date() });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: id,
      name: "Archived Agent",
      role: "engineer",
      status: "paused",
      pauseReason: "company_archived",
      pausedAt: new Date(),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await companyService(db).reactivate(id);
    expect(result.outcome).toBe("reactivated");
    expect(await statusOf(id)).toEqual({ status: "active", pauseReason: null });

    const [agent] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent).toEqual({ status: "idle", pauseReason: null });
  });

  it("returns already_active for an active company", async () => {
    const id = await seedCompany({ status: "active" });
    const result = await companyService(db).reactivate(id);
    expect(result.outcome).toBe("already_active");
  });
});

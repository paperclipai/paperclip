import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, goals } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goalService root company goal invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof goalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goals-service-");
    db = createDb(tempDb.connectionString);
    svc = goalService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Co",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("rejects deleting the only root company-level goal", async () => {
    const companyId = await seedCompany();
    const g1 = await svc.create(companyId, {
      title: "Mission",
      level: "company",
      status: "active",
      parentId: null,
    });

    await expect(svc.remove(g1.id)).rejects.toMatchObject({
      status: 422,
      message: "Companies must keep at least one root company-level goal.",
    });
  });

  it("allows deleting one root company goal when another remains", async () => {
    const companyId = await seedCompany();
    const a = await svc.create(companyId, {
      title: "A",
      level: "company",
      status: "active",
      parentId: null,
    });
    await svc.create(companyId, {
      title: "B",
      level: "company",
      status: "active",
      parentId: null,
    });

    const removed = await svc.remove(a.id);
    expect(removed?.id).toBe(a.id);
  });

  it("rejects demoting the only root company-level goal via update", async () => {
    const companyId = await seedCompany();
    const g1 = await svc.create(companyId, {
      title: "Mission",
      level: "company",
      status: "active",
      parentId: null,
    });

    await expect(svc.update(g1.id, { level: "team" })).rejects.toMatchObject({ status: 422 });
  });

  it("allows renaming the only root company goal", async () => {
    const companyId = await seedCompany();
    const g1 = await svc.create(companyId, {
      title: "Mission",
      level: "company",
      status: "active",
      parentId: null,
    });

    const updated = await svc.update(g1.id, { title: "North star" });
    expect(updated?.title).toBe("North star");
  });
});

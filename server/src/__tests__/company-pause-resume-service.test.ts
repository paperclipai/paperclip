import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping company pause/resume service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company pause/resume service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("sets pausedAt and manual pauseReason when pausing without active runs", async () => {
    const companyId = await seedCompany();

    const paused = await companyService(db).pause(companyId, false);
    expect(paused?.status).toBe("paused");
    expect(paused?.pauseReason).toBe("manual");
    expect(paused?.pausedAt).toBeInstanceOf(Date);
  });

  it("clears pausedAt and pauseReason when resuming", async () => {
    const companyId = await seedCompany();
    await companyService(db).pause(companyId, true);

    const resumed = await companyService(db).resume(companyId);
    expect(resumed?.status).toBe("active");
    expect(resumed?.pauseReason).toBeNull();
    expect(resumed?.pausedAt).toBeNull();

    const row = await db
      .select({
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    expect(row?.status).toBe("active");
    expect(row?.pauseReason).toBeNull();
    expect(row?.pausedAt).toBeNull();
  });
});

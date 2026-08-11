import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companySkills, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill risk-tier backfill", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-risk-backfill-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("classifies a mixed batch into the expected tiers and leaves overrides untouched", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });
    const svc = companySkillService(db);

    const [moneySkill] = await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/invoice-skill`,
      slug: "invoice-skill",
      name: "Invoice Skill",
      markdown: "Calculates pricing and submits payment.",
    }).returning();
    const [writeSkill] = await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/notes-skill`,
      slug: "notes-skill",
      name: "Notes Skill",
      markdown: "Writes a new record to the notes file.",
    }).returning();
    const [readSkill] = await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/summary-skill`,
      slug: "summary-skill",
      name: "Summary Skill",
      markdown: "Reads and summarizes the PR.",
    }).returning();
    const [overriddenSkill] = await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/overridden-skill`,
      slug: "overridden-skill",
      name: "Overridden Skill",
      markdown: "Reads and summarizes the PR.",
      riskTier: 1,
      riskTierSource: "override",
      riskTierRationale: { reason: "manual review", previousTier: 2, previousSource: "unclassified" },
    }).returning();

    const results = await Promise.all(
      [moneySkill, writeSkill, readSkill, overriddenSkill].map((row) =>
        svc.runRiskClassifierForSkill(companyId, row!.id, null)),
    );

    expect(results[0]!.skill.riskTier).toBe(2);
    expect(results[0]!.skipped).toBe(false);
    expect(results[1]!.skill.riskTier).toBe(1);
    expect(results[1]!.skipped).toBe(false);
    expect(results[2]!.skill.riskTier).toBe(0);
    expect(results[2]!.skipped).toBe(false);
    expect(results[3]!.skill.riskTier).toBe(1);
    expect(results[3]!.skipped).toBe(true);

    const rows = await db.select().from(companySkills).where(eq(companySkills.companyId, companyId));
    const tierCounts = rows.reduce<Record<number, number>>((acc, row) => {
      acc[row.riskTier] = (acc[row.riskTier] ?? 0) + 1;
      return acc;
    }, {});
    expect(tierCounts).toEqual({ 0: 1, 1: 2, 2: 1 });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companySkills, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("companySkillService risk tier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-risk-tier-");
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

  async function seedSkill(companyId: string, overrides: Partial<typeof companySkills.$inferInsert> = {}) {
    const [row] = await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/test-skill`,
      slug: "test-skill",
      name: "Test Skill",
      markdown: "# Test Skill\n\nReads a summary.",
      ...overrides,
    }).returning();
    return row!;
  }

  it("defaults new skills to riskTier 2 and source unclassified", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });
    const skill = await seedSkill(companyId);

    expect(skill.riskTier).toBe(2);
    expect(skill.riskTierSource).toBe("unclassified");
  });

  it("overrideRiskTier sets source=override and preserves it across a classifier re-run", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });
    const skill = await seedSkill(companyId, {
      markdown: "# Read-only lookup\n\nJust reads and summarizes.",
    });
    const svc = companySkillService(db);

    const overridden = await svc.overrideRiskTier(
      companyId,
      skill.id,
      { riskTier: 1, reason: "Manual review: this also writes an audit note." },
      null,
    );
    expect(overridden.riskTier).toBe(1);
    expect(overridden.riskTierSource).toBe("override");

    const { skill: reclassified, skipped } = await svc.runRiskClassifierForSkill(companyId, skill.id, null);
    expect(skipped).toBe(true);
    expect(reclassified.riskTier).toBe(1);
    expect(reclassified.riskTierSource).toBe("override");
  });

  it("runRiskClassifierForSkill classifies an unclassified skill via the rule engine", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });
    const skill = await seedSkill(companyId, {
      markdown: "# Submit Invoice\n\nCalculates pricing and submits payment.",
    });
    const svc = companySkillService(db);

    const { skill: classified, skipped } = await svc.runRiskClassifierForSkill(companyId, skill.id, null);
    expect(skipped).toBe(false);
    expect(classified.riskTier).toBe(2);
    expect(classified.riskTierSource).toBe("rule_engine");
    expect(classified.riskTierRationale?.matchedRule).toBe("money_tool_touch");
  });
});

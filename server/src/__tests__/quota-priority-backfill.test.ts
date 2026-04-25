import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { backfillAgentPriorityTiers } from "../services/quota-priority-backfill.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quota priority backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("backfillAgentPriorityTiers (PMSA-17)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-quota-priority-backfill-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    input: {
      name: string;
      role: string;
      metadata?: Record<string, unknown> | null;
      status?: string;
    },
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: input.role as any,
      status: (input.status ?? "idle") as any,
      metadata: input.metadata ?? null,
    });
    return id;
  }

  it("assigns the documented tiers for the 5-agent MVP", async () => {
    const companyId = await seedCompany();
    const ceo = await seedAgent(companyId, { name: "CEO", role: "ceo" });
    const engineer = await seedAgent(companyId, {
      name: "Engineer",
      role: "engineer",
    });
    const prdWriter = await seedAgent(companyId, {
      name: "PRDWriter",
      role: "pm",
    });
    const insightAnalyst = await seedAgent(companyId, {
      name: "InsightAnalyst",
      role: "researcher",
    });
    const techResearcher = await seedAgent(companyId, {
      name: "TechResearcher",
      role: "researcher",
    });

    const result = await backfillAgentPriorityTiers(db);
    expect(result.scanned).toBe(5);
    expect(result.updated).toHaveLength(5);
    expect(result.skipped).toBe(0);

    const tiers = new Map(
      (
        await db
          .select({ id: agents.id, metadata: agents.metadata })
          .from(agents)
      ).map((row) => [
        row.id,
        (row.metadata as Record<string, unknown> | null)?.priorityTier,
      ]),
    );
    expect(tiers.get(ceo)).toBe("p0");
    expect(tiers.get(engineer)).toBe("p1");
    expect(tiers.get(prdWriter)).toBe("p2");
    expect(tiers.get(insightAnalyst)).toBe("p2");
    expect(tiers.get(techResearcher)).toBe("p3");
  });

  it("preserves a previously-set valid tier", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId, {
      name: "Engineer",
      role: "engineer",
      metadata: { priorityTier: "p0", note: "manual override" },
    });

    const result = await backfillAgentPriorityTiers(db);
    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);

    const row = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    const meta = row?.metadata as Record<string, unknown> | null;
    expect(meta?.priorityTier).toBe("p0");
    expect(meta?.note).toBe("manual override");
  });

  it("rewrites an invalid stored tier to the role default", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId, {
      name: "Engineer",
      role: "engineer",
      metadata: { priorityTier: "p9", retainedField: 42 },
    });

    const result = await backfillAgentPriorityTiers(db);
    expect(result.updated).toHaveLength(1);
    const row = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    const meta = row?.metadata as Record<string, unknown> | null;
    expect(meta?.priorityTier).toBe("p1");
    expect(meta?.retainedField).toBe(42);
  });

  it("skips terminated agents", async () => {
    const companyId = await seedCompany();
    const id = await seedAgent(companyId, {
      name: "Old",
      role: "engineer",
      status: "terminated",
    });

    const result = await backfillAgentPriorityTiers(db);
    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toBeGreaterThan(0);
    const row = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    expect(row?.metadata).toBeNull();
  });

  it("is idempotent across repeated runs", async () => {
    const companyId = await seedCompany();
    await seedAgent(companyId, { name: "CEO", role: "ceo" });

    const first = await backfillAgentPriorityTiers(db);
    expect(first.updated).toHaveLength(1);
    const second = await backfillAgentPriorityTiers(db);
    expect(second.updated).toHaveLength(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  executionReceipts,
  heartbeatRuns,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  emitExecutionReceipt,
  getReceiptsBySkillVersion,
  shouldEmitExecutionReceipt,
  verifyReceiptChain,
} from "../services/execution-receipts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Execution Receipts ${randomUUID()}`,
      issuePrefix: `ER${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({ companyId, name: `Agent ${randomUUID()}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function createHeartbeatRun(
  db: Db,
  companyId: string,
  agentId: string,
  overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
) {
  return db
    .insert(heartbeatRuns)
    .values({ companyId, agentId, status: "succeeded", ...overrides })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("execution receipts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-receipts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(executionReceipts);
    await db.delete(toolInvocations);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("round-trips every column through emitExecutionReceipt", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createHeartbeatRun(db, company.id, agent.id, {
      status: "succeeded",
      resultJson: { summary: "did the thing" },
    });
    await db.insert(toolInvocations).values({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id,
      toolName: "Bash",
      status: "succeeded",
      policyDecision: "allow",
      argumentsSummary: { command: "echo hi" } as never,
    });

    const receipt = await emitExecutionReceipt(db, run.id);
    expect(receipt).not.toBeNull();
    expect(receipt!.companyId).toBe(company.id);
    expect(receipt!.agentId).toBe(agent.id);
    expect(receipt!.runId).toBe(run.id);
    expect(receipt!.outcome).toBe("succeeded");
    expect(receipt!.riskTier).toBeNull();
    expect(receipt!.riskTierSource).toBe("fail_safe_default");
    expect(receipt!.chainSeq).toBe(0);
    expect(receipt!.prevReceiptHash).toBeNull();
    expect(receipt!.toolsInvoked).toHaveLength(1);
    expect(receipt!.toolsInvoked[0]!.toolName).toBe("Bash");
    expect(receipt!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const [persisted] = await db.select().from(executionReceipts).where(eq(executionReceipts.id, receipt!.id));
    expect(persisted).toBeDefined();
    expect(persisted!.contentHash).toBe(receipt!.contentHash);
  });

  it("links chainSeq/prevReceiptHash across N sequential inserts for the same company", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const receipts = [];
    for (let i = 0; i < 5; i += 1) {
      const run = await createHeartbeatRun(db, company.id, agent.id, { status: "succeeded" });
      const receipt = await emitExecutionReceipt(db, run.id);
      expect(receipt).not.toBeNull();
      receipts.push(receipt!);
    }

    receipts.forEach((receipt, index) => {
      expect(receipt.chainSeq).toBe(index);
      if (index === 0) {
        expect(receipt.prevReceiptHash).toBeNull();
      } else {
        expect(receipt.prevReceiptHash).toBe(receipts[index - 1]!.contentHash);
      }
    });

    await expect(verifyReceiptChain(db, company.id)).resolves.toEqual({ valid: true });
  });

  it("never inserts a second receipt for the same runId", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createHeartbeatRun(db, company.id, agent.id, { status: "succeeded" });

    const first = await emitExecutionReceipt(db, run.id);
    const second = await emitExecutionReceipt(db, run.id);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const rows = await db.select().from(executionReceipts).where(eq(executionReceipts.runId, run.id));
    expect(rows).toHaveLength(1);
  });

  it("treats an unresolved/null risk tier as mandatory (fail-safe) end-to-end", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const run = await createHeartbeatRun(db, company.id, agent.id, { status: "succeeded" });

    // The SAG-7615 risk classifier hasn't landed, so getSkillRiskTier stubs to
    // null and the company defaults receiptsTier01Enabled to false -- the
    // fail-safe path must still emit a receipt.
    const receipt = await emitExecutionReceipt(db, run.id);
    expect(receipt).not.toBeNull();
    expect(receipt!.riskTier).toBeNull();
    expect(receipt!.riskTierSource).toBe("fail_safe_default");
  });

  it("filters getReceiptsBySkillVersion by companyId and skillVersionHash", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, otherCompany.id);

    const matchingRun = await createHeartbeatRun(db, company.id, agent.id, { status: "succeeded" });
    const nonMatchingRun = await createHeartbeatRun(db, company.id, agent.id, { status: "succeeded" });
    const otherCompanyRun = await createHeartbeatRun(db, otherCompany.id, otherAgent.id, { status: "succeeded" });

    await emitExecutionReceipt(db, matchingRun.id);
    await emitExecutionReceipt(db, nonMatchingRun.id);
    await emitExecutionReceipt(db, otherCompanyRun.id);

    // skillVersionHash resolution is best-effort/all-null today (SAG-7632
    // plan §7 risk #4). Stamp one row directly to simulate a resolved skill
    // version so the filter itself -- not the (separately tracked) resolver
    // -- is what's under test here.
    await db
      .update(executionReceipts)
      .set({ skillVersionHash: "sha256:abc123" })
      .where(eq(executionReceipts.runId, matchingRun.id));

    const results = await getReceiptsBySkillVersion(db, company.id, "sha256:abc123");
    expect(results).toHaveLength(1);
    expect(results[0]!.runId).toBe(matchingRun.id);

    const noMatch = await getReceiptsBySkillVersion(db, otherCompany.id, "sha256:abc123");
    expect(noMatch).toHaveLength(0);
  });
});

describe("shouldEmitExecutionReceipt (emission gate)", () => {
  it("is always mandatory for Tier-2", () => {
    expect(shouldEmitExecutionReceipt(2, false)).toBe(true);
    expect(shouldEmitExecutionReceipt(2, true)).toBe(true);
  });

  it("is mandatory (fail-safe) when the risk tier is unresolved/null", () => {
    expect(shouldEmitExecutionReceipt(null, false)).toBe(true);
    expect(shouldEmitExecutionReceipt(null, true)).toBe(true);
  });

  it("skips Tier 0/1 by default when the company has not opted in", () => {
    expect(shouldEmitExecutionReceipt(0, false)).toBe(false);
    expect(shouldEmitExecutionReceipt(1, false)).toBe(false);
  });

  it("emits Tier 0/1 once the company opts in", () => {
    expect(shouldEmitExecutionReceipt(0, true)).toBe(true);
    expect(shouldEmitExecutionReceipt(1, true)).toBe(true);
  });
});

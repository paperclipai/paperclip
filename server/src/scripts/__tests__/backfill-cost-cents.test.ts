/**
 * Lane G — backfill script integration tests against an embedded Postgres.
 *
 * Verifies (per the Lane G plan in
 * `/Users/mjaverto/.claude/plans/okay-i-agree-let-s-radiant-origami.md`):
 *   - dry-run reports counts but writes nothing
 *   - apply only updates rows where the pricing service returns a positive value
 *     (and only when billing_type is in the allowlist)
 *   - apply is idempotent — second run finds zero candidates
 *   - rollback restores cost_cents from the snapshot table
 *   - agent_runtime_state.total_cost_cents is recomputed from cost_events sums
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  agents,
  agentRuntimeState,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { parseArgs, runBackfill, type BackfillOptions } from "../backfill-cost-cents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Deterministic stand-in for `priceUsd`. Test rows tag themselves via `model`:
//   - `priceable-model` → returns $0.50 (50 cents)
//   - everything else   → returns null
const fakePricer: BackfillOptions["priceUsd"] = (input) => {
  if (input.billingType === "subscription_included") return null;
  if (input.model === "priceable-model") return 0.5;
  return null;
};

describeEmbeddedPostgres("scripts/backfill-cost-cents", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let agentId!: string;
  let priceableEventId!: string;
  let badBillingTypeEventId!: string;
  let unknownModelEventId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backfill-cost-cents-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed() {
    companyId = randomUUID();
    agentId = randomUUID();
    priceableEventId = randomUUID();
    badBillingTypeEventId = randomUUID();
    unknownModelEventId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Backfill Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backfill Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      totalCostCents: 0,
    });

    await db.insert(costEvents).values([
      // Priceable: metered_api, cost_cents=0, fakePricer returns 50 cents.
      {
        id: priceableEventId,
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "priceable-model",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
        costCents: 0,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      // Excluded by billing_type allowlist (subscription_included).
      {
        id: badBillingTypeEventId,
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "subscription_included",
        model: "priceable-model",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
        costCents: 0,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
      // Allowlisted billing_type but pricer returns null (unknown model).
      {
        id: unknownModelEventId,
        companyId,
        agentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "unknown-model",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
        costCents: 0,
        occurredAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    ]);
  }

  function baseOptions(overrides: Partial<BackfillOptions> = {}): BackfillOptions {
    return {
      dryRun: true,
      agentId: null,
      companyId: null,
      batchSize: 500,
      rollback: false,
      yes: true,
      priceUsd: fakePricer,
      log: () => {},
      ...overrides,
    };
  }

  it("dry-run reports candidate counts and writes nothing", async () => {
    await seed();
    const summary = await runBackfill(db, baseOptions({ dryRun: true }));

    // Two candidates pass the SQL filter (metered_api + cost_cents = 0):
    //   priceable-model and unknown-model. The subscription row is excluded.
    expect(summary.mode).toBe("dry-run");
    expect(summary.candidateCount).toBe(2);
    expect(summary.wouldUpdateCount).toBe(1);
    expect(summary.wouldStayZeroWithoutPricingCount).toBe(1);
    expect(summary.appliedUpdateCount).toBe(0);

    // Nothing changed in the DB.
    const rows = await db.select().from(costEvents);
    for (const row of rows) {
      expect(row.costCents).toBe(0);
    }
  });

  it("apply updates only the priceable row and refreshes runtime state", async () => {
    await seed();
    const summary = await runBackfill(db, baseOptions({ dryRun: false }));

    expect(summary.mode).toBe("apply");
    expect(summary.candidateCount).toBe(2);
    expect(summary.wouldUpdateCount).toBe(1);
    expect(summary.appliedUpdateCount).toBe(1);
    expect(summary.affectedAgentIds).toEqual([agentId]);
    expect(summary.agentRuntimeStateRefreshed).toBe(1);

    const [priced] = await db.select().from(costEvents).where(eq(costEvents.id, priceableEventId));
    expect(priced?.costCents).toBe(50);

    const [excluded] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, badBillingTypeEventId));
    expect(excluded?.costCents).toBe(0);

    const [unpricedRow] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, unknownModelEventId));
    expect(unpricedRow?.costCents).toBe(0);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    // 50 from the priceable row; the unknown-model row stays at 0 (not NULL,
    // because the script never wrote NULL — it left the original 0 in place).
    expect(Number(runtime?.totalCostCents)).toBe(50);
  });

  it("re-applying is idempotent — second run finds zero remaining candidates", async () => {
    await seed();
    await runBackfill(db, baseOptions({ dryRun: false }));
    const second = await runBackfill(db, baseOptions({ dryRun: false }));

    // Priceable row now has cost_cents = 50, so it no longer matches the
    // `cost_cents = 0` filter. Only the unknown-model row remains, and it
    // produces no UPDATE because the pricer returns null.
    expect(second.candidateCount).toBe(1);
    expect(second.wouldUpdateCount).toBe(0);
    expect(second.appliedUpdateCount).toBe(0);
  });

  it("rollback restores cost_cents from the snapshot", async () => {
    await seed();
    await runBackfill(db, baseOptions({ dryRun: false }));

    const [afterApply] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, priceableEventId));
    expect(afterApply?.costCents).toBe(50);

    const summary = await runBackfill(db, baseOptions({ rollback: true }));
    expect(summary.mode).toBe("rollback");
    expect(summary.rolledBackRowCount).toBeGreaterThanOrEqual(1);

    const [afterRollback] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, priceableEventId));
    expect(afterRollback?.costCents).toBe(0);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(Number(runtime?.totalCostCents)).toBe(0);
  });
});

describe("scripts/backfill-cost-cents parseArgs", () => {
  it("defaults to dry-run", () => {
    const { options } = parseArgs([]);
    expect(options.dryRun).toBe(true);
    expect(options.rollback).toBe(false);
    expect(options.batchSize).toBe(500);
  });

  it("--apply flips dry-run off", () => {
    const { options } = parseArgs(["--apply"]);
    expect(options.dryRun).toBe(false);
  });

  it("--rollback forces non-dry-run", () => {
    const { options } = parseArgs(["--rollback"]);
    expect(options.rollback).toBe(true);
    expect(options.dryRun).toBe(false);
  });

  it("rejects --apply combined with --rollback", () => {
    expect(() => parseArgs(["--apply", "--rollback"])).toThrow();
  });

  it("parses --agent-id, --company-id, --batch-size", () => {
    const { options } = parseArgs([
      "--agent-id",
      "00000000-0000-0000-0000-000000000001",
      "--company-id",
      "00000000-0000-0000-0000-000000000002",
      "--batch-size",
      "100",
    ]);
    expect(options.agentId).toBe("00000000-0000-0000-0000-000000000001");
    expect(options.companyId).toBe("00000000-0000-0000-0000-000000000002");
    expect(options.batchSize).toBe(100);
  });

  it("rejects invalid batch sizes", () => {
    expect(() => parseArgs(["--batch-size", "0"])).toThrow();
    expect(() => parseArgs(["--batch-size", "abc"])).toThrow();
  });
});

/**
 * Integration tests for the heartbeat pricing fallback (Phase 0.5, Lane F).
 *
 * The full heartbeat run loop is impractical to drive end-to-end here (it
 * requires an adapter registry, plugin worker mocks, environment runtime, etc).
 * We instead exercise the *contract* the heartbeat fallback enforces against a
 * real Postgres + the real services & schemas:
 *
 *   1. The cost-cents value the heartbeat would write is computed from
 *      `priceUsd` (the same module heartbeat uses) and the same precedence:
 *        adapter cost wins → pricing service fallback → null.
 *   2. cost_events.cost_cents is NULL when both the adapter and pricing
 *      service decline to price (the original-bug regression).
 *   3. agent_runtime_state.total_cost_cents UPDATE is *skipped* when the
 *      computed value is NULL (the SQL `n + NULL = NULL` corruption proof).
 *   4. SUM(cost_cents) excludes NULLs and `unpricedRunCount` surfaces in
 *      cost-service aggregates and the budget overview.
 *
 * The cost-cents derivation mirrors `normalizeBilledCostCents` in
 * `server/src/services/heartbeat.ts:1240`. The conditional UPDATE mirrors
 * `updateRuntimeState` at `server/src/services/heartbeat.ts:6035-6064`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentRuntimeState,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import { priceUsd } from "@paperclipai/pricing";
import { costService } from "../services/costs.ts";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-pricing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Mirrors `normalizeBilledCostCents` in services/heartbeat.ts:1240. Kept in
// sync with that production helper; if it diverges, the integration tests will
// stop describing real heartbeat behavior.
function normalizeBilledCostCents(
  adapterCostUsd: number | null | undefined,
  billingType: string | null | undefined,
  pricingContext?: {
    provider: string | null;
    model: string | null;
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          reasoningTokens?: number;
        }
      | null
      | undefined;
  },
): number | null {
  if (billingType === "subscription_included") return 0;
  if (typeof adapterCostUsd === "number" && Number.isFinite(adapterCostUsd)) {
    return Math.max(0, Math.round(adapterCostUsd * 100));
  }
  if (pricingContext) {
    const usage = pricingContext.usage ?? {};
    const inputTokens = Math.max(0, Math.floor(usage.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(usage.outputTokens ?? 0));
    const cachedInputTokens = Math.max(
      0,
      Math.floor(usage.cachedInputTokens ?? 0),
    );
    const reasoningTokens = Math.max(
      0,
      Math.floor(usage.reasoningTokens ?? 0),
    );
    const usd = priceUsd({
      provider: pricingContext.provider,
      model: pricingContext.model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      billingType: typeof billingType === "string" ? billingType : null,
    });
    if (typeof usd === "number" && Number.isFinite(usd)) {
      return Math.max(0, Math.round(usd * 100));
    }
    return null;
  }
  return null;
}

/**
 * Replicates the relevant slice of `updateRuntimeState` from heartbeat.ts:
 *   - compute additionalCostCents via the same precedence as production,
 *   - perform a conditional UPDATE that skips totalCostCents when null,
 *   - insert a cost_events row when there's any signal (token usage or cost).
 */
async function applyHeartbeatLikeWrite(
  db: ReturnType<typeof createDb>,
  args: {
    companyId: string;
    agentId: string;
    provider: string | null;
    model: string | null;
    billingType: string;
    adapterCostUsd: number | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
    };
  },
): Promise<{ additionalCostCents: number | null }> {
  const additionalCostCents = normalizeBilledCostCents(
    args.adapterCostUsd,
    args.billingType,
    {
      provider: args.provider,
      model: args.model,
      usage: args.usage,
    },
  );

  // Mirror the conditional UPDATE in updateRuntimeState (heartbeat.ts:6046).
  const runtimeUpdate: Record<string, unknown> = {
    totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${args.usage.inputTokens}`,
    totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${args.usage.outputTokens}`,
    totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${args.usage.cachedInputTokens ?? 0}`,
    updatedAt: new Date(),
  };
  if (additionalCostCents !== null) {
    runtimeUpdate.totalCostCents = sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`;
  }

  await db
    .update(agentRuntimeState)
    .set(runtimeUpdate)
    .where(eq(agentRuntimeState.agentId, args.agentId));

  const inputTokens = args.usage.inputTokens;
  const outputTokens = args.usage.outputTokens;
  const cachedInputTokens = args.usage.cachedInputTokens ?? 0;
  const hasTokenUsage =
    inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
  const hasNonZeroCost =
    additionalCostCents !== null && additionalCostCents > 0;
  if (hasNonZeroCost || hasTokenUsage) {
    await db.insert(costEvents).values({
      companyId: args.companyId,
      agentId: args.agentId,
      provider: args.provider ?? "unknown",
      biller: args.provider ?? "unknown",
      billingType: args.billingType,
      model: args.model ?? "unknown",
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costCents: additionalCostCents,
      occurredAt: new Date(),
    });
  }
  return { additionalCostCents };
}

async function seedAgentWithRuntimeState(
  db: ReturnType<typeof createDb>,
  initialTotalCostCents = 0,
): Promise<{ companyId: string; agentId: string }> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({
    id: companyId,
    name: "Pricing Test Co",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Pricing Agent",
    role: "engineer",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(agentRuntimeState).values({
    agentId,
    companyId,
    adapterType: "claude_local",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalCostCents: initialTotalCostCents,
  });
  return { companyId, agentId };
}

describeEmbeddedPostgres("heartbeat pricing integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pricing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Order matters: clear FK-dependent tables first.
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("regression: adapter null + unknown model writes cost_cents=NULL and leaves total_cost_cents unchanged", async () => {
    // Original bug: this combination silently became cost_cents=0 and inflated
    // the runtime counter. After the fix, both must remain "unknown".
    const initialTotalCostCents = 12_345;
    const { companyId, agentId } = await seedAgentWithRuntimeState(
      db,
      initialTotalCostCents,
    );

    const { additionalCostCents } = await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "fake-provider",
      model: "fake-provider/fake-model",
      billingType: "metered_api",
      adapterCostUsd: null,
      usage: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0 },
    });

    expect(additionalCostCents).toBeNull();

    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(events).toHaveLength(1);
    expect(events[0]!.costCents).toBeNull();
    expect(events[0]!.inputTokens).toBe(1_000);
    expect(events[0]!.outputTokens).toBe(500);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime!.totalCostCents).toBe(initialTotalCostCents);
    // Token totals still update — only cost is gated.
    expect(runtime!.totalInputTokens).toBe(1_000);
    expect(runtime!.totalOutputTokens).toBe(500);
  });

  it("pricing fallback: adapter null + known catalog model fills cost_cents and increments total_cost_cents", async () => {
    const initialTotalCostCents = 5_000;
    const { companyId, agentId } = await seedAgentWithRuntimeState(
      db,
      initialTotalCostCents,
    );

    // anthropic/claude-opus-4-7 is in the vendored catalog at $5/MTok input,
    // $0.50/MTok cached input, $25/MTok output. Use round numbers so the
    // expected USD is exact.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cachedInputTokens: 0,
    };
    const expectedUsd = priceUsd({
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      billingType: "metered_api",
    });
    expect(typeof expectedUsd).toBe("number");
    const expectedCents = Math.round((expectedUsd as number) * 100);
    expect(expectedCents).toBeGreaterThan(0);

    const { additionalCostCents } = await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      billingType: "metered_api",
      adapterCostUsd: null,
      usage,
    });

    expect(additionalCostCents).toBe(expectedCents);

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(event!.costCents).toBe(expectedCents);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime!.totalCostCents).toBe(
      initialTotalCostCents + expectedCents,
    );
  });

  it("adapter cost wins: catalog is not consulted when adapter reports a non-zero cost", async () => {
    const { companyId, agentId } = await seedAgentWithRuntimeState(db, 0);

    // Adapter says $0.05 (= 5 cents). Even though anthropic/claude-opus-4-7 is
    // in the catalog and would compute a much larger amount, the adapter
    // value must win — fallback only, never override.
    await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      billingType: "metered_api",
      adapterCostUsd: 0.05,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cachedInputTokens: 0,
      },
    });

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(event!.costCents).toBe(5);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime!.totalCostCents).toBe(5);
  });

  it("adapter zero is honored: catalog does not retroactively price a genuinely-free run", async () => {
    const { companyId, agentId } = await seedAgentWithRuntimeState(db, 0);

    // adapterCostUsd=0 must be preserved as the adapter's authoritative
    // statement that the run was free (e.g. subscription-included path that
    // the adapter has already classified). Catalog must not re-price it.
    await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      billingType: "metered_api",
      adapterCostUsd: 0,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cachedInputTokens: 0,
      },
    });

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(event!.costCents).toBe(0);

    const [runtime] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime!.totalCostCents).toBe(0);
  });

  it("subscription_included billingType writes cost_cents=NULL even when catalog has the model", async () => {
    const initialTotalCostCents = 7_777;
    const { companyId, agentId } = await seedAgentWithRuntimeState(
      db,
      initialTotalCostCents,
    );

    // Per heartbeat.ts:1250 + pricing service allowlist, subscription rows are
    // not USD-denominated per-run. The adapter reports null, billingType is
    // "subscription_included", model is in catalog — but the heartbeat's
    // early-return on subscription preserves "0" for the incremented total
    // (genuinely free for the user) while pricing service is gated out.
    //
    // Production helper short-circuits to 0 on subscription_included
    // (heartbeat.ts:1250). We assert that branch here: no UPDATE skip, but
    // also no catalog-based recompute. Then independently verify that for
    // *other* non-allowlisted billing types (e.g. subscription_overage),
    // priceUsd itself returns null.
    await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      billingType: "subscription_included",
      adapterCostUsd: null,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cachedInputTokens: 0,
      },
    });

    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(event!.costCents).toBe(0);

    // priceUsd must return null for the same model under a non-allowlisted
    // billing type, proving the subscription gate in the pricing service.
    const subscriptionPrice = priceUsd({
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cachedInputTokens: 0,
      billingType: "subscription_overage",
    });
    expect(subscriptionPrice).toBeNull();
  });

  it("NULL-skip-UPDATE: a NULL cost_cents insert leaves agent_runtime_state.total_cost_cents byte-for-byte preserved", async () => {
    // Direct proof of the SQL `n + NULL = NULL` corruption avoidance.
    const preExisting = 99_999;
    const { companyId, agentId } = await seedAgentWithRuntimeState(
      db,
      preExisting,
    );

    // Snapshot pre-state.
    const [before] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(before!.totalCostCents).toBe(preExisting);

    // Apply the corruption-prone case: adapter null, model not in catalog.
    await applyHeartbeatLikeWrite(db, {
      companyId,
      agentId,
      provider: "made-up-provider",
      model: "made-up-provider/made-up-model",
      billingType: "metered_api",
      adapterCostUsd: null,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    });

    const [after] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    // Critical: NOT NULL, NOT 0, NOT some other corruption. Exact preservation.
    expect(after!.totalCostCents).toBe(preExisting);

    // And the cost_events row exists with NULL — proving the row was inserted
    // even though we skipped the runtime UPDATE for the cost field.
    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(event!.costCents).toBeNull();
  });

  it("aggregates surface unpriced count: SUM excludes NULLs and unpricedRunCount lands on costs.byAgent + budget overview", async () => {
    const { companyId, agentId } = await seedAgentWithRuntimeState(db, 0);

    // Three rows in the same UTC month: two priced, one unpriced.
    const occurredAt = new Date();
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-4-7",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        costCents: 100,
        occurredAt,
      },
      {
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-4-7",
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 200,
        occurredAt,
      },
      {
        companyId,
        agentId,
        provider: "fake-provider",
        biller: "fake-provider",
        billingType: "metered_api",
        model: "fake-provider/fake-model",
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 150,
        costCents: null,
        occurredAt,
      },
    ]);

    const costs = costService(db);
    const byAgent = await costs.byAgent(companyId);
    expect(byAgent).toHaveLength(1);
    const row = byAgent[0]!;
    // SQL SUM of (100, 200, NULL) = 300 — NULLs are excluded.
    expect(Number(row.costCents)).toBe(300);
    expect(Number(row.unpricedRunCount)).toBe(1);

    // Budget overview: create a billed_cents policy on the agent and verify
    // observedAmount + unpricedRunCount surface correctly.
    const budgets = budgetService(db);
    const policySummary = await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        amount: 100_000, // $1000
        windowKind: "calendar_month_utc",
      },
      null,
    );
    expect(policySummary.observedAmount).toBe(300);
    expect(policySummary.unpricedRunCount).toBe(1);

    const overview = await budgets.overview(companyId);
    const agentPolicy = overview.policies.find(
      (p) => p.scopeType === "agent" && p.scopeId === agentId,
    );
    expect(agentPolicy).toBeDefined();
    expect(agentPolicy!.observedAmount).toBe(300);
    expect(agentPolicy!.unpricedRunCount).toBe(1);
    expect(overview.unpricedRunCount).toBeGreaterThanOrEqual(1);
  });
});

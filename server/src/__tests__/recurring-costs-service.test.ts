import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { agents, companies, costEvents } from "@paperclipai/db";
import {
  RECURRING_FIXED_BILLING_TYPE,
  createRecurringCostsService,
} from "../services/recurring-costs.ts";
import type { RecurringCostLine } from "@paperclipai/shared";

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

interface InsertedRow {
  companyId: string;
  agentId: string;
  biller: string;
  provider: string;
  model: string;
  billingType: string;
  costCents: number;
  occurredAt: Date;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

interface MakeDbOpts {
  companies: {
    id: string;
    recurringCosts: RecurringCostLine[];
    costAttributionAgentId: string | null;
  }[];
  /** companyId -> id of the agent the ceo-fallback lookup should return for that company (null = none). */
  ceoAgentsByCompany: Record<string, string | null>;
  /** Set of "companyId|biller|model" combos that already have a current-month recurring_fixed event. */
  existingEvents: Set<string>;
}

/**
 * Thin db stub: dispatches based on the table passed to .from(). For the ceo lookup and the
 * existence check, tests must call setNextAgentLookup / setNextExistenceQuery just before the
 * service hits that query, because the mock can't introspect the Drizzle SQL condition.
 */
function makeDb(opts: MakeDbOpts) {
  const inserts: InsertedRow[] = [];
  let existenceQueryContext: { companyId: string | null; biller: string | null; model: string | null } = {
    companyId: null,
    biller: null,
    model: null,
  };
  let agentLookupContext: { companyId: string | null } = { companyId: null };

  type ThenableChain = {
    from: (table: unknown) => ThenableChain;
    where: (cond: unknown) => ThenableChain;
    orderBy: (...args: unknown[]) => ThenableChain;
    limit: (n: number) => ThenableChain;
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
  };

  function makeChain(): ThenableChain {
    let tableRef: unknown = null;
    const chain: ThenableChain = {
      from: vi.fn((table: unknown) => {
        tableRef = table;
        return chain;
      }),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: vi.fn(async (resolve: (value: unknown) => unknown) => {
        if (tableRef === companies) {
          const rows = opts.companies
            .filter((c) => c.recurringCosts.length > 0)
            .map((c) => ({
              id: c.id,
              recurringCosts: c.recurringCosts,
              costAttributionAgentId: c.costAttributionAgentId,
            }));
          return resolve(rows);
        }
        if (tableRef === agents) {
          const ceoId = agentLookupContext.companyId
            ? opts.ceoAgentsByCompany[agentLookupContext.companyId] ?? null
            : null;
          return resolve(ceoId ? [{ id: ceoId }] : []);
        }
        if (tableRef === costEvents) {
          const { companyId, biller, model } = existenceQueryContext;
          const key = `${companyId}|${biller}|${model}`;
          return resolve(opts.existingEvents.has(key) ? [{ id: "existing" }] : []);
        }
        return resolve([]);
      }),
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: InsertedRow) => {
        inserts.push(row);
      }),
    })),
  };

  return {
    db: db as unknown as Parameters<typeof createRecurringCostsService>[0]["db"],
    inserts,
    setNextExistenceQuery(companyId: string, biller: string, model: string) {
      existenceQueryContext = { companyId, biller, model };
    },
    setNextAgentLookup(companyId: string) {
      agentLookupContext = { companyId };
    },
  };
}

describe("recurring-costs service", () => {
  const monthMid = new Date(Date.UTC(2026, 4, 15, 12, 0, 0)); // 2026-05-15 UTC
  const monthStart = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts one cost_event per active line for a company with explicit attribution agent", async () => {
    const line: RecurringCostLine = {
      biller: "anthropic-claude-pro-max",
      provider: "anthropic",
      model: "subscription",
      monthlyCents: 10000,
      startedOn: "2026-05-01",
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "agent-explicit" },
      ],
      ceoAgentsByCompany: { c1: "agent-ceo" },
      existingEvents: new Set(),
    });

    harness.setNextExistenceQuery("c1", line.biller, line.model);

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();

    expect(result).toEqual({ inserted: 1, skipped: 0, companies: 1 });
    expect(harness.inserts).toHaveLength(1);
    const row = harness.inserts[0]!;
    expect(row.companyId).toBe("c1");
    expect(row.agentId).toBe("agent-explicit");
    expect(row.biller).toBe(line.biller);
    expect(row.provider).toBe(line.provider);
    expect(row.model).toBe(line.model);
    expect(row.billingType).toBe(RECURRING_FIXED_BILLING_TYPE);
    expect(row.costCents).toBe(line.monthlyCents);
    expect(row.occurredAt.getTime()).toBe(monthStart.getTime());
    expect(row.inputTokens).toBe(0);
    expect(row.cachedInputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  it("falls back to the first active ceo-role agent when costAttributionAgentId is null", async () => {
    const line: RecurringCostLine = {
      biller: "cloudflare",
      provider: "cloudflare",
      model: "pages-pro",
      monthlyCents: 2000,
      startedOn: "2026-05-01",
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: null },
      ],
      ceoAgentsByCompany: { c1: "agent-ceo" },
      existingEvents: new Set(),
    });

    harness.setNextAgentLookup("c1");
    harness.setNextExistenceQuery("c1", line.biller, line.model);

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result.inserted).toBe(1);
    expect(harness.inserts[0]!.agentId).toBe("agent-ceo");
  });

  it("is idempotent: skips insert when a recurring_fixed event already exists for (company, biller, model) this month", async () => {
    const line: RecurringCostLine = {
      biller: "anthropic-claude-pro-max",
      provider: "anthropic",
      model: "subscription",
      monthlyCents: 10000,
      startedOn: "2026-05-01",
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "agent-explicit" },
      ],
      ceoAgentsByCompany: {},
      existingEvents: new Set([`c1|${line.biller}|${line.model}`]),
    });

    harness.setNextExistenceQuery("c1", line.biller, line.model);

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result).toEqual({ inserted: 0, skipped: 1, companies: 1 });
    expect(harness.inserts).toHaveLength(0);
  });

  it("skips a line whose startedOn is in the future", async () => {
    const line: RecurringCostLine = {
      biller: "future-biller",
      provider: "x",
      model: "y",
      monthlyCents: 500,
      startedOn: "2026-06-01", // strictly after monthMid (2026-05-15)
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "agent-explicit" },
      ],
      ceoAgentsByCompany: {},
      existingEvents: new Set(),
    });

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result).toEqual({ inserted: 0, skipped: 0, companies: 1 });
    expect(harness.inserts).toHaveLength(0);
  });

  it("skips a line whose endedOn is before the current UTC month start", async () => {
    const line: RecurringCostLine = {
      biller: "expired-biller",
      provider: "x",
      model: "y",
      monthlyCents: 500,
      startedOn: "2026-01-01",
      endedOn: "2026-04-30",
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "agent-explicit" },
      ],
      ceoAgentsByCompany: {},
      existingEvents: new Set(),
    });

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result).toEqual({ inserted: 0, skipped: 0, companies: 1 });
    expect(harness.inserts).toHaveLength(0);
  });

  it("includes a line whose endedOn is inside the current UTC month", async () => {
    const line: RecurringCostLine = {
      biller: "ending-this-month",
      provider: "x",
      model: "y",
      monthlyCents: 700,
      startedOn: "2026-01-01",
      endedOn: "2026-05-20",
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "agent-explicit" },
      ],
      ceoAgentsByCompany: {},
      existingEvents: new Set(),
    });
    harness.setNextExistenceQuery("c1", line.biller, line.model);

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result.inserted).toBe(1);
    expect(harness.inserts[0]!.costCents).toBe(700);
  });

  it("skips a company with no explicit attribution and no active ceo-role agent (warns, does not insert)", async () => {
    const line: RecurringCostLine = {
      biller: "orphan-biller",
      provider: "x",
      model: "y",
      monthlyCents: 100,
      startedOn: "2026-05-01",
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: null },
      ],
      ceoAgentsByCompany: { c1: null },
      existingEvents: new Set(),
    });
    harness.setNextAgentLookup("c1");

    const logger = makeLogger();
    const svc = createRecurringCostsService({
      db: harness.db,
      logger,
      now: () => monthMid,
    });

    const result = await svc.tick();
    expect(result).toEqual({ inserted: 0, skipped: 0, companies: 1 });
    expect(harness.inserts).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("computes [monthStart, monthEnd) strictly from `now`", async () => {
    const line: RecurringCostLine = {
      biller: "boundary-biller",
      provider: "x",
      model: "y",
      monthlyCents: 1234,
      startedOn: "2026-05-01",
      endedOn: null,
    };
    const harness = makeDb({
      companies: [
        { id: "c1", recurringCosts: [line], costAttributionAgentId: "a1" },
      ],
      ceoAgentsByCompany: {},
      existingEvents: new Set(),
    });
    harness.setNextExistenceQuery("c1", line.biller, line.model);

    const svc = createRecurringCostsService({
      db: harness.db,
      logger: makeLogger(),
      now: () => monthMid,
    });

    await svc.tick();
    expect(harness.inserts[0]!.occurredAt.getTime()).toBe(monthStart.getTime());
    // sanity: monthEnd is exclusive — May has 31 days
    expect(monthEnd.getTime() - monthStart.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });
});

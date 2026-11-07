import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  diffLedgerTotals,
  emptyLedgerTotals,
  readLedgerTotals,
  resolveStateDbPath,
  type LedgerTotals,
  type ModelUsage,
} from "./ledger-usage.js";

interface Row {
  session_id: string;
  model: string;
  api_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;
  cost_status?: string;
}

/** A state.db with just the columns the adapter reads, matching Hermes' schema. */
function writeLedger(rows: Row[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ledger-test-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT NOT NULL DEFAULT 'unknown'
  )`);
  const insert = db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.session_id,
      r.model,
      r.api_call_count ?? 0,
      r.input_tokens ?? 0,
      r.output_tokens ?? 0,
      r.cache_read_tokens ?? 0,
      r.cache_write_tokens ?? 0,
      r.estimated_cost_usd ?? 0,
      r.actual_cost_usd ?? 0,
      r.cost_status ?? "unknown",
    );
  }
  db.close();
  return dbPath;
}

const totals = (over: Partial<LedgerTotals> = {}): LedgerTotals => ({
  ...emptyLedgerTotals(),
  hasRows: true,
  ...over,
});

/** One model's accumulated usage. `costUsd: null` means the ledger could not price it. */
const used = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  apiCalls: 0,
  costUsd: null,
  ...over,
});

describe("readLedgerTotals", () => {
  it("sums tokens and cost across every model in a session", () => {
    const dbPath = writeLedger([
      {
        session_id: "s1",
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        api_call_count: 3,
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
        estimated_cost_usd: 0.0108,
        cost_status: "estimated",
      },
      {
        session_id: "s1",
        model: "anthropic/claude-sonnet-4",
        api_call_count: 1,
        input_tokens: 500,
        output_tokens: 100,
        actual_cost_usd: 0.003,
        estimated_cost_usd: 0.0029,
        cost_status: "actual",
      },
      { session_id: "other", model: "x", input_tokens: 999999, cost_status: "actual" },
    ]);

    const read = readLedgerTotals("s1", dbPath);
    expect(read).toMatchObject({
      inputTokens: 1500,
      cachedInputTokens: 50,
      outputTokens: 300,
      apiCalls: 4,
      pricedRows: 2,
      unpricedRows: 0,
    });
    // A reconciled actual wins over the estimate for the same row.
    expect(read?.costUsd).toBeCloseTo(0.0138, 10);
  });

  it("refuses a negative cost rather than summing it into the total", () => {
    // OpenRouter publishes prompt/completion of -1 for its router
    // pseudo-models, which produced costs of -$1 per token.
    const dbPath = writeLedger([
      {
        session_id: "s1",
        model: "auto",
        api_call_count: 2,
        input_tokens: 25304,
        output_tokens: 48,
        estimated_cost_usd: -25352,
        cost_status: "estimated",
      },
    ]);

    const read = readLedgerTotals("s1", dbPath);
    expect(read?.costUsd).toBe(0);
    expect(read?.pricedRows).toBe(0);
    // The tokens are real and must survive; only the price is rejected.
    expect(read?.inputTokens).toBe(25304);
    expect(read?.unpricedRows).toBe(1);
    expect(read?.unpricedModels).toEqual(["auto"]);
  });

  it("reports tokens with no cost when the ledger could not price them", () => {
    const dbPath = writeLedger([
      {
        session_id: "s1",
        model: "auto",
        api_call_count: 1,
        input_tokens: 800,
        output_tokens: 90,
        cost_status: "unknown",
      },
    ]);

    const read = readLedgerTotals("s1", dbPath);
    expect(read?.inputTokens).toBe(800);
    expect(read?.costUsd).toBe(0);
    expect(read?.pricedRows).toBe(0);
    expect(read?.unpricedRows).toBe(1);
  });

  it("clamps negative counters reported by a provider", () => {
    const dbPath = writeLedger([
      {
        session_id: "s1",
        model: "m",
        api_call_count: -5,
        input_tokens: -100,
        output_tokens: 7,
        cost_status: "unknown",
      },
    ]);

    expect(readLedgerTotals("s1", dbPath)).toMatchObject({
      inputTokens: 0,
      outputTokens: 7,
      apiCalls: 0,
    });
  });

  it("returns null -- not zero -- when usage cannot be read", () => {
    const dbPath = writeLedger([{ session_id: "s1", model: "m", input_tokens: 1 }]);
    expect(readLedgerTotals("s1", path.join(path.dirname(dbPath), "absent.db"))).toBeNull();
    expect(readLedgerTotals(null, dbPath)).toBeNull();
    expect(readLedgerTotals("s1", null)).toBeNull();
  });

  it("distinguishes a session with no rows yet from a ledger it cannot read", () => {
    const dbPath = writeLedger([{ session_id: "s1", model: "m", input_tokens: 1 }]);

    // Readable ledger, nothing billed to this session yet: a known zero.
    const empty = readLedgerTotals("no-such-session", dbPath);
    expect(empty).not.toBeNull();
    expect(empty).toMatchObject({ inputTokens: 0, costUsd: 0, hasRows: false });

    // Unreadable ledger: unknown, and never silently zero.
    expect(readLedgerTotals("s1", path.join(path.dirname(dbPath), "absent.db"))).toBeNull();
  });

  it("records a per-model breakdown so a delta can tell which models moved", () => {
    const dbPath = writeLedger([
      { session_id: "s1", model: "nemotron", input_tokens: 100, actual_cost_usd: 0.01, cost_status: "actual" },
      { session_id: "s1", model: "auto", input_tokens: 50, cost_status: "unknown" },
    ]);
    const read = readLedgerTotals("s1", dbPath);
    expect(read?.hasRows).toBe(true);
    expect(read?.byModel.nemotron).toMatchObject({ inputTokens: 100, costUsd: 0.01 });
    expect(read?.byModel.auto).toMatchObject({ inputTokens: 50, costUsd: null });
  });
});

describe("diffLedgerTotals", () => {
  it("charges only the growth, because a resumed session's rows accumulate", () => {
    const before = totals({
      inputTokens: 1000,
      outputTokens: 100,
      apiCalls: 2,
      costUsd: 0.01,
      pricedRows: 1,
      byModel: { nemotron: used({ inputTokens: 1000, outputTokens: 100, apiCalls: 2, costUsd: 0.01 }) },
    });
    const after = totals({
      inputTokens: 2500,
      outputTokens: 400,
      apiCalls: 5,
      costUsd: 0.025,
      pricedRows: 1,
      byModel: { nemotron: used({ inputTokens: 2500, outputTokens: 400, apiCalls: 5, costUsd: 0.025 }) },
    });

    const delta = diffLedgerTotals(before, after);
    expect(delta).toMatchObject({
      inputTokens: 1500,
      outputTokens: 300,
      apiCalls: 3,
      priced: true,
      unpriced: false,
    });
    expect(delta?.costUsd).toBeCloseTo(0.015, 10);
  });

  it("charges the full total against a fresh session's empty baseline", () => {
    const delta = diffLedgerTotals(
      emptyLedgerTotals(),
      totals({
        inputTokens: 700,
        costUsd: 0.004,
        pricedRows: 1,
        byModel: { nemotron: used({ inputTokens: 700, costUsd: 0.004 }) },
      }),
    );
    expect(delta).toMatchObject({ inputTokens: 700, priced: true });
    expect(delta?.costUsd).toBeCloseTo(0.004, 10);
  });

  it("is unknown -- not a re-charge of the whole session -- when the baseline could not be read", () => {
    // A resumed session whose pre-run read failed. Treating null as zero would
    // bill this run for every token the session ever used.
    const after = totals({
      inputTokens: 500_000,
      costUsd: 12.5,
      pricedRows: 1,
      byModel: { nemotron: used({ inputTokens: 500_000, costUsd: 12.5 }) },
    });
    expect(diffLedgerTotals(null, after)).toBeNull();
  });

  it("never charges a negative delta", () => {
    const delta = diffLedgerTotals(
      totals({ inputTokens: 500, costUsd: 0.02, byModel: { m: used({ inputTokens: 500, costUsd: 0.02 }) } }),
      totals({ inputTokens: 100, costUsd: 0.01, byModel: { m: used({ inputTokens: 100, costUsd: 0.01 }) } }),
    );
    expect(delta).toMatchObject({ inputTokens: 0, costUsd: 0 });
  });

  it("is unknown when the ledger could not be read after the run", () => {
    expect(diffLedgerTotals(totals({ inputTokens: 5 }), null)).toBeNull();
  });

  it("de-duplicates the unpriced models it reports", () => {
    const delta = diffLedgerTotals(
      emptyLedgerTotals(),
      totals({
        unpricedRows: 2,
        unpricedModels: ["auto", "openrouter/auto"],
        byModel: {
          auto: used({ inputTokens: 10 }),
          "openrouter/auto": used({ inputTokens: 10 }),
        },
      }),
    );
    expect(delta?.unpriced).toBe(true);
    expect(delta?.unpricedModels).toEqual(["auto", "openrouter/auto"]);
  });

  it("judges pricing on the models this run grew, not on the session's history", () => {
    // Yesterday's run priced. This run added only unpriced usage. Reading the
    // session's totals would call the run priced at a cost of $0 -- i.e. free.
    const before = totals({
      inputTokens: 1000,
      costUsd: 0.02,
      pricedRows: 1,
      byModel: { nemotron: used({ inputTokens: 1000, costUsd: 0.02 }) },
    });
    const after = totals({
      inputTokens: 1600,
      costUsd: 0.02,
      pricedRows: 1,
      unpricedRows: 1,
      unpricedModels: ["auto"],
      byModel: {
        nemotron: used({ inputTokens: 1000, costUsd: 0.02 }),
        auto: used({ inputTokens: 600 }),
      },
    });

    const delta = diffLedgerTotals(before, after);
    expect(delta).toMatchObject({
      inputTokens: 600,
      priced: false,
      unpriced: true,
      unpricedModels: ["auto"],
      costUsd: 0,
    });
  });

  it("withholds a partial price when a run grew both a priced and an unpriced model", () => {
    const before = totals({ byModel: { nemotron: used({ costUsd: 0 }) } });
    const after = totals({
      inputTokens: 900,
      costUsd: 0.03,
      pricedRows: 1,
      unpricedRows: 1,
      unpricedModels: ["auto"],
      byModel: {
        nemotron: used({ inputTokens: 300, costUsd: 0.03 }),
        auto: used({ inputTokens: 600 }),
      },
    });

    const delta = diffLedgerTotals(before, after);
    // The known part is kept for the log, but `priced` is false, so the caller
    // reports no cost rather than reporting part of one as the whole.
    expect(delta?.costUsd).toBeCloseTo(0.03, 10);
    expect(delta?.priced).toBe(false);
    expect(delta?.unpriced).toBe(true);
  });

  it("ignores a priced model that did not move", () => {
    const steady = used({ inputTokens: 1000, costUsd: 0.02 });
    const delta = diffLedgerTotals(
      totals({ inputTokens: 1000, costUsd: 0.02, byModel: { nemotron: steady } }),
      totals({ inputTokens: 1000, costUsd: 0.02, byModel: { nemotron: { ...steady } } }),
    );
    expect(delta).toMatchObject({ inputTokens: 0, costUsd: 0, priced: false, unpriced: false });
  });
});

describe("resolveStateDbPath", () => {
  it("prefers explicit config, then HERMES_HOME, then the default home", () => {
    expect(resolveStateDbPath({ hermesStateDb: "/tmp/custom.db" }, {})).toBe("/tmp/custom.db");
    expect(resolveStateDbPath({}, { HERMES_HOME: "/opt/hermes" })).toBe("/opt/hermes/state.db");
    expect(resolveStateDbPath({}, {})).toBe(path.join(os.homedir(), ".hermes", "state.db"));
    // Blank values are not paths.
    expect(resolveStateDbPath({ hermesStateDb: "  " }, { HERMES_HOME: "/opt/hermes" })).toBe(
      "/opt/hermes/state.db",
    );
  });

  it("follows a HOME the child was configured with, not the server's own", () => {
    // config.env can relocate the child's home. Hermes' ledger moves with it,
    // so metering must follow it rather than reading os.homedir().
    expect(resolveStateDbPath({}, { HOME: "/sandbox/agent-7" })).toBe(
      path.join("/sandbox/agent-7", ".hermes", "state.db"),
    );
    // HERMES_HOME still wins over HOME.
    expect(resolveStateDbPath({}, { HOME: "/sandbox/agent-7", HERMES_HOME: "/opt/hermes" })).toBe(
      "/opt/hermes/state.db",
    );
    // A blank HOME is not a path.
    expect(resolveStateDbPath({}, { HOME: "   " })).toBe(
      path.join(os.homedir(), ".hermes", "state.db"),
    );
  });
});

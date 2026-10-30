import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import {
  hasLegacyExecutionSettlement,
  LEGACY_EXECUTION_SETTLEMENT_KEY,
  LEGACY_EXECUTION_SETTLEMENT_SCHEMA,
  legacyExecutionSettlementReceipt,
  readLegacyExecutionSettlement,
  reachedProviderDispatchStage,
} from "../legacy-execution-settlement.js";

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

describe("legacy execution settlement receipts", () => {
  it("accepts a historical settlement recorded in the stage it replaced", () => {
    expect(hasLegacyExecutionSettlement({ resultJson: null, executionStage: "settled" })).toBe(true);
    expect(hasLegacyExecutionSettlement({ resultJson: null, executionStage: "dispatching" })).toBe(false);
    expect(hasLegacyExecutionSettlement({ resultJson: null, executionStage: null })).toBe(false);
  });

  it("ignores a receipt of an unknown schema rather than trusting its fields", () => {
    const stale = { [LEGACY_EXECUTION_SETTLEMENT_KEY]: { schema: "other.v9", settledAt: "2026-01-01T00:00:00.000Z", stage: "preparing" } };
    expect(readLegacyExecutionSettlement({ resultJson: stale, executionStage: "dispatching" })).toBeNull();
    expect(hasLegacyExecutionSettlement({ resultJson: stale, executionStage: "dispatching" })).toBe(false);
  });

  it.each([
    ["dispatching", true],
    ["preparing", false],
    [null, false],
    ["settled", null],
  ] as const)("reports the dispatch claim recorded by stage %s", (executionStage, expected) => {
    expect(reachedProviderDispatchStage({ resultJson: null, executionStage })).toBe(expected);
  });

  it("reads the dispatch claim out of the receipt once the stage has moved on", () => {
    const receipt = {
      [LEGACY_EXECUTION_SETTLEMENT_KEY]: {
        schema: LEGACY_EXECUTION_SETTLEMENT_SCHEMA, settledAt: "2026-01-01T00:00:00.000Z",
        controllerBootId: null, stage: "dispatching",
      },
    };
    expect(reachedProviderDispatchStage({ resultJson: receipt, executionStage: "preparing" })).toBe(true);
    expect(hasLegacyExecutionSettlement({ resultJson: receipt, executionStage: "preparing" })).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("the settlement write", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  const bootId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-settlement-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settlement test", issuePrefix: `S${companyId.slice(0, 7)}` });
    agentId = (await db.insert(agents).values({ companyId, name: "Agent", status: "idle" }).returning())[0]!.id;
  });

  async function seed(status: string, executionStage: string | null, resultJson: Record<string, unknown> | null = null) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status, invocationSource: "on_demand", runtimeMode: "legacy",
      executionStage, resultJson: resultJson as never, controllerBootId: bootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(), finishedAt: new Date(),
    }).returning();
    return run!;
  }

  async function settle(settledAt = new Date()) {
    await db.update(heartbeatRuns).set({
      resultJson: legacyExecutionSettlementReceipt(settledAt, bootId),
      controllerLeaseExpiresAt: null,
    }).where(and(eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.controllerBootId, bootId),
      inArray(heartbeatRuns.status, TERMINAL)));
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("keeps the dispatch claim readable instead of overwriting it with the settlement", async () => {
    const run = await seed("cancelled", "dispatching");
    const settledAt = new Date();
    await settle(settledAt);
    const settled = await read(run.id);
    expect(settled.executionStage).toBe("dispatching");
    expect(settled.controllerLeaseExpiresAt).toBeNull();
    expect(readLegacyExecutionSettlement(settled)).toEqual({
      settledAt: settledAt.toISOString(), controllerBootId: bootId, stage: "dispatching",
    });
    expect(hasLegacyExecutionSettlement(settled)).toBe(true);
    expect(reachedProviderDispatchStage(settled)).toBe(true);
  });

  it("records a run that never claimed dispatch as exactly that", async () => {
    const run = await seed("cancelled", "preparing");
    await settle();
    const settled = await read(run.id);
    expect(settled.executionStage).toBe("preparing");
    expect(reachedProviderDispatchStage(settled)).toBe(false);
  });

  it("settles only cancelled runs, as the stage write it replaces did", async () => {
    const runs = await Promise.all(TERMINAL.map(status => seed(status, "dispatching")));
    await settle();
    for (const run of runs) {
      const settled = await read(run.id);
      expect(settled.executionStage).toBe("dispatching");
      expect(hasLegacyExecutionSettlement(settled)).toBe(run.status === "cancelled");
      expect(settled.controllerLeaseExpiresAt).toBeNull();
    }
  });

  it("preserves unrelated result fields and does not consume the stage on a re-run", async () => {
    const run = await seed("cancelled", "dispatching", { startupCancellation: { beforeNativeSelection: false }, stopReason: "operator" });
    await settle(new Date(1_800_000_000_000));
    const again = new Date(1_800_000_060_000);
    await settle(again);
    const settled = await read(run.id);
    expect(settled.resultJson).toMatchObject({ startupCancellation: { beforeNativeSelection: false }, stopReason: "operator" });
    expect(readLegacyExecutionSettlement(settled)).toEqual({
      settledAt: again.toISOString(), controllerBootId: bootId, stage: "dispatching",
    });
    expect(settled.executionStage).toBe("dispatching");
  });

  it("leaves a run owned by another controller boot untouched", async () => {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "cancelled", invocationSource: "on_demand", runtimeMode: "legacy",
      executionStage: "dispatching", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date(), finishedAt: new Date(),
    }).returning();
    await settle();
    const other = await read(run!.id);
    expect(hasLegacyExecutionSettlement(other)).toBe(false);
    expect(other.controllerLeaseExpiresAt).not.toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bettingBankrollSnapshots, companies, createDb } from "@paperclipai/db";
import { bettingStopLossService } from "../services/betting-stop-loss.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres betting stop-loss tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("bettingStopLossService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-betting-stop-loss-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__telegramBot;
    await db.delete(bettingBankrollSnapshots);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocks when the daily drawdown reaches the approved threshold", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip BET",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(bettingBankrollSnapshots).values([
      {
        companyId,
        balance: 1100,
        currency: "RON",
        totalBets: 0,
        wonBets: 0,
        lostBets: 0,
        voidBets: 0,
        totalStaked: 0,
        totalReturn: 0,
        roi: 0,
        snapshotAt: new Date("2026-04-24T00:05:00.000Z"),
      },
      {
        companyId,
        balance: 1044,
        currency: "RON",
        totalBets: 1,
        wonBets: 0,
        lostBets: 1,
        voidBets: 0,
        totalStaked: 56,
        totalReturn: 0,
        roi: -100,
        snapshotAt: new Date("2026-04-24T09:00:00.000Z"),
      },
    ]);

    const result = await bettingStopLossService(db).preflight({
      companyId,
      at: "2026-04-24T09:05:00.000Z",
      currentBalance: 1044,
      notifyOnTrigger: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.triggers).toEqual(["daily"]);
    expect(result.daily.baselineBalance).toBe(1100);
    expect(result.daily.floorBalance).toBeCloseTo(1045, 5);
    expect(result.daily.lossPct).toBeCloseTo(56 / 1100, 5);
  });

  it("blocks when the session drawdown reaches the approved threshold and sends one telegram alert", async () => {
    const companyId = randomUUID();
    const send = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__telegramBot = { send };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip BET",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(bettingBankrollSnapshots).values([
      {
        companyId,
        balance: 1098.74,
        currency: "RON",
        totalBets: 0,
        wonBets: 0,
        lostBets: 0,
        voidBets: 0,
        totalStaked: 0,
        totalReturn: 0,
        roi: 0,
        snapshotAt: new Date("2026-04-24T01:30:00.000Z"),
      },
      {
        companyId,
        balance: 988,
        currency: "RON",
        totalBets: 3,
        wonBets: 0,
        lostBets: 3,
        voidBets: 0,
        totalStaked: 110.74,
        totalReturn: 0,
        roi: -100,
        snapshotAt: new Date("2026-04-24T04:30:00.000Z"),
      },
    ]);

    const svc = bettingStopLossService(db);
    const first = await svc.preflight({
      companyId,
      at: "2026-04-24T04:35:00.000Z",
      currentBalance: 988,
      sessionStartedAt: "2026-04-24T01:30:00.000Z",
      source: "executor_pre_bet_check",
    });
    const second = await svc.preflight({
      companyId,
      at: "2026-04-24T04:36:00.000Z",
      currentBalance: 988,
      sessionStartedAt: "2026-04-24T01:30:00.000Z",
      source: "executor_pre_bet_check",
    });

    expect(first.allowed).toBe(false);
    expect(first.triggers).toContain("session");
    expect(first.session.floorBalance).toBeCloseTo(988.866, 3);
    expect(first.session.lossPct).toBeGreaterThanOrEqual(0.10);
    expect(second.allowed).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("allows a bet when both stop-loss checks remain under the threshold", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip BET",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(bettingBankrollSnapshots).values([
      {
        companyId,
        balance: 1098.74,
        currency: "RON",
        totalBets: 0,
        wonBets: 0,
        lostBets: 0,
        voidBets: 0,
        totalStaked: 0,
        totalReturn: 0,
        roi: 0,
        snapshotAt: new Date("2026-04-24T01:30:00.000Z"),
      },
      {
        companyId,
        balance: 1075,
        currency: "RON",
        totalBets: 2,
        wonBets: 1,
        lostBets: 1,
        voidBets: 0,
        totalStaked: 40,
        totalReturn: 16.26,
        roi: -59.35,
        snapshotAt: new Date("2026-04-24T03:00:00.000Z"),
      },
    ]);

    const result = await bettingStopLossService(db).preflight({
      companyId,
      at: "2026-04-24T03:05:00.000Z",
      currentBalance: 1075,
      sessionStartedAt: "2026-04-24T01:30:00.000Z",
      notifyOnTrigger: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.triggers).toEqual([]);
    expect(result.reason).toBeNull();
  });

  it("fails closed when no bankroll snapshots exist yet", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip BET",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const result = await bettingStopLossService(db).preflight({
      companyId,
      notifyOnTrigger: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.currentBalance).toBeNull();
    expect(result.reason).toContain("Missing bankroll baseline");
  });
});

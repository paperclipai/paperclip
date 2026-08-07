import { describe, expect, it, vi } from "vitest";
import {
  getAssignmentLivenessWarnings,
  getAssignmentLivenessState,
  listAssignmentLivenessByAgentIds,
} from "../services/agent-assignability.js";

const COMPANY_ID = "company-1";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Minimal drizzle-shaped db stub: select().from().where().then() resolves to a
 * configurable row set. Mirrors the chainable pattern used by the surrounding
 * route/service test suites.
 */
function dbReturning(rows: Record<string, unknown>[]): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows));
  const select = vi.fn(() => query);
  return { select };
}

function agentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Senior Reviewer",
    status: "running",
    errorReason: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-03-13T09:00:00.000Z"),
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600 } },
    ...overrides,
  };
}

describe("getAssignmentLivenessWarnings (DB-backed)", () => {
  it("returns no warnings when the assignee is not provided", async () => {
    await expect(getAssignmentLivenessWarnings(dbReturning([]), COMPANY_ID, null)).resolves.toEqual([]);
    await expect(getAssignmentLivenessWarnings(dbReturning([]), COMPANY_ID, undefined)).resolves.toEqual([]);
  });

  it("returns no warnings when the agent row is missing", async () => {
    await expect(getAssignmentLivenessWarnings(dbReturning([]), COMPANY_ID, AGENT_ID)).resolves.toEqual([]);
  });

  it("returns no warnings when the agent belongs to a different company", async () => {
    const db = dbReturning([agentRow({ companyId: "other-company" })]);
    await expect(getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID)).resolves.toEqual([]);
  });

  it("warns for an agent explicitly in the error status", async () => {
    const db = dbReturning([agentRow({
      status: "error",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
    })]);
    const warnings = await getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"Senior Reviewer"');
    expect(warnings[0]).toContain("error state");
    expect(warnings[0]).toContain("Process lost");
  });

  it("catches the live LEG-1924 shape: status running, but errorReason + stale heartbeat", async () => {
    const db = dbReturning([agentRow({
      status: "running",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
    })]);
    const warnings = await getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("error state");
    expect(warnings[0]).toContain("Process lost");
  });

  it("does not false-positive when errorReason lingers but the agent is actively heartbeating", async () => {
    const db = dbReturning([agentRow({
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: new Date(),
    })]);
    await expect(getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID)).resolves.toEqual([]);
  });

  it("does not flag on-demand (heartbeat-disabled) agents as stale", async () => {
    const db = dbReturning([agentRow({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: false } },
      lastHeartbeatAt: new Date("2024-01-01T00:00:00.000Z"),
    })]);
    await expect(getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID)).resolves.toEqual([]);
  });

  it("parses runtimeConfig defensively when malformed", async () => {
    const db = dbReturning([agentRow({
      status: "idle",
      runtimeConfig: "not-an-object" as unknown as Record<string, unknown>,
      lastHeartbeatAt: new Date("2024-01-01T00:00:00.000Z"),
    })]);
    // heartbeat disabled (unparseable) => not stale => no warning
    await expect(getAssignmentLivenessWarnings(db, COMPANY_ID, AGENT_ID)).resolves.toEqual([]);
  });
});

describe("getAssignmentLivenessState (LEG-1928 read-model shape)", () => {
  it("returns null when there is no assignee agent", async () => {
    await expect(getAssignmentLivenessState(dbReturning([]), COMPANY_ID, null)).resolves.toBeNull();
    await expect(getAssignmentLivenessState(dbReturning([]), COMPANY_ID, undefined)).resolves.toBeNull();
  });

  it("returns null when the agent row is missing or cross-company", async () => {
    await expect(getAssignmentLivenessState(dbReturning([]), COMPANY_ID, AGENT_ID)).resolves.toBeNull();
    const db = dbReturning([agentRow({ companyId: "other-company" })]);
    await expect(getAssignmentLivenessState(db, COMPANY_ID, AGENT_ID)).resolves.toBeNull();
  });

  it("reports live for a healthy agent", async () => {
    const db = dbReturning([agentRow({ status: "running", lastHeartbeatAt: new Date() })]);
    await expect(getAssignmentLivenessState(db, COMPANY_ID, AGENT_ID)).resolves.toEqual({ state: "live" });
  });

  it("reports the error state with the reason", async () => {
    const db = dbReturning([agentRow({
      status: "error",
      errorReason: "Process lost -- child pid 93238",
      lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z"),
    })]);
    await expect(getAssignmentLivenessState(db, COMPANY_ID, AGENT_ID)).resolves.toEqual({
      state: "error",
      reason: "Process lost -- child pid 93238",
    });
  });

  it("reports the paused state", async () => {
    const db = dbReturning([agentRow({ status: "paused", lastHeartbeatAt: new Date() })]);
    await expect(getAssignmentLivenessState(db, COMPANY_ID, AGENT_ID)).resolves.toEqual({
      state: "paused",
      reason: null,
    });
  });
});

describe("listAssignmentLivenessByAgentIds (board batch lookup)", () => {
  const AGENT_TWO = "22222222-2222-4222-8222-222222222222";

  it("returns an empty map when there are no agent ids", async () => {
    const map = await listAssignmentLivenessByAgentIds(dbReturning([]), COMPANY_ID, [null, undefined]);
    expect(map.size).toBe(0);
  });

  it("dedupes agent ids and resolves each to its liveness summary", async () => {
    const db = dbReturning([
      agentRow({ id: AGENT_ID, status: "error", errorReason: "boom", lastHeartbeatAt: new Date("2026-07-31T10:03:20.635Z") }),
      agentRow({ id: AGENT_TWO, status: "running", lastHeartbeatAt: new Date() }),
    ]);
    const map = await listAssignmentLivenessByAgentIds(db, COMPANY_ID, [AGENT_ID, AGENT_ID, AGENT_TWO]);
    expect(map.size).toBe(2);
    expect(map.get(AGENT_ID)).toEqual({ state: "error", reason: "boom" });
    expect(map.get(AGENT_TWO)).toEqual({ state: "live" });
  });

  it("skips agents that belong to a different company", async () => {
    const db = dbReturning([agentRow({ id: AGENT_ID, companyId: "other-company" })]);
    const map = await listAssignmentLivenessByAgentIds(db, COMPANY_ID, [AGENT_ID]);
    expect(map.has(AGENT_ID)).toBe(false);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  heartbeatRuns,
  budgetPolicies,
  budgetIncidents,
  approvals,
  activityLog,
  instanceSettings,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { perRunCeilingService, resolveEffectiveMaxTurns } from "../services/per-run-ceiling.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("G3 per-run ceiling — evaluate", () => {
  const svc = perRunCeilingService({} as never);

  it("returns a fault when a run exceeds the ceiling", () => {
    const fault = svc.evaluate(1_500_000, 1_000_000);
    expect(fault).not.toBeNull();
    expect(fault!.reason).toBe("per_run_ceiling");
    expect(fault!.runTotalTokens).toBe(1_500_000);
    expect(fault!.ceiling).toBe(1_000_000);
  });

  it("returns null at or under the ceiling", () => {
    expect(svc.evaluate(1_000_000, 1_000_000)).toBeNull();
    expect(svc.evaluate(999_999, 1_000_000)).toBeNull();
  });

  it("returns null when the ceiling is disabled (<= 0)", () => {
    expect(svc.evaluate(9_999_999, 0)).toBeNull();
  });
});

describe("G3 turns clamp — resolveEffectiveMaxTurns", () => {
  it("clamps an agent above the floor down to the floor", () => {
    expect(resolveEffectiveMaxTurns(1000, 120)).toBe(120);
  });

  it("keeps an agent configured below the floor", () => {
    expect(resolveEffectiveMaxTurns(50, 120)).toBe(50);
  });

  it("clamps an unset/non-positive agent value to the floor", () => {
    expect(resolveEffectiveMaxTurns(null, 120)).toBe(120);
    expect(resolveEffectiveMaxTurns(0, 120)).toBe(120);
    expect(resolveEffectiveMaxTurns(undefined, 120)).toBe(120);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("G3 per-run ceiling — trip side effects", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-per-run-ceiling-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      status: "active",
    });
    return { companyId, agentId };
  }

  it("pauses the agent + opens a per_run_ceiling incident when tripped", async () => {
    const { companyId, agentId } = await seed();
    const svc = perRunCeilingService(db);

    const fault = svc.evaluate(2_000_000, 1_000_000);
    expect(fault).not.toBeNull();
    await svc.trip(companyId, agentId, fault!);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0]!);
    expect(agent.status).toBe("paused");
    expect(agent.pauseReason).toBe("budget");

    const incident = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.scopeId, agentId))
      .then((r) => r[0] ?? null);
    expect(incident).not.toBeNull();
    expect(incident!.status).toBe("open");
    expect(incident!.amountObserved).toBe(2_000_000);
    expect(incident!.amountLimit).toBe(1_000_000);

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId))
      .then((r) => r[0] ?? null);
    expect(approval).not.toBeNull();
    expect(approval!.type).toBe("budget_override_required");
    const payload = approval!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("per_run_ceiling");
    expect(payload.perRunCeilingExceeded).toBe(true);
  });
});

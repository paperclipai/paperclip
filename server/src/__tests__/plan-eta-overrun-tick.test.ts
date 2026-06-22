/**
 * Integration tests for tickPlanEtaOverruns (plan-supervision.ts).
 *
 * Uses embedded Postgres for real SQL + a vi.fn() mock for the wakeup dep.
 * Verifies: overdue plans trigger wakeup exactly once, etaOverrunNotifiedAt is
 * stamped, non-qualifying plans are skipped, and missing CTO is handled gracefully.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues, planDetails } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { tickPlanEtaOverruns } from "../services/plan-supervision.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plan-eta-overrun-tick tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("tickPlanEtaOverruns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-eta-overrun-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeWakeup() {
    return vi.fn().mockResolvedValue(null);
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedCtoAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "engineering-manager",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  async function seedPlan(
    companyId: string,
    opts: {
      state?: string;
      estimatedCompletionAt?: Date | null;
      etaOverrunNotifiedAt?: Date | null;
      assigneeAgentId?: string | null;
    } = {},
  ) {
    const rootId = randomUUID();
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Test Plan",
      workMode: "planning",
      status: "in_progress",
      assigneeAgentId: opts.assigneeAgentId ?? null,
    });
    await db.insert(planDetails).values({
      issueId: rootId,
      companyId,
      state: opts.state ?? "active",
      estimatedCompletionAt: opts.estimatedCompletionAt ?? null,
      etaOverrunNotifiedAt: opts.etaOverrunNotifiedAt ?? null,
    });
    return rootId;
  }

  it("wakes CTO once for an overdue active plan and stamps etaOverrunNotifiedAt", async () => {
    const companyId = await seedCompany();
    const ctoId = await seedCtoAgent(companyId);
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    const planId = await seedPlan(companyId, { estimatedCompletionAt: pastEta });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(1);
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith(ctoId, expect.objectContaining({
      reason: "plan_eta_overrun",
      payload: { planIssueId: planId },
    }));

    const [row] = await db.select({ etaOverrunNotifiedAt: planDetails.etaOverrunNotifiedAt })
      .from(planDetails)
      .where(eq(planDetails.issueId, planId));
    expect(row?.etaOverrunNotifiedAt).not.toBeNull();
  });

  it("does NOT wake when etaOverrunNotifiedAt is already set (idempotent)", async () => {
    const companyId = await seedCompany();
    await seedCtoAgent(companyId);
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlan(companyId, {
      estimatedCompletionAt: pastEta,
      etaOverrunNotifiedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does NOT wake when ETA is in the future", async () => {
    const companyId = await seedCompany();
    await seedCtoAgent(companyId);
    const futureEta = new Date(Date.now() + 60 * 60 * 1000);
    await seedPlan(companyId, { estimatedCompletionAt: futureEta });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does NOT wake for non-active (stopped) plans", async () => {
    const companyId = await seedCompany();
    await seedCtoAgent(companyId);
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlan(companyId, { state: "stopped", estimatedCompletionAt: pastEta });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(0);
  });

  it("does NOT wake when estimatedCompletionAt is null", async () => {
    const companyId = await seedCompany();
    await seedCtoAgent(companyId);
    await seedPlan(companyId); // no estimatedCompletionAt
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(0);
  });

  it("falls back to plan root assignee when no CTO agent by urlKey", async () => {
    const companyId = await seedCompany();
    // Agent named 'Engineer', NOT 'CTO' — resolveByReference('cto') won't match.
    const engineerId = randomUUID();
    await db.insert(agents).values({
      id: engineerId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlan(companyId, { estimatedCompletionAt: pastEta, assigneeAgentId: engineerId });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    // Falls back to the plan root assignee (the engineer).
    expect(result.notified).toBe(1);
    expect(wakeup).toHaveBeenCalledWith(engineerId, expect.anything());
  });

  it("stamps etaOverrunNotifiedAt even when no CTO or assignee found (suppresses retry)", async () => {
    const companyId = await seedCompany();
    // No agents seeded at all.
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    const planId = await seedPlan(companyId, { estimatedCompletionAt: pastEta });
    const wakeup = makeWakeup();

    const result = await tickPlanEtaOverruns(db, { wakeup }, new Date());

    expect(result.notified).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();

    const [row] = await db.select({ etaOverrunNotifiedAt: planDetails.etaOverrunNotifiedAt })
      .from(planDetails)
      .where(eq(planDetails.issueId, planId));
    // Still stamped to prevent repeated log.warn noise.
    expect(row?.etaOverrunNotifiedAt).not.toBeNull();
  });

  it("two consecutive ticks for the same plan only notify once", async () => {
    const companyId = await seedCompany();
    await seedCtoAgent(companyId);
    const pastEta = new Date(Date.now() - 60 * 60 * 1000);
    await seedPlan(companyId, { estimatedCompletionAt: pastEta });
    const wakeup = makeWakeup();
    const now = new Date();

    const r1 = await tickPlanEtaOverruns(db, { wakeup }, now);
    const r2 = await tickPlanEtaOverruns(db, { wakeup }, now);

    expect(r1.notified).toBe(1);
    expect(r2.notified).toBe(0);
    expect(wakeup).toHaveBeenCalledOnce();
  });
});

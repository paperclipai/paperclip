import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

async function insertCompany(db: ReturnType<typeof createDb>, overrides: Record<string, unknown> = {}) {
  const id = overrides.id as string ?? randomUUID();
  const prefix = `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({
    id,
    name: `Company-${id.slice(0, 4)}`,
    issuePrefix: prefix,
    requireBoardApprovalForNewAgents: false,
    ...overrides,
  });
  return id;
}

async function insertAgent(db: ReturnType<typeof createDb>, companyId: string, overrides: Record<string, unknown> = {}) {
  const id = overrides.id as string ?? randomUUID();
  await db.insert(agents).values({
    id,
    companyId,
    name: `Agent-${id.slice(0, 4)}`,
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    ...overrides,
  });
  return id;
}

describeEP("companyService pause/resume", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pauses only active agents when pausing a company", async () => {
    const companyId = await insertCompany(db);
    const idleAgent = await insertAgent(db, companyId, { status: "idle" });
    const runningAgent = await insertAgent(db, companyId, { status: "running" });
    const manuallyPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "manual" });
    const budgetPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "budget" });
    const terminatedAgent = await insertAgent(db, companyId, { status: "terminated" });

    const svc = companyService(db);
    const result = await svc.pause(companyId);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("paused");
    expect(result!.pausedAgentIds).toHaveLength(2);
    expect(result!.pausedAgentIds).toContain(idleAgent);
    expect(result!.pausedAgentIds).toContain(runningAgent);
    expect(result!.pausedAgentIds).not.toContain(manuallyPausedAgent);
    expect(result!.pausedAgentIds).not.toContain(budgetPausedAgent);
    expect(result!.pausedAgentIds).not.toContain(terminatedAgent);

    const idleRow = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, idleAgent)).then(r => r[0]);
    expect(idleRow.status).toBe("paused");
    expect(idleRow.pauseReason).toBe("company_paused");

    const runningRow = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, runningAgent)).then(r => r[0]);
    expect(runningRow.status).toBe("paused");
    expect(runningRow.pauseReason).toBe("company_paused");

    const terminatedRow = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, terminatedAgent)).then(r => r[0]);
    expect(terminatedRow.status).toBe("terminated");

    const manualStill = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, manuallyPausedAgent)).then(r => r[0]);
    expect(manualStill.status).toBe("paused");
    expect(manualStill.pauseReason).toBe("manual");

    const budgetStill = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, budgetPausedAgent)).then(r => r[0]);
    expect(budgetStill.status).toBe("paused");
    expect(budgetStill.pauseReason).toBe("budget");
  });

  it("resumes only agents paused by the company", async () => {
    const companyId = await insertCompany(db, { status: "paused", pauseReason: "manual", pausedAt: new Date() });
    const companyPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "company_paused" });
    const manuallyPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "manual" });
    const budgetPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "budget" });

    const svc = companyService(db);
    const result = await svc.resume(companyId);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("active");
    expect(result!.resumedAgentIds).toHaveLength(1);
    expect(result!.resumedAgentIds).toContain(companyPausedAgent);
    expect(result!.resumedAgentIds).not.toContain(manuallyPausedAgent);
    expect(result!.resumedAgentIds).not.toContain(budgetPausedAgent);

    const resumed = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, companyPausedAgent)).then(r => r[0]);
    expect(resumed.status).toBe("idle");
    expect(resumed.pauseReason).toBeNull();

    const manualStill = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, manuallyPausedAgent)).then(r => r[0]);
    expect(manualStill.status).toBe("paused");
    expect(manualStill.pauseReason).toBe("manual");

    const budgetStill = await db.select({ status: agents.status, pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, budgetPausedAgent)).then(r => r[0]);
    expect(budgetStill.status).toBe("paused");
    expect(budgetStill.pauseReason).toBe("budget");
  });

  it("does not pause agents from other companies", async () => {
    const companyA = await insertCompany(db);
    const companyB = await insertCompany(db);
    const agentA = await insertAgent(db, companyA, { status: "idle" });
    const agentB = await insertAgent(db, companyB, { status: "idle" });

    const svc = companyService(db);
    const result = await svc.pause(companyA);

    expect(result!.pausedAgentIds).toContain(agentA);
    expect(result!.pausedAgentIds).not.toContain(agentB);

    const otherAgent = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentB)).then(r => r[0]);
    expect(otherAgent.status).toBe("idle");
  });

  it("sets company pauseReason and pausedAt", async () => {
    const companyId = await insertCompany(db);
    const svc = companyService(db);
    const result = await svc.pause(companyId, "manual");

    expect(result!.pauseReason).toBe("manual");
    expect(result!.pausedAt).not.toBeNull();
  });

  it("cancels active work for agents that will be paused", async () => {
    const companyId = await insertCompany(db);
    const runningAgent = await insertAgent(db, companyId, { status: "running" });
    const manuallyPausedAgent = await insertAgent(db, companyId, { status: "paused", pauseReason: "manual" });
    const cancelActiveForAgent = vi.fn(async () => undefined);

    const svc = companyService(db);
    await svc.pause(companyId, "manual", { cancelActiveForAgent });

    expect(cancelActiveForAgent).toHaveBeenCalledWith(runningAgent);
    expect(cancelActiveForAgent).not.toHaveBeenCalledWith(manuallyPausedAgent);
  });

  it("clears company pauseReason and pausedAt on resume", async () => {
    const companyId = await insertCompany(db);
    const svc = companyService(db);
    await svc.pause(companyId);
    const result = await svc.resume(companyId);

    expect(result!.pauseReason).toBeNull();
    expect(result!.pausedAt).toBeNull();
  });

  it("returns null for non-existent company on pause", async () => {
    const svc = companyService(db);
    const result = await svc.pause(randomUUID());
    expect(result).toBeNull();
  });

  it("refuses to resume a company that is not paused", async () => {
    const companyId = await insertCompany(db);
    const svc = companyService(db);
    await expect(svc.resume(companyId)).rejects.toThrow("not paused");
  });

  it("refuses to pause a company that is already paused", async () => {
    const companyId = await insertCompany(db, { status: "paused", pauseReason: "manual", pausedAt: new Date() });
    const svc = companyService(db);
    await expect(svc.pause(companyId)).rejects.toThrow("already paused");
  });

  it("skips timer heartbeats for agents in paused companies", async () => {
    const companyId = await insertCompany(db, { status: "paused", pauseReason: "manual", pausedAt: new Date() });
    const dueCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await insertAgent(db, companyId, {
      status: "idle",
      createdAt: dueCreatedAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 30 } },
    });
    await insertAgent(db, companyId, {
      status: "running",
      createdAt: dueCreatedAt,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 30 } },
    });

    const result = await heartbeatService(db).tickTimers(new Date("2026-01-01T00:01:00.000Z"));

    expect(result.checked).toBe(0);
    expect(result.enqueued).toBe(0);
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toHaveLength(0);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping paused-agent wake-redirect tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SOF-551 heartbeat_timer wake redirects to manager when agent is paused", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sof-551-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip SOF-551",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? "Backend Lead",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "running",
      adapterType: "codex_local",
      adapterConfig: {},
      // Default policy: heartbeat DISABLED so wakeup() doesn't try to actually
      // execute a heartbeat run (the test infra doesn't have an adapter runtime
      // wired up). The redirect path runs before the policy gate, so the skip
      // row + manager wake row are still produced.
      runtimeConfig: overrides.runtimeConfig ?? {
        heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false },
      },
      permissions: {},
      reportsTo: overrides.reportsTo ?? null,
      pauseReason: overrides.pauseReason ?? null,
      pausedAt: overrides.pausedAt ?? null,
    });
    return agentId;
  }

  async function listWakeupRowsForAgent(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("redirects heartbeat_timer wake for paused agent to its manager and writes a skip row on the assignee", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, {
      name: "VP of Engineering",
      role: "vp",
      status: "running",
    });
    const assigneeId = await seedAgent(companyId, {
      name: "Backend Lead",
      role: "engineer",
      status: "paused",
      pauseReason: "quota_exceeded",
      pausedAt: new Date(),
      reportsTo: managerId,
    });

    const svc = heartbeatService(db);
    await (svc as unknown as {
      wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
    }).wakeup(assigneeId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });

    // Assignee has exactly one row — the skip audit trail with the redirect reason.
    const assigneeRows = await listWakeupRowsForAgent(assigneeId);
    expect(assigneeRows).toHaveLength(1);
    expect(assigneeRows[0]?.status).toBe("skipped");
    expect(assigneeRows[0]?.reason).toBe("assignee_paused_routed_to_manager");
    expect(assigneeRows[0]?.error ?? "").toContain(managerId);

    // Manager received the recovery wake carrying the pausedAgentId marker.
    const managerRows = await listWakeupRowsForAgent(managerId);
    expect(managerRows.length).toBeGreaterThanOrEqual(1);
    const recoveryWake = managerRows.find(
      (r) => (r.payload as Record<string, unknown> | null)?.pausedAgentId === assigneeId,
    );
    expect(recoveryWake).toBeDefined();
    const payload = (recoveryWake?.payload ?? {}) as Record<string, unknown>;
    expect(payload.pausedAgentPauseReason).toBe("quota_exceeded");
    expect(payload.wakeKind).toBe("paused_agent_recovery");
  });

  it("records a skip row when the manager is itself paused (no recursion)", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, {
      name: "VP of Engineering",
      role: "vp",
      status: "paused",
      pauseReason: "quota_exceeded",
      pausedAt: new Date(),
    });
    const assigneeId = await seedAgent(companyId, {
      name: "Backend Lead",
      role: "engineer",
      status: "paused",
      pauseReason: "quota_exceeded",
      pausedAt: new Date(),
      reportsTo: managerId,
    });

    const svc = heartbeatService(db);
    await (svc as unknown as {
      wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
    }).wakeup(assigneeId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });

    const assigneeRows = await listWakeupRowsForAgent(assigneeId);
    expect(assigneeRows).toHaveLength(1);
    expect(assigneeRows[0]?.status).toBe("skipped");
    expect(assigneeRows[0]?.reason).toBe("assignee_paused_manager_unavailable");
  });

  it("does NOT redirect when the assignee is running", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, {
      name: "VP of Engineering",
      role: "vp",
      status: "running",
    });
    const assigneeId = await seedAgent(companyId, {
      name: "Backend Lead",
      role: "engineer",
      status: "running",
      reportsTo: managerId,
    });

    const svc = heartbeatService(db);
    const wakePromise = (svc as unknown as {
      wakeup: (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;
    }).wakeup(assigneeId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    wakePromise.catch(() => undefined);
    await wakePromise;

    // Assignee's row exists but is NOT a redirect skip — it should be a
    // normal queued heartbeat wake (the heartbeat_scheduler path).
    const assigneeRows = await listWakeupRowsForAgent(assigneeId);
    const redirectSkips = assigneeRows.filter(
      (r) => r.reason === "assignee_paused_routed_to_manager",
    );
    expect(redirectSkips).toHaveLength(0);

    // Manager did NOT receive a wake in this case.
    const managerRows = await listWakeupRowsForAgent(managerId);
    expect(managerRows).toHaveLength(0);
  });
});
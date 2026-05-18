import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  activityLog,
  companySkills,
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
    `Skipping STO-838 no-task empty-inbox drop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// STO-838: scheduler backstop — drop wake when no PAPERCLIP_TASK_ID + assignee
// inbox is empty + reason is retry-class. Sibling of STO-267.
describeEmbeddedPostgres("heartbeat: drop no-task retry wake on empty inbox (STO-838)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sto838-drop-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    // heartbeat.wakeup() enqueues a background heartbeat-run that may insert
    // into company_skills (default skill seeding) AFTER the test's await chain
    // has returned. We drain the queue by polling until either company_skills
    // is empty or we time out. Without this, cleanup races the bg work and
    // companies cannot be deleted (FK from company_skills).
    const waitForQuiescence = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        // Yield to the macrotask queue so any setImmediate/Promise.then chains
        // pending from the heartbeat runner get a chance to settle.
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await db.delete(companySkills);
          await db.delete(companies);
          return;
        } catch (err) {
          const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
          if (code !== "23503") throw err; // not the expected FK race -> bubble up
          // Otherwise: bg work re-inserted between our deletes; retry.
        }
      }
      throw new Error("company_skills cleanup timed out (50 retries)");
    };

    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await waitForQuiescence();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { companyId: string; agentId: string; agentName?: string }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: input.agentName ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
  }

  it("drops a retry-class wake with no issueId and an empty inbox (cancelled, no run)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedAgent({ companyId, agentId });

    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "retry_failed_run",
      payload: { retryOfRunId: randomUUID() },
    });

    // Drop returns null — no adapter invocation, no follow-up retry queued.
    expect(result).toBeNull();

    const runRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runRows).toHaveLength(0);

    const wakeupRows = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeupRows).toHaveLength(1);
    expect(wakeupRows[0]).toMatchObject({
      status: "cancelled",
      reason: "dropped_no_task_empty_inbox",
    });

    // Audit log entry must exist so we can review drop decisions later.
    const auditRows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("agent.wakeup_dropped_no_task_empty_inbox");
    expect(auditRows[0]?.details).toMatchObject({
      requestedReason: "retry_failed_run",
      source: "automation",
    });
  });

  it("does NOT drop a retry-class wake when the assignee has actionable work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedAgent({ companyId, agentId });

    // Seed a single actionable issue assigned to this agent.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "T-1",
      title: "Pending work",
      description: "still has work",
      status: "todo",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
    });

    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "retry_failed_run",
      payload: { retryOfRunId: randomUUID() },
    });

    // Inbox not empty -> wake proceeds and a heartbeat run is queued.
    expect(result).not.toBeNull();

    const queuedWakeups = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "cancelled"),
        ),
      );
    expect(queuedWakeups).toHaveLength(0);
  });

  it("does NOT drop a heartbeat_timer wake even when the inbox is empty (only retry-class is gated)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedAgent({ companyId, agentId });

    const result = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "heartbeat",
      reason: "heartbeat_timer",
      payload: null,
    });

    // Original heartbeat ticks are legitimate even with empty inboxes.
    expect(result).not.toBeNull();

    const dropped = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "dropped_no_task_empty_inbox"),
        ),
      );
    expect(dropped).toHaveLength(0);
  });
});

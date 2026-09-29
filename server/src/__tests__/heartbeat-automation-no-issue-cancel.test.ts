import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkillVersions,
  companySkills,
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
    `Skipping automation-no-issue heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("automation-source wake without issue binding (SPA-9035)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-automation-no-issue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(companies);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Automation No-Issue Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Automation Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    return { companyId, ownerUserId, agentId };
  }

  it("skips an agent-initiated automation-source wake with no issue binding (no run created)", async () => {
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "external_automation_probe",
      payload: { /* no issueId */ },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    expect(run).toBeNull();

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);

    const wakeupRequest = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);
    expect(wakeupRequest).toMatchObject({
      status: "skipped",
      reason: "automation_wake_no_issue_binding",
    });
  });

  it("does NOT skip a user-initiated automation wake without an issue (approval-resume regression)", async () => {
    // User-originated wakes (approval resumes, comment-driven wakes) must
    // continue to queue even when no issue is bound. The guard targets
    // agent-initiated automation wakes only.
    const { agentId, ownerUserId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "user_automation_probe",
      payload: {},
      requestedByActorType: "user",
      requestedByActorId: ownerUserId,
    });

    const skippedForOurGuard = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.some((row) => row.reason === "automation_wake_no_issue_binding"));
    expect(skippedForOurGuard).toBe(false);
  });

  it("does NOT skip a system-originated automation wake without an issue (legitimate pattern)", async () => {
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "productivity_review",
      payload: {},
      contextSnapshot: { wakeReason: "productivity_review" },
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    const skippedForOurGuard = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.some((row) => row.reason === "automation_wake_no_issue_binding"));
    expect(skippedForOurGuard).toBe(false);
  });

  it("does NOT apply the guard when the contextSnapshot carries an issueId", async () => {
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "bound_via_context",
      payload: {},
      contextSnapshot: { issueId: randomUUID() },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    const skippedForOurGuard = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.some((row) => row.reason === "automation_wake_no_issue_binding"));
    expect(skippedForOurGuard).toBe(false);
  });

  it("does NOT apply the guard to on_demand wakes", async () => {
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      payload: {},
      contextSnapshot: {},
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    const skippedForOurGuard = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .then((rows) => rows.some((row) => row.reason === "automation_wake_no_issue_binding"));
    expect(skippedForOurGuard).toBe(false);
  });

  it("stamps the wake initiator onto the run's contextSnapshot", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bound automation issue",
      status: "in_progress",
      assigneeAgentId: agentId,
      createdByUserId: `user-${randomUUID()}`,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "callback",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });

    expect(run).not.toBeNull();
    if (run) {
      const snapshot = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      expect(snapshot.requestedByActorType).toBe("agent");
      expect(snapshot.requestedByActorId).toBe(agentId);
    }
  });
});
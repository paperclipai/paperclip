import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { pullAgentLifecycleService } from "../services/pull-agent-lifecycle.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("pull agent lifecycle routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-pull-agent-lifecycle-routes-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(agentTaskSessions);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt" as const,
    };
  }

  function freshLease(overrides: Record<string, unknown> = {}) {
    return {
      source: "resident-seat",
      state: "running",
      observedAt: new Date(Date.now() - 30_000).toISOString(),
      expiresAt: "2027-08-16T16:00:00.000Z",
      evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
      ...overrides,
    };
  }

  async function seedAgent(runtimeConfig: Record<string, unknown> = { executionModel: "pull" }) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "PullLifecycle");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "Wren",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig,
      permissions: {},
    });
    return { ...seeded, agentId };
  }

  it("GET /agents/:id/lifecycle is unreachable for a pull agent with no lease", async () => {
    const { actor, agentId } = await seedAgent();
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      executionModel: "pull",
      state: "unreachable",
      dispatchEnabled: false,
      queuedIssueCount: 0,
      blockedIssueCount: 0,
    });
  });

  it("POST /agents/:id/lifecycle-report persists a lease and GET derives running", async () => {
    const { actor, agentId, companyId } = await seedAgent();
    await ctx.db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "process",
      stateJson: { keepMe: true, totalRuns: 9 },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const posted = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({
        source: "resident-seat",
        state: "running",
        evidence: [{ kind: "external_lease", id: "vps-poller-5", active: true }],
      });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
      dispatchEnabled: false,
    });
    expect(posted.body.expiresAt).toEqual(expect.any(String));

    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson);
    expect(stored).toMatchObject({
      keepMe: true,
      totalRuns: 9,
      pullLifecycleReport: {
        source: "resident-seat",
        state: "running",
      },
    });

    const got = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(got.status).toBe(200);
    expect(got.body.state).toBe("running");
    expect(got.body.evidence).toEqual([
      { kind: "external_lease", id: "vps-poller-5", active: true },
    ]);

    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "running" }]);
  });

  it("rejects lifecycle reports for push agents", async () => {
    const { actor, agentId } = await seedAgent({});
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({ source: "resident-seat" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/pull-executed/i);
  });

  it("lets a pull agent report only its own lifecycle", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherId = randomUUID();
    await ctx.db.insert(agents).values({
      id: otherId,
      companyId,
      name: "Other",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { executionModel: "pull" },
      permissions: {},
    });
    const app = routeApp(ctx.db, agentActor(companyId, agentId) as never, agentRoutes);
    const own = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({ source: "self" });
    expect(own.status).toBe(200);
    const other = await request(app)
      .post(`/api/agents/${otherId}/lifecycle-report`)
      .send({ source: "self" });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/own lifecycle/i);
  });

  it("hides another company's agent as 404", async () => {
    const { agentId } = await seedAgent();
    const outsider = await seedCompanyWithBoardAccess(ctx.db, "Outsider");
    const app = routeApp(ctx.db, outsider.actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(404);
  });

  it("GET /lifecycle idles an expired running pull agent without a heartbeat run", async () => {
    const { actor, agentId } = await seedAgent();
    const app = routeApp(ctx.db, actor, agentRoutes);
    const posted = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({
        source: "resident-seat",
        state: "running",
        evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
      });
    expect(posted.status).toBe(200);
    expect(posted.body.state).toBe("running");

    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson as Record<string, unknown>);
    const report = {
      ...(stored.pullLifecycleReport as Record<string, unknown>),
      expiresAt: "2026-08-14T19:59:59.000Z",
      observedAt: "2026-08-14T19:58:00.000Z",
    };
    await ctx.db.update(agentRuntimeState).set({
      stateJson: { ...stored, pullLifecycleReport: report },
    });
    await ctx.db.update(agents).set({ status: "running" });

    const got = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(got.status).toBe(200);
    expect(got.body.state).toBe("unreachable");
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "idle" }]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("GET /agents/:id embeds pullLifecycle from runtimeConfig when native state is empty", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      pullLifecycle: freshLease(),
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.pullLifecycle).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
      dispatchEnabled: false,
    });
    expect(res.body.pullLifecycle.evidence).toEqual([
      { kind: "external_lease", id: "vps-poller", active: true },
    ]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("GET /agents/:id does not embed pullLifecycle for push agents", async () => {
    const { actor, agentId } = await seedAgent({});
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.pullLifecycle).toBeUndefined();
  });

  it("timer ticks reconcile pull agents and do not enqueue heartbeat runs", async () => {
    const { agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: true, intervalSec: 60 },
    });
    await ctx.db.insert(agentRuntimeState).values({
      agentId,
      companyId: (await ctx.db.select({ companyId: agents.companyId }).from(agents).then((rows) => rows[0]!.companyId)),
      adapterType: "process",
      stateJson: {
        pullLifecycleReport: {
          source: "resident-seat",
          state: "running",
          observedAt: "2026-08-14T19:58:00.000Z",
          expiresAt: "2026-08-14T19:59:59.000Z",
          evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
        },
      },
    });
    await ctx.db.update(agents).set({
      status: "running",
      lastHeartbeatAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    const result = await heartbeatService(ctx.db).tickTimers(new Date("2026-08-14T20:00:00.000Z"));
    expect(result.enqueued).toBe(0);
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "idle" }]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("PATCH /agents/:id runtimeConfig.pullLifecycle becomes a native lease and running status", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: false },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const patched = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          executionModel: "pull",
          pull: { dispatchEnabled: false },
          heartbeat: { enabled: false },
          pullLifecycle: freshLease({
            evidence: [{ kind: "external_lease", id: "vps-poller-4", active: true }],
          }),
        },
      });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("running");
    expect(patched.body.pullLifecycle).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
      dispatchEnabled: false,
    });
    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson);
    expect(stored).toMatchObject({
      pullLifecycleReport: {
        source: "resident-seat",
        state: "running",
      },
    });
    const persisted = (stored as { pullLifecycleReport: { observedAt: string; expiresAt: string } })
      .pullLifecycleReport;
    const persistedTtlMs = new Date(persisted.expiresAt).getTime() - new Date(persisted.observedAt).getTime();
    expect(persistedTtlMs).toBeLessThanOrEqual(3600 * 1000);
    expect(persisted.expiresAt).not.toBe("2027-08-16T16:00:00.000Z");
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("PATCH clamps a future observedAt so the native lease cannot outlive now plus TTL", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: false },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const before = Date.now();
    const patched = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          executionModel: "pull",
          pull: { dispatchEnabled: false },
          heartbeat: { enabled: false },
          pullLifecycle: freshLease({
            observedAt: new Date(Date.now() + 3_600_000).toISOString(),
            expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
          }),
        },
      });
    const after = Date.now();
    expect(patched.status).toBe(200);
    expect(patched.body.pullLifecycle.state).toBe("running");
    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson as { pullLifecycleReport?: { observedAt: string; expiresAt: string } });
    const observedMs = new Date(stored.pullLifecycleReport!.observedAt).getTime();
    const expiresMs = new Date(stored.pullLifecycleReport!.expiresAt).getTime();
    expect(observedMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(observedMs).toBeLessThanOrEqual(after + 1_000);
    expect(expiresMs - observedMs).toBeLessThanOrEqual(3600 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 3600 * 1000 + 1_000);
  });

  it("does not treat queued, retry, or orphaned running rows as live when dispatch is enabled", async () => {
    const { actor, agentId, companyId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: true },
    });
    const queuedId = randomUUID();
    const retryId = randomUUID();
    const orphanId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values([
      { id: queuedId, companyId, agentId, status: "queued" },
      { id: retryId, companyId, agentId, status: "scheduled_retry" },
      {
        id: orphanId,
        companyId,
        agentId,
        status: "running",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unreachable");
    expect(res.body.evidence.some((item: { active?: boolean }) => item.active)).toBe(false);
    expect(res.body.evidence.some((item: { id: string }) => item.id === queuedId || item.id === retryId || item.id === orphanId)).toBe(false);
  });

  it("keeps a quiet dispatch-enabled run live when its adapter pid is still recorded", async () => {
    const { actor, agentId, companyId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: true },
    });
    const quietId = randomUUID();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await ctx.db.insert(heartbeatRuns).values({
      id: quietId,
      companyId,
      agentId,
      status: "running",
      startedAt: tenMinutesAgo,
      processStartedAt: tenMinutesAgo,
      lastOutputAt: tenMinutesAgo,
      processPid: 4242,
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("running");
    expect(res.body.source).toBe("task_session");
    expect(res.body.evidence).toEqual([
      expect.objectContaining({
        kind: "task_session",
        id: quietId,
        active: true,
        status: "running",
      }),
    ]);
  });

  it("GET /agents/:id expires a stale runtimeConfig lease onto idle without a heartbeat run", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      pullLifecycle: {
        source: "resident-seat",
        state: "running",
        observedAt: "2026-08-14T19:58:00.000Z",
        expiresAt: "2026-08-14T19:59:59.000Z",
        evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
      },
    });
    await ctx.db.update(agents).set({ status: "running" });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.pullLifecycle.state).toBe("unreachable");
    expect(res.body.status).toBe("idle");
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "idle" }]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("GET /companies/:companyId/agents embeds pullLifecycle only for pull agents", async () => {
    const { actor, agentId, companyId } = await seedAgent({
      executionModel: "pull",
      pullLifecycle: freshLease({
        evidence: [{ kind: "claim", id: "issue:COM-10564", active: true }],
      }),
    });
    const pushId = randomUUID();
    await ctx.db.insert(agents).values({
      id: pushId,
      companyId,
      name: "Pushy",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);
    expect(res.status).toBe(200);
    const pullRow = res.body.find((row: { id: string }) => row.id === agentId);
    const pushRow = res.body.find((row: { id: string }) => row.id === pushId);
    expect(pullRow.pullLifecycle).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
    });
    expect(pushRow.pullLifecycle).toBeUndefined();
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("PATCH /agents/:id cannot enable heartbeat on a pull agent without dispatchEnabled", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: false },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const patched = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          executionModel: "pull",
          pull: { dispatchEnabled: false },
          heartbeat: { enabled: true, intervalSec: 120 },
        },
      });
    expect(patched.status).toBe(200);
    expect(patched.body.runtimeConfig).toMatchObject({
      executionModel: "pull",
      heartbeat: { enabled: false, intervalSec: 120 },
    });
    const stored = await ctx.db
      .select({ runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .then((rows) => rows[0]?.runtimeConfig as Record<string, unknown>);
    expect(stored).toMatchObject({
      executionModel: "pull",
      heartbeat: { enabled: false },
    });
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("POST /heartbeat/invoke and /wakeup skip pull agents without creating a run", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: true, intervalSec: 60 },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);

    const invoked = await request(app).post(`/api/agents/${agentId}/heartbeat/invoke`).send({});
    expect(invoked.status).toBe(202);
    expect(invoked.body).toEqual({ status: "skipped" });

    const woken = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand" });
    expect(woken.status).toBe(202);
    expect(woken.body.status ?? woken.body).toBeTruthy();

    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
    const skipped = await ctx.db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests);
    expect(skipped.length).toBeGreaterThanOrEqual(2);
    expect(skipped.every((row) => row.status === "skipped")).toBe(true);
    expect(skipped.every((row) => row.reason === "heartbeat.pull_dispatch_disabled")).toBe(true);
  });

  it("PATCH does not renew an expired runtimeConfig lease as a fresh native report", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: false },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const patched = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          executionModel: "pull",
          pull: { dispatchEnabled: false },
          heartbeat: { enabled: false },
          pullLifecycle: {
            source: "resident-seat",
            state: "running",
            observedAt: "2026-08-14T19:58:00.000Z",
            expiresAt: "2026-08-14T19:59:59.000Z",
            evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
          },
        },
      });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("idle");
    expect(patched.body.pullLifecycle.state).toBe("unreachable");
    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson as Record<string, unknown> | undefined);
    expect(stored?.pullLifecycleReport).toBeUndefined();
  });

  it("treats a retained session as inactive after its last run finishes", async () => {
    const { actor, agentId, companyId } = await seedAgent();
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      finishedAt: new Date("2026-08-16T16:00:00.000Z"),
    });
    await ctx.db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey: "issue:COM-10564",
      sessionDisplayId: "sess-finished",
      lastRunId: runId,
      updatedAt: new Date(),
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unreachable");
    expect(res.body.evidence).toEqual([
      expect.objectContaining({
        kind: "task_session",
        id: "sess-finished",
        active: false,
        status: "succeeded",
      }),
    ]);
  });

  it("does not treat leftover heartbeat rows as active when pull dispatch is disabled", async () => {
    const { actor, agentId, companyId } = await seedAgent();
    const finishedId = randomUUID();
    const leftoverId = randomUUID();
    const zombieId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values([
      {
        id: finishedId,
        companyId,
        agentId,
        status: "succeeded",
        finishedAt: new Date("2026-08-16T16:00:00.000Z"),
      },
      {
        id: leftoverId,
        companyId,
        agentId,
        status: "queued",
      },
      {
        id: zombieId,
        companyId,
        agentId,
        status: "running",
      },
    ]);
    await ctx.db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey: "issue:COM-10564",
      sessionDisplayId: "sess-stale-last-run",
      lastRunId: finishedId,
      updatedAt: new Date(),
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("unreachable");
    expect(res.body.evidence).toEqual([
      expect.objectContaining({
        kind: "task_session",
        id: "sess-stale-last-run",
        active: false,
        status: "succeeded",
      }),
    ]);
    expect(res.body.evidence.some((item: { id: string }) => item.id === leftoverId || item.id === zombieId)).toBe(false);
  });

  it("derives running from a live heartbeat run when pull dispatch is enabled", async () => {
    const { actor, agentId, companyId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: true },
    });
    const finishedId = randomUUID();
    const liveId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values([
      {
        id: finishedId,
        companyId,
        agentId,
        status: "succeeded",
        finishedAt: new Date("2026-08-16T16:00:00.000Z"),
      },
      {
        id: liveId,
        companyId,
        agentId,
        status: "running",
        startedAt: new Date(),
        processPid: 4242,
        lastOutputAt: new Date(),
      },
    ]);
    await ctx.db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey: "issue:COM-10564",
      sessionDisplayId: "sess-stale-last-run",
      lastRunId: finishedId,
      updatedAt: new Date(),
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("running");
    expect(res.body.source).toBe("task_session");
    expect(res.body.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "task_session",
        id: "sess-stale-last-run",
        active: false,
        status: "succeeded",
      }),
      expect.objectContaining({
        kind: "task_session",
        id: liveId,
        active: true,
        status: "running",
      }),
    ]));
  });

  it("derives running from a live heartbeat run attached to a task session when dispatch is enabled", async () => {
    const { actor, agentId, companyId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: true },
    });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      processPid: 4242,
      lastOutputAt: new Date(),
    });
    await ctx.db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey: "issue:COM-10564",
      sessionDisplayId: "sess-live",
      lastRunId: runId,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("running");
    expect(res.body.source).toBe("task_session");
    expect(res.body.evidence).toEqual([
      expect.objectContaining({
        kind: "task_session",
        id: "sess-live",
        active: true,
        status: "running",
      }),
    ]);
  });

  it("does not overwrite a paused agent from a stale running snapshot", async () => {
    const { agentId } = await seedAgent({
      executionModel: "pull",
      pullLifecycle: freshLease(),
    });
    const [snapshot] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
    expect(snapshot?.status).toBe("idle");
    await ctx.db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await pullAgentLifecycleService(ctx.db).reconcile(snapshot!);
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "paused" }]);
  });
});

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { logger } from "../middleware/logger.js";
import { isAgentDispatchActive } from "../services/agent-start-lock.js";

const held = vi.hoisted(() => {
  const state = {
    release: () => undefined as void,
    released: Promise.resolve(),
    reset() {
      state.released = new Promise<void>((resolve) => { state.release = resolve; });
    },
  };
  return state;
})

const passes = vi.hoisted(() => ({ started: 0, active: 0, peak: 0 }));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: async () => {
        await held.released;
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "done", provider: "test", model: "test" };
      },
    })),
  };
});

vi.mock("../services/agent-start-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-start-lock.js")>("../services/agent-start-lock.js");
  const measure = async <T>(pass: () => Promise<T>) => {
    passes.started += 1;
    passes.active += 1;
    passes.peak = Math.max(passes.peak, passes.active);
    try {
      return await pass();
    } finally {
      passes.active -= 1;
    }
  };
  return {
    ...actual,
    dispatchForAgent: (agentId: string, spec: Parameters<typeof actual.dispatchForAgent>[1]) =>
      actual.dispatchForAgent(agentId, { ...spec, run: (request, signal) => measure(() => spec.run(request, signal)) }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const CAP = 4;
const UNCLAIMABLE = 12;
const CLAIMABLE = 3 * CAP;
const TRIGGERS = 40;

suite("queued-run dispatch under a trigger burst", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-queued-dispatch-stacking-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`create table running_peaks (agent_id uuid not null, running int not null)`);
    await db.execute(sql`create function record_running_peak() returns trigger language plpgsql as $$
      begin
        insert into running_peaks select new.agent_id, count(*) from heartbeat_runs where agent_id = new.agent_id and status = 'running';
        return new;
      end $$`);
    await db.execute(sql`create trigger record_running_peak after update of status on heartbeat_runs
      for each row when (new.status = 'running') execute function record_running_peak()`);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    held.release();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seedAgent() {
    userId = randomUUID();
    companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Burst", issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: CAP } }, permissions: {} });
    return agentId;
  }

  async function task(agentId: string) {
    const [row] = await db.insert(issues).values({ companyId, title: "Continue the work", status: "in_progress", assigneeAgentId: agentId }).returning();
    return row!;
  }

  async function finishedRun(agentId: string, issueId: string, minutesAgo: number) {
    const finishedAt = new Date(Date.now() - minutesAgo * 60_000);
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment",
      status: "failed", errorCode: "server_shutdown_interrupted", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 120_000), contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return row!;
  }

  async function queuedContinuation(agentId: string, input: { minutesAgo: number; wakeReason: string; sourceIssueId?: string }) {
    const issue = await task(agentId);
    const source = await finishedRun(agentId, input.sourceIssueId ?? issue.id, input.minutesAgo + 5);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: input.wakeReason, status: "queued", requestedByActorType: "system", requestedByActorId: null,
      payload: { issueId: issue.id } }).returning();
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, invocationSource: "automation",
      triggerDetail: "system", status: "queued", retryOfRunId: source.id, wakeupRequestId: wake!.id,
      createdAt: new Date(Date.now() - input.minutesAgo * 60_000),
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: input.wakeReason, previousRunId: source.id,
        source: "issue.assigned_work_invariant", paperclipWorkspace: { notes: "x".repeat(16_000) } } }).returning();
    await db.update(agentWakeupRequests).set({ runId: row!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    return row!;
  }

  const peakRunning = async (agentId: string) => Number((await db.execute(sql`select coalesce(max(running), 0) as peak
    from running_peaks where agent_id = ${agentId}::uuid`))[0]!.peak);

  it("runs one pass at a time for a burst of triggers, offers a refused run once, and never runs past the agent's limit", async () => {
    held.reset();
    passes.started = 0; passes.active = 0; passes.peak = 0;
    const agentId = await seedAgent();
    const otherTask = await task(agentId);
    const unclaimable = new Set<string>();
    for (let index = 0; index < UNCLAIMABLE; index += 1) {
      unclaimable.add((await queuedContinuation(agentId, { minutesAgo: 180 - index, wakeReason: "issue_continuation_needed",
        sourceIssueId: otherTask.id })).id);
    }
    for (let index = 0; index < CLAIMABLE; index += 1) {
      await queuedContinuation(agentId, { minutesAgo: 30 - index, wakeReason: "issue_assigned" });
    }

    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const offers = new Map<string, number>();
    let inFlightClaims = 0;
    let peakInFlightClaims = 0;
    const triggers: Array<Promise<unknown>> = [];
    let burstFired = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ runId, stage }) => {
        if (stage !== "claim") return;
        offers.set(runId, (offers.get(runId) ?? 0) + 1);
        inFlightClaims += 1;
        peakInFlightClaims = Math.max(peakInFlightClaims, inFlightClaims);
        try {
          if (!burstFired) {
            burstFired = true;
            for (let index = 0; index < TRIGGERS; index += 1) {
              skewMs += 31_000;
              triggers.push(heartbeat.resumeQueuedRunsForAgent(companyId, agentId));
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            skewMs = 0;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        } finally {
          inFlightClaims -= 1;
        }
      },
    });

    try {
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await Promise.all(triggers);
      const refusedOffers = [...unclaimable].reduce((sum, id) => sum + (offers.get(id) ?? 0), 0);
      expect({
        passes: passes.started,
        peakConcurrentPasses: passes.peak,
        peakInFlightClaims,
        refusedOffersPerTrigger: refusedOffers / (TRIGGERS + 1),
        peakRunning: await peakRunning(agentId),
      }).toEqual({
        passes: 2,
        peakConcurrentPasses: 1,
        peakInFlightClaims: 1,
        refusedOffersPerTrigger: UNCLAIMABLE / (TRIGGERS + 1),
        peakRunning: CAP,
      });
      await vi.waitFor(() => {
        expect(passes.active).toBe(0);
        expect(isAgentDispatchActive(agentId)).toBe(false);
      }, { timeout: 10_000 });

    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it.each(["declined", "rejected"] as const)("waits a bounded time before offering a %s run again, and offers it again once that time passes", async (refusal) => {
    const agentId = await seedAgent();
    if (refusal === "rejected") {
      await db.update(companies).set({ defaultResponsibleUserId: null }).where(eq(companies.id, companyId));
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    }
    const otherTask = await task(agentId);
    const refused = await queuedContinuation(agentId, { minutesAgo: 180, wakeReason: "issue_continuation_needed", sourceIssueId: otherTask.id });
    const warn = vi.spyOn(logger, "warn");
    const offersOf = () => warn.mock.calls.filter(([fields, message]) => typeof message === "string"
      && message.startsWith("long-queued heartbeat run was offered a free slot")
      && (fields as { runId?: string }).runId === refused.id).length;
    const heartbeat = heartbeatService(db);
    try {
      for (let index = 0; index < 10; index += 1) await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      expect(offersOf()).toBe(1);
      await vi.waitFor(async () => {
        await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
        expect(offersOf()).toBe(2);
      }, { timeout: 20_000, interval: 1_000 });
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 60_000);

  async function passesSettle() {
    let last = -1;
    await vi.waitFor(() => {
      const settled = passes.started === last && !passes.active;
      last = passes.started;
      expect(settled).toBe(true);
    }, { timeout: 30_000, interval: 1_000 });
    return passes.started;
  }

  it("stops chaining passes once every refused run was tried", async () => {
    passes.started = 0; passes.active = 0; passes.peak = 0;
    const agentId = await seedAgent();
    const otherTask = await task(agentId);
    for (let index = 0; index < 60; index += 1) {
      await queuedContinuation(agentId, { minutesAgo: 180 - index, wakeReason: "issue_continuation_needed", sourceIssueId: otherTask.id });
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      expect(await passesSettle()).toBe(3);
      expect(passes.peak).toBe(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("starts runnable work queued behind more refused person runs than one pass tries", async () => {
    held.reset();
    passes.started = 0; passes.active = 0; passes.peak = 0;
    const agentId = await seedAgent();
    const otherTask = await task(agentId);
    for (let index = 0; index < 30; index += 1) {
      await queuedContinuation(agentId, { minutesAgo: 90 - index, wakeReason: "task_retry", sourceIssueId: otherTask.id });
    }
    const runnable: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      runnable.push((await queuedContinuation(agentId, { minutesAgo: 30 - index, wakeReason: "issue_assigned" })).id);
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      expect(await passesSettle()).toBeLessThanOrEqual(3);
      const started = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.id} in (${sql.join(runnable.map(id => sql`${id}::uuid`), sql`, `)}) and ${heartbeatRuns.startedAt} is not null`);
      expect(started).toHaveLength(runnable.length);
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("starts a run that becomes ready during a chain of passes when a fresh trigger arrives", async () => {
    held.reset();
    passes.started = 0; passes.active = 0; passes.peak = 0;
    const agentId = await seedAgent();
    const otherTask = await task(agentId);
    const ready = await queuedContinuation(agentId, { minutesAgo: 200, wakeReason: "issue_continuation_needed", sourceIssueId: otherTask.id });
    for (let index = 0; index < 30; index += 1) {
      await queuedContinuation(agentId, { minutesAgo: 180 - index, wakeReason: "issue_continuation_needed", sourceIssueId: otherTask.id });
    }
    let refusedOffers = 0;
    let freshTrigger: Promise<unknown> | null = null;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ runId, stage }) => {
        if (stage !== "claim" || runId === ready.id) return;
        refusedOffers += 1;
        if (refusedOffers !== 5) return;
        const source = await finishedRun(agentId, ready.issueId!, 205);
        await db.update(heartbeatRuns).set({ retryOfRunId: source.id,
          contextSnapshot: { ...ready.contextSnapshot, previousRunId: source.id } }).where(eq(heartbeatRuns.id, ready.id));
        await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, ready.issueId!));
        freshTrigger = heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      },
    });
    try {
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await passesSettle();
      await freshTrigger;
      const [row] = await db.select({ startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, ready.id));
      expect(row!.startedAt).not.toBeNull();
    } finally {
      held.release();
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, costEvents, heartbeatRuns } from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { logActivity } from "../services/activity-log.ts";

// On-read reconciliation of orphaned `running` agent status (ATLA-1225).
// These tests exercise the read/serialize path of agentService so that GET /api/agents/me,
// GET /api/agents/{id}, and GET /api/companies/{id}/agents all self-heal an orphaned flag.

vi.mock("../services/activity-log.ts", () => ({
  logActivity: vi.fn(async () => {}),
}));

const logActivityMock = vi.mocked(logActivity);

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const HOUR_MS = 60 * 60 * 1000;

function baseAgent(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: COMPANY_ID,
    name: "Builder",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: new Date(now.getTime() - HOUR_MS),
    metadata: null,
    createdAt: new Date(now.getTime() - HOUR_MS),
    // running flag written an hour ago => well past the reconciliation window
    updatedAt: new Date(now.getTime() - HOUR_MS),
    ...overrides,
  };
}

/**
 * A db stub that dispatches by drizzle table identity. It serves the agent row(s), the
 * monthly-spend hydration select, the backing-run count, and emulates the atomic NOT EXISTS
 * heal update (which only matches when no queued/running run backs the agent).
 */
function makeDb(opts: { rows: Array<Record<string, unknown>>; backingRunCount: number }) {
  const updates: Array<Record<string, unknown>> = [];
  const db: Record<string, unknown> = {
    select: (_cols?: unknown) => {
      const q: Record<string, unknown> = {};
      let table: unknown = null;
      Object.assign(q, {
        from: (t: unknown) => {
          table = t;
          return q;
        },
        where: () => q,
        groupBy: () => q,
        leftJoin: () => q,
        innerJoin: () => q,
        orderBy: () => q,
        then: (resolve: (value: unknown[]) => unknown) => {
          if (table === agents) return Promise.resolve(resolve(opts.rows));
          if (table === heartbeatRuns) {
            return Promise.resolve(resolve([{ count: opts.backingRunCount }]));
          }
          if (table === costEvents) return Promise.resolve(resolve([]));
          return Promise.resolve(resolve([]));
        },
      });
      return q;
    },
    update: (t: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: () => ({
            then: (resolve: (value: unknown[]) => unknown) => {
              updates.push({ table: t, vals });
              // Emulate the SQL `NOT EXISTS (... queued/running ...)` guard: the heal only
              // matches the row when there is genuinely no backing run.
              const matched = t === agents && opts.backingRunCount === 0;
              const healed = matched ? [{ ...opts.rows[0], ...vals }] : [];
              return Promise.resolve(resolve(healed));
            },
          }),
        }),
      }),
    }),
  };
  return { db, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("on-read orphaned running-status reconciliation", () => {
  it("heals an orphaned `running` agent to idle on read and records an audit event", async () => {
    const { db, updates } = makeDb({ rows: [baseAgent()], backingRunCount: 0 });
    const svc = agentService(db as never);

    const agent = await svc.getById("11111111-1111-4111-8111-111111111111");

    expect(agent?.status).toBe("idle");
    // exactly one heal update against the agents table
    expect(updates.filter((u) => u.table === agents)).toHaveLength(1);
    // audit row captures the prior state
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const [, input] = logActivityMock.mock.calls[0]!;
    expect(input).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "system",
      action: "agent.status.reconciled",
      entityType: "agent",
      entityId: "11111111-1111-4111-8111-111111111111",
      agentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(input.details).toMatchObject({
      reason: "orphaned_running_no_backing_run",
      priorStatus: "running",
      priorCurrentRunId: null,
    });
  });

  it("does NOT flip a running agent that still has a backing (queued or running) run", async () => {
    const { db, updates } = makeDb({ rows: [baseAgent()], backingRunCount: 1 });
    const svc = agentService(db as never);

    const agent = await svc.getById("11111111-1111-4111-8111-111111111111");

    expect(agent?.status).toBe("running");
    expect(updates.filter((u) => u.table === agents)).toHaveLength(0);
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("does NOT flip a legitimately-starting run inside the reconciliation window", async () => {
    // running flag written 5s ago, agent has finished heartbeats before => still within window
    const justStarted = baseAgent({
      status: "running",
      updatedAt: new Date("2026-06-20T00:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-06-19T23:50:00.000Z"),
    });
    const { db, updates } = makeDb({ rows: [justStarted], backingRunCount: 0 });
    const svc = agentService(db as never);

    const agent = await svc.reconcileOrphanedRunningStatus(
      justStarted as never,
      new Date("2026-06-20T00:00:05.000Z"),
    );

    expect((agent as { status: string }).status).toBe("running");
    expect(updates).toHaveLength(0);
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("reconciles a first-run orphan immediately when lastHeartbeatAt is null", async () => {
    const firstRunOrphan = baseAgent({
      status: "running",
      lastHeartbeatAt: null,
      updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    });
    const { db } = makeDb({ rows: [firstRunOrphan], backingRunCount: 0 });
    const svc = agentService(db as never);

    const agent = await svc.reconcileOrphanedRunningStatus(
      firstRunOrphan as never,
      // only a second later: the window does not apply because lastHeartbeatAt is null
      new Date("2026-06-20T00:00:01.000Z"),
    );

    expect((agent as { status: string }).status).toBe("idle");
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  it("self-heals orphaned rows through the company agents list path", async () => {
    const { db } = makeDb({ rows: [baseAgent()], backingRunCount: 0 });
    const svc = agentService(db as never);

    const list = await svc.list(COMPANY_ID);

    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("idle");
    expect(logActivityMock).toHaveBeenCalledTimes(1);
  });

  // Regression: the historical orphans named in ATLA-1221 / ATLA-1136 reconcile to idle.
  it.each([
    ["Head of Quant Research (ATLA-1221)", "51521122-5151-4151-8151-515151515151"],
    ["quant-strategy-developer (ATLA-1136)", "ec16c228-ec16-4c22-8c16-ec16c228ec16"],
  ])("reconciles historical orphan %s through the read path", async (_label, agentId) => {
    const orphan = baseAgent({ id: agentId, status: "running" });
    const { db } = makeDb({ rows: [orphan], backingRunCount: 0 });
    const svc = agentService(db as never);

    const agent = await svc.getById(agentId);

    expect(agent?.status).toBe("idle");
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const [, input] = logActivityMock.mock.calls[0]!;
    expect(input).toMatchObject({ entityId: agentId, action: "agent.status.reconciled" });
  });
});

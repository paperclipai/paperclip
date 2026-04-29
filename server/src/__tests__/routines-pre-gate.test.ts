import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";
import { routinePreGateSchema } from "@paperclipai/shared/validators/routine";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres preGate tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine preGate — tickScheduledTriggers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-pregate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts: {
    preGate?: unknown;
    lastTriggeredAt?: Date | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const wakeups: Array<{ agentId: string; opts: unknown }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "PreGate Test Co",
      issuePrefix: "PGT",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GateBot",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Gated Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "gated routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    // Apply preGate and lastTriggeredAt via DB update so tests can inject
    // invalid preGate objects (bypassing TypeScript) to verify runtime security.
    const lastTriggeredAt = opts.lastTriggeredAt !== undefined
      ? opts.lastTriggeredAt
      : new Date("2026-01-01T00:00:00Z");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db
      .update(routines)
      .set({ preGate: (opts.preGate ?? null) as any, lastTriggeredAt })
      .where(eq(routines.id, routine.id));

    // Insert a past-due schedule trigger so tickScheduledTriggers picks it up
    const pastRunAt = new Date("2026-04-01T10:00:00Z");
    await db.insert(routineTriggers).values({
      id: randomUUID(),
      companyId,
      routineId: routine.id,
      kind: "schedule",
      enabled: true,
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      nextRunAt: pastRunAt,
    });

    const now = new Date("2026-04-01T11:00:00Z"); // > pastRunAt
    return { companyId, agentId, projectId, svc, routineId: routine.id, now, wakeups };
  }

  it("creates gated_skip run when preGate condition is not satisfied (count < minCount)", async () => {
    const { companyId, svc, now, wakeups } = await seedFixture({
      preGate: { kind: "sql_count", table: "issues", condition: "created_at > lastTriggeredAt", minCount: 1 },
      // No issues in DB → count = 0 < minCount 1 → gate fails
    });

    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(0);
    expect(wakeups).toHaveLength(0);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("gated_skip");
    expect(runs[0]?.linkedIssueId).toBeNull();
  });

  it("dispatches normally (creates issue) when preGate is null", async () => {
    const { companyId, svc, now, wakeups } = await seedFixture({
      preGate: null,
    });

    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(1);
    expect(wakeups).toHaveLength(1);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("issue_created");
    expect(runs[0]?.linkedIssueId).toBeTruthy();
  });

  it("dispatches normally when preGate condition is satisfied (count >= minCount)", async () => {
    const { companyId, agentId, projectId, svc, now, wakeups } = await seedFixture({
      preGate: { kind: "sql_count", table: "issues", condition: "created_at > lastTriggeredAt", minCount: 1 },
      lastTriggeredAt: new Date("2026-01-01T00:00:00Z"),
    });

    // Seed an issue whose created_at > lastTriggeredAt so the gate passes
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Trigger issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(1);
    expect(wakeups).toHaveLength(1);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("issue_created");
  });

  it("treats lastTriggeredAt = null as gate passed (first-run semantics, no dispatch blocked)", async () => {
    const { companyId, svc, now, wakeups } = await seedFixture({
      preGate: { kind: "sql_count", table: "issues", condition: "created_at > lastTriggeredAt", minCount: 1 },
      lastTriggeredAt: null, // first run → evaluatePreGate returns true regardless of count
    });

    // No issues in DB — count = 0 < minCount 1 — but gate must pass because lastTriggeredAt = null
    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(1);
    expect(wakeups).toHaveLength(1);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("issue_created");
  });

  it("creates gated_skip (not dispatched) when preGate references a non-whitelisted table", async () => {
    // Intentionally bypass TypeScript to inject a non-whitelisted table via JSONB.
    // This simulates corrupted or legacy DB data reaching the runtime security check.
    const { companyId, svc, now, wakeups } = await seedFixture({
      preGate: { kind: "sql_count", table: "company_secrets", condition: "created_at > lastTriggeredAt", minCount: 1 },
    });

    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(0);
    expect(wakeups).toHaveLength(0);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("gated_skip");
    expect(runs[0]?.linkedIssueId).toBeNull();
  });

  it("creates gated_skip (not dispatched) when preGate condition references a disallowed column", async () => {
    // "password" is not in PREGATE_SAFE_COLUMNS — evaluatePreGate must reject it.
    const { companyId, svc, now, wakeups } = await seedFixture({
      preGate: { kind: "sql_count", table: "issues", condition: "password > lastTriggeredAt", minCount: 1 },
    });

    const result = await svc.tickScheduledTriggers(now);

    expect(result.triggered).toBe(0);
    expect(wakeups).toHaveLength(0);

    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("gated_skip");
    expect(runs[0]?.linkedIssueId).toBeNull();
  });
});

// ---- Pure unit tests for routinePreGateSchema (no DB required) ----

describe("routinePreGateSchema — input validation", () => {
  it("accepts a valid sql_count preGate object with known table and reference", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "sql_count",
      table: "issues",
      condition: "created_at > lastTriggeredAt",
      minCount: 5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts all whitelisted tables", () => {
    const tables = ["agents", "issues", "routines", "routine_runs", "heartbeat_runs"] as const;
    for (const table of tables) {
      const result = routinePreGateSchema.safeParse({
        kind: "sql_count",
        table,
        condition: "created_at > lastTriggeredAt",
        minCount: 1,
      });
      expect(result.success, `table "${table}" should be accepted`).toBe(true);
    }
  });

  it("accepts null (no gate configured)", () => {
    const result = routinePreGateSchema.safeParse(null);
    expect(result.success).toBe(true);
  });

  it("accepts undefined (no gate configured)", () => {
    const result = routinePreGateSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("rejects a non-whitelisted table (e.g. company_secrets)", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "sql_count",
      table: "company_secrets",
      condition: "created_at > lastTriggeredAt",
      minCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a SQL injection attempt in the condition field", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "sql_count",
      table: "issues",
      condition: "1=1; DROP TABLE companies;--",
      minCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a condition with a disallowed reference value", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "sql_count",
      table: "issues",
      condition: "created_at > someArbitraryValue",
      minCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects minCount below minimum (schema enforces min=1)", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "sql_count",
      table: "issues",
      condition: "created_at > lastTriggeredAt",
      minCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown preGate kind", () => {
    const result = routinePreGateSchema.safeParse({
      kind: "regex_match",
      table: "issues",
      condition: "title ~ 'urgent'",
      minCount: 1,
    });
    expect(result.success).toBe(false);
  });
});

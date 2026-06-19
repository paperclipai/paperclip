import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  dispatchUnassignedTodo,
  type DispatcherLiteConfig,
} from "../services/dispatcher-lite.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping dispatcher-lite tests: ${support.reason ?? "embedded pg unsupported"}`);
}

d("dispatcher-lite: dispatchUnassignedTodo", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let wakeups: Array<{ agentId: string; source?: string }>;

  const wakeup = async (agentId: string, opts: { source?: string }) => {
    wakeups.push({ agentId, source: opts.source });
    return null;
  };

  function cfg(over: Partial<DispatcherLiteConfig> = {}): DispatcherLiteConfig {
    return {
      enabled: true,
      companyIds: [companyId],
      maxPerTick: 5,
      wipCap: 3,
      cooldownMin: 15,
      ...over,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dl-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    try {
      await (tempDb as { stop?: () => Promise<void> } | null)?.stop?.();
    } catch {
      /* noop */
    }
  });

  async function seedCompany() {
    companyId = randomUUID();
    wakeups = [];
    await db.insert(companies).values({
      id: companyId,
      name: "DL",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(
    opts: { dispatch?: boolean; hb?: boolean; status?: string; maxConcurrentRuns?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `a-${id.slice(0, 4)}`,
      role: "engineer",
      status: opts.status ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: opts.hb ?? true,
          intervalSec: 1,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
        },
        dispatch: { enabled: opts.dispatch ?? true },
      },
      permissions: {},
      lastHeartbeatAt: new Date(0),
    });
    return id;
  }

  async function seedIssue(
    opts: { status?: string; assignee?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `i-${id.slice(0, 4)}`,
      status: opts.status ?? "todo",
      assigneeAgentId: opts.assignee ?? null,
    });
    return id;
  }

  async function seedRun(agentId: string, status: string, startedAt?: Date) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status,
      ...(startedAt ? { startedAt } : {}),
    });
  }

  async function assigneeOf(issueId: string): Promise<string | null> {
    const [row] = await db
      .select({ a: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row?.a ?? null;
  }

  it("disabled flag -> no-op", async () => {
    await seedCompany();
    const a = await seedAgent();
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg({ enabled: false }));
    expect(r.considered).toBe(0);
    expect(r.assigned).toBe(0);
    expect(await assigneeOf(iss)).toBeNull();
    expect(wakeups.length).toBe(0);
    void a;
  });

  it("dry-run -> reports WOULD assign but mutates nothing", async () => {
    await seedCompany();
    await seedAgent();
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg(), { apply: false });
    expect(r.dryRun).toBe(true);
    expect(r.assigned).toBe(1);
    expect(await assigneeOf(iss)).toBeNull();
    expect(wakeups.length).toBe(0);
  });

  it("assigns unassigned todo to eligible idle agent + fires assignment wakeup", async () => {
    await seedCompany();
    const a = await seedAgent();
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(1);
    expect(await assigneeOf(iss)).toBe(a);
    expect(wakeups).toEqual([{ agentId: a, source: "assignment" }]);
  });

  it("skips agent not opted in (dispatch.enabled=false)", async () => {
    await seedCompany();
    await seedAgent({ dispatch: false });
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(await assigneeOf(iss)).toBeNull();
  });

  it("skips non-idle agent (error)", async () => {
    await seedCompany();
    await seedAgent({ status: "error" });
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(0);
    expect(await assigneeOf(iss)).toBeNull();
  });

  it("skips agent with heartbeat disabled", async () => {
    await seedCompany();
    await seedAgent({ hb: false });
    await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(0);
  });

  it("skips agent in failure cooldown", async () => {
    await seedCompany();
    const a = await seedAgent();
    await seedRun(a, "failed", new Date(Date.now() - 60_000)); // 1 min ago, within 15-min cooldown
    const iss = await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(0);
    expect(await assigneeOf(iss)).toBeNull();
  });

  it("skips agent at concurrency cap (running run)", async () => {
    await seedCompany();
    const a = await seedAgent({ maxConcurrentRuns: 1 });
    await seedRun(a, "running");
    await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.assigned).toBe(0);
  });

  it("respects WIP cap", async () => {
    await seedCompany();
    const a = await seedAgent();
    // agent already holds wipCap(=2 here) open issues
    await seedIssue({ status: "in_progress", assignee: a });
    await seedIssue({ status: "todo", assignee: a });
    const iss = await seedIssue(); // the unassigned one
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg({ wipCap: 2 }));
    expect(r.assigned).toBe(0);
    expect(await assigneeOf(iss)).toBeNull();
  });

  it("respects maxPerTick cap", async () => {
    await seedCompany();
    // 3 eligible agents, 5 unassigned issues, cap 2 -> only 2 assigned this tick
    await seedAgent();
    await seedAgent();
    await seedAgent();
    for (let i = 0; i < 5; i++) await seedIssue();
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg({ maxPerTick: 2 }));
    expect(r.considered).toBe(2);
    expect(r.assigned).toBe(2);
    expect(wakeups.length).toBe(2);
  });

  it("ignores blocked / already-assigned / done", async () => {
    await seedCompany();
    const a = await seedAgent();
    const other = await seedAgent();
    const blocked = await seedIssue({ status: "blocked" });
    const assigned = await seedIssue({ status: "todo", assignee: other });
    const done = await seedIssue({ status: "done" });
    const r = await dispatchUnassignedTodo(db, { wakeup }, cfg());
    expect(r.considered).toBe(0);
    expect(r.assigned).toBe(0);
    expect(await assigneeOf(blocked)).toBeNull();
    expect(await assigneeOf(assigned)).toBe(other);
    void a;
    void done;
  });
});

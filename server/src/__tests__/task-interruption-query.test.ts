import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureInterruptionQuery, seedInterruptionFixture } from "./helpers/task-interruption-fixture.js";

const captureTaskInterruptionFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure }));

describe("task interruption latest run query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("interruption-query-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("does not inspect unrelated company history for a small issue page", async () => {
    const f = await seedInterruptionFixture(db, { selected: 2, history: 3, unrelated: 1500, payloadBytes: 4096 });
    const query = await captureInterruptionQuery(db, taskInterruptionPresentations, f.companyId, f.input);
    const [explain] = await db.$client.unsafe(`explain (analyze, buffers, format json) ${query.sql}`, query.params as never[]);
    const inspected: number[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "heartbeat_runs") inspected.push(
        (Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0)) * Number(node["Actual Loops"] ?? 1));
      for (const child of node.Plans as Record<string, unknown>[] ?? []) visit(child);
    };
    visit(explain["QUERY PLAN"][0].Plan);
    expect(inspected.length).toBeGreaterThan(0);
    expect(Math.max(...inspected)).toBeLessThan(30);
    const presentations = await taskInterruptionPresentations(db, f.companyId, f.input);
    for (const issue of f.input) expect(presentations.get(issue.id)).toMatchObject({ state: "failed", canRetry: true });
    for (const issue of f.input) expect(captureTaskInterruptionFailure).toHaveBeenCalledWith(expect.objectContaining({
      companyId: f.companyId, taskId: issue.id, runId: presentations.get(issue.id)!.observedRunId,
      runStatus: "failed", agentAdapter: "process",
    }));
  });

  it("preserves native, first-class and text legacy precedence, ties, and tenant scope", async () => {
    const companyId = randomUUID(), otherId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values([companyId, otherId].map(id => ({ id, name: "Selectors", issuePrefix: `S${id.slice(0, 7)}` })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Selector agent", adapterType: "process" });
    const input = await db.insert(issues).values(Array.from({ length: 10 }, (_, n) => ({ companyId, title: `Selector ${n}`, status: "in_progress", assigneeAgentId: agentId }))).returning();
    const base = { companyId, agentId, status: "failed", createdAt: new Date("2026-10-27T00:00:00Z") };
    const winnerIds = Array.from({ length: 7 }, () => randomUUID());
    await db.$client.unsafe("alter table heartbeat_runs disable trigger heartbeat_runs_set_scope_kind");
    await db.insert(heartbeatRuns).values([
      { ...base, id: winnerIds[0], nativeIssueId: input[0]!.id, issueId: input[1]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[2]!.id } },
      { ...base, id: winnerIds[1], issueId: input[1]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[2]!.id } },
      { ...base, id: winnerIds[2], contextSnapshot: { issueId: input[2]!.id } },
      { ...base, nativeIssueId: randomUUID(), contextSnapshot: { issueId: input[3]!.id } },
      { ...base, nativeIssueId: null, issueId: input[9]!.id, scopeKind: "issue", contextSnapshot: { issueId: input[3]!.id } },
      { ...base, contextSnapshot: { issueId: input[3]!.id.toUpperCase() } },
      ...[null, "", [], 5, { issueId: "" }, { issueId: {} }, { issueId: [] }].map(contextSnapshot => ({ ...base, contextSnapshot: contextSnapshot as never })),
      { ...base, id: winnerIds[3], nativeIssueId: input[4]!.id, contextSnapshot: null },
      { ...base, id: winnerIds[4], issueId: input[5]!.id, scopeKind: "issue", contextSnapshot: [input[3]!.id] as never },
      { ...base, id: "00000000-0000-0000-0000-000000000001", contextSnapshot: { issueId: input[6]!.id } },
      { ...base, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", nativeIssueId: input[6]!.id, contextSnapshot: { issueId: "" } },
      { ...base, companyId: otherId, nativeIssueId: input[3]!.id, createdAt: new Date("2026-10-28T00:00:00Z") },
    ]);
    await db.$client.unsafe("alter table heartbeat_runs enable trigger heartbeat_runs_set_scope_kind");
    const result = await taskInterruptionPresentations(db, companyId, [...input, input[0]!, { ...input[0]!, companyId: otherId }]);
    for (let n = 0; n < 3; n++) expect(result.get(input[n]!.id)?.observedRunId).toBe(winnerIds[n]);
    expect(result.get(input[3]!.id)).toBeNull();
    expect(result.get(input[4]!.id)?.observedRunId).toBe(winnerIds[3]);
    expect(result.get(input[5]!.id)?.observedRunId).toBe(winnerIds[4]);
    expect(result.get(input[6]!.id)?.observedRunId).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(result.get(input[7]!.id)).toBeNull();
    expect(result.get(input[8]!.id)).toBeNull();
    const upper = { ...input[4]!, id: input[4]!.id.toUpperCase() };
    expect((await taskInterruptionPresentations(db, companyId, [upper])).get(upper.id)).toBeNull();
    expect(await taskInterruptionPresentations(db, companyId, [])).toEqual(new Map());
  });

  it("reports the saved-message failure state without reporting work, retries or user actions", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), pausedAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Failure states", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", adapterType: "process" },
      { id: pausedAgentId, companyId, name: "Paused worker", adapterType: "process", status: "paused" },
    ]);
    const input = await db.insert(issues).values(Array.from({ length: 9 }, (_, n) => ({
      companyId, title: `State ${n}`, status: n === 5 ? "done" : "in_progress",
      assigneeAgentId: n === 8 ? pausedAgentId : agentId,
    }))).returning();
    const runs = await db.insert(heartbeatRuns).values(input.map((issue, n) => ({
      companyId, agentId: issue.assigneeAgentId!, issueId: issue.id,
      status: n === 1 || n === 4 ? "succeeded" : n === 2 ? "running" : n === 7 ? "cancelled" : "failed",
      errorCode: n === 6 ? "native_provider_approval_required" : null,
      scheduledRetryAt: n === 3 ? new Date(Date.now() + 60_000) : null,
    }))).returning();
    const [wait] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", payload: { issueId: input[1]!.id }, requestedAt: new Date(Date.now() - 20_000),
    }).returning();
    captureTaskInterruptionFailure.mockClear();
    const result = await taskInterruptionPresentations(db, companyId, [...input, { ...input[0]!, companyId: randomUUID() }]);
    expect(captureTaskInterruptionFailure).toHaveBeenCalledTimes(3);
    for (const n of [0, 1, 7]) {
      expect(result.get(input[n]!.id)).toMatchObject({ responsibility: "system", state: "failed" });
      expect(captureTaskInterruptionFailure).toHaveBeenCalledWith({
        companyId, agentId, taskId: input[n]!.id, runId: runs[n]!.id,
        runStatus: runs[n]!.status, agentAdapter: "process", intentId: n === 1 ? wait!.id : null,
      });
    }
    expect(result.get(input[2]!.id)?.state).toBe("working");
    expect(result.get(input[3]!.id)?.state).toBe("retry_scheduled");
    for (const n of [4, 5]) expect(result.get(input[n]!.id)?.state).toBe("resolved");
    for (const n of [6, 8]) expect(result.get(input[n]!.id)?.responsibility).toBe("user");
  });
});

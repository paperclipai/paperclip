import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureInterruptionQuery, seedInterruptionFixture } from "./helpers/task-interruption-fixture.js";

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
});

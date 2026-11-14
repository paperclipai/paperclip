import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listFailedRunBatchFallback, listFailedRunsWithNewerRun } from "../services/attention-source-eligibility.js";

const externalUrl = resolveExternalTestDatabaseUrl(
  "PAPERCLIP_ATTENTION_INDEXED_LOOKUP_TEST_DATABASE_URL",
);
const embeddedPostgresSupport = externalUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("attention indexed lookup", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;
  let companyId: string;
  let agentId1: string;
  let agentId2: string;
  let issueId1: string;
  let issueId2: string;
  let issueId3: string;

  beforeAll(async () => {
    if (!externalUrl)
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-attention-indexed-",
      );
    db = createDb(externalUrl ?? tempDb!.connectionString, {
      maxConnections: 4,
    });

    const [company] = await db
      .insert(companies)
      .values({ identifier: "AI", name: "Attention Indexed Test" })
      .returning();
    companyId = company.id;

    const [agent1, agent2] = await db
      .insert(agents)
      .values([
        {
          id: randomUUID(),
          companyId,
          identifier: "agent-1",
          name: "Test Agent 1",
          status: "idle",
        },
        {
          id: randomUUID(),
          companyId,
          identifier: "agent-2",
          name: "Test Agent 2",
          status: "idle",
        },
      ])
      .returning();
    agentId1 = agent1.id;
    agentId2 = agent2.id;

    const [iss1, iss2, iss3] = await db
      .insert(issues)
      .values([
        {
          id: randomUUID(),
          companyId,
          identifier: "ATT-1",
          title: "Issue One",
          status: "todo",
        },
        {
          id: randomUUID(),
          companyId,
          identifier: "ATT-2",
          title: "Issue Two",
          status: "todo",
        },
        {
          id: randomUUID(),
          companyId,
          identifier: "ATT-3",
          title: "Issue Three",
          status: "todo",
        },
      ])
      .returning();
    issueId1 = iss1.id;
    issueId2 = iss2.id;
    issueId3 = iss3.id;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const ctxSnapshot = (issueId: string) => ({
    issueId,
    taskId: "",
    stepDetails: 0,
  });

  const seedRuns = (db: ReturnType<typeof createDb>, state: {
    companyId: string;
    agentId1: string;
    agentId2: string;
    issueId1: string;
    issueId2: string;
    issueId3: string;
  }, runIds: { run1Id: string; run2Id: string; run3Id: string; run4Id: string; run5Id: string; run6Id: string }, now: Date) => {
    const t = (ms: number) => new Date(now.getTime() + ms);
    return db.insert(heartbeatRuns).values([
      { id: runIds.run1Id, companyId: state.companyId, agentId: state.agentId1, scopeKind: "issue", issueId: state.issueId1, contextSnapshot: ctxSnapshot(state.issueId1), status: "failed", createdAt: t(0), startedAt: t(0), finishedAt: t(1000), exitCode: 1 },
      { id: runIds.run2Id, companyId: state.companyId, agentId: state.agentId1, scopeKind: "issue", issueId: state.issueId1, contextSnapshot: ctxSnapshot(state.issueId1), status: "failed", createdAt: t(60000), startedAt: t(60000), finishedAt: t(61000), exitCode: 1 },
      { id: runIds.run3Id, companyId: state.companyId, agentId: state.agentId1, scopeKind: "issue", issueId: state.issueId1, contextSnapshot: ctxSnapshot(state.issueId1), status: "failed", createdAt: t(120000), startedAt: t(120000), finishedAt: t(121000), exitCode: 1 },
      { id: randomUUID(), companyId: state.companyId, agentId: state.agentId1, scopeKind: "issue", issueId: state.issueId1, contextSnapshot: ctxSnapshot(state.issueId1), status: "completed", createdAt: t(200000), startedAt: t(200000), finishedAt: t(201000) },
      { id: runIds.run4Id, companyId: state.companyId, agentId: state.agentId1, scopeKind: "issue", issueId: state.issueId2, contextSnapshot: ctxSnapshot(state.issueId2), status: "failed", createdAt: t(0), startedAt: t(0), finishedAt: t(1000), exitCode: 1 },
      { id: runIds.run5Id, companyId: state.companyId, agentId: state.agentId2, scopeKind: "issue", issueId: state.issueId3, contextSnapshot: ctxSnapshot(state.issueId3), status: "failed", createdAt: t(0), startedAt: t(0), finishedAt: t(1000), exitCode: 1 },
      { id: runIds.run6Id, companyId: state.companyId, agentId: state.agentId2, scopeKind: "issue", issueId: state.issueId3, contextSnapshot: ctxSnapshot(state.issueId3), status: "failed", createdAt: t(60000), startedAt: t(60000), finishedAt: t(61000), exitCode: 1 },
      { id: randomUUID(), companyId: state.companyId, agentId: state.agentId2, scopeKind: "issue", issueId: state.issueId3, contextSnapshot: ctxSnapshot(state.issueId3), status: "completed", createdAt: t(200000), startedAt: t(200000), finishedAt: t(201000) },
    ]);
  };

  const failedRuns = (runIds: { run1Id: string; run2Id: string; run3Id: string; run4Id: string; run5Id: string; run6Id: string }) => [
    { id: runIds.run1Id, agentId: agentId1, issueId: issueId1, createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: runIds.run2Id, agentId: agentId1, issueId: issueId1, createdAt: new Date("2026-01-01T00:01:00Z") },
    { id: runIds.run3Id, agentId: agentId1, issueId: issueId1, createdAt: new Date("2026-01-01T00:02:00Z") },
    { id: runIds.run4Id, agentId: agentId1, issueId: issueId2, createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: runIds.run5Id, agentId: agentId2, issueId: issueId3, createdAt: new Date("2026-01-01T00:00:00Z") },
    { id: runIds.run6Id, agentId: agentId2, issueId: issueId3, createdAt: new Date("2026-01-01T00:01:00Z") },
  ];

  const expectResults = (runIds: { run1Id: string; run2Id: string; run3Id: string; run4Id: string; run5Id: string; run6Id: string }, set: Set<string>) => {
    expect(set.has(runIds.run1Id)).toBe(true);
    expect(set.has(runIds.run2Id)).toBe(true);
    expect(set.has(runIds.run3Id)).toBe(true);
    expect(set.has(runIds.run4Id)).toBe(false);
    expect(set.has(runIds.run5Id)).toBe(true);
    expect(set.has(runIds.run6Id)).toBe(true);
    expect(set.size).toBe(5);
  };

  it("returns failed runs with newer runs using indexed issue_id lookup", async () => {
    const runIds = {
      run1Id: randomUUID(),
      run2Id: randomUUID(),
      run3Id: randomUUID(),
      run4Id: randomUUID(),
      run5Id: randomUUID(),
      run6Id: randomUUID(),
    };
    const now = new Date("2026-01-01T00:00:00Z");
    await seedRuns(db, { companyId, agentId1, agentId2, issueId1, issueId2, issueId3 }, runIds, now);
    const result = await listFailedRunsWithNewerRun(db, companyId, failedRuns(runIds));
    expectResults(runIds, result instanceof Set ? result : new Set(result));
  });

  it("indexed lookup and context_snapshot fallback give the same results", async () => {
    const runIds = {
      run1Id: randomUUID(),
      run2Id: randomUUID(),
      run3Id: randomUUID(),
      run4Id: randomUUID(),
      run5Id: randomUUID(),
      run6Id: randomUUID(),
    };
    const now = new Date("2026-01-01T00:00:00Z");
    await seedRuns(db, { companyId, agentId1, agentId2, issueId1, issueId2, issueId3 }, runIds, now);
    const indexedResult = await listFailedRunsWithNewerRun(db, companyId, failedRuns(runIds));
    const indexedSet = indexedResult instanceof Set ? indexedResult : new Set(indexedResult);
    const fallbackResult = await listFailedRunBatchFallback(db, companyId, failedRuns(runIds));
    const fallbackSet = fallbackResult instanceof Set ? fallbackResult : new Set(fallbackResult);
    expect(indexedSet.size).toBe(fallbackSet.size);
    for (const id of indexedSet) expect(fallbackSet.has(id)).toBe(true);
  });

  it("handles empty input correctly", async () => {
    const result = await listFailedRunsWithNewerRun(db, companyId, []);
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });
});

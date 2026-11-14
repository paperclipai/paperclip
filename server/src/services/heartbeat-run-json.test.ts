import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { activityService } from "./activity.js";
import { executionProjectionsForRuns } from "./execution-projection.js";
import { createHeartbeatRunState } from "./heartbeat/run-state.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("heartbeat run JSON reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-run-json-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`alter table heartbeat_runs set (autovacuum_enabled = false, toast.autovacuum_enabled = false)`);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function toastBlocks(): Promise<number> {
    await db.execute(sql`select pg_stat_force_next_flush()`);
    const rows = await db.execute<{ blocks: string }>(sql`
      select coalesce(toast_blks_hit, 0) + coalesce(toast_blks_read, 0) as blocks
      from pg_statio_all_tables where relid = 'heartbeat_runs'::regclass`);
    return Number(rows[0]?.blocks);
  }

  async function measured<T>(work: () => Promise<T>): Promise<{ blocks: number; result: T }> {
    const before = await toastBlocks();
    const result = await work();
    return { blocks: (await toastBlocks()) - before, result };
  }

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Run JSON", issuePrefix: `J${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Large output", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Large output", assigneeAgentId: agent.id }).returning();
    return { companyId, agent, issue };
  }

  function sqlAsciiState() {
    const reader = new Proxy(db, {
      get: (target, key, receiver) => key === "execute"
        ? async () => [{ server_encoding: "SQL_ASCII" }]
        : Reflect.get(target, key, receiver),
    });
    return createHeartbeatRunState(reader);
  }

  const largeText = () => randomBytes(512 * 1024).toString("base64");

  it("reads large stored run JSON once per row in task, projection, detail, evidence and compaction queries", async () => {
    const { companyId, agent, issue } = await fixture();
    const stdout = largeText();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, issueId: issue.id, status: "succeeded", livenessState: "completed",
      sessionIdAfter: "large-session", usageJson: { rawInputTokens: 200 },
      contextSnapshot: { issueId: issue.id, paperclipTaskMarkdown: largeText() },
      resultJson: { summary: "done", stdout, terminalSessionFailure: { category: "none", title: "t", details: "d" } },
    }).returning();

    const { blocks: resultRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.resultJson} ->> 'summary' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id}`));
    expect(resultRead).toBeGreaterThan(50);
    const { blocks: contextRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.contextSnapshot} ->> 'issueId' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id}`));
    expect(contextRead).toBeGreaterThan(50);
    const { blocks: twoReads } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.resultJson} ->> 'summary', ${heartbeatRuns.resultJson} ->> 'stdout'
        from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id}`));
    expect(twoReads).toBe(resultRead * 2);

    const state = createHeartbeatRunState(db);
    const taskRuns = await measured(() => activityService(db).runsForIssue(
      companyId, issue.id, null, undefined, undefined, { skipLivenessBackfill: true }));
    const projection = await measured(() => executionProjectionsForRuns(db, companyId, [run.id]));
    const detail = await measured(() => state.getRun(run.id));
    const evidence = await measured(() => state.getRun(run.id, { includeExecutionEvidence: true }));
    const executionWait = await measured(() => state.getRunExecutionWait(companyId, run.id));
    const compaction = await measured(() => state.evaluateSessionCompaction({
      agent: { ...agent, runtimeConfig: { heartbeat: { sessionCompaction: { maxRawInputTokens: 100 } } } },
      sessionId: "large-session", issueId: issue.id,
    }));
    const sqlAsciiDetail = await measured(() => sqlAsciiState().getRun(run.id));

    expect(taskRuns.result.map((row) => row.runId)).toEqual([run.id]);
    expect(taskRuns.result[0]?.contextIssueId).toBe(issue.id);
    expect(projection.result.has(run.id)).toBe(true);
    const detailResult = detail.result?.resultJson as { summary?: unknown; stdout?: unknown; truncated?: unknown } | null | undefined;
    expect(detailResult?.summary).toBe("done");
    expect(detailResult?.truncated).toBe(true);
    expect(String(detailResult?.stdout).length).toBeLessThan(stdout.length);
    expect(evidence.result?.resultJson).not.toBeNull();
    expect(executionWait.result?.contextSnapshot).toEqual({ issueId: issue.id });
    expect(compaction.result.handoffMarkdown).toContain("done");
    expect(sqlAsciiDetail.result?.resultJson).toBeNull();
    expect({
      runsForIssue: taskRuns.blocks,
      executionProjection: projection.blocks,
      getRun: detail.blocks,
      getRunEvidence: evidence.blocks,
      getRunExecutionWait: executionWait.blocks,
      evaluateSessionCompaction: compaction.blocks,
      sqlAsciiGetRun: sqlAsciiDetail.blocks,
    }).toEqual({
      runsForIssue: 2 * (resultRead + contextRead),
      executionProjection: resultRead + contextRead,
      getRun: resultRead + contextRead,
      getRunEvidence: resultRead + contextRead,
      getRunExecutionWait: resultRead + contextRead,
      evaluateSessionCompaction: resultRead,
      sqlAsciiGetRun: contextRead,
    });
  });

  it("reads large results only for the runs a limited task read returns", async () => {
    const { companyId, agent, issue } = await fixture();
    const runIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId: agent.id, issueId: issue.id, status: "succeeded", livenessState: "completed",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        contextSnapshot: { issueId: issue.id },
        resultJson: { summary: `run ${index}`, stdout: randomBytes(128 * 1024).toString("base64") },
      }).returning();
      runIds.push(run.id);
    }
    const { blocks: resultRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.resultJson} ->> 'summary' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runIds[9]}`));
    expect(resultRead).toBeGreaterThan(10);

    const limited = await measured(() => activityService(db).runsForIssue(
      companyId, issue.id, null, 2, undefined, { skipLivenessBackfill: true },
    ));

    expect(limited.result.map((row) => row.runId)).toEqual([runIds[9], runIds[8]]);
    expect(limited.blocks).toBe(2 * 2 * resultRead);
  });

  it("reads large results only for the session runs compaction keeps", async () => {
    const { companyId, agent, issue } = await fixture();
    const runIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId: agent.id, issueId: issue.id, status: "succeeded", livenessState: "completed",
        sessionIdAfter: "long-session", usageJson: { rawInputTokens: 200 },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        contextSnapshot: { issueId: issue.id },
        resultJson: { summary: `run ${index}`, stdout: randomBytes(128 * 1024).toString("base64") },
      }).returning();
      runIds.push(run.id);
    }
    const { blocks: resultRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.resultJson} ->> 'summary' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runIds[9]}`));
    expect(resultRead).toBeGreaterThan(10);

    const compaction = await measured(() => createHeartbeatRunState(db).evaluateSessionCompaction({
      agent: { ...agent, runtimeConfig: { heartbeat: { sessionCompaction: { maxRawInputTokens: 100 } } } },
      sessionId: "long-session", issueId: issue.id,
    }));

    expect(compaction.result.rotate).toBe(true);
    expect(compaction.result.previousRunId).toBe(runIds[9]);
    expect(compaction.result.handoffMarkdown).toContain("run 9");
    expect(compaction.blocks).toBe(4 * resultRead);
  });

  it("reads a large run context once per listed run", async () => {
    const { companyId, agent, issue } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, status: "succeeded", resultJson: { summary: "small" },
      contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned", paperclipTaskMarkdown: largeText() },
    }).returning();
    const { blocks: contextRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.contextSnapshot} ->> 'issueId' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id}`));
    expect(contextRead).toBeGreaterThan(50);

    const state = createHeartbeatRunState(db);
    const listed = await measured(() => state.listRuns(companyId, agent.id));
    const summary = await measured(() => state.listRuns(companyId, agent.id, undefined, { summary: true }));

    expect(listed.result.map((row) => [row.id, row.contextSnapshot])).toEqual([
      [run.id, expect.objectContaining({ issueId: issue.id, wakeReason: "issue_assigned" })],
    ]);
    expect({ listRuns: listed.blocks, summaryListRuns: summary.blocks })
      .toEqual({ listRuns: contextRead, summaryListRuns: contextRead });
  });

  it("returns a stored result within the size limit unchanged with one read", async () => {
    const { companyId, agent } = await fixture();
    const resultJson = { summary: "mid", stdout: randomBytes(30 * 1024).toString("base64") };
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "succeeded", resultJson }).returning();
    const [legacy] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "succeeded" }).returning();
    await db.update(heartbeatRuns).set({ resultJson: ["legacy"] as unknown as Record<string, unknown> })
      .where(eq(heartbeatRuns.id, legacy.id));
    const { blocks: resultRead } = await measured(() =>
      db.execute(sql`select ${heartbeatRuns.resultJson} ->> 'summary' from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id}`));
    expect(resultRead).toBeGreaterThan(0);

    const state = createHeartbeatRunState(db);
    const detail = await measured(() => state.getRun(run.id));

    expect(detail.result?.resultJson).toEqual(resultJson);
    expect(detail.blocks).toBe(resultRead);
    expect((await state.getRun(legacy.id))?.resultJson).toEqual(["legacy"]);
  });

  it("keeps a missing stored result missing", async () => {
    const { companyId, agent, issue } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, issueId: issue.id, status: "succeeded" }).returning();
    await db.update(heartbeatRuns).set({ resultJson: null, contextSnapshot: null }).where(eq(heartbeatRuns.id, run.id));

    const state = createHeartbeatRunState(db);
    expect((await state.getRun(run.id))?.resultJson).toBeNull();
    expect((await state.getRun(run.id, { includeExecutionEvidence: true }))?.resultJson).toBeNull();
    expect((await state.getRunExecutionWait(companyId, run.id))?.contextSnapshot).toBeNull();
    const [taskRun] = await activityService(db).runsForIssue(
      companyId, issue.id, null, undefined, undefined, { skipLivenessBackfill: true });
    expect(taskRun?.resultJson).toBeNull();
    expect(taskRun?.contextIssueId).toBeNull();
  });
});

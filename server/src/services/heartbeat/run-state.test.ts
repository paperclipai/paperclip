import { randomBytes, randomUUID } from "node:crypto";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import * as legacy from "../heartbeat.js";
import * as extracted from "./run-state.js";
import { readRunCancellation } from "../run-cancellation.js";
import { decideQueuedCommentQueueSteering } from "../issue-queued-comment-queue.js";

// SQL_ASCII needs a separate database cluster. Inspect its selected SQL here;
// the PostgreSQL tests below exercise the session queries and transactions.
function readingDatabase(serverEncoding: string, ...results: unknown[][]) {
  const scopes: unknown[][] = [];
  const columns: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => [{ server_encoding: serverEncoding }]);
  const select = vi.fn((projection: Record<string, unknown> = {}) => {
    columns.push(projection);
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      leftJoin: () => query,
      where: (condition: SQL) => {
        scopes.push(new PgDialect().sqlToQuery(condition).params);
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  });
  return { db: { execute, select } as unknown as Db, execute, select, columns, scopes };
}

describe("heartbeat run state module", () => {
  it("preserves the legacy public helper identities", () => {
    expect(legacy.resolveNextSessionState).toBe(extracted.resolveNextSessionState);
    expect(legacy.buildExplicitResumeSessionOverride).toBe(extracted.buildExplicitResumeSessionOverride);
    expect(legacy.normalizeAdapterRunUsage).toBe(extracted.normalizeAdapterRunUsage);
    expect(legacy.resolveLedgerScopeForRun).toBe(extracted.resolveLedgerScopeForRun);
    expect(legacy.summarizeHeartbeatRunListResultJson).toBe(extracted.summarizeHeartbeatRunListResultJson);
  });

  it("constructs without queries and binds session lookups to each database", async () => {
    const first = readingDatabase("UTF8", [{ sessionDisplayId: "first" }]);
    const second = readingDatabase("UTF8", [{ sessionDisplayId: "second" }]);
    const firstState = extracted.createHeartbeatRunState(first.db);
    const secondState = extracted.createHeartbeatRunState(second.db);
    expect(first.select).not.toHaveBeenCalled();
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.select).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
    const [one, two] = await Promise.all([
      firstState.getTaskSession("company-one", "agent-one", "codex_local", "task-one"),
      secondState.getTaskSession("company-two", "agent-two", "claude_local", "task-two"),
    ]);
    expect(one?.sessionDisplayId).toBe("first");
    expect(two?.sessionDisplayId).toBe("second");
    expect(first.scopes[0]).toEqual(["company-one", "agent-one", "codex_local", "task-one"]);
    expect(second.scopes[0]).toEqual(["company-two", "agent-two", "claude_local", "task-two"]);
  });

  it("keeps encoding caches local to each factory and preserves full-result reads", async () => {
    const ascii = readingDatabase("SQL_ASCII");
    const utf8 = readingDatabase("UTF8");
    const asciiState = extracted.createHeartbeatRunState(ascii.db);
    const utf8State = extracted.createHeartbeatRunState(utf8.db);
    await Promise.all([asciiState.getRun("ascii-one"), asciiState.getRun("ascii-two"), utf8State.getRun("utf8")]);
    const projectedSql = (column: unknown) => new PgDialect().sqlToQuery((column as SQL.Aliased).sql).sql;
    expect(ascii.execute).toHaveBeenCalledTimes(1);
    expect(utf8.execute).toHaveBeenCalledTimes(1);
    expect(projectedSql(ascii.columns[0].resultJson)).toBe("NULL");
    expect(projectedSql(utf8.columns[0].resultJson)).toContain("pg_column_size");
    await asciiState.getRun("evidence", { includeExecutionEvidence: true });
    expect(projectedSql(ascii.columns[2].resultJson)).toContain("startupPreparationSettledAt");
    await asciiState.getRunWorkspaceSettlement("settlement");
    expect(projectedSql(ascii.columns[3].error)).toBe("NULL");
    expect(ascii.execute).toHaveBeenCalledTimes(1);
    const raw = readingDatabase("SQL_ASCII");
    await extracted.createHeartbeatRunState(raw.db).getRun("raw", { unsafeFullResultJson: true });
    expect(raw.execute).not.toHaveBeenCalled();
    expect(raw.columns[0].resultJson).toBe(heartbeatRuns.resultJson);
  });

  it.each(["UTF8", "SQL_ASCII"])("keeps execution-wait reads company scoped with %s text handling", async encoding => {
    const reader = readingDatabase(encoding), state = extracted.createHeartbeatRunState(reader.db);
    expect(await state.getRunExecutionWait("company", "run")).toBeNull();
    expect(await state.getRunExecutionWait("other-company", "run")).toBeNull();
    expect(reader.scopes).toEqual([["company", "run"], ["other-company", "run"]]);
    expect(reader.execute).toHaveBeenCalledTimes(1);
    if (encoding === "UTF8") expect(reader.columns[0].error).toBe(heartbeatRuns.error);
    else expect(new PgDialect().sqlToQuery((reader.columns[0].error as SQL.Aliased).sql).sql).toBe("NULL");
    expect(new PgDialect().sqlToQuery((reader.columns[0].resultJson as SQL.Aliased).sql).sql).toContain("startupPreparationSettledAt");
  });

  it("loads current run status without large fields or an encoding probe", async () => {
    const binding = { id: "run", companyId: "company", agentId: "agent", status: "running" };
    const reader = readingDatabase("SQL_ASCII", [binding], []);
    const state = extracted.createHeartbeatRunState(reader.db);
    expect(await state.getRunStatus("run")).toEqual(binding);
    expect(await state.getRunStatus("missing")).toBeNull();
    expect(reader.execute).not.toHaveBeenCalled();
    expect(reader.columns).toEqual(Array(2).fill({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
    }));
    expect(reader.scopes).toEqual([["run"], ["missing"]]);
  });

  it("loads run read bindings without large fields or an encoding probe", async () => {
    const binding = { id: "run", companyId: "company", scopeKind: "issue", issueId: "issue" };
    const reader = readingDatabase("SQL_ASCII", [binding], []);
    const state = extracted.createHeartbeatRunState(reader.db);
    expect(await state.getRunReadAccess("run")).toEqual(binding);
    expect(await state.getRunReadAccess("missing")).toBeNull();
    expect(reader.execute).not.toHaveBeenCalled();
    expect(reader.columns).toEqual(Array(2).fill({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      scopeKind: heartbeatRuns.scopeKind,
      issueId: heartbeatRuns.issueId,
    }));
    expect(reader.scopes).toEqual([["run"], ["missing"]]);
  });
});

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;
if (!postgresSupport.supported) {
  console.warn(`Skipping run-state PostgreSQL tests: ${postgresSupport.reason ?? "unsupported host"}`);
}

describePostgres("heartbeat run state database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-run-state-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Run state", issuePrefix: `S${companyId.slice(0, 8)}` });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Session agent", adapterType: "codex_local",
    }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Session task", assigneeAgentId: agent.id }).returning();
    return { companyId, agent, issue, state: extracted.createHeartbeatRunState(db) };
  }

  it("reads current execution-wait evidence without transferring saved input or output", async () => {
    const { companyId, agent, issue } = await fixture();
    const payload = randomBytes(128 * 1024).toString("base64");
    const context = { issueId: issue.id, connectionIntentResolution: "existing_connection", source: "connection_intent.resolved",
      interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction", interactionId: randomUUID() };
    const result = { startupCancellation: { beforeNativeSelection: true, futureProof: { version: 2 } },
      startupPreparationSettledAt: "2020-01-01T00:00:00Z", cancellation: { source: "provider", expected: false,
        initiator: { type: "provider" }, reason: "Cancelled", recordedAt: "2020-01-01T00:00:00Z" },
      acpToolInventoryComplete: true, acpPendingToolCount: 0, stdout: payload };
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      contextSnapshot: { ...context, prompt: payload }, resultJson: result,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { prompt: payload } }, savedInput: payload },
      stdoutExcerpt: payload, stderrExcerpt: payload,
    }).returning();
    const observed = createDb(database.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
    try {
      const state = extracted.createHeartbeatRunState(observed);
      const read = await state.getRunExecutionWait(companyId, run.id);
      capture.flush();
      const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
      expect(summary.completedQueries).toBe(2);
      expect(summary.responseValueBytes).toBeLessThan(4096);
      expect(read).toMatchObject({ id: run.id, companyId, agentId: agent.id, status: "cancelled", contextSnapshot: context,
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { startupCancellation: result.startupCancellation, cancellation: result.cancellation,
          acpToolInventoryComplete: true, acpPendingToolCount: 0 } });
      expect(JSON.stringify(read)).not.toContain(payload.slice(0, 64));
      expect(read).not.toHaveProperty("stdoutExcerpt");
      expect(read).not.toHaveProperty("stderrExcerpt");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
      await db.update(heartbeatRuns).set({ status: "running", resultJson: { ...result, acpPendingToolCount: 1 },
        runnerProfileJson: { adapterDispatch: { adapterType: "process" }, savedInput: payload },
      }).where(eq(heartbeatRuns.id, run.id));
      expect(await state.getRunExecutionWait(companyId, run.id)).toMatchObject({ status: "running",
        resultJson: { acpPendingToolCount: 1 }, runnerProfileJson: { adapterDispatch: { adapterType: "process" } } });
      expect(await state.getRunExecutionWait(randomUUID(), run.id)).toBeNull();
      expect(await state.getRunExecutionWait(companyId, randomUUID())).toBeNull();
      for (const value of [null, false, 42, [], {}, { nested: true }, "task"]) {
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, issueId: value },
          runnerProfileJson: { adapterDispatch: { adapterType: value } },
        }).where(eq(heartbeatRuns.id, run.id));
        expect(await state.getRunExecutionWait(companyId, run.id)).toMatchObject({ contextSnapshot: { issueId: value },
          runnerProfileJson: { adapterDispatch: { adapterType: value } } });
      }
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it("reads current workspace access without execution snapshots and retains JSON types", async () => {
    const { companyId, agent, issue } = await fixture();
    const payload = randomBytes(128 * 1024).toString("base64"), workspaceId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId: issue.id,
      contextSnapshot: { executionWorkspaceId: workspaceId, prompt: payload }, runnerProfileJson: { instructions: payload },
      resultJson: { stdout: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
    }).returning();
    const observed = createDb(database.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
    try {
      const state = extracted.createHeartbeatRunState(observed);
      expect(await state.getRunWorkspaceAccess(run.id)).toEqual({
        id: run.id, companyId, scopeKind: "issue", issueId: issue.id, executionWorkspaceId: workspaceId,
      });
      capture.flush();
      const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
      expect(summary.completedQueries).toBe(1);
      expect(summary.responseValueBytes).toBeLessThan(1024);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
      for (const value of [null, true, 42, " workspace-two ", [workspaceId], { id: workspaceId }]) {
        await db.update(heartbeatRuns).set({ contextSnapshot: { executionWorkspaceId: value, prompt: payload } }).where(eq(heartbeatRuns.id, run.id));
        expect((await state.getRunWorkspaceAccess(run.id))?.executionWorkspaceId).toEqual(value);
      }
      expect(await state.getRunWorkspaceAccess(randomUUID())).toBeNull();
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it("reads fresh issue control facts without transferring execution snapshots", async () => {
    const { companyId, agent, issue } = await fixture();
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running",
      runtimeMode: "legacy", runtimeModeResolvedAt: null,
      startedAt: new Date("2020-01-01T00:00:00Z"),
      contextSnapshot: { issueId: issue.id, prompt: payload },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { prompt: payload } }, savedInput: payload },
      resultJson: { stdout: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
    }).returning();
    const observed = createDb(database.connectionString);
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
    try {
      const state = extracted.createHeartbeatRunState(observed);
      const direct = await state.getRunIssueControl(run.id), active = await state.getActiveRunIssueControlForAgent(agent.id);
      expect(active).toEqual(direct);
      expect(direct).toEqual({ id: run.id, companyId, agentId: agent.id, status: "running", runtimeMode: "legacy",
        runtimeModeResolvedAt: null, startedAt: run.startedAt, createdAt: run.createdAt,
        contextSnapshot: { issueId: issue.id }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } });
      capture.flush();
      const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
      expect(summary.completedQueries).toBe(2);
      expect(summary.responseValueBytes).toBeLessThan(2048);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, run.id));
      expect((await state.getRunIssueControl(run.id))?.status).toBe("failed");
      expect(await state.getActiveRunIssueControlForAgent(agent.id)).toBeNull();
      expect(await state.getActiveRunIssueControlForAgent(randomUUID())).toBeNull();
      expect(await state.getRunIssueControl(randomUUID())).toBeNull();
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it("preserves native preparation, legacy steering, and typed issue context in issue control reads", async () => {
    const { companyId, agent, issue, state } = await fixture();
    for (const mode of ["native", "legacy"] as const) {
      for (const value of [null, false, 42, [], {}, { nested: true }, "paperclip_runner", "process"]) {
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", runtimeMode: mode,
          contextSnapshot: { issueId: value }, runnerProfileJson: { adapterDispatch: { adapterType: value } },
        }).returning();
        const narrow = await state.getRunIssueControl(run.id), full = await state.getRun(run.id);
        expect(narrow?.contextSnapshot?.issueId).toEqual(value);
        expect(narrow?.runnerProfileJson).toEqual({ adapterDispatch: { adapterType: value } });
        for (const queueState of ["queued", "deferred", null] as const) {
          const facts = { state: queueState, queueRunRuntimeMode: mode, assignedAgentAdapterType: "paperclip_runner", queuedCommentCount: 1 };
          expect(decideQueuedCommentQueueSteering({ ...facts, activeRun: narrow }))
            .toEqual(decideQueuedCommentQueueSteering({ ...facts, activeRun: full }));
        }
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: issue.id }, runtimeModeResolvedAt: new Date("2020-01-01T00:00:00Z") })
          .where(eq(heartbeatRuns.id, run.id));
        const updated = await state.getRunIssueControl(run.id);
        expect(updated?.contextSnapshot).toEqual({ issueId: issue.id });
        expect(updated?.runtimeModeResolvedAt).toEqual(new Date("2020-01-01T00:00:00Z"));
      }
    }
  });

  it("reads cleanup and workspace settlement without transferring saved input or changing the run", async () => {
    const { companyId, agent, issue, state } = await fixture();
    const bulk = "cleanup-saved-input-sentinel🙂".repeat(40_000);
    const sync = { schema: "paperclip.native-workspace-sync.v1", state: "prepared", resourceDisposition: "destroy" };
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, issueId: issue.id, runtimeMode: "native", status: "failed",
      errorCode: "provider_transport_failed", error: "Retain saved files", nativePhase: "terminal_failure",
      runnerProfileJson: { nativeWorkspaceSync: sync, nativeResourceDisposition: "keep_running", savedInput: bulk },
      resultJson: { workspaceExportRetry: { requestId: "retry-source" }, stdout: bulk },
      contextSnapshot: { timerClaimWasFirstHeartbeat: true, savedInput: bulk },
      stdoutExcerpt: bulk, stderrExcerpt: bulk,
    }).returning();
    await state.getRunWorkspaceSettlement(run.id);
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    expect(await state.getRunCleanupState(run.id)).toEqual({
      id: run.id, companyId, agentId: agent.id, runtimeMode: run.runtimeMode,
      status: run.status, errorCode: run.errorCode, nativePhase: run.nativePhase,
    });
    expect(await state.getRunWorkspaceSettlement(run.id)).toEqual({
      id: run.id, status: run.status, error: run.error,
      runnerProfileJson: { nativeWorkspaceSync: sync, nativeResourceDisposition: "keep_running" },
      resultJson: { workspaceExportRetry: { requestId: "retry-source" } },
      contextSnapshot: { timerClaimWasFirstHeartbeat: true },
    });
    capture.flush();
    const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
    expect(summary.completedQueries).toBe(2);
    expect(summary.responseValueBytes).toBeLessThan(2000);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect(JSON.stringify(events)).not.toContain("cleanup-saved-input-sentinel");
    expect(await state.getRunCleanupState(randomUUID())).toBeNull();
    expect(await state.getRunWorkspaceSettlement(randomUUID())).toBeNull();
  });

  it("preserves JSON types in workspace settlement decisions", async () => {
    const { companyId, agent, state } = await fixture();
    for (const value of [null, false, true, "true", 0, [], { future: [1, "retained"] }]) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId: agent.id,
        runnerProfileJson: { nativeWorkspaceSync: value },
        resultJson: { workspaceExportRetry: value },
        contextSnapshot: { timerClaimWasFirstHeartbeat: value },
      }).returning({ id: heartbeatRuns.id });
      const actual = await state.getRunWorkspaceSettlement(run.id);
      expect(actual?.runnerProfileJson?.nativeWorkspaceSync).toEqual(value);
      expect(actual?.resultJson?.workspaceExportRetry).toEqual(value);
      expect(actual?.contextSnapshot?.timerClaimWasFirstHeartbeat).toEqual(value);
    }
  });

  it("retains the consumed queue identity in issue polling summaries", async () => {
    const { companyId, agent, issue, state } = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: agent.id, source: "issue", status: "claimed",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, issueId: issue.id, status: "running",
      startedAt: new Date(), wakeupRequestId: wake.id,
      contextSnapshot: { issueId: issue.id, commentId: "delivered-message", queuedCommentSourceWakeIds: ["coalesced-queue"] },
    }).returning();
    for (const summary of [
      await state.getRunIssueSummary(run.id),
      await state.getActiveRunIssueSummaryForAgent(agent.id),
    ]) {
      expect(summary).toMatchObject({ id: run.id, wakeupRequestId: wake.id, contextCommentId: "delivered-message", queuedCommentSourceWakeIds: ["coalesced-queue"] });
    }
  });

  it("bounds history at the service boundary and keeps company and agent scope", async () => {
    const { companyId, agent, state } = await fixture();
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, created_at)
      select ${companyId}::uuid, ${agent.id}::uuid, '2026-01-01'::timestamptz + n * interval '1 second'
      from generate_series(1, 1005) n`);
    const foreign = await fixture();
    await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agent.id });
    const rows = await state.listRuns(companyId);
    expect(rows).toHaveLength(200);
    expect(rows.every(row => row.companyId === companyId && row.agentId === agent.id)).toBe(true);
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(rows[199].createdAt.getTime());
    expect(await state.listRuns(companyId, agent.id, 10000)).toHaveLength(1000);
    expect(await state.listRuns(companyId, agent.id, 1.9)).toHaveLength(1);
    expect(await state.listRuns(companyId, agent.id, -10)).toHaveLength(1);
    expect(await state.listRuns(companyId, agent.id, NaN)).toHaveLength(200);
    expect(await state.listRuns(companyId, foreign.agent.id)).toEqual([]);
  });

  it("preserves legacy context text, native issue precedence and summary privacy", async () => {
    const { companyId, agent, issue, state } = await fixture();
    const contexts: unknown[] = [null, [], "legacy", 3, true, {}, {
      issueId: "legacy-issue", taskId: 17, taskKey: { nested: true }, commentId: ["one", 2],
      wakeCommentId: null, wakeReason: false, wakeSource: "   ", wakeTriggerDetail: "héllo\nworld",
      secret: "never return this", prompt: randomBytes(96 * 1024).toString("hex"),
    }];
    for (const [index, contextSnapshot] of contexts.entries()) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId: agent.id, issueId: index === contexts.length - 1 ? issue.id : null,
        contextSnapshot: contextSnapshot as Record<string, unknown>,
      }).returning();
      const expected = (await db.execute(sql`select coalesce(issue_id::text, context_snapshot->>'issueId') as "issueId",
        context_snapshot->>'taskId' as "taskId", context_snapshot->>'taskKey' as "taskKey",
        context_snapshot->>'commentId' as "commentId", context_snapshot->>'wakeCommentId' as "wakeCommentId",
        context_snapshot->>'wakeReason' as "wakeReason", context_snapshot->>'wakeSource' as "wakeSource",
        context_snapshot->>'wakeTriggerDetail' as "wakeTriggerDetail" from heartbeat_runs where id = ${run.id}::uuid`))[0];
      for (const summary of [false, true]) {
        const actual = (await state.listRuns(companyId, agent.id, 100, { summary })).find(row => row.id === run.id)!;
        expect(actual.contextSnapshot).toEqual(extracted.summarizeHeartbeatRunContextSnapshot(expected));
        expect(actual.contextSnapshot ?? {}).not.toHaveProperty("secret");
        expect(actual.contextSnapshot ?? {}).not.toHaveProperty("prompt");
      }
    }
  });

  it("preserves controller lease cancellation when a large result is bounded", async () => {
    const { companyId, agent, state } = await fixture();
    const cancellation = {
      source: "controller_lease", expected: false, initiator: { type: "system" },
      reason: "Legacy controller lease lost (renewal_rejected)", recordedAt: "2026-01-01T00:00:00Z",
    };
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", status: "cancelled",
      resultJson: { cancellation, providerPrivateData: randomBytes(96 * 1024).toString("hex") },
    }).returning();
    const [stored] = await db.select({ size: sql<number>`pg_column_size(${heartbeatRuns.resultJson})` })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stored.size).toBeGreaterThan(64 * 1024);
    const bounded = await state.getRun(run.id);
    expect(bounded?.resultJson).not.toHaveProperty("providerPrivateData");
    expect(readRunCancellation(bounded?.resultJson)).toEqual(cancellation);
  });

  it("resumes only the selected agent's run and task session", async () => {
    const { companyId, agent, issue, state } = await fixture();
    const foreign = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", status: "failed",
      contextSnapshot: { issueId: issue.id }, sessionIdAfter: "our-session",
    }).returning();
    const [foreignRun] = await db.insert(heartbeatRuns).values({
      companyId: foreign.companyId, agentId: foreign.agent.id, invocationSource: "assignment",
      contextSnapshot: { issueId: foreign.issue.id }, sessionIdAfter: "foreign-session",
    }).returning();
    await state.upsertTaskSession({
      companyId, agentId: agent.id, adapterType: agent.adapterType, taskKey: issue.id,
      sessionParamsJson: { sessionId: "our-session", cwd: "/saved-workspace" },
      sessionDisplayId: "our-session", lastRunId: run.id, lastError: null,
    });
    expect(await state.resolveExplicitResumeSessionOverride(agent, { resumeFromRunId: foreignRun.id }, issue.id)).toBeNull();
    expect(await state.resolveExplicitResumeSessionOverride(agent, { resumeFromRunId: run.id }, issue.id)).toMatchObject({
      resumeFromRunId: run.id, issueId: issue.id, taskKey: issue.id,
      sessionDisplayId: "our-session", sessionParams: { sessionId: "our-session", cwd: "/saved-workspace" },
    });
    expect(await state.resolveSessionBeforeForWakeup(agent, issue.id)).toBe("our-session");
    expect(await state.getRuntimeStateWithSessions(agent.id)).toMatchObject({
      companyId, sessionDisplayId: "our-session", sessionParamsJson: { sessionId: "our-session" },
    });
    expect((await state.listRuns(companyId)).map((row) => row.id)).toEqual([run.id]);
  });

  it("subtracts prior cumulative usage while excluding the current run", async () => {
    const { companyId, agent, state } = await fixture();
    await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", sessionIdAfter: "cumulative",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      usageJson: { rawInputTokens: 800, rawCachedInputTokens: 100, rawOutputTokens: 80 },
    });
    const [current] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", sessionIdAfter: "cumulative",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      usageJson: { rawInputTokens: 1000, rawCachedInputTokens: 125, rawOutputTokens: 100 },
    }).returning();
    const rawUsage = { inputTokens: 1000, cachedInputTokens: 125, outputTokens: 100 };
    const input = { agentId: agent.id, runId: current.id, sessionId: "cumulative", rawUsage };
    expect(await state.resolveNormalizedUsageForSession({ ...input, usageBasis: "session_cumulative" })).toEqual({
      normalizedUsage: { inputTokens: 200, cachedInputTokens: 25, outputTokens: 20 },
      previousRawUsage: { inputTokens: 800, cachedInputTokens: 100, outputTokens: 80 },
      derivedFromSessionTotals: true,
    });
    expect(await state.resolveNormalizedUsageForSession({ ...input, usageBasis: "per_run" })).toEqual({
      normalizedUsage: rawUsage, previousRawUsage: null, derivedFromSessionTotals: false,
    });
  });

  it("uses the selected session's usage and summary for compaction", async () => {
    const { companyId, agent, issue, state } = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", sessionIdAfter: "compact",
      usageJson: { rawInputTokens: 90, rawCachedInputTokens: 20, rawInputIncludesCached: false },
      resultJson: { summary: "Continue our task", providerPrivateData: "omit this" },
    }).returning();
    const foreign = await fixture();
    await db.insert(heartbeatRuns).values({
      companyId: foreign.companyId, agentId: foreign.agent.id, invocationSource: "assignment",
      sessionIdAfter: "compact", resultJson: { summary: "Foreign task" },
    });
    const decision = await state.evaluateSessionCompaction({
      agent: { ...agent, runtimeConfig: { heartbeat: { sessionCompaction: { maxRawInputTokens: 100 } } } },
      sessionId: "compact", issueId: issue.id,
    });
    expect(decision).toMatchObject({ rotate: true, reason: "session raw input reached 110 tokens (threshold 100)", previousRunId: run.id });
    expect(decision.handoffMarkdown).toContain("Continue our task");
    expect(decision.handoffMarkdown).not.toContain("Foreign task");
    expect(decision.handoffMarkdown).not.toContain("omit this");
  });

  it.each(["superseded", "cancelled"] as const)("fences %s conversation session writes and clears", async (scenario) => {
    const { companyId, agent, issue, state } = await fixture();
    await db.update(issues).set({
      conversationAgentId: agent.id, conversationUserId: "test-user", conversationState: "active",
      conversationSessionGeneration: 2,
    }).where(eq(issues.id, issue.id));
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, invocationSource: "assignment", status: "succeeded",
      contextSnapshot: { conversationSessionGeneration: 2 },
    }).returning();
    const input = {
      companyId, agentId: agent.id, adapterType: agent.adapterType, taskKey: issue.id,
      sessionParamsJson: { sessionId: "retained" }, sessionDisplayId: "retained", lastRunId: run.id, lastError: null,
    };
    const saved = await state.upsertTaskSession(input);
    expect(saved?.sessionDisplayId).toBe("retained");
    if (scenario === "superseded") {
      await db.update(issues).set({ conversationSessionGeneration: 3 }).where(eq(issues.id, issue.id));
    } else {
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    }
    expect(await state.upsertTaskSession({ ...input, sessionDisplayId: "stale" })).toBeNull();
    expect(await state.clearTaskSessions(companyId, agent.id, { taskKey: issue.id, expectedRunId: run.id })).toBe(0);
    const [retained] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, saved!.id));
    expect(retained.sessionDisplayId).toBe("retained");
  });
});

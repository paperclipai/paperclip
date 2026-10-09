import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import * as legacy from "../heartbeat.js";
import * as extracted from "./run-state.js";

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
    const raw = readingDatabase("SQL_ASCII");
    await extracted.createHeartbeatRunState(raw.db).getRun("raw", { unsafeFullResultJson: true });
    expect(raw.execute).not.toHaveBeenCalled();
    expect(raw.columns[0].resultJson).toBe(heartbeatRuns.resultJson);
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

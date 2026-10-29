import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityService } from "./activity.js";
import { executionProjectionsForRuns } from "./execution-projection.js";
import { logger } from "../middleware/logger.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-01-01T00:00:00Z");
const tables = ["heartbeat_runs", "native_run_finalizations", "issue_thread_interactions", "issue_recovery_actions"];
const dialect = new PgDialect();
function disconnected(code = "CONNECTION_CLOSED") {
  return new Error("Failed query", { cause: Object.assign(new Error("Connection failed"), { code }) });
}

function fixture(options: {
  failures?: Record<string, Error[]>;
  missing?: boolean;
  noIssue?: boolean;
  backfill?: boolean;
  writeFailure?: Error;
} = {}) {
  const attempts: Array<{ key: string; params: unknown[]; order: string[] }> = [];
  const row = {
    id: runId, companyId, runId, status: "succeeded", runtimeMode: "native", errorCode: null,
    nativeIssueId: options.noIssue ? null : issueId, contextSnapshot: {},
    finishedAt: now, startedAt: now, createdAt: now, resultJson: null, usageJson: null,
    scheduledRetryAt: null, scheduledRetryAttempt: 0, retryOfRunId: null, nextAction: null,
  };
  const select = vi.fn((fields: Record<string, unknown> = {}) => ({
    from(table: Parameters<typeof getTableName>[0]) {
      const name = getTableName(table);
      const key = name === "heartbeat_runs" && "runId" in fields ? "run_list"
        : name === "heartbeat_runs" && "stdoutExcerpt" in fields ? "liveness_backfill"
          : name;
      let condition: SQL;
      let order: SQL[] = [];
      let result: Promise<unknown[]> | undefined;
      const query = {
        where(value: SQL) { condition = value; return query; },
        innerJoin() { return query; },
        orderBy(...values: SQL[]) { order = values; return query; },
        limit() { return query; },
        then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          // Re-awaiting the same failed builder cannot recover the connection.
          result ??= Promise.resolve().then(() => {
            const attempt = attempts.filter((read) => read.key === key).length;
            attempts.push({ key, params: dialect.sqlToQuery(condition).params,
              order: order.map((value) => dialect.sqlToQuery(value).sql) });
            const error = options.failures?.[key]?.[attempt];
            if (error) throw error;
            if (options.missing) return [];
            if (key === "heartbeat_runs" || key === "run_list") return [row];
            if (key === "liveness_backfill") return options.backfill ? [row] : [];
            if (key === "issues") return [{ status: "in_progress", title: "Fixture", workMode: "standard" }];
            if (key === "issue_thread_interactions") return [{ issueId, kind: "ask_user_questions" }];
            return [];
          });
          return result.then(resolve, reject);
        },
      };
      return query;
    },
  }));
  const updateWhere = vi.fn(async () => { if (options.writeFailure) throw options.writeFailure; });
  const update = vi.fn(() => ({ set: () => ({ where: updateWhere }) }));
  const transaction = vi.fn(() => { throw new Error("Must not start or replay a transaction"); });
  const db = { select, update, transaction } as unknown as Db;
  return { db, attempts, select, update, updateWhere, transaction,
    count: (key: string) => attempts.filter((read) => read.key === key).length };
}

afterEach(() => vi.restoreAllMocks());

describe("execution projection read retries", () => {
  it.each(tables)("rebuilds only the failed %s SELECT within the existing retry budget", async (table) => {
    const test = fixture({ failures: { [table]: [disconnected(), disconnected("CONNECTION_ENDED")] } });
    const result = await executionProjectionsForRuns(test.db, companyId, [runId], now, { retryDatabaseReads: true });
    expect(result.get(runId)).toMatchObject({ phase: "waiting_for_answer", label: "Waiting for answer" });
    for (const name of tables) expect(test.count(name)).toBe(name === table ? 3 : 1);
    expect(test.select).toHaveBeenCalledTimes(6);
    const reads = test.attempts.filter((read) => read.key === table);
    expect(reads[1]).toEqual(reads[0]);
    expect(reads[2]).toEqual(reads[0]);
    expect(reads[0].params).toContain(companyId);
    expect(reads[0].params).toContain(table === "heartbeat_runs" || table === "native_run_finalizations" ? runId : issueId);
    if (table === "issue_thread_interactions") expect(reads[0].params).toContain("pending");
    if (table === "issue_recovery_actions") expect(reads[0].order).toEqual(['"issue_recovery_actions"."updated_at" desc']);
    expect(test.update).not.toHaveBeenCalled();
    expect(test.transaction).not.toHaveBeenCalled();
  });

  it.each(tables)("preserves the last %s error after three attempts", async (table) => {
    const errors = [disconnected(), disconnected(), disconnected()];
    const test = fixture({ failures: { [table]: errors } });
    await expect(executionProjectionsForRuns(test.db, companyId, [runId], now, { retryDatabaseReads: true })).rejects.toBe(errors[2]);
    for (const [index, name] of tables.entries()) {
      expect(test.count(name)).toBe(index < tables.indexOf(table) ? 1 : name === table ? 3 : 0);
    }
  });

  it.each(tables)("keeps the default transaction-compatible %s path single-attempt", async (table) => {
    const error = disconnected();
    const test = fixture({ failures: { [table]: [error] } });
    await expect(executionProjectionsForRuns(test.db, companyId, [runId], now)).rejects.toBe(error);
    expect(test.count(table)).toBe(1);
    expect(test.transaction).not.toHaveBeenCalled();
  });

  it.each([new Error("CONNECTION_CLOSED"), disconnected("28P01"), disconnected("42501"), disconnected("22P02"), disconnected("25P02")])(
    "does not retry an unclassified or non-transient error", async (error) => {
      const test = fixture({ failures: { issue_thread_interactions: [error] } });
      await expect(executionProjectionsForRuns(test.db, companyId, [runId], now, { retryDatabaseReads: true })).rejects.toBe(error);
      expect(test.count("issue_thread_interactions")).toBe(1);
      expect(test.count("issue_recovery_actions")).toBe(0);
    },
  );

  it("preserves empty and taskless projection behavior without unnecessary reads", async () => {
    const empty = fixture();
    expect(await executionProjectionsForRuns(empty.db, companyId, [], now, { retryDatabaseReads: true })).toEqual(new Map());
    expect(empty.select).not.toHaveBeenCalled();
    for (const options of [{ missing: true }, { noIssue: true }]) {
      const test = fixture(options);
      const result = await executionProjectionsForRuns(test.db, companyId, [runId], now, { retryDatabaseReads: true });
      expect(test.select).toHaveBeenCalledTimes(2);
      expect(options.missing ? result.size : result.get(runId)?.phase).toBe(options.missing ? 0 : "completed");
    }
  });

  it.each([false, true])("the run list retries projection reads without replaying other reads or backfill writes (write fails: %s)", async (writeFails) => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const test = fixture({ backfill: true, writeFailure: writeFails ? disconnected() : undefined,
      failures: { issue_thread_interactions: [disconnected(), disconnected()] } });
    const result = await activityService(test.db).runsForIssue(companyId, issueId);
    expect(result).toMatchObject([{ runId, execution: { phase: "waiting_for_answer" } }]);
    expect(test.count("issue_thread_interactions")).toBe(3);
    for (const key of ["run_list", "liveness_backfill", "heartbeat_runs", "native_run_finalizations", "environment_leases", "issue_recovery_actions"]) {
      expect(test.count(key)).toBe(1);
    }
    // One retry-exhaustion lookup plus the independent backfill's event count.
    expect(test.count("heartbeat_run_events")).toBe(2);
    expect(test.update).toHaveBeenCalledTimes(1);
    expect(test.updateWhere).toHaveBeenCalledTimes(1);
    expect(test.transaction).not.toHaveBeenCalled();
  });
});

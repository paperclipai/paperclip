import type { Request, Response } from "express";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUN_LIST_DEFAULT_LIMIT,
  heartbeatService,
} from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { getAccessibleResource } from "../routes/authz.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const dialect = new PgDialect();

function disconnected(code = "CONNECTION_CLOSED") {
  return new Error("Failed query", {
    cause: Object.assign(new Error(`write ${code}`), { code }),
  });
}

function fixture(options: {
  failures?: Record<string, Error[]>;
  missing?: boolean;
  encoding?: string;
} = {}) {
  const attempts: Array<{
    table: string;
    params: unknown[];
    fields: Record<string, unknown>;
    order: string[];
    limit: number | undefined;
  }> = [];
  const row = { id: issueId, companyId, identifier: "TEST-1", externalConversationState: "waiting" };
  const select = vi.fn((fields: Record<string, unknown> = {}) => ({
    from(table: Parameters<typeof getTableName>[0]) {
      const name = getTableName(table);
      let condition: SQL;
      let order: SQL[] = [];
      let limit: number | undefined;
      let result: Promise<unknown[]> | undefined;
      const query = {
        where(value: SQL) { condition = value; return query; },
        innerJoin() { return query; },
        orderBy(...values: SQL[]) { order = values; return query; },
        limit(value: number) { limit = value; return query; },
        then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          // A failed query object stays failed. Recovery must build another one.
          result ??= Promise.resolve().then(() => {
            const attempt = attempts.filter((read) => read.table === name).length;
            attempts.push({ table: name, fields, params: dialect.sqlToQuery(condition).params,
              order: order.map((value) => dialect.sqlToQuery(value).sql), limit });
            const error = options.failures?.[name]?.[attempt];
            if (error) throw error;
            if (options.missing) return [];
            if (name === "issues") return [row];
            if (name === "issue_labels") return [{ issueId, label: { id: "label-1", name: "Ready" } }];
            if (name === "issue_watchdogs") return [];
            if (name === "heartbeat_runs") return [{
              id: "run-1", companyId, agentId, status: "succeeded",
              contextIssueId: issueId, contextWakeReason: "issue_assigned", resultSummary: "Finished",
            }];
            throw new Error(`Unexpected read: ${name}`);
          });
          return result.then(resolve, reject);
        },
      };
      return query;
    },
  }));
  const execute = vi.fn().mockResolvedValue([{ server_encoding: options.encoding ?? "UTF8" }]);
  const db = { select, execute } as unknown as Db;
  return { db, row, attempts, select, execute };
}

describe("heartbeat list connection recovery", () => {
  it.each([
    { summary: false, agent: agentId, limit: 5, encoding: "UTF8" },
    { summary: true, agent: undefined, limit: undefined, encoding: "UTF8" },
    { summary: false, agent: undefined, limit: undefined, encoding: "SQL_ASCII" },
  ])("rebuilds the scoped list with its projection and limit (%j)", async (options) => {
    const test = fixture({ encoding: options.encoding,
      failures: { heartbeat_runs: [disconnected(), disconnected("CONNECTION_ENDED")] } });
    await expect(heartbeatService(test.db).list(companyId, options.agent, options.limit, options))
      .resolves.toEqual([{
        id: "run-1", companyId, agentId, status: "succeeded",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        resultJson: options.summary || options.encoding === "SQL_ASCII" ? null : { summary: "Finished" },
      }]);
    expect(test.select).toHaveBeenCalledTimes(3);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.attempts).toHaveLength(3);
    for (const attempt of test.attempts) {
      expect(attempt.params).toEqual(options.agent ? [companyId, agentId] : [companyId]);
      expect(attempt.limit).toBe(options.limit ?? HEARTBEAT_RUN_LIST_DEFAULT_LIMIT);
      expect(attempt.order).toEqual(['"heartbeat_runs"."created_at" desc']);
      expect("resultSummary" in attempt.fields).toBe(!options.summary && options.encoding === "UTF8");
      expect(attempt.fields).toEqual(test.attempts[0].fields);
    }
  });

  it("propagates the final list error after three attempts", async () => {
    const failures = [disconnected(), disconnected(), disconnected()];
    const test = fixture({ failures: { heartbeat_runs: failures } });
    await expect(heartbeatService(test.db).list(companyId)).rejects.toBe(failures[2]);
    expect(test.select).toHaveBeenCalledTimes(3);
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("CONNECTION_CLOSED"), disconnected("28P01"), disconnected("42501")])(
    "does not retry other list errors", async (error) => {
      const test = fixture({ failures: { heartbeat_runs: [error] } });
      await expect(heartbeatService(test.db).list(companyId)).rejects.toBe(error);
      expect(test.select).toHaveBeenCalledTimes(1);
    },
  );

  it("returns an empty list without retries", async () => {
    const test = fixture({ missing: true });
    await expect(heartbeatService(test.db).list(companyId)).resolves.toEqual([]);
    expect(test.select).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  { name: "UUID", read: (db: Db) => issueService(db).getById(issueId), parameter: issueId },
  { name: "identifier", read: (db: Db) => issueService(db).getByIdentifier("test-1"), parameter: "TEST-1" },
  { name: "identifier through getById", read: (db: Db) => issueService(db).getById(" test-1 "), parameter: "TEST-1" },
])("issue lookup connection recovery ($name)", ({ read, parameter }) => {
  it("rebuilds the base lookup and enriches only the successful result", async () => {
    const test = fixture({ failures: { issues: [disconnected(), disconnected("CONNECT_TIMEOUT")] } });
    await expect(read(test.db)).resolves.toEqual({ ...test.row,
      labels: [{ id: "label-1", name: "Ready" }], labelIds: ["label-1"], watchdog: null });
    expect(test.select).toHaveBeenCalledTimes(5);
    expect(test.attempts.map((attempt) => attempt.table))
      .toEqual(["issues", "issues", "issues", "issue_labels", "issue_watchdogs"]);
    for (const attempt of test.attempts.slice(0, 3)) {
      expect(attempt.params).toEqual([parameter]);
      expect(attempt.fields).toHaveProperty("externalConversationState");
    }
    expect(test.attempts[3].params).toEqual([issueId]);
    expect(test.attempts[4].params).toEqual([companyId, issueId, "active"]);
  });

  it("propagates the final lookup error without enrichment", async () => {
    const failures = [disconnected(), disconnected(), disconnected()];
    const test = fixture({ failures: { issues: failures } });
    await expect(read(test.db)).rejects.toBe(failures[2]);
    expect(test.attempts.map((attempt) => attempt.table)).toEqual(["issues", "issues", "issues"]);
  });

  it("returns null for a missing issue without retries or enrichment", async () => {
    const test = fixture({ missing: true });
    await expect(read(test.db)).resolves.toBeNull();
    expect(test.select).toHaveBeenCalledTimes(1);
  });

  it("preserves non-transient database errors", async () => {
    const error = disconnected("42501");
    const test = fixture({ failures: { issues: [error] } });
    await expect(read(test.db)).rejects.toBe(error);
    expect(test.select).toHaveBeenCalledTimes(1);
  });

  it.each(["issue_labels", "issue_watchdogs"])("does not replay the lookup when %s enrichment fails", async (table) => {
    const error = disconnected();
    const test = fixture({ failures: { [table]: [error] } });
    await expect(read(test.db)).rejects.toBe(error);
    expect(test.attempts.map((attempt) => attempt.table)).toEqual(["issues", "issue_labels", "issue_watchdogs"]);
  });
});

describe("issue access after lookup recovery", () => {
  it.each([true, false])("retains the same not-found response for missing and inaccessible issues (missing=%s)", async (missing) => {
    const test = fixture({ missing, failures: { issues: [disconnected()] } });
    const req = { method: "GET", actor: { type: "agent", companyId: "other-company" } } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    await expect(getAccessibleResource(req, res, issueService(test.db).getById(issueId), "Issue not found"))
      .resolves.toBeNull();
    expect(res.status).toHaveBeenCalledExactlyOnceWith(404);
    expect(res.json).toHaveBeenCalledExactlyOnceWith({ error: "Issue not found" });
    expect(test.attempts.filter((attempt) => attempt.table === "issues")).toHaveLength(2);
  });
});

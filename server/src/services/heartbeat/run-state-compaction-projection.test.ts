import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  createHeartbeatRunState,
  isInvalidEncodingByteSequenceError,
  selectSessionCompactionRunColumns,
} from "./run-state.js";

function renderCompactionSelectSql(unsafeTextProjection: boolean): string {
  const qb = new QueryBuilder();
  return qb
    .select(selectSessionCompactionRunColumns(unsafeTextProjection))
    .from(heartbeatRuns)
    .toSQL()
    .sql.toLowerCase();
}

describe("selectSessionCompactionRunColumns", () => {
  it("always projects the columns compaction needs to decide rotation", () => {
    for (const unsafe of [false, true]) {
      const columns = selectSessionCompactionRunColumns(unsafe);
      expect(Object.keys(columns)).toEqual(
        expect.arrayContaining([
          "id",
          "createdAt",
          "usageJson",
          "error",
          "terminalFailureCategory",
          "resultSummary",
          "resultResult",
          "resultMessage",
          "resultError",
          "resultTotalCostUsd",
          "resultCostUsd",
          "resultCostUsdCamel",
        ]),
      );
    }
  });

  it("keeps a stable row shape across both projections", () => {
    // Downstream compaction code reads the same fields regardless of the
    // encoding branch, so both projections must expose an identical key set.
    expect(Object.keys(selectSessionCompactionRunColumns(true)).sort()).toEqual(
      Object.keys(selectSessionCompactionRunColumns(false)).sort(),
    );
  });

  it("decomposes result_json / selects error on encoding-safe databases", () => {
    const sql = renderCompactionSelectSql(false);
    // The summary handoff is derived from jsonb text decomposition + error.
    expect(sql).toContain("->> 'summary'");
    expect(sql).toContain("->> 'error'");
    expect(sql).toContain('"error"');
    // The terminal-failure category reads result_json via the #>> path op.
    expect(sql).toContain("#>>");
    expect(sql).toContain("result_json");
    // Usage + ordering columns are always present.
    expect(sql).toContain("usage_json");
    expect(sql).toContain("created_at");
  });

  it("omits error + result_json text projections on SQL_ASCII databases", () => {
    const sql = renderCompactionSelectSql(true);
    // No jsonb text decomposition of result_json — that is what throws
    // `invalid byte sequence for encoding "UTF8"` on a poisoned SQL_ASCII row.
    expect(sql).not.toContain("->>");
    expect(sql).not.toContain("#>>");
    expect(sql).not.toContain("result_json");
    // The error column must not be read either; it is projected as NULL.
    expect(sql).not.toMatch(/"heartbeat_runs"\."error"/);
    // But the columns compaction actually needs are still selected.
    expect(sql).toContain("usage_json");
    expect(sql).toContain("created_at");
    // The unsafe fields are emitted as constant nulls so the row shape is stable.
    expect(sql).toContain("null");
  });
});

describe("isInvalidEncodingByteSequenceError", () => {
  it("matches SQLSTATE 22021", () => {
    expect(isInvalidEncodingByteSequenceError({ code: "22021" })).toBe(true);
  });

  it("matches the invalid-byte-sequence message when code is absent", () => {
    expect(
      isInvalidEncodingByteSequenceError(
        new Error('invalid byte sequence for encoding "UTF8": 0xe2'),
      ),
    ).toBe(true);
  });

  it("walks the cause chain Drizzle wraps the driver error in", () => {
    const wrapped = new Error("Failed query") as Error & { cause?: unknown };
    wrapped.cause = { code: "22021" };
    expect(isInvalidEncodingByteSequenceError(wrapped)).toBe(true);
  });

  it("walks nested cause chains that only carry the message", () => {
    const inner = new Error('invalid byte sequence for encoding "UTF8": 0xe2');
    const middle = new Error("Failed query") as Error & { cause?: unknown };
    middle.cause = inner;
    const outer = new Error("heartbeat setup failed") as Error & { cause?: unknown };
    outer.cause = middle;
    expect(isInvalidEncodingByteSequenceError(outer)).toBe(true);
  });

  it("terminates on a self-referential cause chain", () => {
    const cyclic: { code: string; cause?: unknown } = { code: "23505" };
    cyclic.cause = cyclic;
    expect(isInvalidEncodingByteSequenceError(cyclic)).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isInvalidEncodingByteSequenceError(null)).toBe(false);
    expect(isInvalidEncodingByteSequenceError(undefined)).toBe(false);
    expect(isInvalidEncodingByteSequenceError({ code: "23505" })).toBe(false);
    expect(
      isInvalidEncodingByteSequenceError(new Error("connection reset")),
    ).toBe(false);
  });
});

const compactionAgent = {
  id: "agent-compaction",
  adapterType: "codex_local",
  runtimeConfig: {
    heartbeat: { sessionCompaction: { enabled: true, maxSessionRuns: 8 } },
  },
} as unknown as typeof agents.$inferSelect;

/**
 * Minimal run-state database: the encoding probe answers, and the run-history
 * select either resolves to no rows or rejects with `selectFailure`.
 */
function compactionDatabase(serverEncoding: string, selectFailure?: unknown) {
  const execute = vi.fn(async () => [{ server_encoding: serverEncoding }]);
  const select = vi.fn(() => {
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
        (selectFailure === undefined
          ? Promise.resolve([] as unknown[])
          : Promise.reject(selectFailure)
        ).then(resolve, reject),
    };
    return query;
  });
  return { db: { execute, select } as unknown as Db, execute, select };
}

describe("evaluateSessionCompaction legacy-encoding recovery", () => {
  it("rotates the session when the run-history query fails with a Drizzle-wrapped 22021", async () => {
    // Drizzle re-throws driver failures inside DrizzleQueryError, so the
    // SQLSTATE only appears on `.cause`. This is the shape that used to wedge
    // heartbeat setup: the outer error matched nothing and was rethrown.
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: { code: "22021", message: 'invalid byte sequence for encoding "UTF8": 0xe2' },
    });
    const binding = compactionDatabase("UTF8", wrapped);
    const state = createHeartbeatRunState(binding.db);

    const decision = await state.evaluateSessionCompaction({
      agent: compactionAgent,
      sessionId: "session-legacy",
      issueId: null,
    });

    expect(binding.select).toHaveBeenCalled();
    expect(decision.rotate).toBe(true);
    expect(decision.handoffMarkdown).toBeNull();
    expect(decision.previousRunId).toBeNull();
    expect(decision.reason).toMatch(/rotating to recover/i);
  });

  it("rethrows a run-history failure that is not an encoding error", async () => {
    const binding = compactionDatabase("UTF8", new Error("connection reset"));
    const state = createHeartbeatRunState(binding.db);

    await expect(
      state.evaluateSessionCompaction({
        agent: compactionAgent,
        sessionId: "session-legacy",
        issueId: null,
      }),
    ).rejects.toThrow("connection reset");
  });
});

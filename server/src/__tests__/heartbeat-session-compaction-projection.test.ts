import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { heartbeatRuns } from "@paperclipai/db";
import {
  isInvalidEncodingByteSequenceError,
  selectSessionCompactionRunColumns,
} from "../services/heartbeat.ts";

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

  it("does not match unrelated errors", () => {
    expect(isInvalidEncodingByteSequenceError(null)).toBe(false);
    expect(isInvalidEncodingByteSequenceError(undefined)).toBe(false);
    expect(isInvalidEncodingByteSequenceError({ code: "23505" })).toBe(false);
    expect(
      isInvalidEncodingByteSequenceError(new Error("connection reset")),
    ).toBe(false);
  });
});

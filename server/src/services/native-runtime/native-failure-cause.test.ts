import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_FAILURE_CAUSE_HOPS,
  buildNativeFailureCauseResultJson,
  describeNativeFailureCause,
} from "./native-failure-cause.js";

/**
 * `DrizzleQueryError` builds its message from the query and params only
 * (drizzle-orm/errors.js:12-13) and keeps the driver error on `cause`. These
 * fixtures reproduce that shape exactly, because the whole defect is that the
 * rendered message alone cannot answer "was it a deadlock?".
 */
function drizzleQueryError(sqlstate: string, params: unknown[]): Error {
  const cause = Object.assign(new Error("deadlock detected"), { code: sqlstate });
  return Object.assign(
    new Error(`Failed query: update "heartbeat_runs" set "status" = $1 where ("heartbeat_runs"."id" = $2)\nparams: ${params.join(",")}`),
    { cause },
  );
}

describe("describeNativeFailureCause", () => {
  it("recovers the Postgres SQLSTATE that the rendered message omits", () => {
    const error = drizzleQueryError("40P01", ["failed", "run-1"]);

    const detail = describeNativeFailureCause(error);

    expect(detail.causeCode).toBe("40P01");
    expect(detail.sqlstate).toBe(true);
    // The rendered message must not be the thing answering the question.
    expect(error.message).not.toContain("40P01");
  });

  it("keeps every hop of the chain with its machine code", () => {
    const detail = describeNativeFailureCause(drizzleQueryError("55P03", ["failed"]));

    expect(detail.causeChain).toHaveLength(2);
    expect(detail.causeChain[0]).toMatchObject({ depth: 0, message: expect.stringContaining("Failed query") });
    expect(detail.causeChain[1]).toMatchObject({ depth: 1, code: "55P03", sqlstate: true });
  });

  it("follows originalError, the link name some transports use", () => {
    const error = Object.assign(new Error("Failed query: select 1"), {
      originalError: Object.assign(new Error("terminating connection"), { code: "57P01" }),
    });

    expect(describeNativeFailureCause(error).causeCode).toBe("57P01");
  });

  it("prefers the deepest SQLSTATE over a shallower driver code", () => {
    const error = Object.assign(new Error("Failed query: update"), {
      code: "DRIVER_LEAK",
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });

    const detail = describeNativeFailureCause(error);

    expect(detail.causeCode).toBe("40P01");
    expect(detail.sqlstate).toBe(true);
  });

  it("reports a non-SQLSTATE driver code without claiming it is a SQLSTATE", () => {
    const error = Object.assign(new Error("connection terminated"), { code: "ECONNRESET" });

    const detail = describeNativeFailureCause(error);

    expect(detail.causeCode).toBe("ECONNRESET");
    expect(detail.sqlstate).toBe(false);
  });

  it("stops on a cyclic cause chain instead of looping", () => {
    const first: Record<string, unknown> = { message: "first", code: "40P01" };
    const second: Record<string, unknown> = { message: "second", code: "40001" };
    first.cause = second;
    second.cause = first;

    const detail = describeNativeFailureCause(first);

    expect(detail.causeChain.length).toBeLessThanOrEqual(MAX_NATIVE_FAILURE_CAUSE_HOPS);
  });

  it("bounds the chain at the hop limit", () => {
    let cursor: Record<string, unknown> = { message: "hop-0" };
    const root = cursor;
    for (let index = 1; index < 20; index += 1) {
      const next: Record<string, unknown> = { message: `hop-${index}` };
      cursor.cause = next;
      cursor = next;
    }

    expect(describeNativeFailureCause(root).causeChain).toHaveLength(MAX_NATIVE_FAILURE_CAUSE_HOPS);
  });

  it("tolerates non-Error throws", () => {
    expect(describeNativeFailureCause("native_finalization_invalid").causeCode).toBeNull();
    expect(describeNativeFailureCause(null).causeChain).toEqual([]);
    expect(describeNativeFailureCause(undefined).causeChain).toEqual([]);
  });
});

describe("buildNativeFailureCauseResultJson", () => {
  it("makes the SQLSTATE reachable with a json path instead of text parsing", () => {
    const payload = buildNativeFailureCauseResultJson(
      describeNativeFailureCause(drizzleQueryError("40P01", ["failed", "run-1"])),
    );

    expect(payload.finalizationCauseCode).toBe("40P01");
    expect(payload.finalizationSqlstate).toBe(true);
    expect(payload.finalizationCauseChain).toHaveLength(2);
  });

  it("omits the code keys when no cause carried a code", () => {
    const payload = buildNativeFailureCauseResultJson(describeNativeFailureCause(new Error("plain")));

    expect(payload).not.toHaveProperty("finalizationCauseCode");
    expect(payload).not.toHaveProperty("finalizationSqlstate");
  });
});

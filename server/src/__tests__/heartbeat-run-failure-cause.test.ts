import { describe, expect, it, vi } from "vitest";
import {
  describeRunFailureError,
  isTransientDbErrorCode,
  isTransientDbFailure,
  isTransientDbSqlState,
  readDbFailureErrorCode,
  unwrapDbErrorCause,
} from "../services/db-error-codes.js";
import {
  FIRST_LIFECYCLE_WRITE_RETRY_DELAYS_MS,
  runWithTransientDbRetry,
} from "../services/heartbeat.js";

/**
 * Build a `DrizzleQueryError`-shaped throw: a wrapper whose `.message` is only
 * the `Failed query:` SQL text and whose real Postgres driver error (SQLSTATE
 * `code` / `detail`) lives on `.cause` — exactly what drizzle throws and what
 * the AGE-810 run-event insert failure recorded without a cause.
 */
function makeDrizzleQueryError(opts: { code?: string; detail?: string; causeMessage?: string }) {
  const cause = new Error(opts.causeMessage ?? "connection terminated unexpectedly");
  if (opts.code) (cause as { code?: string }).code = opts.code;
  if (opts.detail) (cause as { detail?: string }).detail = opts.detail;
  const err = new Error(
    "Failed query: insert into \"heartbeat_run_events\" (...) values (...)\nparams: ...",
  );
  err.name = "DrizzleQueryError";
  (err as { cause?: unknown }).cause = cause;
  return err;
}

describe("describeRunFailureError", () => {
  it("appends the underlying cause message + SQLSTATE code + detail", () => {
    const err = makeDrizzleQueryError({
      code: "08006",
      detail: "server closed the connection",
      causeMessage: "connection terminated unexpectedly",
    });
    const described = describeRunFailureError(err, "Unknown adapter failure");
    expect(described).toContain("Failed query:");
    expect(described).toContain("connection terminated unexpectedly");
    expect(described).toContain("code=08006");
    expect(described).toContain("detail=server closed the connection");
    // It must not be swallowed to just the bare drizzle wrapper.
    expect(described).not.toBe(err.message);
  });

  it("returns the base message for a non-DB error", () => {
    const described = describeRunFailureError(new Error("boom"), "fallback");
    expect(described).toBe("boom");
  });

  it("returns the fallback when there is no usable message", () => {
    expect(describeRunFailureError(null, "fallback")).toBe("fallback");
    expect(describeRunFailureError({}, "fallback")).toBe("fallback");
  });
});

describe("readDbFailureErrorCode", () => {
  it("maps a known SQLSTATE to pg_<sqlstate>", () => {
    expect(readDbFailureErrorCode(makeDrizzleQueryError({ code: "08006" }))).toBe("pg_08006");
    expect(readDbFailureErrorCode(makeDrizzleQueryError({ code: "23505" }))).toBe("pg_23505");
  });

  it("falls back to db_query_failed for a drizzle wrapper with no surfaced code", () => {
    expect(readDbFailureErrorCode(makeDrizzleQueryError({ causeMessage: "nope" }))).toBe(
      "db_query_failed",
    );
  });

  it("returns null for a non-DB error so callers keep their default", () => {
    expect(readDbFailureErrorCode(new Error("boom"))).toBeNull();
    expect(readDbFailureErrorCode(null)).toBeNull();
  });
});

describe("unwrapDbErrorCause", () => {
  it("extracts message, code and detail from the cause", () => {
    const cause = unwrapDbErrorCause(
      makeDrizzleQueryError({ code: "40001", detail: "d", causeMessage: "m" }),
    );
    expect(cause).toEqual({ message: "m", code: "40001", detail: "d" });
  });

  it("returns null when there is no cause", () => {
    expect(unwrapDbErrorCause(new Error("boom"))).toBeNull();
  });
});

describe("isTransientDbSqlState / isTransientDbFailure", () => {
  it("treats the connection (08) class, serialization/deadlock/lock/cancel and admin-shutdown codes as transient", () => {
    // 57P01 / 08006 are the exact codes AGE-810/AGE-815 call out for a Neon
    // connection drop / cold-start failover.
    for (const code of ["08000", "08003", "08006", "40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03"]) {
      expect(isTransientDbSqlState(code)).toBe(true);
      expect(isTransientDbFailure(makeDrizzleQueryError({ code }))).toBe(true);
    }
  });

  it("treats deterministic data/schema errors as non-transient", () => {
    for (const code of ["23505", "23503", "42P01", "42703"]) {
      expect(isTransientDbSqlState(code)).toBe(false);
      expect(isTransientDbFailure(makeDrizzleQueryError({ code }))).toBe(false);
    }
    expect(isTransientDbSqlState(null)).toBe(false);
    expect(isTransientDbFailure(new Error("boom"))).toBe(false);
  });
});

describe("isTransientDbErrorCode", () => {
  it("classifies persisted transient DB errorCodes (pg_<transient-sqlstate> + db_query_failed) as transient", () => {
    for (const errorCode of ["pg_57P01", "pg_08006", "pg_40001", "pg_57P03", "db_query_failed"]) {
      expect(isTransientDbErrorCode(errorCode)).toBe(true);
    }
  });

  it("does not treat deterministic DB errorCodes or unrelated codes as transient", () => {
    for (const errorCode of ["pg_23505", "pg_42P01", "adapter_failed", "setup_failed", "timeout", null, undefined]) {
      expect(isTransientDbErrorCode(errorCode)).toBe(false);
    }
  });
});

describe("runWithTransientDbRetry", () => {
  it("retries a transient write failure and then succeeds instead of hard-failing", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    let calls = 0;
    const result = await runWithTransientDbRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw makeDrizzleQueryError({ code: "40001" });
        return "ok";
      },
      { isTransient: isTransientDbFailure, sleep, onRetry },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("re-throws a non-transient failure immediately without retrying", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      runWithTransientDbRetry(
        async () => {
          calls += 1;
          throw makeDrizzleQueryError({ code: "23505" });
        },
        { isTransient: isTransientDbFailure, sleep },
      ),
    ).rejects.toMatchObject({ name: "DrizzleQueryError" });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("re-throws after exhausting the bounded retry budget", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      runWithTransientDbRetry(
        async () => {
          calls += 1;
          throw makeDrizzleQueryError({ code: "08006" });
        },
        { isTransient: isTransientDbFailure, sleep, delaysMs: [1, 1] },
      ),
    ).rejects.toMatchObject({ name: "DrizzleQueryError" });
    // Initial attempt + one retry per configured delay.
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("exposes a bounded default backoff schedule", () => {
    expect(FIRST_LIFECYCLE_WRITE_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(FIRST_LIFECYCLE_WRITE_RETRY_DELAYS_MS.every((ms) => ms > 0)).toBe(true);
  });
});

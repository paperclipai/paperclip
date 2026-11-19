import { describe, expect, it } from "vitest";
import { normalizeRunFailureCause, readRunFailureCause, RUN_FAILURE_CAUSE_MAX_LENGTH, withoutSqlStatementText } from "./run-failure-cause.js";

describe("run failure cause contract", () => {
  it("accepts bounded identifier codes", () => {
    for (const code of ["40001", "ECONNRESET", "provider_http_429", "TypeError", "signal_SIGKILL", "a".repeat(RUN_FAILURE_CAUSE_MAX_LENGTH)]) {
      expect(normalizeRunFailureCause(code)).toBe(code);
    }
  });

  it("rejects message text, SQL, paths, overlong values and non-strings", () => {
    for (const value of ["", "select * from users", "Failed query: update x", "/Users/me/project", "a b",
      "a".repeat(RUN_FAILURE_CAUSE_MAX_LENGTH + 1), 40001, null, undefined, {}]) {
      expect(normalizeRunFailureCause(value)).toBeNull();
    }
  });

  it("reads the cause from a stored result and treats legacy rows as having none", () => {
    expect(readRunFailureCause({ failureCause: "40001", stopReason: "adapter_failed" })).toBe("40001");
    expect(readRunFailureCause({ stopReason: "adapter_failed" })).toBeNull();
    expect(readRunFailureCause(null)).toBeNull();
    expect(readRunFailureCause(["40001"])).toBeNull();
  });

  it("drops Drizzle statement text and parameters but keeps the wrapper and the code", () => {
    const message = 'Failed to save usage: Failed query: update "heartbeat_runs" set "usage_json" = $1 where "id" = $2\nparams: {"token":"sk-secret"},run-1';
    const safe = withoutSqlStatementText(message, "40001");
    expect(safe).toBe("Failed to save usage: Database query failed (40001)");
    expect(safe).not.toMatch(/heartbeat_runs|params|sk-secret|\$1/);
    expect(withoutSqlStatementText("Failed query: select 1", null)).toBe("Database query failed");
  });

  it("drops unwrapped statements with placeholders and ignores an invalid cause", () => {
    expect(withoutSqlStatementText('Lookup failed: select "id" from "issues" where "id" = $1', "not a code"))
      .toBe("Lookup failed: Database query failed");
    expect(withoutSqlStatementText("insert into agents (name) values ($1)")).toBe("Database query failed");
  });

  it("leaves ordinary error text unchanged", () => {
    for (const message of ["Adapter failed", "Select a model from the list", "Process exited with code 1", "Costs $5 per run"]) {
      expect(withoutSqlStatementText(message, "40001")).toBe(message);
    }
  });
});
